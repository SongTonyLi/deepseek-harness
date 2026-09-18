/** The browser's status, outline, deliverables, subagent, settings, and plugin panels as terminal commands, plus the approval detail. */

import { describe, expect, it } from 'vitest'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { KEY, bench } from './bench.ts'

function typeLine(terminal: { type(data: string): void }, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

/** A projection registry stub whose snapshot the test controls and whose listeners it can fire. */
function projectionsStub(values: () => Record<string, unknown>): { stub: NonNullable<Exclude<Parameters<typeof bench>[0], undefined>['projections']>; fire(session: Session): void; disposed: number } {
  const listeners = new Set<(session: Session) => void>()
  const state = {
    disposed: 0,
    fire(session: Session) { for (const listener of listeners) listener(session) },
    stub: {
      snapshot: () => ({ asOfSeq: 1, values: values() }),
      onChanged(listener: (session: Session) => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener); state.disposed += 1 }
      },
    },
  }
  return state
}

describe('status', () => {
  it('folds the projection seam into the footer, redraws on change, and prints /status', async () => {
    const extra: { todos?: unknown[] } = {}
    const projections = projectionsStub(() => ({
      contextPressure: { projectedTokens: 54_000, pressureTokens: 50_000, contextWindow: 128_000 },
      plan: { active: true, pending: false },
      ...extra,
    }))
    const test = await bench({ projections: projections.stub })
    await test.settle()
    expect(test.terminal.text()).toContain('ctx 42%')
    expect(test.terminal.text()).toContain('+1')
    extra.todos = [{ id: '1', content: 'write tests', status: 'completed' }, { id: '2', content: 'ship', status: 'pending' }]
    projections.fire(test.session)
    await test.settle()
    expect(test.terminal.text()).toContain('+2')
    typeLine(test.terminal, '/status')
    await test.settle()
    expect(test.terminal.text()).toContain('context: ~54k / 128k (42%)')
    expect(test.terminal.text()).toContain('write tests')
    // Another session's change does not redraw this footer.
    projections.fire({ id: 'session-other' } as Session)
    test.app.stop()
    expect(projections.disposed).toBe(1)
  })

  it('shows an empty status without a projection registry', async () => {
    const test = await bench({ projections: 'none' })
    typeLine(test.terminal, '/status')
    await test.settle()
    expect(test.terminal.text()).toContain('no session status yet')
  })

  it('draws compaction and model-retry facts from the log', async () => {
    const test = await bench({ running: true })
    test.session.append('compaction/summary', {
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 3400,
      summary: 'earlier work',
      turn: 1,
    } as never)
    test.session.append('llm/retry', {
      mode: 'normal',
      retry: 2,
      maxRetries: 5,
      delayMs: 4000,
      failure: { code: 'RATE_LIMIT', message: 'provider busy' },
      turn: 1,
      step: 1,
    } as never)
    await test.settle()
    expect(test.terminal.text()).toContain('compacted 3 items (~3.4k tokens)')
    expect(test.terminal.text()).toContain('retrying (2/5) in 4s · RATE_LIMIT: provider busy')
  })
})

describe('catalog commands', () => {
  it('prints the outline, deliverables, and plugins, or their empty states', async () => {
    const test = await bench({
      projections: { snapshot: () => ({ asOfSeq: 1, values: { turnOutline: [{ turn: 1, seq: 0, prompt: 'Fix it', response: 'Fixed.' }] } }), onChanged: () => () => {} },
      before: (ctx) => {
        ctx.provide('sessionQuery', {
          observeSession: () => Promise.resolve({
            events: [{ type: 'deliverables/presented', seq: 1, time: 1, data: { turn: 1, callId: 'c', files: [{ path: 'report.md', description: 'Summary' }] } }],
            [Symbol.dispose]: () => {},
          }),
        } as never)
        ctx.provide('loader', { * entries() { yield { id: 'llm', options: { name: '@deepseek-ai/dsh-llm' }, disabled: false, fiber: { state: 2 } } } } as never)
      },
    })
    typeLine(test.terminal, '/outline')
    typeLine(test.terminal, '/deliverables')
    typeLine(test.terminal, '/plugins')
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('1. Fix it')
    expect(screen).toContain('report.md  Summary')
    expect(screen).toContain('llm  @deepseek-ai/dsh-llm  enabled  active')
    const empty = await bench({
      projections: { snapshot: () => ({ asOfSeq: 1, values: { turnOutline: [] } }), onChanged: () => () => {} },
      before: (ctx) => {
        ctx.provide('sessionQuery', { observeSession: () => Promise.resolve({ events: [], [Symbol.dispose]: () => {} }) } as never)
        ctx.provide('loader', { * entries() { /* nothing composed */ } } as never)
      },
    })
    typeLine(empty.terminal, '/outline')
    typeLine(empty.terminal, '/deliverables')
    typeLine(empty.terminal, '/plugins')
    await empty.settle()
    const blank = empty.terminal.text()
    expect(blank).toContain('no completed turn yet')
    expect(blank).toContain('nothing presented yet')
    expect(blank).toContain('no plugins are listed')
  })

  it('browses the changed files of a turn into one file\'s comparison, and notices a live announcement', async () => {
    const summary = { turn: 1, cwd: '/work', total: 2, added: 3, deleted: 1, files: [
      { path: 'src/a.ts', display: 'src/a.ts', added: 3, deleted: 1 },
      { path: 'img.png', display: 'img.png', added: 0, deleted: 0, binary: true },
    ] }
    const diffs: unknown[] = []
    const test = await bench({
      before: (ctx) => {
        ctx.provide('sessionQuery', {
          observeSession: () => Promise.resolve({
            events: [{ type: 'workspace/changes', seq: 4, time: 1, data: { turn: 1 } }],
            [Symbol.dispose]: () => {},
          }),
        } as never)
        ctx.provide('workspaceChanges', {
          summary: () => summary,
          diff: (...args: unknown[]) => {
            diffs.push(args.slice(0, 3))
            return Promise.resolve({
              kind: 'text', path: 'src/a.ts', display: 'src/a.ts', before: true, after: true, coarse: false,
              hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old line', '+new line'] }],
            })
          },
        } as never)
      },
    })
    typeLine(test.terminal, '/changes')
    await test.settle()
    let screen = test.terminal.text()
    expect(screen).toContain('turn 1 · 2 files · +3 −1')
    expect(screen).toContain('src/a.ts')
    expect(screen).toContain('+3 −1')
    expect(screen).toContain('binary')
    test.terminal.type(KEY.enter)
    await test.settle()
    screen = test.terminal.text()
    expect(screen).toContain('@@ -1,1 +1,1 @@')
    expect(screen).toContain('- old line')
    expect(screen).toContain('+ new line')
    expect(diffs).toEqual([[test.session.id, 4, 0]])
    // The page closes back into the picker, which draws before it takes the next key.
    test.terminal.type(KEY.escape)
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    typeLine(test.terminal, '/changes 7')
    typeLine(test.terminal, '/changes zero')
    await test.settle()
    screen = test.terminal.text()
    expect(screen).toContain('no changed files recorded for turn 7')
    expect(screen).toContain('usage: /changes · /changes <turn>')
    test.session.append('workspace/changes', { turn: 1 })
    await test.settle()
    expect(test.terminal.text()).toContain('turn 1 changed 2 files (+3 −1) · /changes')
  })

  it('prints the empty states of /changes without the recorder or without announcements', async () => {
    const test = await bench({
      before: (ctx) => {
        ctx.provide('sessionQuery', { observeSession: () => Promise.resolve({ events: [], [Symbol.dispose]: () => {} }) } as never)
        ctx.provide('workspaceChanges', { summary: () => undefined, diff: () => Promise.resolve(undefined) } as never)
      },
    })
    typeLine(test.terminal, '/changes')
    await test.settle()
    expect(test.terminal.text()).toContain('no changed files recorded yet')
    test.session.append('workspace/changes', { turn: 1 })
    await test.settle()
    expect(test.terminal.text()).not.toContain('changed 0 files')
    const empty = await bench({
      before: (ctx) => {
        ctx.provide('sessionQuery', {
          observeSession: () => Promise.resolve({ events: [{ type: 'workspace/changes', seq: 2, time: 1, data: { turn: 1 } }], [Symbol.dispose]: () => {} }),
        } as never)
        ctx.provide('workspaceChanges', { summary: () => ({ turn: 1, cwd: '/work', total: 0, added: 0, deleted: 0, files: [] }), diff: () => Promise.resolve(undefined) } as never)
      },
    })
    typeLine(empty.terminal, '/changes')
    await empty.settle()
    expect(empty.terminal.text()).toContain('turn 1 · 0 files · +0 −0: no file listed')
    const bare = await bench()
    typeLine(bare.terminal, '/changes')
    await bare.settle()
    expect(bare.terminal.text()).toContain('changes failed: workspace changes are not recorded in this profile')
  })

  it('manages bundles through /plugins verbs', async () => {
    const calls: unknown[] = []
    const test = await bench({
      before: (ctx) => {
        ctx.provide('loader', { * entries() { yield { id: 'llm', options: { name: '@deepseek-ai/dsh-llm' }, disabled: false, fiber: { state: 2 } } } } as never)
        ctx.provide('pluginManager', {
          listPlugins: () => Promise.resolve([{ entryId: 'llm', moduleName: '@deepseek-ai/dsh-llm', enabled: true, fiberPhase: 'active', patchId: 'llm' }]),
          listBundles: () => Promise.resolve([{ name: '@acme/bundle', version: '1.0.0', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] }]),
          setPluginEnabled: (...args: unknown[]) => {
            calls.push(args)
            return Promise.resolve({ changed: true, application: 'applied', stage: 'enable', target: 'llm', enabled: false })
          },
          installBundle: (spec: string) => Promise.resolve(spec === 'nope'
            ? { changed: false, application: 'failed', stage: 'install', target: 'nope', error: { code: 'not-found' } }
            : { changed: true, application: 'applied', stage: 'install', target: spec, bundle: '@acme/good', enabled: true }),
          removeBundle: () => Promise.resolve({ changed: true, application: 'restart-required', stage: 'remove', target: '@acme/bundle' }),
        } as never)
      },
    })
    typeLine(test.terminal, '/plugins bundles')
    typeLine(test.terminal, '/plugins disable llm')
    typeLine(test.terminal, '/plugins add nope')
    typeLine(test.terminal, '/plugins add acme-good')
    typeLine(test.terminal, '/plugins remove @acme/bundle')
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('@acme/bundle  1.0.0  enabled  installed  removable')
    expect(screen).toContain('enable llm: applied')
    expect(calls).toEqual([['llm', false]])
    expect(screen).toContain('installing nope…')
    expect(screen).toContain('plugins failed: install nope: unchanged, failed · not-found')
    expect(screen).toContain('install acme-good: applied · bundle @acme/good')
    expect(screen).toContain('remove @acme/bundle: restart-required')
    for (const incomplete of ['/plugins enable', '/plugins disable', '/plugins add', '/plugins remove', '/plugins dance']) {
      typeLine(test.terminal, incomplete)
      await test.settle()
    }
    expect(test.terminal.text().split('usage: /plugins · /plugins bundles').length).toBe(6)
  })

  it('lists, shows, sets, and resets settings', async () => {
    const writes: unknown[] = []
    const test = await bench({
      before: (ctx) => {
        ctx.provide('settings', {
          describe: () => [
            { ns: 'agent-default-model', revision: 3, value: { provider: 'deepseek', model: 'chat' }, user: { model: 'chat' }, applies: 'live', secrets: [] },
            { ns: 'shell', revision: 1, value: {}, user: {}, applies: 'restart', secrets: [] },
          ],
          mutate: (...args: unknown[]) => { writes.push(['mutate', ...args]); return Promise.resolve() },
          replace: (...args: unknown[]) => { writes.push(['replace', ...args]); return Promise.resolve() },
        } as never)
      },
    })
    typeLine(test.terminal, '/settings')
    await test.settle()
    expect(test.terminal.text()).toContain('agent-default-model  rev 3  user-overridden  applies live')
    typeLine(test.terminal, '/settings agent-default-model')
    await test.settle()
    expect(test.terminal.text()).toContain('"model": "chat"')
    typeLine(test.terminal, '/settings shell')
    await test.settle()
    expect(test.terminal.text()).toContain('{}')
    typeLine(test.terminal, '/settings agent-default-model model')
    typeLine(test.terminal, '/settings reset')
    await test.settle()
    expect(test.terminal.text()).toContain('usage: /settings <namespace> <path> <value>')
    expect(test.terminal.text()).toContain('usage: /settings reset <namespace>')
    typeLine(test.terminal, '/settings agent-default-model model reasoner')
    typeLine(test.terminal, '/settings reset shell')
    await test.settle()
    expect(writes).toEqual([
      ['mutate', 'agent-default-model', [{ op: 'set', path: ['model'], value: 'reasoner' }], 3],
      ['replace', 'shell', {}, 1],
    ])
    expect(test.terminal.text()).toContain('settings agent-default-model: set model = "reasoner"')
    expect(test.terminal.text()).toContain('settings shell: reset to defaults')
    typeLine(test.terminal, '/settings missing')
    await test.settle()
    expect(test.terminal.text()).toContain('/settings failed: settings namespace "missing" is not registered')
  })

  it('completes shared commands with their input hint', async () => {
    const test = await bench({
      before: async (ctx) => {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        await ctx.plugin(CommandRuntime)
        ctx.commands.register({ name: 'goal', description: 'Set the goal', input: { hint: '<objective>' }, handler: () => ({ kind: 'success' }) })
      },
    })
    for (const char of '/go') test.terminal.type(char)
    await test.settle()
    expect(test.terminal.text()).toContain('Set the goal · <objective>')
  })
})

describe('subagent sessions', () => {
  /** Two readable subagent sessions and one the listing could not read. */
  const descendants = [
    { kind: 'child', id: 'session-kid', activity: 'inactive', mode: 'one-shot', hasChildren: true, parentId: 'session-tui-test', depth: 1 },
    { kind: 'child', id: 'session-grandkid', activity: 'running', mode: 'continuable', label: 'reviewer', hasChildren: false, parentId: 'session-kid', depth: 2 },
    { kind: 'diagnostic', id: 'session-broken', reason: 'corrupt', parentId: 'session-tui-test', depth: 1 },
  ]

  /**
   * A bench whose subagent runtime lists `entries` and whose query engine
   * answers with one titled session per id.
   * @param entries - the descendant listing `/subagents` reads.
   * @returns the started bench.
   */
  function benchWithSubagents(entries: unknown[]): Promise<Awaited<ReturnType<typeof bench>>> {
    return bench({
      subagents: () => Promise.resolve(entries as never),
      before: (ctx) => {
        ctx.provide('sessionQuery', {
          observeSession: (id: string) => Promise.resolve({
            header: { id, createdAt: Date.UTC(2026, 1, 3, 14, 25, 30), cwd: `/work/${id}` },
            events: [],
            projections: { asOfSeq: 1, values: { title: `${id} title`, turnOutline: [] } },
            [Symbol.dispose]: () => {},
          }),
        } as never)
      },
    })
  }

  it('notices an empty list without opening anything', async () => {
    const test = await benchWithSubagents([])
    typeLine(test.terminal, '/subagents')
    await test.settle()
    expect(test.terminal.text()).toContain('no subagent sessions')
    expect(test.terminal.text()).not.toContain('Subagent sessions')
  })

  it('names the missing runtime', async () => {
    const test = await bench()
    typeLine(test.terminal, '/subagents')
    await test.settle()
    expect(test.terminal.text()).toContain('/subagents failed: subagents are not mounted in this profile')
  })

  it('walks the sessions, shows one session, and reopens the list on it', async () => {
    const test = await benchWithSubagents(descendants)
    typeLine(test.terminal, '/subagents')
    await test.settle()
    const listed = test.terminal.text()
    expect(listed).toContain('Subagent sessions')
    expect(listed).toContain('session-kid')
    expect(listed).toContain('inactive · one-shot')
    expect(listed).toContain('reviewer')

    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    const detail = test.terminal.text()
    expect(detail).toContain('workspace: /work/session-grandkid')
    expect(detail).toContain('title: session-grandkid title')
    expect(detail).toContain('created: 2026-02-03 14:25')
    expect(detail).toContain('↑ ↓ scroll · Enter, Esc, or ← returns')

    // Leaving the details reopens the list on the session just read.
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('reviewer ✓')

    test.terminal.type(KEY.up)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('workspace: /work/session-kid')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.text()).toContain('session-kid ✓')

    // A row the listing could not read opens its details all the same.
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('unreadable subagent session: corrupt')
    test.terminal.type(KEY.left)
    await test.settle()

    test.terminal.type(KEY.escape)
    await test.settle()
    typeLine(test.terminal, 'back to typing')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'back to typing' }]])
  })
})

describe('todo list', () => {
  const mixed: TodoItem[] = [
    { content: 'read the spec', status: 'completed' },
    { content: 'write the data layer', status: 'in_progress' },
    { content: 'wire the picker', status: 'pending' },
  ]

  it('walks the list, shows one item in full, and reopens the list on it', async () => {
    const test = await bench({ projections: projectionsStub(() => ({ todos: mixed })).stub })
    typeLine(test.terminal, '/todos')
    await test.settle()
    const listed = test.terminal.text()
    expect(listed).toContain('? Todos')
    expect(listed).toContain('✓ read the spec')
    expect(listed).toContain('▸ write the data layer')
    expect(listed).toContain('being worked on now')

    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    const detail = test.terminal.text()
    expect(detail).toContain('Todo 2')
    expect(detail).toContain('status: in progress')
    expect(detail).toContain('item 2 of 3')
    expect(detail).toContain('1 completed · 1 in progress · 1 pending')

    // Leaving the item reopens the list on it.
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('write the data layer ✓')

    test.terminal.type(KEY.up)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('status: completed')
    expect(test.terminal.text()).toContain('item 1 of 3')

    test.terminal.type(KEY.escape)
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    typeLine(test.terminal, 'back to typing')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'back to typing' }]])
  })

  it('draws a todo line too wide for the list default beside its status', async () => {
    const content = 'Wire the navigable todo list into the terminal status bar'
    const test = await bench({ projections: projectionsStub(() => ({ todos: [{ content, status: 'pending' }] })).stub })
    typeLine(test.terminal, '/todos')
    await test.settle()
    expect(test.terminal.text()).toContain(`○ ${content}`)
    expect(test.terminal.text()).toContain('pending')
  })

  it('opens the same list from the status bar, leaving the segment label alone', async () => {
    const test = await bench({ projections: projectionsStub(() => ({ todos: mixed })).stub })
    await test.settle()
    expect(test.terminal.text()).toContain('+1')
    // The bar holds the model segment first; effort is always next, then todo.
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('todo 1/3')
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('? Todos')
    // The list replaced the printed section, so /status keeps its own wording.
    expect(test.terminal.text()).not.toContain('todos: 1 done')
    test.terminal.type(KEY.escape)
    await test.settle()
    typeLine(test.terminal, 'after the list')
    await test.settle()
    expect(test.calls.followups).toHaveLength(1)
  })

  it('notices an empty list instead of opening a picker', async () => {
    const unmounted = await bench({ projections: 'none' })
    typeLine(unmounted.terminal, '/todos')
    await unmounted.settle()
    expect(unmounted.terminal.text()).toContain('no todos yet')
    expect(unmounted.terminal.text()).not.toContain('? Todos')
    const unwritten = await bench({ projections: projectionsStub(() => ({ todos: null })).stub })
    typeLine(unwritten.terminal, '/todos')
    typeLine(unwritten.terminal, '/help')
    await unwritten.settle()
    expect(unwritten.terminal.text()).toContain('no todos yet')
    expect(unwritten.terminal.text()).toContain('/todos')
    expect(unwritten.terminal.text()).toContain('Browse the agent\'s todo list (Enter shows one item in full)')
  })

  it('reports the turn an item was written in and the turn its status moved', async () => {
    let todos: TodoItem[] = []
    const test = await bench({ projections: projectionsStub(() => ({ todos })).stub })
    /** Log one turn that replaces the todo list with `next`. */
    const write = (turn: number, next: TodoItem[]): void => {
      test.session.append('turn/start', { turn })
      todos = next
      test.session.append('todo/write', { todos })
      test.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    write(1, [{ content: 'read the spec', status: 'in_progress' }, { content: 'ship it', status: 'pending' }])
    write(2, [{ content: 'read the spec', status: 'completed' }, { content: 'ship it', status: 'pending' }])
    // The third turn drops the second item, so its return in the fourth starts it over.
    write(3, [{ content: 'read the spec', status: 'completed' }])
    write(4, [{ content: 'read the spec', status: 'completed' }, { content: 'ship it', status: 'pending' }])
    await test.settle()

    typeLine(test.terminal, '/todos')
    await test.settle()
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('first written in turn 1')
    expect(test.terminal.text()).toContain('status last changed in turn 2')

    test.terminal.type(KEY.enter)
    await test.settle()
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('first written in turn 4')
    // The item has held its status since it came back, so it reports no change.
    expect(screen.split('status last changed in turn')).toHaveLength(2)
  })

  it('forgets the turn facts of the session it left', async () => {
    let todos: TodoItem[] = []
    const test = await bench({ projections: projectionsStub(() => ({ todos })).stub })
    test.session.append('turn/start', { turn: 7 })
    todos = [{ content: 'read the spec', status: 'pending' }]
    test.session.append('todo/write', { todos })
    await test.settle()
    typeLine(test.terminal, '/new')
    await test.settle()
    typeLine(test.terminal, '/todos')
    await test.settle()
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('status: pending')
    expect(test.terminal.text()).not.toContain('first written in turn')
  })

  it('reports a failing todo read from the status bar instead of crashing', async () => {
    const test = await bench({
      projections: {
        // Only the list's own one-key read fails, so the bar still draws its segments.
        snapshot: (_session: Session, keys: readonly string[]) => {
          if (keys.length === 1) throw new Error('the todos projection failed')
          return { asOfSeq: 1, values: { todos: [{ content: 'read the spec', status: 'pending' }] } }
        },
        onChanged: () => () => {},
      },
    })
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('/todos failed: the todos projection failed')
  })
})

describe('approval detail', () => {
  it('shows the logged tool call above the options when the request names it', async () => {
    const test = await bench()
    test.appendToolCall('call-9', 'bash', { command: 'rm -rf build' })
    const outcome = new Promise<ApprovalOutcome | undefined>((resolve) => {
      void test.ctx.waterfall('approval/request', { agent: test.agent, toolName: 'bash', callId: 'call-9' as ToolCallId, reason: 'deletes files' }, () => Promise.resolve<ApprovalOutcome>('unavailable')).then(resolve)
    })
    await test.settle()
    expect(test.terminal.text()).toContain('Allow bash?')
    expect(test.terminal.text()).toContain('deletes files')
    expect(test.terminal.text()).toContain('rm -rf build')
    test.terminal.type(KEY.enter)
    await expect(outcome).resolves.toBe('allowed-once')
  })
})
