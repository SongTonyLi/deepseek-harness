/** Marker-driven keyboard controller for built TUI profile tests. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const PROCESS_TIMEOUT_MS = 60_000
const binScript = fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url))
const CTRL_D = '\u0004'

/**
 * How long one step waits for its own marker before the run quits anyway. It
 * is re-armed whenever a step advances, so a slow launch or a slow turn costs
 * the following steps nothing; only a marker that never arrives spends it. The
 * assertions then report which step the terminal did not reach, instead of the
 * process timeout reporting nothing.
 */
const STEP_TIMEOUT_MS = 30_000

/**
 * Drop CSI, OSC, and APC sequences so assertions read the rendered words.
 * @param output - what the terminal was written.
 * @returns the rendered words.
 */
export function plain(output: string): string {
  return output
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b_[^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
}

/** The captured text of one execa stream; other capture forms are not configured here. */
function streamText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Captured output and exit status from one scripted TUI process. */
export interface Run {
  /** Rendered words, with the terminal's own sequences dropped. */
  stdout: string
  /** Everything the terminal was written, sequences included. */
  raw: string
  stderr: string
  exitCode: number | undefined
}

/** One scripted step: wait for `marker` on stdout, then send `keys`. */
export interface Step {
  /** The rendered words the step waits for, searched after the previous step's own. */
  marker: string
  /**
   * The bytes to send once it appears; empty waits for the marker alone. A
   * function reads them from everything written so far, sequences included,
   * for input that depends on where something was drawn, such as a click.
   */
  keys: string | ((raw: string) => string)
}

/**
 * Start the tui profile in `cwd`, drive the scripted keys as each step's
 * marker is rendered, and send Ctrl+D on the empty editor so the app saves and
 * exits.
 * @param cwd - Isolated subprocess workspace.
 * @param args - Additional CLI arguments.
 * @param steps - Rendered markers and keyboard input.
 * @param patchPath - Test composition patch.
 * @param env - Scenario environment overrides.
 * @returns Captured terminal output and process status.
 */
export async function runTuiScript(
  cwd: string, args: readonly string[], steps: readonly Step[], patchPath: string, env: NodeJS.ProcessEnv = {},
): Promise<Run> {
  const launch = resolveExampleLaunch({
    srcBin: binScript,
    configArgs: ['--profile', 'tui', '--patch', patchPath, ...args],
    mode: 'lib',
    env: {
      DSH_HOME: join(cwd, '.dsh'),
      DSH_AGENTS_HOME: join(cwd, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      // The subject is the terminal surface, not the sandbox: run the mock's
      // shell command unconfined so the round trip completes on hosts without
      // a usable sandbox backend.
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_CLI_MOCK_REVIEW_TRACE: join(cwd, '.auto-review-requests'),
      DSH_CLI_MOCK_REJECT_REVIEW_TEMPERATURE: '1',
      NO_COLOR: '1',
      COLUMNS: '120',
      LINES: '40',
      ...env,
    },
  })
  const child = execa(launch.command, launch.args, {
    cwd,
    env: launch.env,
    stdin: 'pipe',
    timeout: PROCESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    reject: false,
    stripFinalNewline: false,
  })
  const send = (keys: string): void => {
    const stdin = child.stdin
    if (stdin !== undefined && stdin.writable) stdin.write(keys)
  }
  let quit = false
  let deadline: NodeJS.Timeout | undefined
  const finish = (): void => {
    if (deadline !== undefined) clearTimeout(deadline)
    deadline = undefined
    if (quit) return
    quit = true
    send(CTRL_D)
  }
  /** Give the step that is now waiting its own window, replacing the previous one's. */
  const armStep = (): void => {
    if (deadline !== undefined) clearTimeout(deadline)
    deadline = setTimeout(finish, STEP_TIMEOUT_MS)
    deadline.unref()
  }
  armStep()
  let seen = ''
  let step = 0
  let from = 0
  child.stdout?.on('data', (chunk: Buffer) => {
    seen += chunk.toString()
    const text = plain(seen)
    while (step < steps.length) {
      const next = steps[step] as Step
      const at = text.indexOf(next.marker, from)
      if (at < 0) return
      from = at + next.marker.length
      step += 1
      send(typeof next.keys === 'string' ? next.keys : next.keys(seen))
      armStep()
    }
    finish()
  })
  try {
    const result = await child
    const raw = streamText(result.stdout)
    const stdout = plain(raw)
    const stderr = streamText(result.stderr)
    if (result.timedOut) {
      throw new Error(`tui smoke did not exit within ${String(PROCESS_TIMEOUT_MS / 1_000)}s. stdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    return { stdout, raw, stderr, exitCode: result.exitCode }
  } finally {
    if (deadline !== undefined) clearTimeout(deadline)
  }
}
