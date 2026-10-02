/**
 * Host-side exec shim logic. The provider's confined argv runs this shim on
 * the host; the shim runs the caller's argv in the guest through
 * `container exec`, carrying the host spawn's working directory and filtered
 * environment. `container` 1.5.0 does not forward signals through
 * `container exec`, so the shim records the guest process-group id and
 * signals that group itself. A start sentinel distinguishes a runtime failure
 * (exit {@link SHIM_FAILURE_EXIT} with a {@link SHIM_FAILURE_PREFIX} line)
 * from a command that ran and failed.
 * @module @deepseek-ai/dsh-sandbox-apple-container/shim
 */

import { constants } from 'node:os'

/** Exit status of a shim or container-runtime failure that happened before the command started. */
export const SHIM_FAILURE_EXIT = 125

/** Prefix of the single stderr line the shim writes for {@link SHIM_FAILURE_EXIT}. */
export const SHIM_FAILURE_PREFIX = 'dsh-container-exec: '

/** The decoded shim invocation. */
export interface ShimArgs {
  /** The `container` CLI executable. */
  executable: string
  /** Name of the running container the argv executes in. */
  container: string
  /** Environment keys not forwarded to the guest; a trailing `*` matches a prefix. */
  denylist: readonly string[]
  /** The caller's exact argv. */
  argv: readonly string[]
}

/**
 * Encode a shim invocation as the argument list that follows the shim entry.
 * @param args - the invocation; denylist entries are environment names and never contain commas.
 * @returns `[executable, container, denylist, '--', ...argv]`.
 */
export function encodeShimArgs(args: ShimArgs): string[] {
  return [args.executable, args.container, args.denylist.join(','), '--', ...args.argv]
}

/**
 * Decode the argument list produced by {@link encodeShimArgs}.
 * @param args - the shim process arguments after the entry path.
 * @returns the decoded invocation.
 * @throws {Error} when the list is malformed or the argv is empty.
 */
export function parseShimArgs(args: readonly string[]): ShimArgs {
  const [executable, container, denylist, separator, ...argv] = args
  if (executable === undefined || container === undefined || denylist === undefined || separator !== '--' || argv.length === 0) {
    throw new Error('usage: exec-shim <executable> <container> <denylist> -- <argv...>')
  }
  return { executable, container, denylist: denylist === '' ? [] : denylist.split(','), argv }
}

/**
 * Whether the denylist withholds `key` from the guest.
 * @param key - an environment variable name.
 * @param denylist - name globs where `*` matches any run of characters; matching ignores case.
 * @returns true when `key` is withheld.
 */
export function isDenied(key: string, denylist: readonly string[]): boolean {
  return denylist.some(entry => new RegExp(`^${entry.split('*').map(part => part.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`)).join('.*')}$`, 'iu').test(key))
}

/** A URL carrying `user:password@` credentials, such as an authenticated proxy. */
const URL_CREDENTIALS = /:\/\/[^/\s@]*:[^/\s@]*@/u

/**
 * The `--env-file` text for `env`: one `KEY=value` line per forwarded
 * variable. Denied keys and values embedding URL credentials are withheld;
 * names outside POSIX identifier syntax and values containing a line break are
 * omitted because the file format cannot carry them.
 * @param env - the shim's environment.
 * @param denylist - keys withheld from the guest.
 * @returns the file contents.
 */
export function envFileText(env: NodeJS.ProcessEnv, denylist: readonly string[]): string {
  let text = ''
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isDenied(key, denylist) || URL_CREDENTIALS.test(value)) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || /[\r\n]/u.test(value)) continue
    text += `${key}=${value}\n`
  }
  return text
}

/** Guest paths of one run's process-group id file and start sentinel. */
function tokenPaths(token: string): { pid: string; started: string } {
  return { pid: `/run/dsh-${token}.pid`, started: `/run/dsh-${token}.started` }
}

/**
 * The guest `sh -c` wrapper: records its process-group id and a start
 * sentinel, runs the argv, and removes both files after a zero exit.
 * @param token - the run's unique token.
 * @returns the script text.
 */
export function wrapperScript(token: string): string {
  const { pid, started } = tokenPaths(token)
  return `echo $$ > ${pid}; : > ${started}; "$@"; s=$?; if [ $s -eq 0 ]; then rm -f ${pid} ${started}; fi; exit $s`
}

/**
 * The `container exec` arguments that run the caller's argv in its own guest session.
 * @param args - the shim invocation.
 * @param run - the host working directory, environment file, TTY state, and run token.
 * @returns the arguments after the `container` executable.
 */
export function execArgs(args: ShimArgs, run: { cwd: string; envFile: string; tty: boolean; token: string }): string[] {
  return [
    'exec', '-i', ...run.tty ? ['-t'] : [], '-w', run.cwd, '--env-file', run.envFile, args.container,
    'setsid', '-w', 'sh', '-c', wrapperScript(run.token), 'sh', ...args.argv,
  ]
}

/**
 * The `container exec` arguments that deliver `signal` to the run's guest process group.
 * @param container - the container name.
 * @param token - the run's token.
 * @param signal - the host signal to deliver.
 * @returns the arguments after the `container` executable.
 */
export function killArgs(container: string, token: string, signal: NodeJS.Signals): string[] {
  return ['exec', container, 'sh', '-c', `kill -${signal.slice(3)} -$(cat ${tokenPaths(token).pid}) 2>/dev/null; true`]
}

/**
 * The `container exec` arguments that remove the run's token files and exit
 * zero only when the start sentinel existed.
 * @param container - the container name.
 * @param token - the run's token.
 * @returns the arguments after the `container` executable.
 */
export function settleArgs(container: string, token: string): string[] {
  const { pid, started } = tokenPaths(token)
  return ['exec', container, 'sh', '-c', `test -e ${started}; s=$?; rm -f ${pid} ${started}; exit $s`]
}

/** The child-process events the shim consumes. */
export interface ShimChild {
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

/** Process facilities the shim runs against; the entry binds them to Node. */
export interface ShimDeps {
  /** Unique token naming this run's guest files. */
  token: string
  /** Host working directory, used as the guest working directory. */
  cwd: string
  /** Host environment, filtered into the guest environment. */
  env: NodeJS.ProcessEnv
  /** Whether stdin is a terminal. */
  tty: boolean
  /** Spawn `container exec` with inherited stdio. */
  spawn(executable: string, args: readonly string[]): ShimChild
  /** Run a control command to completion and return its exit status. */
  run(executable: string, args: readonly string[]): Promise<number>
  /** Write a private environment file and return its path. */
  writeEnvFile(text: string): string
  /** Remove the environment file. */
  removeEnvFile(path: string): void
  /** Subscribe to termination signals; returns the unsubscribe function. */
  onSignal(handler: (signal: NodeJS.Signals) => void): () => void
  /** Write diagnostic text to stderr. */
  stderr(text: string): void
}

/** The exit status a shell reports for a process killed by `signal`. */
function signalExit(signal: NodeJS.Signals): number {
  return 128 + constants.signals[signal]
}

/**
 * Run the caller's argv in the guest and return the shim's exit status: the
 * command's status, `128 + n` after a forwarded or terminating signal, or
 * {@link SHIM_FAILURE_EXIT} when the runtime failed before the command started.
 * @param args - the decoded invocation.
 * @param deps - process facilities.
 * @returns the exit status.
 */
export async function runShim(args: ShimArgs, deps: ShimDeps): Promise<number> {
  const envFile = deps.writeEnvFile(envFileText(deps.env, args.denylist))
  let forwarded: NodeJS.Signals | undefined
  const unsubscribe = deps.onSignal((signal) => {
    forwarded ??= signal
    void deps.run(args.executable, killArgs(args.container, deps.token, signal))
  })
  try {
    const child = deps.spawn(args.executable, execArgs(args, { cwd: deps.cwd, envFile, tty: deps.tty, token: deps.token }))
    const exit = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { resolve(code ?? signalExit(signal as NodeJS.Signals)) })
    })
    if (exit === 0 && forwarded === undefined) return 0
    const started = await deps.run(args.executable, settleArgs(args.container, deps.token))
    if (forwarded !== undefined) return signalExit(forwarded)
    if (started === 0) return exit
    deps.stderr(`${SHIM_FAILURE_PREFIX}the container runtime failed before the command started (container exec exited ${exit})\n`)
    return SHIM_FAILURE_EXIT
  } catch (error: unknown) {
    // The only rejection is the child's `error` event, which carries an Error.
    deps.stderr(`${SHIM_FAILURE_PREFIX}${(error as Error).message}\n`)
    return SHIM_FAILURE_EXIT
  } finally {
    unsubscribe()
    deps.removeEnvFile(envFile)
  }
}
