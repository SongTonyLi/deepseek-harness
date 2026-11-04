/** Failed-attempt text and reasoning survive a real TUI process restart. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  assertPersistedSessionVersion, assertSessionFixtureVersion, fixtureContext,
  formatSystemPromptSnapshot, formatToolSchemasSnapshot, latestPersistedSessionPaths,
  normalizeSessionSnapshot, normalizeSessionSnapshots, normalizedSystemPrompts,
  normalizedToolSchemas, parseSnapshotManifest, redactSessionSnapshotIds,
  sessionFixtureName, sessionFixtureNames,
} from '@deepseek-ai/dsh-session-snapshot'
import { runTuiScript } from '../../apps/cli/tests/profiles/tui/tests/run-tui-script.ts'

const root = fileURLToPath(new URL('./attempt-replay/', import.meta.url))
const cliPatch = fileURLToPath(new URL('../../apps/cli/tests/profiles/tui/tests/fixtures/cli.patch.yml', import.meta.url))
const mode = process.env.DSH_SNAPSHOT ?? 'replay'
if (!['replay', 'refresh'].includes(mode)) throw new Error('attempt-replay is authored; use replay or refresh')

it.skipIf(process.platform === 'win32')('attempt-replay retains settled content after restarting the TUI', async () => {
  const manifest = parseSnapshotManifest(await readFile(join(root, 'snapshot.yml'), 'utf8'))
  expect(manifest).toMatchObject({ profile: 'tui', recording: 'authored', header: { pin: true } })
  const [name] = sessionFixtureNames(await readdir(root))
  if (name === undefined) throw new Error('missing attempt-replay Session fixture')
  const fixture = await readFile(join(root, name), 'utf8')
  assertSessionFixtureVersion(name, fixture)
  const user = parseSessionLog(fixture).find(event => event.type === 'user/message' && event.data.source?.kind === 'user')
  if (user?.type !== 'user/message') throw new Error('attempt-replay Session fixture has no human task')
  const task = user.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-attempt-replay-'))
  try {
    const patch = join(root, 'cordis.snapshot.yml')
    const live = await runTuiScript(cwd, ['--patch', patch], [
      { marker: 'cli-mock/cli-mock', keys: `${task}\r` },
      { marker: 'turn failed: SERVER: ATTEMPT_PROVIDER_FAILED', keys: '/retry\r' },
      { marker: 'ATTEMPT_RECOVERY_DONE', keys: '' },
    ], cliPatch, { DSH_TUI_SNAPSHOT_SESSION: join(root, name) })
    expect(live.exitCode, `${live.stderr}\n${live.stdout}`).toBe(0)
    expect(live.stdout).toContain('ATTEMPT_TEXT_RETAINED')
    expect(live.stdout).toContain('ATTEMPT_REASONING_RETAINED')
    const storage = join(cwd, '.sessions')
    const paths = latestPersistedSessionPaths(await readdir(storage, { recursive: true }))
    expect(paths).toHaveLength(1)
    const path = join(storage, paths[0]!)
    const raw = await readFile(path, 'utf8')
    const version = assertPersistedSessionVersion(basename(path), raw)
    const events = parseSessionLog(raw)
    expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(events.some(event => event.type === 'tool/call' || event.type === 'tool/result')).toBe(false)
    const attempt = events.find(event => event.type === 'assistant/attempt')
    expect(attempt).not.toHaveProperty('surfaceOp')
    const header = JSON.parse(raw.split('\n')[0]!) as { id: string }
    const resumed = await runTuiScript(cwd, ['--patch', patch, '--resume', header.id], [
      { marker: 'ATTEMPT_TEXT_RETAINED', keys: '' },
      { marker: 'ATTEMPT_RECOVERY_DONE', keys: '' },
    ], cliPatch, { DSH_TUI_SNAPSHOT_SESSION: undefined })
    expect(resumed.exitCode, `${resumed.stderr}\n${resumed.stdout}`).toBe(0)
    expect(resumed.stdout).toContain('ATTEMPT_REASONING_RETAINED')
    expect(resumed.stdout).not.toContain('ATTEMPT_TOOL_MUST_NOT_RUN')
    expect(resumed.stdout).not.toContain('Unexecuted attempt tool')
    expect(resumed.stdout).not.toContain('[interrupted]')
    const restored = parseSessionLog(await readFile(path, 'utf8'))
    expect(restored.slice(0, events.length)).toEqual(events)
    expect(restored.slice(events.length).map(event => ({ type: event.type, data: event.data })))
      .toEqual([{ type: 'session/end-seed', data: {} }])

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
})
