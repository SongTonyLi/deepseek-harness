/**
 * The shipped TUI profile completes a workflow in a workspace-write session on
 * the Apple container backend, with only the remote model replaced by the CLI
 * mock. The workflow process starts the host Node executable and is confined on
 * the host, while the session's backend stays the container. Skips unless the
 * `container` runtime answers on macOS on Apple silicon.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runTuiScript } from './run-tui-script.ts'

const runtimeUp = process.platform === 'darwin' && process.arch === 'arm64'
  && spawnSync('container', ['system', 'status'], { stdio: 'ignore', timeout: 10_000 }).status === 0
const cliPatch = fileURLToPath(new URL('./fixtures/cli.patch.yml', import.meta.url))

describe.skipIf(!runtimeUp)('tui profile workflow on the Apple container backend', () => {
  it('returns the child result to the model in a workspace-write container session', async () => {
    // A home-directory workspace sits under the default unreadable root, so the read fence must grant it.
    const cwd = await realpath(await mkdtemp(join(homedir(), 'dsh-tui-workflow-container-')))
    try {
      const run = await runTuiScript(cwd, [], [
        { marker: 'cli-mock/cli-mock', keys: '/sandbox\r' },
        { marker: 'Commands → Linux container', keys: '' },
        // The backend panel's frame ends in the footer legend; close it there, then type once the editor returns.
        { marker: 'Shift+↑ read · Shift+↓ status', keys: '\u001b' },
        { marker: 'Shift+↑ read · Shift+↓ status', keys: 'Run the CLI workflow.\r' },
        { marker: 'CLI tool round trip complete:', keys: '' },
      ], cliPatch, { DSH_PERMISSION_MODE: 'workspace-write', DSH_CLI_MOCK_WORKFLOW: '1' })
      expect(run.exitCode, `${run.stderr}\n${run.stdout}`).toBe(0)
      expect(run.stdout).toContain('Commands → Linux container')
      expect(run.stdout).toContain('workflow "cli-mock-workflow" completed (1 agent).')
      expect(run.stdout).toContain('"reply": "CLI_WORKFLOW_CHILD_OK"')
      expect(run.stdout).not.toContain('workflow run failed')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 120_000)
})
