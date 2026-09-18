/**
 * The settings, plugins, subagent rows and details, deliverables, changed-file,
 * and outline rows, and the plugin-management verbs, over scripted services.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ChangeChoice, SubagentChoice } from '../src/catalog.ts'
import {
  changeDiffRows,
  changesNotice,
  installBundle,
  listBundles,
  listDeliverables,
  listPlugins,
  listSettings,
  listSubagentChoices,
  listTurnChanges,
  removeBundle,
  resetSetting,
  sessionOutline,
  setPluginEnabled,
  setSetting,
  showSetting,
  subagentDetail,
} from '../src/catalog.ts'

const signal = new AbortController().signal
const sessionId = 'session-root' as SessionId

/** A settings stub over fixed descriptors that records every write. */
function settingsStub(descriptors: Record<string, unknown>[]): { ctx: Context; writes: unknown[]; described: unknown[] } {
  const ctx = new Context()
  const writes: unknown[] = []
  const described: unknown[] = []
  ctx.provide('settings', {
    describe: (options: unknown) => {
      described.push(options)
      return descriptors
    },
    mutate: (...args: unknown[]) => {
      writes.push(['mutate', ...args])
      return Promise.resolve()
    },
    replace: (...args: unknown[]) => {
      writes.push(['replace', ...args])
      return Promise.resolve()
    },
  } as never)
  return { ctx, writes, described }
}

describe('settings rows', () => {
  it('names the missing service', async () => {
    const ctx = new Context()
    expect(() => listSettings(ctx)).toThrow('settings are not mounted in this profile')
    expect(() => showSetting(ctx, 'llm')).toThrow('settings are not mounted in this profile')
    await expect(setSetting(ctx, 'llm', 'a', '1')).rejects.toThrow('settings are not mounted in this profile')
    await expect(resetSetting(ctx, 'llm')).rejects.toThrow('settings are not mounted in this profile')
  })

  it('lists every namespace with its revision, override state, and effect timing', () => {
    const { ctx, described } = settingsStub([
      { ns: 'llm-deepseek', revision: 3, applies: 'live', user: { apiKey: 'x' }, value: {} },
      { ns: 'editor', revision: 0, applies: 'restart', value: {} },
      { ns: 'shell', revision: 1, applies: 'live', user: {}, value: {} },
    ])
    expect(listSettings(ctx)).toEqual([
      'llm-deepseek  rev 3  user-overridden  applies live',
      'editor  rev 0  inherited  applies restart',
      'shell  rev 1  inherited  applies live',
    ])
    expect(described).toEqual([{ redactSecrets: true }])
  })

  it('shows the redacted value as JSON lines plus each secret slot', () => {
    const { ctx } = settingsStub([
      { ns: 'llm', revision: 2, applies: 'live', value: { model: 'chat', nested: { n: 1 } }, secrets: [{ path: ['api', 'key'], set: true }, { path: ['token'], set: false }] },
      { ns: 'plain', revision: 0, applies: 'live', value: 'text' },
    ])
    expect(showSetting(ctx, 'llm')).toEqual([
      '{',
      '  "model": "chat",',
      '  "nested": {',
      '    "n": 1',
      '  }',
      '}',
      'secret api.key: set',
      'secret token: unset',
    ])
    expect(showSetting(ctx, 'plain')).toEqual(['"text"'])
    expect(() => showSetting(ctx, 'absent')).toThrow('settings namespace "absent" is not registered')
  })

  it('sets one field through a path op at the read revision, parsing JSON and falling back to text', async () => {
    const { ctx, writes } = settingsStub([{ ns: 'llm', revision: 4, applies: 'live', value: {} }])
    await expect(setSetting(ctx, 'llm', 'api.timeoutMs', '1500')).resolves.toBe('settings llm: set api.timeoutMs = 1500')
    await expect(setSetting(ctx, 'llm', 'model', 'deepseek-chat')).resolves.toBe('settings llm: set model = "deepseek-chat"')
    await expect(setSetting(ctx, 'llm', '', '{"a":true}')).resolves.toBe('settings llm: set (root) = {"a":true}')
    expect(writes).toEqual([
      ['mutate', 'llm', [{ op: 'set', path: ['api', 'timeoutMs'], value: 1500 }], 4],
      ['mutate', 'llm', [{ op: 'set', path: ['model'], value: 'deepseek-chat' }], 4],
      ['mutate', 'llm', [{ op: 'set', path: [], value: { a: true } }], 4],
    ])
    await expect(setSetting(ctx, 'absent', 'a', '1')).rejects.toThrow('settings namespace "absent" is not registered')
  })

  it('resets a namespace by replacing its user section at the read revision', async () => {
    const { ctx, writes } = settingsStub([{ ns: 'llm', revision: 7, applies: 'live', value: {} }])
    await expect(resetSetting(ctx, 'llm')).resolves.toBe('settings llm: reset to defaults')
    expect(writes).toEqual([['replace', 'llm', {}, 7]])
    await expect(resetSetting(ctx, 'absent')).rejects.toThrow('settings namespace "absent" is not registered')
  })
})

describe('listPlugins', () => {
  it('names the missing loader', () => {
    expect(() => listPlugins(new Context())).toThrow('the plugin loader is not mounted in this profile')
  })

  it('lists non-group entries with enablement and fiber phase', () => {
    const ctx = new Context()
    ctx.provide('loader', {
      * entries() {
        yield { id: 'group', options: { name: 'group', group: true }, disabled: false, fiber: { state: 2 } }
        yield { id: 'llm', options: { name: '@deepseek-ai/dsh-llm' }, disabled: false, fiber: { state: 2 } }
        yield { id: 'web', options: { name: '@deepseek-ai/dsh-web' }, disabled: true, fiber: undefined }
        yield { id: 'gone', options: { name: '@deepseek-ai/dsh-gone' }, disabled: false, fiber: { state: 4 } }
        yield { id: 'slow', options: { name: '@deepseek-ai/dsh-slow' }, disabled: false, fiber: { state: 1 } }
      },
    } as never)
    expect(listPlugins(ctx)).toEqual([
      'llm  @deepseek-ai/dsh-llm  enabled  active',
      'web  @deepseek-ai/dsh-web  disabled  none',
      'gone  @deepseek-ai/dsh-gone  enabled  none',
      'slow  @deepseek-ai/dsh-slow  enabled  loading',
    ])
  })
})

/** A subagent runtime stub over one fixed descendant listing that records every call. */
function descendantsStub(entries: unknown[]): { ctx: Context; asked: unknown[] } {
  const ctx = new Context()
  const asked: unknown[] = []
  ctx.provide('subagents', {
    listDescendants: (...args: unknown[]) => {
      asked.push(args)
      return Promise.resolve(entries)
    },
  } as never)
  return { ctx, asked }
}

describe('listSubagentChoices', () => {
  it('names the missing runtime', async () => {
    await expect(listSubagentChoices(new Context(), sessionId, signal)).rejects.toThrow('subagents are not mounted in this profile')
  })

  it('indents each descendant by depth and keeps its label, activity, mode, id, and diagnostic reason', async () => {
    const { ctx, asked } = descendantsStub([
      { kind: 'child', id: 'session-a', activity: 'running', mode: 'continuable', label: 'reviewer', hasChildren: true, parentId: sessionId, depth: 1 },
      { kind: 'child', id: 'session-b', activity: 'inactive', mode: 'one-shot', hasChildren: true, parentId: 'session-a', depth: 2 },
      { kind: 'child', id: 'session-d', activity: 'inactive', mode: 'one-shot', label: 'fixer', hasChildren: false, parentId: 'session-b', depth: 3 },
      { kind: 'diagnostic', id: 'session-c', reason: 'corrupt', parentId: sessionId, depth: 1 },
    ])
    await expect(listSubagentChoices(ctx, sessionId, signal)).resolves.toEqual([
      { id: 'session-a', depth: 1, label: 'reviewer', description: 'running · continuable · session-a', enterable: true },
      { id: 'session-b', depth: 2, label: '  session-b', description: 'inactive · one-shot', enterable: true },
      { id: 'session-d', depth: 3, label: '    fixer', description: 'inactive · one-shot · session-d', enterable: true },
      { id: 'session-c', depth: 1, label: 'session-c', description: 'corrupt', enterable: false },
    ])
    expect(asked).toEqual([[sessionId, signal]])
  })

  it('refuses an entry kind it does not know', async () => {
    const { ctx } = descendantsStub([{ kind: 'sketch', id: 'session-x', depth: 1 }])
    await expect(listSubagentChoices(ctx, sessionId, signal)).rejects.toThrow('unreachable variant in tui subagent list entry')
  })
})

/** A session query stub serving one observation and counting its disposals. */
function observationStub(observation: object): { ctx: Context; observed: unknown[]; disposals: { count: number } } {
  const ctx = new Context()
  const observed: unknown[] = []
  const disposals = { count: 0 }
  ctx.provide('sessionQuery', {
    observeSession: (...args: unknown[]) => {
      observed.push(args)
      return Promise.resolve({ ...observation, [Symbol.dispose]: () => { disposals.count += 1 } })
    },
  } as never)
  return { ctx, observed, disposals }
}

describe('subagentDetail', () => {
  const child: SubagentChoice = {
    id: 'session-a' as SessionId,
    depth: 1,
    label: 'reviewer',
    description: 'running · continuable · session-a',
    enterable: true,
  }

  it('reads the entered session once and shows its row facts, header, title, outline, and presented files', async () => {
    const { ctx, observed, disposals } = observationStub({
      header: { id: 'session-a', createdAt: Date.UTC(2026, 1, 3, 14, 25, 30), cwd: '/work/repo' },
      events: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'deliverables/presented', seq: 2, time: 3, data: { turn: 1, callId: 'call-1', files: [{ path: 'report.md', description: 'Summary' }, { path: 'notes.txt' }] } },
      ],
      projections: {
        asOfSeq: 2,
        values: {
          title: 'Review the parser',
          turnOutline: [
            { turn: 1, seq: 0, prompt: 'Review the parser', response: 'Found two bugs.' },
            { turn: 2, seq: 3, prompt: '', response: '' },
          ],
        },
      },
    })
    await expect(subagentDetail(ctx, child, signal)).resolves.toEqual([
      'reviewer',
      'running · continuable · session-a',
      'created: 2026-02-03 14:25',
      'workspace: /work/repo',
      'title: Review the parser',
      '1. Review the parser',
      '  → Found two bugs.',
      '2. (no prompt)',
      'presented: report.md',
      'presented: notes.txt',
    ])
    expect(observed).toEqual([['session-a', { signal, projectionMode: 'all' }]])
    expect(disposals.count).toBe(1)
  })

  it('drops the row indent and skips every fact the observation has no value for', async () => {
    const nested: SubagentChoice = {
      id: 'session-b' as SessionId,
      depth: 2,
      label: '  session-b',
      description: 'inactive · one-shot',
      enterable: true,
    }
    const identity = ['session-b', 'inactive · one-shot', 'created: 2026-02-03 14:25']
    const unprojected = observationStub({
      header: { id: 'session-b', createdAt: Date.UTC(2026, 1, 3, 14, 25, 30) },
      events: [],
    })
    await expect(subagentDetail(unprojected.ctx, nested, signal)).resolves.toEqual(identity)
    const untitled = observationStub({
      header: { id: 'session-b', createdAt: Date.UTC(2026, 1, 3, 14, 25, 30) },
      events: [],
      projections: { asOfSeq: -1, values: { title: null, turnOutline: [] } },
    })
    await expect(subagentDetail(untitled.ctx, nested, signal)).resolves.toEqual(identity)
  })

  it('counts the turns and files past the cap instead of listing them', async () => {
    const { ctx } = observationStub({
      header: { id: 'session-a', createdAt: Date.UTC(2026, 1, 3, 14, 25, 30) },
      events: [{
        type: 'deliverables/presented',
        seq: 1,
        time: 2,
        data: { turn: 1, callId: 'call-1', files: Array.from({ length: 10 }, (_item, index) => ({ path: `file-${String(index)}.md` })) },
      }],
      projections: {
        asOfSeq: 1,
        values: {
          turnOutline: Array.from({ length: 9 }, (_item, index) => ({ turn: index + 1, seq: index, prompt: `prompt ${String(index + 1)}`, response: '' })),
        },
      },
    })
    await expect(subagentDetail(ctx, child, signal)).resolves.toEqual([
      'reviewer',
      'running · continuable · session-a',
      'created: 2026-02-03 14:25',
      '1. prompt 1',
      '2. prompt 2',
      '3. prompt 3',
      '4. prompt 4',
      '5. prompt 5',
      '6. prompt 6',
      '7. prompt 7',
      '8. prompt 8',
      '… 1 more turn',
      'presented: file-0.md',
      'presented: file-1.md',
      'presented: file-2.md',
      'presented: file-3.md',
      'presented: file-4.md',
      'presented: file-5.md',
      'presented: file-6.md',
      'presented: file-7.md',
      '… 2 more files',
    ])
  })

  it('explains an unreadable session instead of throwing', async () => {
    await expect(subagentDetail(new Context(), child, signal))
      .resolves.toEqual(['cannot read session-a: the session query engine is not mounted in this profile'])
    const ctx = new Context()
    ctx.provide('sessionQuery', {
      observeSession: () => Promise.reject(new Error('session "session-a" not found')),
    } as never)
    await expect(subagentDetail(ctx, child, signal)).resolves.toEqual(['cannot read session-a: session "session-a" not found'])
  })

  it('reports the listing diagnostic for a row with no readable session, without observing it', async () => {
    const { ctx, observed } = observationStub({ header: { id: 'session-c', createdAt: 0 }, events: [] })
    const diagnostic: SubagentChoice = {
      id: 'session-c' as SessionId,
      depth: 1,
      label: 'session-c',
      description: 'corrupt',
      enterable: false,
    }
    await expect(subagentDetail(ctx, diagnostic, signal)).resolves.toEqual([
      'session-c',
      'unreadable subagent session: corrupt',
    ])
    expect(observed).toEqual([])
  })
})

describe('listDeliverables', () => {
  it('names the missing query engine', async () => {
    await expect(listDeliverables(new Context(), sessionId, signal)).rejects.toThrow('the session query engine is not mounted in this profile')
  })

  it('groups presented files by turn from one disposed observation', async () => {
    const ctx = new Context()
    const observed: unknown[] = []
    let disposed = 0
    ctx.provide('sessionQuery', {
      observeSession: (...args: unknown[]) => {
        observed.push(args)
        return Promise.resolve({
          events: [
            { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
            { type: 'deliverables/presented', seq: 1, time: 2, data: { turn: 1, callId: 'call-1', files: [{ path: 'report.md', description: 'Summary' }] } },
            { type: 'deliverables/presented', seq: 2, time: 3, data: { turn: 1, callId: 'call-2', files: [{ path: 'notes.txt' }] } },
            { type: 'deliverables/presented', seq: 3, time: 4, data: { turn: 3, callId: 'call-3', files: [{ path: '/abs/chart.png', description: 'Chart' }] } },
          ],
          [Symbol.dispose]: () => { disposed += 1 },
        })
      },
    } as never)
    await expect(listDeliverables(ctx, sessionId, signal)).resolves.toEqual([
      'turn 1',
      '  report.md  Summary',
      '  notes.txt',
      'turn 3',
      '  /abs/chart.png  Chart',
    ])
    expect(observed).toEqual([[sessionId, { signal, projectionMode: 'none' }]])
    expect(disposed).toBe(1)
  })
})

describe('sessionOutline', () => {
  const session = { id: sessionId } as Session

  it('names the missing registry and the unregistered projection', () => {
    expect(() => sessionOutline(new Context(), session)).toThrow('session projections are not mounted in this profile')
    const ctx = new Context()
    ctx.provide('sessionProjections', { snapshot: () => ({ asOfSeq: -1, values: {} }) } as never)
    expect(() => sessionOutline(ctx, session)).toThrow('the turnOutline projection is not registered in this profile')
  })

  it('numbers each turn with its prompt and response previews', () => {
    const ctx = new Context()
    const asked: unknown[] = []
    ctx.provide('sessionProjections', {
      snapshot: (...args: unknown[]) => {
        asked.push(args)
        return {
          asOfSeq: 5,
          values: {
            turnOutline: [
              { turn: 1, seq: 0, prompt: 'Fix the build', response: 'Done: the build passes.' },
              { turn: 2, seq: 4, prompt: '', response: '' },
            ],
          },
        }
      },
    } as never)
    expect(sessionOutline(ctx, session)).toEqual([
      '1. Fix the build',
      '  → Done: the build passes.',
      '2. (no prompt)',
    ])
    expect(asked).toEqual([[session, ['turnOutline']]])
  })
})

/** One turn's summary as the Host serves it: one text file and one binary file of three. */
const changesSummary = {
  turn: 2,
  cwd: '/work',
  total: 3,
  added: 12,
  deleted: 4,
  files: [
    { path: 'src/a.ts', display: 'src/a.ts', added: 10, deleted: 4 },
    { path: '/tmp/blob.bin', display: '/tmp/blob.bin', added: 0, deleted: 0, binary: true as const },
  ],
}

/** Three announcements among other events: turn 1 once, turn 2 twice, so the later one wins. */
const changesEvents = [
  { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
  { type: 'workspace/changes', seq: 3, time: 1, data: { turn: 1 } },
  { type: 'workspace/changes', seq: 5, time: 2, data: { turn: 2 } },
  { type: 'workspace/changes', seq: 7, time: 3, data: { turn: 2 } },
]

/** A log of `events` and a workspace-changes service holding `held` summaries by sequence and answering `diff` with one comparison. */
function changesCtx(events: readonly unknown[], held: Record<number, unknown> = { 7: changesSummary }, diff?: unknown): Context {
  const ctx = new Context()
  ctx.provide('sessionQuery', { observeSession: () => Promise.resolve({ events, [Symbol.dispose]: () => {} }) } as never)
  ctx.provide('workspaceChanges', { summary: (_id: unknown, seq: number) => held[seq], diff: () => Promise.resolve(diff) } as never)
  return ctx
}

describe('listTurnChanges', () => {
  it('names the missing services', async () => {
    await expect(listTurnChanges(new Context(), sessionId, undefined, signal)).rejects.toThrow('workspace changes are not recorded in this profile')
    const ctx = new Context()
    ctx.provide('workspaceChanges', {} as never)
    await expect(listTurnChanges(ctx, sessionId, undefined, signal)).rejects.toThrow('the session query engine is not mounted in this profile')
  })

  it('resolves the latest announcement of the newest turn, or of the named one', async () => {
    await expect(listTurnChanges(changesCtx(changesEvents), sessionId, undefined, signal)).resolves.toEqual({
      heading: 'turn 2 · 3 files (2 listed) · +12 −4',
      choices: [
        { index: 0, seq: 7, label: 'src/a.ts', description: '+10 −4' },
        { index: 1, seq: 7, label: '/tmp/blob.bin', description: 'binary' },
      ],
    })
    const first = { ...changesSummary, turn: 1, total: 1, files: [{ ...changesSummary.files[0], oversized: true as const }] }
    await expect(listTurnChanges(changesCtx(changesEvents, { 3: first }), sessionId, 1, signal)).resolves.toEqual({
      heading: 'turn 1 · 1 file · +12 −4',
      choices: [{ index: 0, seq: 3, label: 'src/a.ts', description: 'oversized' }],
    })
  })

  it('reports an unannounced turn as undefined and a dropped summary as an error', async () => {
    await expect(listTurnChanges(changesCtx([]), sessionId, undefined, signal)).resolves.toBeUndefined()
    await expect(listTurnChanges(changesCtx(changesEvents), sessionId, 9, signal)).resolves.toBeUndefined()
    await expect(listTurnChanges(changesCtx(changesEvents, {}), sessionId, undefined, signal))
      .rejects.toThrow('the changed files of turn 2 are no longer held by this host')
  })
})

describe('changesNotice', () => {
  it('counts the turn\'s files and lines', () => {
    expect(changesNotice(changesSummary)).toBe('turn 2 changed 3 files (+12 −4) · /changes')
    expect(changesNotice({ ...changesSummary, total: 1 })).toBe('turn 2 changed 1 file (+12 −4) · /changes')
  })
})

describe('changeDiffRows', () => {
  const choice: ChangeChoice = { index: 0, seq: 7, label: 'src/a.ts', description: '+1 −1' }

  it('names the missing service', async () => {
    await expect(changeDiffRows(new Context(), sessionId, choice, signal)).rejects.toThrow('workspace changes are not recorded in this profile')
  })

  it('draws the hunks in the tool cards\' diff row form', async () => {
    const diff = {
      kind: 'text',
      path: 'src/a.ts',
      display: 'src/a.ts',
      before: true,
      after: true,
      coarse: false,
      hunks: [
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-old', '+new'] },
        { oldStart: 9, oldLines: 1, newStart: 9, newLines: 1, lines: ['-a', '+b'] },
      ],
    }
    await expect(changeDiffRows(changesCtx([], {}, diff), sessionId, choice, signal)).resolves.toEqual([
      '@@ -1,2 +1,2 @@', '  keep', '- old', '+ new', '  …', '@@ -9,1 +9,1 @@', '- a', '+ b',
    ])
  })

  it('explains a new, deleted, coarse, unchanged, binary, oversized, or dropped comparison', async () => {
    const text = { kind: 'text', path: 'x', display: 'x', before: false, after: false, coarse: true, hunks: [] }
    await expect(changeDiffRows(changesCtx([], {}, text), sessionId, choice, signal)).resolves.toEqual([
      'new file', 'deleted', 'comparison timed out: every line is shown as replaced', 'no line changes',
    ])
    await expect(changeDiffRows(changesCtx([], {}, { kind: 'binary', path: 'x', display: 'x' }), sessionId, choice, signal))
      .resolves.toEqual(['x: binary content, no line comparison'])
    await expect(changeDiffRows(changesCtx([], {}, { kind: 'oversized', path: 'x', display: 'x' }), sessionId, choice, signal))
      .resolves.toEqual(['x: larger than the comparison limit, no line comparison'])
    await expect(changeDiffRows(changesCtx([]), sessionId, choice, signal))
      .resolves.toEqual(['src/a.ts: the comparison is no longer held by this host'])
  })
})

/** A plugin manager over one plugin entry and two bundles that records every change call. */
function managerCtx(calls: unknown[]): Context {
  const ctx = new Context()
  ctx.provide('pluginManager', {
    listPlugins: () => Promise.resolve([{ entryId: 'llm', moduleName: '@deepseek-ai/dsh-llm', enabled: true, fiberPhase: 'active', patchId: 'llm' }]),
    listBundles: () => Promise.resolve([
      { name: '@acme/bundle', version: '1.2.0', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] },
      { name: '@deepseek-ai/dsh-acp-app', version: '0.1.0', enabled: false, installed: false, optional: true, removable: false, rows: [], overrides: [] },
      {
        name: '@deepseek-ai/dsh-web-app',
        enabled: false,
        installed: false,
        optional: false,
        removable: false,
        readOnlyReason: 'unaddressable',
        error: { code: 'not-removable' },
        rows: [],
        overrides: [],
      },
    ]),
    setPluginEnabled: (...args: unknown[]) => {
      calls.push(['plugin', ...args])
      return Promise.resolve({ changed: true, application: 'applied', stage: 'enable', target: 'llm', enabled: false })
    },
    setBundleEnabled: (...args: unknown[]) => {
      calls.push(['bundle', ...args])
      return Promise.resolve({ changed: true, application: 'restart-required', stage: 'enable', target: '@acme/bundle', enabled: true, warnings: ['row x stays disabled'] })
    },
    installBundle: (...args: unknown[]) => {
      calls.push(['install', ...args])
      return Promise.resolve(args[0] === 'nope'
        ? { changed: false, application: 'failed', stage: 'install', target: 'nope', error: { code: 'operation-error', diagnostic: 'pnpm exited 1' }, pendingBuilds: ['esbuild'] }
        : { changed: true, application: 'applied', stage: 'install', target: String(args[0]), bundle: '@acme/other', enabled: true })
    },
    removeBundle: (...args: unknown[]) => {
      calls.push(['remove', ...args])
      return Promise.resolve({ changed: true, application: 'applied', stage: 'remove', target: '@acme/bundle', bundle: '@acme/bundle' })
    },
  } as never)
  return ctx
}

describe('plugin management', () => {
  it('names the missing manager', async () => {
    await expect(listBundles(new Context())).rejects.toThrow('plugin management is not mounted in this profile')
    await expect(setPluginEnabled(new Context(), 'llm', true)).rejects.toThrow('plugin management is not mounted in this profile')
    await expect(installBundle(new Context(), 'x')).rejects.toThrow('plugin management is not mounted in this profile')
    await expect(removeBundle(new Context(), 'x')).rejects.toThrow('plugin management is not mounted in this profile')
  })

  it('lists bundles with how the profile holds them', async () => {
    await expect(listBundles(managerCtx([]))).resolves.toEqual([
      '@acme/bundle  1.2.0  enabled  installed  removable',
      '@deepseek-ai/dsh-acp-app  0.1.0  disabled  optional',
      '@deepseek-ai/dsh-web-app  -  disabled  shipped  read-only (unaddressable)  error not-removable',
    ])
  })

  it('switches a plugin entry, then a bundle, and refuses an unknown target', async () => {
    const calls: unknown[] = []
    await expect(setPluginEnabled(managerCtx(calls), 'llm', false)).resolves.toBe('enable llm: applied')
    await expect(setPluginEnabled(managerCtx(calls), '@acme/bundle', true)).resolves.toBe('enable @acme/bundle: restart-required · row x stays disabled')
    await expect(setPluginEnabled(managerCtx(calls), 'ghost', true)).rejects.toThrow('"ghost" is neither a plugin entry nor a bundle of this profile')
    expect(calls).toEqual([['plugin', 'llm', false], ['bundle', '@acme/bundle', true]])
  })

  it('installs and removes bundles, raising a failed change as the row it describes', async () => {
    const calls: unknown[] = []
    await expect(installBundle(managerCtx(calls), 'acme-other@1')).resolves.toBe('install acme-other@1: applied · bundle @acme/other')
    await expect(installBundle(managerCtx(calls), 'nope'))
      .rejects.toThrow('install nope: unchanged, failed · operation-error: pnpm exited 1 · scripts awaiting approval: esbuild')
    await expect(removeBundle(managerCtx(calls), '@acme/bundle')).resolves.toBe('remove @acme/bundle: applied')
    expect(calls).toEqual([['install', 'acme-other@1'], ['install', 'nope'], ['remove', '@acme/bundle']])
  })
})
