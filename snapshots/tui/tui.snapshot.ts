/** Replay recorded terminal scenarios (an Auto-mode shell turn and an external subagent task) through the shipped terminal profile. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  assertPersistedSessionVersion, assertSessionFixtureVersion, fixtureContext,
  formatSystemPromptSnapshot, formatToolSchemasSnapshot, latestPersistedSessionPaths,
  normalizeSessionSnapshot, normalizeSessionSnapshots, normalizedSystemPrompts,
  normalizedToolSchemas, parseSnapshotManifest, redactSessionSnapshotIds,
  sessionFixtureName, sessionFixtureNames,
} from '@deepseek-ai/dsh-session-snapshot'
import { runTuiScript } from '../../apps/cli/tests/profiles/tui/tests/run-tui-script.ts'

const root = fileURLToPath(new URL('./auto-review-temperature/', import.meta.url))
const externalRoot = fileURLToPath(new URL('./external-subagent/', import.meta.url))
const cliPatch = fileURLToPath(new URL('../../apps/cli/tests/profiles/tui/tests/fixtures/cli.patch.yml', import.meta.url))
const mode = process.env.DSH_SNAPSHOT ?? 'replay'
if (!['replay', 'record', 'refresh'].includes(mode)) throw new Error(`unknown DSH_SNAPSHOT mode: ${mode}`)

describe('TUI recorded-session replay', () => {
  it.skipIf(process.platform === 'win32').each([false, true])('auto-review-temperature (malformed JSON: %s)', async (malformedJson) => {
    const manifest = parseSnapshotManifest(await readFile(join(root, 'snapshot.yml'), 'utf8'))
    expect(manifest).toMatchObject({ profile: 'tui', recording: 'authored', header: { pin: true } })
    const [name] = sessionFixtureNames(await readdir(root))
    if (name === undefined) throw new Error('missing TUI Session fixture')
    const fixture = await readFile(join(root, name), 'utf8')
    assertSessionFixtureVersion(name, fixture)
    const user = parseSessionLog(fixture).find(event => event.type === 'user/message' && event.data.source?.kind === 'user')
    if (user?.type !== 'user/message') throw new Error('TUI Session fixture has no human task')
    const task = user.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-recorded-'))
    try {
      const run = await runTuiScript(cwd, ['--patch', join(root, 'cordis.snapshot.yml')], [
        { marker: 'cli-mock/cli-mock', keys: '/permission auto\r' },
        { marker: '/permission: preset auto', keys: `${task}\r` },
        { marker: 'CLI tool round trip complete: CLI_TOOL_ROUND_TRIP', keys: '\u0007\u001b[H\u001b[B' },
        { marker: 'row 2/', keys: '\u0007/sandbox\r' },
        { marker: 'Sandbox backend', keys: '' },
        { marker: 'Shift+↑ read · Shift+↓ status', keys: '\u001b' },
        { marker: 'Shift+↑ read · Shift+↓ status', keys: '' },
      ], cliPatch, { LINES: '40', DSH_CLI_MOCK_MALFORMED_REVIEW_ONCE: malformedJson ? '1' : '0',
        ...mode === 'record' ? {} : { DSH_TUI_SNAPSHOT_SESSION: join(root, name) } })
      expect(run.exitCode, `${run.stderr}\n${run.stdout}`).toBe(0)
      expect(run.stdout).toContain('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP')
      expect(run.stdout).toMatch(/[⠁⠈⠐⠠⢀⡀⠄⠂] calling bash/u)
      expect(run.stdout).toContain(`❯ ${task}`)
      expect(run.stdout).toContain('row 2/')
      expect(run.stdout).toContain('Sandbox backend')
      expect(run.stdout).toContain('Container unavailable:')
      expect(run.stdout).toContain('Access preview · Local')
      expect(run.stdout).toContain('Sandbox bypassed: commands run on the host, regardless of backend choice.')
      expect(await readFile(join(cwd, '.auto-review-requests'), 'utf8')).toBe(malformedJson ? 'reviewed\nreviewed\n' : 'reviewed\n')
      const storage = join(cwd, '.sessions')
      const paths = latestPersistedSessionPaths(await readdir(storage, { recursive: true }))
      expect(paths).toHaveLength(1)
      const raw = await readFile(join(storage, paths[0]!), 'utf8')
      const version = assertPersistedSessionVersion(basename(paths[0]!), raw)
      const context = fixtureContext(raw)
      const prompts = normalizedSystemPrompts(raw, context)
      const schemas = normalizedToolSchemas(raw, context)
      expect(prompts).toHaveLength(1)
      const prompt = formatSystemPromptSnapshot(prompts[0]!)
      const tools = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
      if (mode === 'replay') {
        expect(normalizeSessionSnapshots([raw], context, { nativeWriterOutput: true }))
          .toEqual(normalizeSessionSnapshots([fixture], fixtureContext(fixture), { nativeWriterOutput: true }))
        expect(schemas).toHaveLength(1 + (manifest.header?.changes ?? 0))
        expect(prompt).toBe(await readFile(join(root, 'system-prompt.expected.md'), 'utf8'))
        expect(tools).toBe(await readFile(join(root, 'tool-schemas.expected.json'), 'utf8'))
      } else {
        const [normalized] = redactSessionSnapshotIds([normalizeSessionSnapshot(raw, context, { identityMode: 'preserve' })])
        await writeFile(join(root, sessionFixtureName(0, version)), normalized!)
        await writeFile(join(root, 'system-prompt.expected.md'), prompt)
        await writeFile(join(root, 'tool-schemas.expected.json'), tools)
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 75_000)

  it.skipIf(process.platform === 'win32')('external-subagent', async () => {
    const manifest = parseSnapshotManifest(await readFile(join(externalRoot, 'snapshot.yml'), 'utf8'))
    expect(manifest).toMatchObject({ profile: 'tui', recording: 'authored', header: { pin: true } })
    const [name] = sessionFixtureNames(await readdir(externalRoot))
    if (name === undefined) throw new Error('missing TUI Session fixture')
    const fixture = await readFile(join(externalRoot, name), 'utf8')
    assertSessionFixtureVersion(name, fixture)
    const user = parseSessionLog(fixture).find(event => event.type === 'user/message' && event.data.source?.kind === 'user')
    if (user?.type !== 'user/message') throw new Error('TUI Session fixture has no human task')
    const task = user.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-external-'))
    try {
      // The authored model script drives every mode: the mock's built-in script cannot delegate.
      const run = await runTuiScript(cwd, ['--patch', join(externalRoot, 'cordis.snapshot.yml')], [
        { marker: 'cli-mock/cli-mock', keys: `${task}\r` },
        // The task omits the recorded answer, so this marker waits for the finished turn.
        { marker: 'EXTERNAL_TUI_DONE', keys: '/subagents\r' },
        { marker: 'external task · no local session', keys: '\r' },
        // Only the detail page joins these words with a colon.
        { marker: 'external task: no local session', keys: '\u001b' },
        // Leaving the detail reopens the list on the row just read. That frame ends in the footer legend,
        // so the first legend marker closes the list and the second waits for the editor to return.
        { marker: 'external snapshot task ✓', keys: '' },
        { marker: 'Shift+↑ read · Shift+↓ status', keys: '\u001b' },
        { marker: 'Shift+↑ read · Shift+↓ status', keys: '' },
      ], cliPatch, { DSH_TUI_SNAPSHOT_SESSION: join(externalRoot, name) })
      expect(run.exitCode, `${run.stderr}\n${run.stdout}`).toBe(0)
      expect(run.stdout).toContain(`❯ ${task}`)
      expect(run.stdout).toContain('EXTERNAL_TUI_DONE')
      expect(run.stdout).toContain('Subagent sessions')
      expect(run.stdout).toContain('external snapshot task')
      expect(run.stdout).toContain('external task · no local session')
      expect(run.stdout).toContain('external task: no local session')
      expect(run.stdout).not.toContain('◆ subagent view')
      const storage = join(cwd, '.sessions')
      const paths = latestPersistedSessionPaths(await readdir(storage, { recursive: true }))
      expect(paths).toHaveLength(1)
      const raw = await readFile(join(storage, paths[0]!), 'utf8')
      const catalog = raw.split('\n')
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as { type?: string; data?: { mode?: string } })
        .filter(row => row.type === 'subagent/catalog')
      expect(catalog.map(row => row.data?.mode)).toEqual(['external'])
      const version = assertPersistedSessionVersion(basename(paths[0]!), raw)
      const context = fixtureContext(raw)
      const prompts = normalizedSystemPrompts(raw, context)
      const schemas = normalizedToolSchemas(raw, context)
      expect(prompts).toHaveLength(1)
      const prompt = formatSystemPromptSnapshot(prompts[0]!)
      const tools = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
      if (mode === 'replay') {
        expect(normalizeSessionSnapshots([raw], context, { nativeWriterOutput: true }))
          .toEqual(normalizeSessionSnapshots([fixture], fixtureContext(fixture), { nativeWriterOutput: true }))
        expect(schemas).toHaveLength(1 + (manifest.header?.changes ?? 0))
        expect(prompt).toBe(await readFile(join(externalRoot, 'system-prompt.expected.md'), 'utf8'))
        expect(tools).toBe(await readFile(join(externalRoot, 'tool-schemas.expected.json'), 'utf8'))
      } else {
        const [normalized] = redactSessionSnapshotIds([normalizeSessionSnapshot(raw, context, { identityMode: 'preserve' })])
        await writeFile(join(externalRoot, sessionFixtureName(0, version)), normalized!)
        await writeFile(join(externalRoot, 'system-prompt.expected.md'), prompt)
        await writeFile(join(externalRoot, 'tool-schemas.expected.json'), tools)
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 75_000)
})
