/** The settings, plugins, subagents, deliverables, and outline rows over scripted services. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  listDeliverables,
  listPlugins,
  listSettings,
  listSubagents,
  resetSetting,
  sessionOutline,
  setSetting,
  showSetting,
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

describe('listSubagents', () => {
  it('names the missing runtime', async () => {
    await expect(listSubagents(new Context(), sessionId, signal)).rejects.toThrow('subagents are not mounted in this profile')
  })

  it('indents descendants by depth with activity, mode, label, or diagnostic reason', async () => {
    const ctx = new Context()
    const asked: unknown[] = []
    ctx.provide('subagents', {
      listDescendants: (...args: unknown[]) => {
        asked.push(args)
        return Promise.resolve([
          { kind: 'child', id: 'session-a', activity: 'running', mode: 'continuable', label: 'reviewer', hasChildren: true, parentId: sessionId, depth: 1 },
          { kind: 'child', id: 'session-b', activity: 'inactive', mode: 'one-shot', hasChildren: false, parentId: 'session-a', depth: 2 },
          { kind: 'diagnostic', id: 'session-c', reason: 'corrupt', parentId: sessionId, depth: 1 },
        ])
      },
    } as never)
    await expect(listSubagents(ctx, sessionId, signal)).resolves.toEqual([
      'session-a  running  continuable  reviewer',
      '  session-b  inactive  one-shot',
      'session-c  corrupt',
    ])
    expect(asked).toEqual([[sessionId, signal]])
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
