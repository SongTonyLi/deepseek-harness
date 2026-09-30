/**
 * The shipped tui profile through the real `dsh` launcher: a keyless mock
 * model drives the production shell tool, the terminal renders the turn, the
 * keyboard walks it and reads it full screen, the session persists on quit,
 * and both the session picker and `--resume` redraw it in fresh processes.
 *
 * The launch is pinned to the built `lib` bundles. In `src` mode the launcher
 * loads the profile's rows through its installation route (built `lib/`) while
 * tsx maps the imports inside them to `src/`, so the tui composition ends up
 * with two copies of `@deepseek-ai/dsh-tools` and the agent loop's scheduler
 * symbol misses the tools instance; the shipped profile is a built artifact.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runTuiScript, type Run, type Step } from './run-tui-script.ts'

const PROCESS_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = PROCESS_TIMEOUT_MS * 3 + 15_000
const configPath = fileURLToPath(new URL('./fixtures/cli.patch.yml', import.meta.url))
const ENTER = '\r'
const CTRL_G = '\u0007'
const CTRL_P = '\u0010'
const DOWN = '\u001b[B'
const SHIFT_TAB = '\u001b[Z'
const SHIFT_UP = '\u001b[1;2A'
const SHIFT_LEFT = '\u001b[1;2D'
const SHIFT_RIGHT = '\u001b[1;2C'
const ESCAPE = '\u001b'

function runScript(cwd: string, args: readonly string[], steps: readonly Step[]): Promise<Run> {
  return runTuiScript(cwd, args, steps, configPath)
}

describe('tui profile keyless smoke', () => {
  it('edits a prompt, picks an effort, reads the turn, and resumes it through both paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-smoke-'))
    try {
      // The `!` inserted after Shift+Right distinguishes an end-of-word jump
      // from an ignored key before the mock turn gates the remaining keys.
      const first = await runScript(cwd, [], [
        {
          marker: 'cli-mock/cli-mock',
          keys: `I want to do${SHIFT_LEFT}quickly ${SHIFT_RIGHT}!${ENTER}`,
        },
        { marker: 'CLI tool round trip complete', keys: SHIFT_TAB },
        { marker: 'Reasoning effort · cli-mock/cli-mock', keys: `${DOWN}${ENTER}` },
        { marker: 'effort off from the next request', keys: SHIFT_UP },
        { marker: ' ● READ ', keys: CTRL_G },
        // Closing restores the conversation's own screen rather than drawing
        // it again, so the step that follows walks a section: what the
        // terminal writes next is the conversation answering a key.
        { marker: ' ● READER ', keys: `${ESCAPE}${SHIFT_UP}` },
        { marker: ' ● READ ', keys: '' },
      ])
      expect(first.exitCode, `stderr:\n${first.stderr}\nstdout:\n${first.stdout}`).toBe(0)
      expect(first.stdout).toContain('❯ I want to quickly do!')
      expect(first.stdout).toContain('Inspecting the task before the tool call.')
      expect(first.stdout).toContain(process.platform === 'win32' ? 'pwsh' : 'bash')
      expect(first.stdout).toContain('CLI_TOOL_ROUND_TRIP')
      expect(first.stdout).toContain('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP')
      expect(first.stdout).toContain('cli-mock/cli-mock')
      expect(first.stdout).toContain('Reasoning effort · cli-mock/cli-mock')
      expect(first.stdout).toContain('effort off from the next request')
      // Read mode is docked chrome with its own legend; the reader is the
      // full-screen surface that takes the terminal from the conversation.
      expect(first.stdout).toContain(' ● READ ')
      expect(first.stdout).toContain('Esc input')
      expect(first.stdout).toContain(' ● READER ')
      // It opened on the section the walk held, so the turn panel owns the
      // keyboard and the readout states how far into that turn the reading is.
      // The legend takes the widest of its steps the width holds.
      expect(first.stdout).toMatch(/↑↓ (jk )?scrolls · PgUp PgDn (Space b )?pages · /u)
      expect(first.stdout).toMatch(/turn \d+\/\d+ · row \d+\/\d+/u)
      // The reader runs on the terminal's alternate screen: it switches away
      // from the conversation and back, and never writes a row of itself onto
      // the conversation's own screen.
      const takes = first.raw.indexOf('\u001b[?1049h')
      expect(takes).toBeGreaterThan(-1)
      expect(first.raw.indexOf('\u001b[?1049l', takes)).toBeGreaterThan(takes)
      // The conversation is underneath it, answering the walk again.
      const reader = first.stdout.indexOf(' ● READER ')
      expect(first.stdout.indexOf(' ● READ ', reader)).toBeGreaterThan(reader)
      const saved = /--resume (session-[\w-]+)/u.exec(first.stderr)
      expect(saved, first.stderr).not.toBeNull()
      const sessionId = saved![1]!

      const viaPicker = await runScript(cwd, [], [
        { marker: 'cli-mock/cli-mock', keys: `/resume${ENTER}` },
        { marker: 'Switch to a session', keys: `${DOWN}${ENTER}` },
        { marker: `resumed: session ${sessionId}`, keys: '' },
      ])
      expect(viaPicker.exitCode, `stderr:\n${viaPicker.stderr}\nstdout:\n${viaPicker.stdout}`).toBe(0)
      expect(viaPicker.stdout).toContain('Switch to a session')
      expect(viaPicker.stdout).toContain(`resumed: session ${sessionId}`)
      expect(viaPicker.stdout).toContain('❯ I want to quickly do!')
      expect(viaPicker.stdout).toContain('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP')

      const explicitResume = await runScript(cwd, ['--resume', sessionId], [
        { marker: 'CLI tool round trip complete', keys: `again${ENTER}` },
        { marker: '❯ again', keys: '' },
        // The follow-up turn must assemble under the restored model.
        { marker: 'CLI tool round trip complete: CLI_TOOL_ROUND_TRIP', keys: '' },
      ])
      expect(explicitResume.exitCode, `stderr:\n${explicitResume.stderr}\nstdout:\n${explicitResume.stdout}`).toBe(0)
      // The resumed header carries the generated title with the id; the
      // unfocused footer keeps the model id on its one key-facts line.
      expect(explicitResume.stdout).toContain(`I want to quickly do! (${sessionId})`)
      expect(explicitResume.stdout).toContain('cli-mock/cli-mock')
      expect(explicitResume.stdout).toContain('❯ I want to quickly do!')
      expect(explicitResume.stdout).toContain('❯ again')
      expect(explicitResume.stdout).not.toContain('{{model}}')
      expect(explicitResume.stdout).toContain('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP')
      expect(explicitResume.stderr).toContain(`--resume ${sessionId}`)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)

  it('executes a reviewed shell call when the provider rejects temperature', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-auto-review-'))
    try {
      const run = await runScript(cwd, [], [
        { marker: 'cli-mock/cli-mock', keys: `/permission auto${ENTER}` },
        { marker: '/permission: preset auto', keys: `auto-approved tool${ENTER}` },
        { marker: 'CLI tool round trip complete: CLI_TOOL_ROUND_TRIP', keys: '' },
      ])
      expect(run.exitCode, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`).toBe(0)
      expect(run.stdout).toContain('❯ auto-approved tool')
      expect(run.stdout).toContain('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP')
      expect(await readFile(join(cwd, '.auto-review-requests'), 'utf8')).toBe('reviewed\n')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)

  it('compacts on /compact, accounts for what it compressed and preserved, and redraws that account on resume', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-compact-'))
    try {
      const run = await runScript(cwd, [], [
        { marker: 'cli-mock/cli-mock', keys: `first ask${ENTER}` },
        { marker: 'CLI tool round trip complete', keys: `second ask${ENTER}` },
        { marker: '❯ second ask', keys: '' },
        { marker: 'CLI tool round trip complete', keys: `/compact${ENTER}` },
        // The summary is folded under the account, so its first row is the last one drawn.
        { marker: 'CLI_COMPACTION_SUMMARY', keys: '' },
      ])
      expect(run.exitCode, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`).toBe(0)
      const at = run.stdout.indexOf('context compacted by /compact')
      expect(at, run.stdout).toBeGreaterThan(-1)
      const block = run.stdout.slice(at)
      // The token meter prices both sides of the replacement.
      expect(block).toMatch(/context compacted by \/compact · ~[\d.]+k? → ~[\d.]+k? tokens/u)
      expect(block).toMatch(/compressed\s+\d+ items from turns 1–2/u)
      expect(block).toContain('❯ first ask')
      expect(block).toContain('❯ second ask')
      expect(block).toMatch(/preserved\s+system prompt\s+turn 2 · 1 reply/u)
      expect(block).toContain('summary · cli-mock')
      // The checkpoint's framing and the command's own result text are not drawn beside the block.
      expect(run.stdout).not.toContain('compact-checkpoint')
      expect(run.stdout).not.toContain('Compacted ')
      const saved = /--resume (session-[\w-]+)/u.exec(run.stderr)
      expect(saved, run.stderr).not.toBeNull()
      const sessionId = saved![1]!

      const resumed = await runScript(cwd, ['--resume', sessionId], [
        { marker: 'CLI_COMPACTION_SUMMARY', keys: '' },
      ])
      expect(resumed.exitCode, `stderr:\n${resumed.stderr}\nstdout:\n${resumed.stdout}`).toBe(0)
      expect(resumed.stdout).toMatch(/context compacted by \/compact · ~[\d.]+k? → ~[\d.]+k? tokens/u)
      expect(resumed.stdout).toContain('turn 2 · 1 reply')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)

  it('runs the shell call of a read-only /btw side agent beside the session and leaves the session log alone', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-btw-'))
    try {
      const run = await runScript(cwd, [], [
        { marker: 'cli-mock/cli-mock', keys: `first${ENTER}` },
        { marker: 'CLI tool round trip complete', keys: `/btw why${ENTER}` },
        { marker: 'btw side agent', keys: '' },
        // The side agent runs the mock's shell call in the read-only sandbox and answers in its own turn.
        { marker: 'CLI tool round trip complete', keys: CTRL_P },
        { marker: 'btw ended · back in session', keys: '' },
      ])
      expect(run.exitCode, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`).toBe(0)
      const opened = run.stdout.indexOf('btw side agent')
      expect(opened).toBeGreaterThan(-1)
      expect(run.stdout.indexOf('❯ why', opened)).toBeGreaterThan(opened)
      expect(run.stdout.indexOf('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP', opened)).toBeGreaterThan(opened)
      const saved = /--resume (session-[\w-]+)/u.exec(run.stderr)
      expect(saved, run.stderr).not.toBeNull()
      const sessionId = saved![1]!

      const resumed = await runScript(cwd, ['--resume', sessionId], [
        { marker: 'CLI tool round trip complete', keys: '' },
      ])
      expect(resumed.exitCode, `stderr:\n${resumed.stderr}\nstdout:\n${resumed.stdout}`).toBe(0)
      expect(resumed.stdout).toContain('❯ first')
      expect(resumed.stdout).not.toContain('❯ why')
      expect(resumed.stdout).not.toContain('btw · side agent')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)
})
