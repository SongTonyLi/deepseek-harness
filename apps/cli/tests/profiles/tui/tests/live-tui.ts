/**
 * A built tui profile process that a test drives by hand: it sends keys and
 * signals at moments the test chooses, waits on state it can observe (rendered
 * words, stderr lines, pid files the commands write), and on disposal kills the
 * process and every pid it recorded.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { plain } from './run-tui-script.ts'

const binScript = fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url))
const cliPatch = fileURLToPath(new URL('./fixtures/cli.patch.yml', import.meta.url))

/** How long one wait on observable state may take before it fails with what the process wrote so far. */
export const WAIT_MS = 30_000

/** How often a wait re-reads state that raises no event, such as a pid file or a process's liveness. */
const POLL_MS = 25

/** How the process ended and when the test saw it end. */
export interface Exit {
  /** Exit code; null when a signal ended the process. */
  readonly code: number | null
  /** The signal that ended the process, if one did. */
  readonly signal: NodeJS.Signals | null
  /** `Date.now()` when the exit was observed. */
  readonly at: number
}

/**
 * Whether a process exists. A zombie still counts until its parent reaps it.
 * @param pid - the process id.
 * @returns false once signalling the pid reports that no such process exists.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists under another owner; only ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Wait until a process no longer exists. A process killed with its parent is
 * reaped by init a moment after the parent exits, so this polls instead of
 * reading once.
 * @param pid - the process id.
 * @param timeoutMs - how long to wait.
 * @returns true when the process is gone, false when it still exists at the deadline.
 */
export async function gone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (alive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  return true
}

/**
 * Read a pid a command wrote to a file.
 * @param file - the pid file.
 * @returns the pid, or undefined while the file is missing or not yet written.
 */
async function readPid(file: string): Promise<number | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (_missing) {
    // The command has not written the file yet.
    return undefined
  }
  const pid = Number(text.trim())
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/** What one launch adds to the keyless tui profile. */
export interface LaunchOptions {
  /** Patch overlays applied after the keyless `cli.patch.yml`. */
  readonly patches?: readonly string[]
  /** Environment overrides for the mock model and the scenario. */
  readonly env?: NodeJS.ProcessEnv
}

/** One running tui profile process. */
export class LiveTui {
  private raw = ''
  private err = ''
  private ended: Exit | undefined
  private readonly recorded = new Set<number>()
  private readonly child: ReturnType<typeof spawn>
  /** Settles when the process exits; never rejects. */
  readonly exited: Promise<Exit>

  /**
   * Start the tui profile through the built launcher in `cwd`.
   * @param cwd - the isolated workspace the process and its commands run in.
   * @param options - extra overlays and environment.
   */
  constructor(readonly cwd: string, options: LaunchOptions = {}) {
    const launch = resolveExampleLaunch({
      srcBin: binScript,
      configArgs: ['--profile', 'tui', '--patch', cliPatch, ...(options.patches ?? []).flatMap(patch => ['--patch', patch])],
      mode: 'lib',
      env: {
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        DSH_TELEMETRY_DISABLED: '1',
        // The subject is quitting, not confinement: the commands run unconfined
        // so their pids are real host pids on every host.
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_CLI_MOCK_REVIEW_TRACE: join(cwd, '.auto-review-requests'),
        DSH_CLI_MOCK_REJECT_REVIEW_TEMPERATURE: '1',
        NO_COLOR: '1',
        COLUMNS: '120',
        LINES: '40',
        ...options.env,
      },
    })
    // The launch environment holds overrides only; a name it maps to undefined is left out of the child's.
    this.child = spawn(launch.command, launch.args, { cwd, env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.ended = { code, signal, at: Date.now() }
        resolve(this.ended)
      })
    })
    this.child.stdout?.on('data', (chunk: Buffer) => { this.raw += chunk.toString() })
    this.child.stderr?.on('data', (chunk: Buffer) => { this.err += chunk.toString() })
    // A write after the process exited fails with EPIPE; the exit is what the test reads.
    this.child.stdin?.on('error', () => {})
  }

  /** How much the terminal has been written so far, as an offset for {@link LiveTui.stdout}. */
  get written(): number {
    return this.raw.length
  }

  /**
   * The rendered words the terminal was written.
   * @param from - an offset {@link LiveTui.written} returned; omitted reads everything.
   * @returns the words with the terminal's own sequences dropped.
   */
  stdout(from = 0): string {
    return plain(this.raw.slice(from))
  }

  /** @returns everything written to stderr so far. */
  stderr(): string {
    return this.err
  }

  /**
   * The lines the launcher and the app wrote to stderr under the `dsh:` prefix, in order.
   * @returns those lines without their line ends.
   */
  dshLines(): string[] {
    return this.err.split('\n').map(line => line.trimEnd()).filter(line => line.startsWith('dsh: '))
  }

  /** @returns how the process ended, or undefined while it runs. */
  get exit(): Exit | undefined {
    return this.ended
  }

  /**
   * Type into the terminal.
   * @param keys - the bytes the keyboard would send.
   */
  send(keys: string): void {
    const stdin = this.child.stdin
    if (stdin !== null && stdin.writable) stdin.write(keys)
  }

  /**
   * Deliver a signal to the dsh process alone, not to its commands.
   * @param signal - the signal.
   */
  signal(signal: NodeJS.Signals): void {
    this.child.kill(signal)
  }

  /**
   * Wait until `holds` returns true, failing if the process exits first or the wait outlasts `timeoutMs`.
   * @param what - what the wait is for, named in the failure.
   * @param holds - the state check; it is re-run on every poll.
   * @param timeoutMs - the bound on the wait.
   */
  async until(what: string, holds: () => boolean | Promise<boolean>, timeoutMs = WAIT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await holds()) return
      if (this.ended !== undefined) throw new Error(`the process exited before ${what}\n${this.report()}`)
      if (Date.now() >= deadline) throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}\n${this.report()}`)
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
  }

  /**
   * Wait until the terminal shows `marker` after `from`.
   * @param marker - the rendered words.
   * @param from - an offset {@link LiveTui.written} returned.
   * @param timeoutMs - the bound on the wait.
   */
  async rendered(marker: string, from = 0, timeoutMs = WAIT_MS): Promise<void> {
    await this.until(`the terminal to show ${JSON.stringify(marker)}`, () => this.stdout(from).includes(marker), timeoutMs)
  }

  /**
   * Wait for a command to write its pid to `file`, and record the pid for disposal.
   * @param file - the pid file.
   * @returns the pid.
   */
  async pid(file: string): Promise<number> {
    let pid: number | undefined
    await this.until(`a pid in ${file}`, async () => (pid = await readPid(file)) !== undefined)
    this.recorded.add(pid!)
    return pid!
  }

  /**
   * Wait for the process to exit.
   * @param timeoutMs - the bound on the wait.
   * @returns how it ended.
   */
  async waitExit(timeoutMs = WAIT_MS): Promise<Exit> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { resolve('timeout') }, timeoutMs) })
    const result = await Promise.race([this.exited, timeout])
    clearTimeout(timer)
    if (result === 'timeout') throw new Error(`the process did not exit within ${String(timeoutMs)}ms\n${this.report()}`)
    return result
  }

  /**
   * Kill the process if it still runs and await its exit, then kill every
   * recorded pid that still exists and wait until it is gone. Safe to call
   * more than once.
   * @throws when a recorded pid still exists after SIGKILL and the wait.
   */
  async dispose(): Promise<void> {
    if (this.ended === undefined) {
      this.child.kill('SIGKILL')
      await this.exited
    }
    const stuck: number[] = []
    for (const pid of this.recorded) {
      if (!alive(pid)) continue
      try {
        process.kill(pid, 'SIGKILL')
      } catch (_raced) {
        // It exited between the liveness check and the kill.
      }
      if (!await gone(pid)) stuck.push(pid)
    }
    if (stuck.length > 0) throw new Error(`pids ${stuck.join(', ')} still exist after SIGKILL`)
  }

  /** @returns the tail of what the process wrote, for a failure message. */
  private report(): string {
    return `stdout tail:\n${this.stdout().slice(-2_000)}\nstderr:\n${this.err}`
  }
}
