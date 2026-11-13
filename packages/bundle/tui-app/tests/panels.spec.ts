/** The browser's status, outline, deliverables, subagent, settings, and plugin panels as terminal commands, plus the approval detail. */

import { describe, expect, it } from 'vitest'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { FADE_TICK_MS } from '../src/fade.ts'
import { ENTRY_HINTS, HINTS, widestHint } from '../src/keys.ts'
import { LANDING_TICKS, SEGMENT_TICKS } from '../src/motion.ts'
import { BENCH_SPINNER_MS, KEY, bench, spinning, type Bench } from './bench.ts'

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
    expect(test.terminal.text()).toContain('todo 1/2')
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

  it('draws model-retry facts from the log', async () => {
    const test = await bench({ running: true })
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
    expect(test.terminal.text()).toMatch(spinning('retrying (2/5) in 4s · RATE_LIMIT: provider busy', 'retrying'))
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

  it('selects the web-search route through the search settings', async () => {
    const writes: unknown[] = []
    const stored: { baseURL?: string } = {}
    const test = await bench({
      before: (ctx) => {
        ctx.provide('settings', {
          describe: () => [{ ns: 'web-search-deepseek', revision: 2, value: stored, user: {}, applies: 'live', secrets: [] }],
          mutate: (...args: unknown[]) => { writes.push(['mutate', ...args]); return Promise.resolve() },
          replace: (...args: unknown[]) => { writes.push(['replace', ...args]); return Promise.resolve() },
        } as never)
      },
    })
    typeLine(test.terminal, '/search')
    await test.settle()
    expect(test.terminal.text()).toContain('Web search route')
    expect(test.terminal.text()).toContain('DeepSeek ✓')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('web search: OpenRouter deepseek/deepseek-v4-flash-0731')
    stored.baseURL = 'https://openrouter.ai/api/v1'
    typeLine(test.terminal, '/search')
    await test.settle()
    expect(test.terminal.text()).toContain('OpenRouter DeepSeek ✓')
    test.terminal.type(KEY.escape)
    await test.settle()
    typeLine(test.terminal, '/search deepseek')
    typeLine(test.terminal, '/search openrouter deepseek/custom')
    typeLine(test.terminal, '/search google')
    typeLine(test.terminal, '/search deepseek extra')
    await test.settle()
    expect(writes).toEqual([
      ['mutate', 'web-search-deepseek', [{ op: 'set', path: ['baseURL'], value: 'https://openrouter.ai/api/v1' }], 2],
      ['mutate', 'web-search-deepseek', [{ op: 'set', path: ['apiKeyEnv'], value: 'OPENROUTER_API_KEY' }], 2],
      ['mutate', 'web-search-deepseek', [{ op: 'set', path: ['model'], value: 'deepseek/deepseek-v4-flash-0731' }], 2],
      ['replace', 'web-search-deepseek', {}, 2],
      ['mutate', 'web-search-deepseek', [{ op: 'set', path: ['baseURL'], value: 'https://openrouter.ai/api/v1' }], 2],
      ['mutate', 'web-search-deepseek', [{ op: 'set', path: ['apiKeyEnv'], value: 'OPENROUTER_API_KEY' }], 2],
      ['mutate', 'web-search-deepseek', [{ op: 'set', path: ['model'], value: 'deepseek/custom' }], 2],
    ])
    const screen = test.terminal.text()
    expect(screen).toContain('web search: DeepSeek')
    expect(screen).toContain('web search: OpenRouter deepseek/custom')
    expect(screen).toContain('unknown search route "google" (available: deepseek, openrouter)')
    expect(screen).toContain('usage: /search deepseek | /search openrouter [model]')
  })

  it('searches through the OpenRouter model /model selected', async () => {
    const writes: unknown[] = []
    const test = await bench({
      selected: { provider: 'openrouter', model: 'deepseek/picked' },
      before: (ctx) => {
        ctx.provide('settings', {
          describe: () => [{ ns: 'web-search-deepseek', revision: 1, value: {}, user: {}, applies: 'live', secrets: [] }],
          mutate: (...args: unknown[]) => { writes.push(args); return Promise.resolve() },
          replace: () => Promise.resolve(),
        } as never)
      },
    })
    typeLine(test.terminal, '/search openrouter')
    await test.settle()
    expect(writes.at(-1)).toEqual(['web-search-deepseek', [{ op: 'set', path: ['model'], value: 'deepseek/picked' }], 1])
    expect(test.terminal.text()).toContain('web search: OpenRouter deepseek/picked')
  })

  it('reports a search route failure when settings are not mounted', async () => {
    const test = await bench()
    typeLine(test.terminal, '/search deepseek')
    await test.settle()
    expect(test.terminal.text()).toContain('settings are not mounted in this profile')
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

  it('walks the sessions, opens one as a live view, and shows an unreadable row\'s reason', async () => {
    const test = await benchWithSubagents(descendants)
    typeLine(test.terminal, '/subagents')
    await test.settle()
    const listed = test.terminal.text()
    expect(listed).toContain('Subagent sessions')
    expect(listed).toContain('session-kid')
    expect(listed).toContain('inactive · one-shot')
    expect(listed).toContain('reviewer')

    // A readable row opens as a live view of that session, with its details
    // under the entry notice; /parent comes back, and the list reopens.
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    const detail = await test.screen()
    expect(detail).toContain('subagent view')
    expect(detail).toContain('workspace: /work/session-grandkid')
    expect(detail).toContain('title: session-grandkid title')
    expect(detail).toContain('created: 2026-02-03 14:25')
    typeLine(test.terminal, '/parent')
    await test.settle()
    expect(await test.screen()).toContain('back in session session-tui-test')
    typeLine(test.terminal, '/subagents')
    await test.settle()

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

describe('todos page', () => {
  const ENTER_ALT = '\u001b[?1049h'
  const LEAVE_ALT = '\u001b[?1049l'
  const CTRL_T = '\u0014'
  const mixed: TodoItem[] = [
    { content: 'read the spec', status: 'completed' },
    { content: 'write the data layer', status: 'in_progress' },
    { content: 'wire the page', status: 'pending' },
  ]

  /** What the alternate screen drew since the page last opened, escape sequences removed. */
  function page(test: Bench): string {
    const written = test.terminal.written
    return written.slice(written.lastIndexOf(ENTER_ALT)).replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '')
  }

  it('opens the todo list on its own screen, details the selected item, and gives the editor back on Esc', async () => {
    const test = await bench({ projections: projectionsStub(() => ({ todos: mixed })).stub })
    typeLine(test.terminal, '/todos')
    await test.settle()
    expect(test.terminal.written).toContain(ENTER_ALT)
    const drawn = page(test)
    expect(drawn).toContain('todos · 1/3 delivered')
    expect(drawn).toContain('agent · 1/3')
    expect(drawn).toContain('✓ read the spec')
    expect(drawn).toContain('wire the page')
    expect(drawn).toContain('owner  agent · orchestrator')

    test.terminal.type(KEY.down)
    test.terminal.type(KEY.down)
    await test.settle()
    expect(page(test)).toContain('state  deferred · left open when the turn ended')

    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.written.endsWith(LEAVE_ALT) || test.terminal.written.includes(LEAVE_ALT)).toBe(true)
    typeLine(test.terminal, 'back to typing')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'back to typing' }]])
  })

  it('reveals the rows on the spinner tick when color is on, then settles with delivered content scratched out', async () => {
    const test = await bench({ color: true, projections: projectionsStub(() => ({ todos: mixed })).stub })
    typeLine(test.terminal, '/todos')
    await test.settle()
    // The opening reveal draws the branch first and its todos on later steps;
    // until then only the detail pane names the delivered todo. Each later
    // paint writes only the rows it changed, so the count only grows.
    const named = (): number => page(test).split('✓ read the spec').length - 1
    expect(test.tickArmed(BENCH_SPINNER_MS)).toBe(true)
    expect(named()).toBe(1)
    for (let step = 0; step < 16 && test.tickArmed(BENCH_SPINNER_MS); step += 1) test.runTick(BENCH_SPINNER_MS)
    await test.settle()
    expect(test.tickArmed(BENCH_SPINNER_MS)).toBe(false)
    expect(named()).toBeGreaterThan(1)
    expect(test.terminal.written).toContain('\u001b[9mread the spec')
    expect(test.terminal.written).not.toContain('\u001b[9mwrite the data layer')
  })

  it('draws the settled page at once and arms no tick for it under reduced motion', async () => {
    const test = await bench({ color: true, reducedMotion: true, projections: projectionsStub(() => ({ todos: mixed })).stub })
    typeLine(test.terminal, '/todos')
    await test.settle()
    expect(page(test)).toContain('✓ read the spec')
    expect(page(test)).toContain('wire the page')
    expect(test.tickArmed(BENCH_SPINNER_MS)).toBe(false)
  })

  it('opens the same page from Ctrl+T and from the status bar, and Ctrl+T closes it', async () => {
    const test = await bench({ projections: projectionsStub(() => ({ todos: mixed })).stub })
    await test.settle()
    test.terminal.type(CTRL_T)
    await test.settle()
    expect(page(test)).toContain('todos · 1/3 delivered')
    test.terminal.type(CTRL_T)
    await test.settle()
    expect(test.terminal.written.lastIndexOf(LEAVE_ALT)).toBeGreaterThan(test.terminal.written.lastIndexOf(ENTER_ALT))

    // The bar holds the model segment first; effort is always next, then todo.
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.written.lastIndexOf(ENTER_ALT)).toBeGreaterThan(test.terminal.written.lastIndexOf(LEAVE_ALT))
    expect(page(test)).toContain('todos · 1/3 delivered')
    test.terminal.type(KEY.escape)
    await test.settle()
    typeLine(test.terminal, 'after the page')
    await test.settle()
    expect(test.calls.followups).toHaveLength(1)
  })

  it('notices an empty list instead of opening the page', async () => {
    const unmounted = await bench({ projections: 'none' })
    typeLine(unmounted.terminal, '/todos')
    await unmounted.settle()
    expect(unmounted.terminal.text()).toContain('no todos yet')
    expect(unmounted.terminal.written).not.toContain(ENTER_ALT)
    const unwritten = await bench({ projections: projectionsStub(() => ({ todos: null })).stub })
    typeLine(unwritten.terminal, '/todos')
    typeLine(unwritten.terminal, '/help')
    await unwritten.settle()
    expect(unwritten.terminal.text()).toContain('no todos yet')
    expect(unwritten.terminal.text()).toContain('Open the work page')
    expect(unwritten.terminal.written).not.toContain(ENTER_ALT)
  })

  it('repaints a todo write while open, with the turn an item was written in and the turn its status moved', async () => {
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
    await test.settle()

    typeLine(test.terminal, '/todos')
    await test.settle()
    test.terminal.type(KEY.down)
    await test.settle()
    expect(page(test)).toContain('first written in turn 1')
    expect(page(test)).toContain('status last changed in turn 2')

    write(4, [{ content: 'read the spec', status: 'completed' }, { content: 'ship it', status: 'pending' }])
    await test.settle()
    expect(page(test)).toContain('todos · 1/2 delivered')
    test.terminal.type(KEY.down)
    await test.settle()
    const drawn = page(test).slice(page(test).lastIndexOf('ship it'))
    expect(drawn).toContain('first written in turn 4')
    // The item has held its status since it came back, so it reports no change.
    expect(drawn).not.toContain('status last changed in turn')
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
    test.terminal.type(KEY.down)
    await test.settle()
    expect(page(test)).toContain('read the spec')
    expect(page(test)).not.toContain('first written in turn')
  })
})

/** One resident child, which is what makes the subagent panel draw a row. */
const RESIDENT_CHILD = {
  kind: 'child',
  id: 'session-kid',
  parentId: 'session-tui-test',
  depth: 1,
  mode: 'one-shot',
  activity: 'running',
}

describe('one legend grammar', () => {
  /** What a legend clause must open with: a key, never a noun. */
  const KEY_LED = /^(?:[↑↓←→⇧@/]|Shift\+|Ctrl\+|PgUp|PgDn|Home|End|Tab|Enter|Esc|Space)/u

  /**
   * Whether one legend is key clauses joined by the shared separator.
   * @param legend - the drawn legend.
   * @returns true when every clause opens with a key.
   */
  function keyLed(legend: string): boolean {
    return legend.split(' · ').every(clause => KEY_LED.test(clause))
  }

  it('names keys in clauses and ends each docked legend on where Esc goes', async () => {
    const test = await bench({ subagents: () => Promise.resolve([RESIDENT_CHILD] as never) })
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    test.tick()
    typeLine(test.terminal, 'read the spec')
    await test.settle()
    // Unfocused, the bar's own line ends on the keys that leave the input.
    expect((await test.screen()).trimEnd().endsWith(ENTRY_HINTS[0] as string)).toBe(true)
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain(widestHint('transcript'))
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(await test.screen()).toContain(widestHint('panel'))
    test.terminal.type(KEY.down)
    await test.settle()
    expect(await test.screen()).toContain(widestHint('bar'))
    // One grammar: key clauses, the last of them naming where Esc goes.
    for (const region of ['transcript', 'panel', 'bar'] as const) {
      for (const step of HINTS[region]) {
        expect(keyLed(step), step).toBe(true)
        expect(step.endsWith('Esc input'), step).toBe(true)
      }
    }
    // The input has no legend of its own: the keys that reach it are named
    // where the keyboard is, and the keys that leave it on the bar's line.
    for (const step of ENTRY_HINTS) expect(keyLed(step), step).toBe(true)
  })
})

describe('the status bar ends and the region cycle', () => {
  it('selects the first and last segment with Home, End, and the Shift arrows', async () => {
    const test = await bench()
    // The bar of a plain session draws the model, the effort, and the workspace.
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.end)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('workspace: /work')
    test.terminal.type(KEY.home)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('model: test-model')
    test.terminal.type(KEY.shiftRight)
    await test.settle()
    expect(await test.screen()).toContain('workspace: /work · ←→ segments')
    test.terminal.type(KEY.shiftLeft)
    await test.settle()
    expect(await test.screen()).toContain('provider: test-provider · ←→ segments')
  })

  it('cycles the bar to the conversation with Tab, and through the panel while one is drawn', async () => {
    const test = await bench()
    typeLine(test.terminal, 'read the spec')
    await test.settle()
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    // With no panel drawn the walk wraps from the bar straight to the
    // conversation, in both directions.
    test.terminal.type(KEY.tab)
    await test.settle()
    expect(await test.screen()).toContain('1/1 · turn 0 · you')
    test.terminal.type(KEY.tab)
    await test.settle()
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    expect(await test.screen()).toContain('1/1 · turn 0 · you')
  })

  it('walks the bar backwards into the panel instead of moving its selection', async () => {
    const test = await bench({ subagents: () => Promise.resolve([RESIDENT_CHILD] as never) })
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    test.tick()
    await test.settle()
    expect(test.terminal.text()).toContain('subagents · 1 listed')
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.down)
    await test.settle()
    expect(await test.screen()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    // Shift+Tab used to move the bar's selection, which Left already does.
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    expect(await test.screen()).toContain('↑↓ children · Enter opens · Tab regions · Esc input')
    test.terminal.type(KEY.tab)
    await test.settle()
    expect(await test.screen()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    test.terminal.type(KEY.enter)
    await test.settle()
    // The selection stayed on the first segment through the walk.
    expect(test.terminal.text()).toContain('model: test-model')
  })

  it('walks the conversation, the panel, and the bar in the order they are drawn, both ways', async () => {
    const test = await bench({ subagents: () => Promise.resolve([RESIDENT_CHILD] as never) })
    typeLine(test.terminal, 'read the spec')
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    test.tick()
    await test.settle()
    /** The legend the region holding the keyboard draws right now. */
    const region = async (): Promise<string> => {
      const shown = await test.screen()
      if (shown.includes('↑↓ sections · ←→ parts')) return 'conversation'
      if (shown.includes('↑↓ children · Enter opens')) return 'panel'
      if (shown.includes('←→ segments · Enter details')) return 'bar'
      return 'editor'
    }
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await region()).toBe('conversation')
    const forward: string[] = []
    for (let step = 0; step < 3; step += 1) {
      test.terminal.type(KEY.tab)
      await test.settle()
      forward.push(await region())
    }
    expect(forward).toEqual(['panel', 'bar', 'conversation'])
    const backward: string[] = []
    for (let step = 0; step < 3; step += 1) {
      test.terminal.type(KEY.shiftTab)
      await test.settle()
      backward.push(await region())
    }
    expect(backward).toEqual(['bar', 'panel', 'conversation'])
  })

  it('draws the selection Shift+Down puts back on the first segment', async () => {
    const test = await bench()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.right)
    await test.settle()
    expect(await test.screen()).toContain('reasoning effort: the model')
    // Naming the bar again starts it at its first segment, which has to reach
    // the screen before Enter opens a segment nothing draws as selected.
    test.terminal.output = ''
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('provider: test-provider · ←→ segments')
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('model: test-model')
  })

  it('holds the bar when it is the only region drawn', async () => {
    const test = await bench()
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(await test.screen()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    // An empty conversation is not in the walk, so Tab says nothing about
    // having nothing to read: it simply comes back to the bar.
    test.terminal.type(KEY.tab)
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    expect(test.terminal.text()).not.toContain('nothing in the transcript to read yet')
    expect(await test.screen()).toContain('←→ segments · Enter details · Tab regions · Esc input')
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

describe('the lift under the editor', () => {
  /**
   * One complete repaint with its escape sequences, always at the same width
   * so two captures are comparable.
   * @param test - the running bench.
   * @returns the frame as the terminal received it.
   */
  async function repaint(test: Bench): Promise<string> {
    test.terminal.resize(96)
    await test.settle()
    test.terminal.output = ''
    test.terminal.resize(100)
    await test.settle()
    return test.terminal.output
  }

  /** The peak of a lift: the one moment a mark under the editor is drawn bold. */
  const PEAK = '\u001b[1m\u001b[38;5;111m\u001b[38;5;111m'

  it('lifts the segment a walk along the bar reaches and settles it on the accent', async () => {
    const test = await bench({ color: true })
    await test.settle()
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    // The bar takes the keyboard on its first segment, lifted.
    expect(await repaint(test)).toContain(`${PEAK}[test-model]`)
    test.runTick(FADE_TICK_MS, LANDING_TICKS * FADE_TICK_MS)
    await test.settle()
    expect(await repaint(test)).toContain('\u001b[38;5;111m[test-model]')

    test.terminal.type(KEY.right)
    await test.settle()
    const moved = await repaint(test)
    expect(moved).toContain(`${PEAK}[effort default]`)
    expect(moved).not.toContain(`${PEAK}[test-model]`)
    test.runTick(FADE_TICK_MS, SEGMENT_TICKS * FADE_TICK_MS)
    await test.settle()
    const settled = await repaint(test)
    expect(settled).toContain('\u001b[38;5;111m[effort default]')
    expect(settled).not.toContain(PEAK)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('lifts the panel row the keyboard lands on and repaints it as the lift falls', async () => {
    const test = await bench({ color: true, subagents: () => Promise.resolve([RESIDENT_CHILD] as never) })
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    test.tick()
    await test.settle()
    expect(test.terminal.text()).toContain('subagents · 1 listed')
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    // The panel draws its text when something changes it rather than once per
    // frame, so the fade tick is what walks its lift back down.
    expect(await repaint(test)).toContain(`${PEAK}session-kid`)
    test.runTick(FADE_TICK_MS, LANDING_TICKS * FADE_TICK_MS)
    await test.settle()
    const settled = await repaint(test)
    expect(settled).toContain('\u001b[38;5;111msession-kid')
    expect(settled).not.toContain(PEAK)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })
})
