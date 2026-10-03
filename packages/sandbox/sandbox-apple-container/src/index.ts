/**
 * Apple container sandbox backend. Registers as `ctx.sandbox` and routes each
 * confined call by its session's backend: `local` delegates to the inherited
 * local platform chain, while `container` runs the argv through an exec shim
 * inside a Linux container VM that bind-mounts the workspace at its own
 * absolute path (read-only under `read-only`). Host file effects stay inside
 * the workspace, and the guest cannot read unmounted host paths.
 *
 * Each session's backend is the last `sandbox/backend` event in its log,
 * otherwise the configured default; the shared `/sandbox` command reports and
 * switches it. Before each request, a `sandbox:backend` runtime-context
 * contribution tells the model when its confined commands run in the container.
 * @module @deepseek-ai/dsh-sandbox-apple-container
 */

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { SandboxUnavailableError, canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, RunnerFailureRule, SandboxExecutionPolicy, SandboxPolicy, SandboxReadScope } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-sandbox-local'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { ContainerPool } from './pool.ts'
import { ContainerRuntime } from './runtime.ts'
import { containerSupported, resolveBackend } from './host.ts'
import type { ConfiguredBackend } from './host.ts'
import { isSandboxBackend, setSandboxBackend } from './session-backend.ts'
import type { SandboxBackend } from './session-backend.ts'
import { SHIM_FAILURE_EXIT, SHIM_FAILURE_PREFIX, encodeShimArgs } from './shim.ts'

export { SANDBOX_BACKENDS, isSandboxBackend, setSandboxBackend } from './session-backend.ts'
export type { SandboxBackend } from './session-backend.ts'
export { containerSupported, executableResolves, resolveBackend } from './host.ts'
export type { ConfiguredBackend, HostFacts } from './host.ts'

/**
 * Environment names the shim withholds from the guest by default: host-specific
 * paths and session plumbing, plus every credential-shaped name, even one a
 * composition passes deliberately.
 */
export const DEFAULT_ENV_DENYLIST: readonly string[] = [
  'PATH', 'HOME', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'SHLVL', 'SSH_AUTH_SOCK',
  '__CF*', 'XPC_*', 'DYLD_*', 'TERM_PROGRAM*',
  '*KEY*', '*TOKEN*', '*SECRET*', '*PASSWORD*', '*PASSWD*', '*CREDENTIAL*', '*COOKIE*', '*PRIVATE*', 'AWS_*',
]

/** File names hidden from confined commands and host file tools by default: environment files, private keys, and credential stores. */
export const DEFAULT_HIDDEN_FILES: readonly string[] = [
  '.env', '.env.*', '.envrc', '*.pem', '*.key', '*.p12', '*.pfx',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
]

/** Stderr text of a write the read-only workspace mount refused. */
const CONTAINER_DENIAL_SIGNATURES: readonly string[] = ['read-only file system']

/** The shim's own failure line, emitted only when the command never started. */
const CONTAINER_RUNNER_FAILURE_RULES: readonly RunnerFailureRule[] = [
  { allowedExitCodes: [SHIM_FAILURE_EXIT], fatalSignatures: [SHIM_FAILURE_PREFIX] },
]

/** Plugin config: the local chain's fields plus the container backend's. */
export interface Config extends LocalConfig {
  /**
   * Backend for sessions without a recorded `/sandbox` choice and for agentless
   * calls. `auto` selects `container` on macOS on Apple silicon when the
   * `container` CLI resolves, and `local` elsewhere (default: `auto`).
   */
  backend?: ConfiguredBackend
  /** The Apple `container` CLI, resolved on `PATH` when bare (default: `container`). */
  executable?: string
  /** OCI image every owned container runs; it must provide `sh` and util-linux `setsid` (default: `node:22-bookworm`). */
  image?: string
  /** CPUs per container; unset uses the `container` system default. */
  cpus?: number
  /** Memory per container in `container` size syntax such as `4g`; unset uses the system default. */
  memory?: string
  /** Start the `container` API server once when it is stopped (default: true). */
  autoStart?: boolean
  /** Minimum milliseconds between liveness checks of a cached container (default: 10000). */
  recheckMs?: number
  /** Environment name globs not forwarded to the guest; `*` matches any run, case-insensitively (default: {@link DEFAULT_ENV_DENYLIST}). */
  envDenylist?: string[]
  /** Absolute host directories mounted read-only at their own paths and readable by file tools, such as skill roots (default: none). */
  readOnlyMounts?: string[]
  /** Workspace-relative directories kept read-only under `workspace-write`; host programs execute their contents (default: `['.git']`). */
  protectedPaths?: string[]
  /** File-name globs hidden from confined commands and host file tools (default: {@link DEFAULT_HIDDEN_FILES}). */
  hiddenFiles?: string[]
  /** Directory depth of the workspace scan that masks hidden files when a container starts (default: 8). */
  hiddenFilesMaxDepth?: number
  /** Directory names the hidden-file scan does not enter (default: `['node_modules', '.git']`). */
  hiddenFilesSkipDirs?: string[]
}

/** The sandbox-backend projection's state schema. */
const sandboxBackendStateSchema = zod.union([zod.literal('container'), zod.literal('local')]).nullable()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last logged sandbox-backend switch, or null before one (the configured default applies). */
    sandboxBackend: zod.infer<typeof sandboxBackendStateSchema>
  }
}

/**
 * The exec-shim launch prefix for a provider module at `moduleUrl`: the built
 * sibling `exec-shim.js` under plain Node when present, otherwise the source
 * entry through tsx pinned to this checkout's TypeScript paths.
 * @param moduleUrl - the provider module's `import.meta.url`.
 * @returns `[node, ...loader, entry]`.
 */
export function shimInvocation(moduleUrl: string): string[] {
  const built = fileURLToPath(new URL('./exec-shim.js', moduleUrl))
  if (existsSync(built)) return [process.execPath, built]
  const source = fileURLToPath(new URL('./exec-shim.ts', moduleUrl))
  const tsconfig = fileURLToPath(new URL('../../../../tsconfig.base.json', moduleUrl))
  const registration = `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register({ tsconfig: ${JSON.stringify(tsconfig)} });`
  return [process.execPath, '--import', `data:text/javascript,${encodeURIComponent(registration)}`, source]
}

/** Whether `pid` names a live process; a permission refusal still proves existence. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The message of a rejection from the pool or runtime, which reject only with `Error`. */
function messageOf(error: unknown): string {
  return (error as Error).message
}

/**
 * Container-backed process-sandbox provider (`ctx.sandbox`). Owns one
 * container per confined mode and workspace and deletes them when disposed;
 * containers left by dead DSH processes are deleted at load.
 */
export class AppleContainerSandboxProvider extends LocalSandboxProvider {
  // Inline schema call: the config catalog walks `static Config` statically.
  static override Config: z<Config> = z.intersect([LocalSandboxProvider.Config, z.object({
    backend: z.union(['auto', 'container', 'local'] as const).default('auto'),
    executable: z.string().default('container'),
    image: z.string().default('node:22-bookworm'),
    cpus: z.natural(),
    memory: z.string(),
    autoStart: z.boolean().default(true),
    recheckMs: z.natural().default(10_000),
    envDenylist: z.array(z.string()).default([...DEFAULT_ENV_DENYLIST]),
    readOnlyMounts: z.array(z.string()).default([]),
    protectedPaths: z.array(z.string()).default(['.git']),
    hiddenFiles: z.array(z.string()).default([...DEFAULT_HIDDEN_FILES]),
    hiddenFilesMaxDepth: z.natural().default(8),
    hiddenFilesSkipDirs: z.array(z.string()).default(['node_modules', '.git']),
  })])

  static inject = ['sessions', 'sessionProjections']

  /** The backend for sessions without a recorded choice, after `auto` resolution. */
  readonly defaultBackend: SandboxBackend
  /** Whether this host can run the container backend. */
  readonly containerSupported: boolean
  private readonly executable: string
  private readonly image: string
  private readonly envDenylist: readonly string[]
  private readonly readOnlyMounts: readonly string[]
  private readonly hiddenFiles: readonly string[]
  private readonly runtime: ContainerRuntime
  private readonly pool: ContainerPool

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // The schema defaults these fields; the casts record that runtime fact.
    this.executable = config.executable as string
    const host = { platform: process.platform, arch: process.arch, path: process.env.PATH }
    this.containerSupported = containerSupported(this.executable, host)
    this.defaultBackend = resolveBackend(config.backend as ConfiguredBackend, this.containerSupported)
    this.image = config.image as string
    this.envDenylist = config.envDenylist as string[]
    if (this.envDenylist.some(entry => entry === '' || entry.includes(','))) {
      throw new Error('sandbox-apple-container: envDenylist entries must be non-empty and contain no comma')
    }
    if (config.cpus === 0) throw new Error('sandbox-apple-container: cpus must be positive')
    this.readOnlyMounts = config.readOnlyMounts as string[]
    if (this.readOnlyMounts.some(path => !isAbsolute(path) || path.includes(','))) {
      throw new Error('sandbox-apple-container: readOnlyMounts entries must be absolute paths without a comma')
    }
    const protectedPaths = config.protectedPaths as string[]
    if (protectedPaths.some(path => path === '' || isAbsolute(path) || path.includes(',') || path.split(/[\\/]/u).includes('..'))) {
      throw new Error('sandbox-apple-container: protectedPaths entries must be workspace-relative paths without `..` or a comma')
    }
    this.hiddenFiles = config.hiddenFiles as string[]
    this.runtime = new ContainerRuntime({
      executable: this.executable,
      image: this.image,
      autoStart: config.autoStart as boolean,
      ...config.cpus === undefined ? {} : { cpus: config.cpus },
      ...config.memory === undefined ? {} : { memory: config.memory },
    })
    this.pool = new ContainerPool(this.runtime, {
      pid: process.pid,
      recheckMs: config.recheckMs as number,
      now: Date.now,
      protectedPaths,
      readOnlyMounts: this.readOnlyMounts,
      hidden: { names: this.hiddenFiles, maxDepth: config.hiddenFilesMaxDepth as number, skipDirs: config.hiddenFilesSkipDirs as string[] },
    })

    ctx.sessionProjections.register({
      key: 'sandboxBackend',
      stateVersion: 1,
      stateSchema: sandboxBackendStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/backend' ? event.data.backend : state),
    })

    ctx.effect(() => () => this.pool.dispose())

    if (this.defaultBackend === 'container') {
      this.pool.sweep(processAlive).catch((error: unknown) => {
        ctx.logger.warn(`sandbox-apple-container: removing stale containers failed: ${messageOf(error)}`)
      })
    }

    ctx.inject(['sandboxPolicy'], (policyCtx) => {
      const mode = policyCtx.sandboxPolicy.defaultMode
      if (this.defaultBackend !== 'container' || mode === 'danger-full-access') return
      this.pool.ensure({ mode, workspaceRoot: policyCtx.sandboxPolicy.workspaceRoot }).catch((error: unknown) => {
        ctx.logger.warn(`sandbox-apple-container: starting the ${mode} container failed: ${messageOf(error)}`)
      })
    })

    ctx.inject(['systemPrompt', 'sandboxPolicy'], (scope) => {
      scope.systemPrompt.context({
        name: 'sandbox:backend',
        order: scope.systemPrompt.getContextOrder('SANDBOX_BACKEND'),
        text: (context) => {
          const session = context.agent?.session
          if (session === undefined || this.backendFor(session) !== 'container') return ''
          const policy = scope.sandboxPolicy.resolve({ session })
          if (policy.mode === 'danger-full-access') return ''
          return `Commands confined by the DSH file sandbox run inside a Linux container from image ${JSON.stringify(this.image)}. `
            + `Only the session workspace ${JSON.stringify(policy.workspaceRoot)} is shared with the host; `
            + 'files written elsewhere stay inside the container and are not visible to file tools. '
            + 'File tools ask the user before reading a host path outside the workspace; secret files such as `.env` and private keys stay hidden from commands and file tools.'
        },
      })
    })

    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: CommandDefinitionId('@deepseek-ai/dsh-sandbox-apple-container'),
        name: 'sandbox',
        description: 'Show or switch where confined commands run (/sandbox container, /sandbox local)',
        input: { hint: '<container|local>' },
        handler: async ({ agent, rawInput }) => {
          const backend = rawInput.trim()
          if (backend === '') return { kind: 'success', text: await this.describe(agent.session) }
          if (!isSandboxBackend(backend)) {
            return { kind: 'error', text: `unknown backend "${backend}" (available: container, local)` }
          }
          if (backend === 'container' && !this.containerSupported) {
            return { kind: 'error', text: `Apple container is unavailable on this host: it needs macOS on Apple silicon with ${JSON.stringify(this.executable)} installed` }
          }
          setSandboxBackend(agent.session, backend)
          return {
            kind: 'success',
            text: backend === 'container' ? `backend container (image ${this.image})` : 'backend local',
          }
        },
      })
    })
  }

  /**
   * Wrap `argv` for `policy` on its session's backend: the inherited local
   * chain for `local`, or the exec shim against this workspace and mode's
   * container for `container`.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @param signal - cancellation before the container is ready.
   * @returns the confined argv with full enforcement, the read-only-mount
   *   denial dialect, and the shim's runner-failure rule; throws
   *   `SANDBOX_UNAVAILABLE` when the container cannot be started.
   */
  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    if (this.policyBackend(policy) === 'local') return super.confine(argv, policy, signal)
    signal?.throwIfAborted()
    let container: string
    try {
      container = await this.pool.ensure(policy)
    } catch (error: unknown) {
      throw new SandboxUnavailableError(policy.mode, `${messageOf(error)}; run /sandbox local to confine commands on this host instead`)
    }
    signal?.throwIfAborted()
    return {
      argv: [
        ...shimInvocation(import.meta.url),
        ...encodeShimArgs({ executable: this.executable, container, denylist: this.envDenylist, argv }),
      ],
      enforcement: 'full',
      denialSignatures: CONTAINER_DENIAL_SIGNATURES,
      runnerFailureRules: CONTAINER_RUNNER_FAILURE_RULES,
    }
  }

  /**
   * The host read scope of a container-backed confined policy: the workspace
   * (canonical and as spelled) and the extra read-only mounts, minus the
   * hidden files. The local backend and `danger-full-access` confine no reads.
   * @param policy - the calling session's resolved policy.
   * @returns the scope, or `undefined` when reads are unconfined.
   */
  override readScope(policy: SandboxExecutionPolicy): SandboxReadScope | undefined {
    if (policy.mode === 'danger-full-access' || this.policyBackend(policy) === 'local') return undefined
    return {
      roots: [...new Set([policy.workspaceRoot, canonicalPath(policy.workspaceRoot), ...this.readOnlyMounts])],
      hiddenNames: this.hiddenFiles,
    }
  }

  /** The backend of the session a policy names; agentless and unknown sessions use the default. */
  private policyBackend(policy: SandboxExecutionPolicy): SandboxBackend {
    return this.backendFor(policy.sessionId === undefined ? undefined : this.ctx.sessions.get(policy.sessionId))
  }

  /**
   * The backend a session's confined calls use.
   * @param session - the calling session, or undefined for agentless calls.
   * @returns the session's last recorded choice, else the configured default.
   */
  backendFor(session: Session | undefined): SandboxBackend {
    return (session === undefined ? undefined : this.ctx.sessionProjections.stateOf(session, 'sandboxBackend')) ?? this.defaultBackend
  }

  /** The `/sandbox` status line for `session`. */
  private async describe(session: Session): Promise<string> {
    if (this.backendFor(session) === 'local') {
      return 'backend local: confined commands run on this host under the local sandbox (/sandbox container switches)'
    }
    const containers = await Promise.all(this.pool.entries().map(async (entry) => {
      const state = await this.runtime.state(entry.name).catch((error: unknown) => `unknown (${messageOf(error)})`)
      return `${entry.mode} ${entry.name} ${state} at ${entry.root}`
    }))
    return `backend container: image ${this.image}; ${containers.length === 0 ? 'no container started yet' : containers.join(', ')} (/sandbox local switches)`
  }
}

export default AppleContainerSandboxProvider
