/**
 * The shipped tui profile through the real `dsh` launcher: a keyless mock
 * model drives the production shell tool, the terminal renders the turn, the
 * keyboard walks it and reads it full screen, the session persists on quit,
 * and `--resume` redraws it in a second process.
 *
 * The launch is pinned to the built `lib` bundles. In `src` mode the launcher
 * loads the profile's rows through its installation route (built `lib/`) while
 * tsx maps the imports inside them to `src/`, so the tui composition ends up
 * with two copies of `@deepseek-ai/dsh-tools` and the agent loop's scheduler
 * symbol misses the tools instance; the shipped profile is a built artifact.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const PROCESS_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = PROCESS_TIMEOUT_MS * 2 + 15_000
const binScript = fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cli.patch.yml', import.meta.url))
const CTRL_D = '\u0004'
const CTRL_G = '\u0007'
const SHIFT_UP = '\u001b[1;2A'
const ESCAPE = '\u001b'

/**
 * How long one step waits for its own marker before the run quits anyway. It
 * is re-armed whenever a step advances, so a slow launch or a slow turn costs
 * the following steps nothing; only a marker that never arrives spends it. The
 * assertions then report which step the terminal did not reach, instead of the
 * process timeout reporting nothing.
 */
const STEP_TIMEOUT_MS = 30_000

/** Drop CSI, OSC, and APC sequences so assertions read the rendered words. */
function plain(output: string): string {
  return output
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b_[^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
}

/** The captured text of one execa stream; other capture forms are not configured here. */
function streamText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

interface Run {
  stdout: string
  stderr: string
  exitCode: number | undefined
}

/** One scripted step: wait for `marker` on stdout, then send `keys`. */
interface Step {
  /** The rendered words the step waits for, searched after the previous step's own. */
  marker: string
  /** The bytes to send once it appears; empty waits for the marker alone. */
  keys: string
}

/**
 * Start the tui profile in `cwd`, drive the scripted keys as each step's
 * marker is rendered, and send Ctrl+D on the empty editor so the app saves and
 * exits.
 */
async function runScript(cwd: string, args: readonly string[], steps: readonly Step[]): Promise<Run> {
  const launch = resolveExampleLaunch({
    srcBin: binScript,
    configArgs: ['--profile', 'tui', '--patch', configPath, ...args],
    mode: 'lib',
    env: {
      DSH_HOME: join(cwd, '.dsh'),
      DSH_AGENTS_HOME: join(cwd, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      // The subject is the terminal surface, not the sandbox: run the mock's
      // shell command unconfined so the round trip completes on hosts without
      // a usable sandbox backend.
      DSH_PERMISSION_MODE: 'danger-full-access',
      NO_COLOR: '1',
      COLUMNS: '120',
      LINES: '40',
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
      send(next.keys)
      armStep()
    }
    finish()
  })
  try {
    const result = await child
    const stdout = plain(streamText(result.stdout))
    const stderr = streamText(result.stderr)
    if (result.timedOut) {
      throw new Error(`tui smoke did not exit within ${String(PROCESS_TIMEOUT_MS / 1_000)}s. stdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    return { stdout, stderr, exitCode: result.exitCode }
  } finally {
    if (deadline !== undefined) clearTimeout(deadline)
  }
}

describe('tui profile keyless smoke', () => {
  it('runs a tool turn in the terminal, walks and reads it, saves the session on Ctrl+D, and resumes it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-smoke-'))
    try {
      // The keyboard enters the conversation on the newest section, reads it
      // full screen, and comes back before the session is saved.
      const first = await runScript(cwd, ['prove the tool path'], [
        { marker: 'CLI tool round trip complete', keys: SHIFT_UP },
        { marker: ' ● READ ', keys: CTRL_G },
        { marker: ' ● READER ', keys: ESCAPE },
        { marker: ' ● READ ', keys: '' },
      ])
      expect(first.exitCode, `stderr:\n${first.stderr}\nstdout:\n${first.stdout}`).toBe(0)
      expect(first.stdout).toContain('› prove the tool path')
      expect(first.stdout).toContain('Inspecting the task before the tool call.')
      expect(first.stdout).toContain(process.platform === 'win32' ? 'pwsh' : 'bash')
      expect(first.stdout).toContain('CLI_TOOL_ROUND_TRIP')
      expect(first.stdout).toContain('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP')
      expect(first.stdout).toContain('cli-mock/cli-mock')
      // Read mode is docked chrome with its own legend; the reader is the
      // full-screen overlay over the same conversation.
      expect(first.stdout).toContain(' ● READ ')
      expect(first.stdout).toContain('Esc input')
      expect(first.stdout).toContain(' ● READER ')
      // It opened on the section the walk held, so the turn panel owns the
      // keyboard and the readout states how far into that turn the reading is.
      expect(first.stdout).toContain('↑↓ scrolls · PgUp PgDn pages · ← turns · Esc closes')
      expect(first.stdout).toMatch(/turn \d+\/\d+ · row \d+\/\d+/u)
      // The reader closed back onto the section it was opened from.
      const reader = first.stdout.indexOf(' ● READER ')
      expect(first.stdout.indexOf(' ● READ ', reader)).toBeGreaterThan(reader)
      const saved = /--resume (session-[\w-]+)/u.exec(first.stderr)
      expect(saved, first.stderr).not.toBeNull()
      const sessionId = saved![1]!

      const second = await runScript(cwd, ['--resume', sessionId], [
        { marker: 'CLI tool round trip complete', keys: '' },
      ])
      expect(second.exitCode, `stderr:\n${second.stderr}\nstdout:\n${second.stdout}`).toBe(0)
      // The resumed header carries the generated title with the id; the
      // unfocused footer keeps the model id on its one key-facts line.
      expect(second.stdout).toContain(`prove the tool path (${sessionId})`)
      expect(second.stdout).toContain('cli-mock/cli-mock')
      expect(second.stdout).toContain('› prove the tool path')
      expect(second.stdout).toContain('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP')
      expect(second.stderr).toContain(`--resume ${sessionId}`)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)
})
