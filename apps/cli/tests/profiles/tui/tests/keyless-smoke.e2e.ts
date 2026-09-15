/**
 * The shipped tui profile through the real `dsh` launcher: a keyless mock
 * model drives the production shell tool, the terminal renders the turn, the
 * session persists on quit, and `--resume` redraws it in a second process.
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
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const CTRL_D = '\u0004'

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

/**
 * Start the tui profile in `cwd`, wait until `marker` appears on stdout, then
 * send Ctrl+D on the empty editor so the app saves and exits.
 */
async function runUntil(cwd: string, args: readonly string[], marker: string): Promise<Run> {
  const launch = resolveExampleLaunch({
    srcBin: binScript,
    configArgs: ['--profile', 'tui', '--patch', configPath, ...args],
    tsconfigPath,
    sourceImport: 'tsx/esm',
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
  let seen = ''
  let sent = false
  child.stdout?.on('data', (chunk: Buffer) => {
    seen += chunk.toString()
    if (!sent && plain(seen).includes(marker)) {
      sent = true
      child.stdin?.write(CTRL_D)
    }
  })
  const result = await child
  const stdout = plain(streamText(result.stdout))
  const stderr = streamText(result.stderr)
  if (result.timedOut) {
    throw new Error(`tui smoke did not exit within ${String(PROCESS_TIMEOUT_MS / 1_000)}s. stdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  return { stdout, stderr, exitCode: result.exitCode }
}

describe('tui profile keyless smoke', () => {
  it('runs a tool turn in the terminal, saves the session on Ctrl+D, and resumes it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-smoke-'))
    try {
      const first = await runUntil(cwd, ['prove the tool path'], 'CLI tool round trip complete')
      expect(first.exitCode, `stderr:\n${first.stderr}\nstdout:\n${first.stdout}`).toBe(0)
      expect(first.stdout).toContain('› prove the tool path')
      expect(first.stdout).toContain('Inspecting the task before the tool call.')
      expect(first.stdout).toContain(process.platform === 'win32' ? 'pwsh' : 'bash')
      expect(first.stdout).toContain('CLI_TOOL_ROUND_TRIP')
      expect(first.stdout).toContain('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP')
      expect(first.stdout).toContain('cli-mock/cli-mock')
      const saved = /--resume (session-[\w-]+)/u.exec(first.stderr)
      expect(saved, first.stderr).not.toBeNull()
      const sessionId = saved![1]!

      const second = await runUntil(cwd, ['--resume', sessionId], 'CLI tool round trip complete')
      expect(second.exitCode, `stderr:\n${second.stderr}\nstdout:\n${second.stdout}`).toBe(0)
      expect(second.stdout).toContain(`session ${sessionId}`)
      expect(second.stdout).toContain('› prove the tool path')
      expect(second.stdout).toContain('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP')
      expect(second.stderr).toContain(`--resume ${sessionId}`)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)
})
