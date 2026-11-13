/**
 * The shipped tui profile opens the todos page through the real `dsh`
 * launcher: the keyless mock model writes a todo list with `todo_write`,
 * `/todos` draws it on the alternate screen, `q` gives the conversation its
 * screen back, and `Ctrl+D` on the editor then quits, which it reaches only
 * once the page has closed. The runner sends `Ctrl+D` right after the last
 * step's keys, so the step closes with `q`: a lone `Esc` followed at once by
 * another byte reads as an `Alt` chord.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { plain, runTuiScript } from './run-tui-script.ts'

const cliPatch = fileURLToPath(new URL('./fixtures/cli.patch.yml', import.meta.url))
const ENTER_ALT = '\u001b[?1049h'
const LEAVE_ALT = '\u001b[?1049l'

describe('tui profile todos page', () => {
  it('draws the written todo list on its own screen and closes on q', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-todos-page-'))
    try {
      const run = await runTuiScript(cwd, [], [
        { marker: 'cli-mock/cli-mock', keys: 'Write the CLI todos.\r' },
        { marker: 'CLI tool round trip complete:', keys: '/todos\r' },
        { marker: 'todos · 1/3 delivered', keys: 'q' },
      ], cliPatch, { DSH_CLI_MOCK_TODOS: '1' })
      expect(run.exitCode, `${run.stderr}\n${run.stdout}`).toBe(0)
      const page = plain(run.raw.slice(run.raw.lastIndexOf(ENTER_ALT)))
      expect(page).toContain('todos · 1/3 delivered')
      expect(page).toContain('Read the CLI round trip')
      expect(page).toContain('Write the CLI todo list')
      expect(page).toContain('Check the CLI todos page')
      expect(run.raw.lastIndexOf(LEAVE_ALT)).toBeGreaterThan(run.raw.lastIndexOf(ENTER_ALT))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 120_000)
})
