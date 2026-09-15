/** The browser's status, outline, deliverables, subagent, settings, and plugin panels as terminal commands, plus the approval detail. */

import { describe, expect, it } from 'vitest'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
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
    let todos: unknown[] = []
    const projections = projectionsStub(() => ({
      contextPressure: { projectedTokens: 54_000, pressureTokens: 50_000, contextWindow: 128_000 },
      todos,
      plan: { active: true, pending: false },
    }))
    const test = await bench({ projections: projections.stub })
    await test.settle()
    expect(test.terminal.text()).toContain('ctx 42%')
    expect(test.terminal.text()).toContain('plan')
    todos = [{ id: '1', content: 'write tests', status: 'completed' }, { id: '2', content: 'ship', status: 'pending' }]
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
  it('prints the outline, deliverables, subagents, and plugins, or their empty states', async () => {
    const test = await bench({
      projections: { snapshot: () => ({ asOfSeq: 1, values: { turnOutline: [{ turn: 1, seq: 0, prompt: 'Fix it', response: 'Fixed.' }] } }), onChanged: () => () => {} },
      before: (ctx) => {
        ctx.provide('sessionQuery', {
          observeSession: () => Promise.resolve({
            events: [{ type: 'deliverables/presented', seq: 1, time: 1, data: { turn: 1, callId: 'c', files: [{ path: 'report.md', description: 'Summary' }] } }],
            [Symbol.dispose]: () => {},
          }),
        } as never)
        ctx.provide('subagents', {
          listDescendants: () => Promise.resolve([{ kind: 'child', id: 'session-kid', activity: 'inactive', mode: 'one-shot', hasChildren: false, parentId: 'x', depth: 1 }]),
        } as never)
        ctx.provide('loader', { * entries() { yield { id: 'llm', options: { name: '@deepseek-ai/dsh-llm' }, disabled: false, fiber: { state: 2 } } } } as never)
      },
    })
    typeLine(test.terminal, '/outline')
    typeLine(test.terminal, '/deliverables')
    typeLine(test.terminal, '/subagents')
    typeLine(test.terminal, '/plugins')
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('1. Fix it')
    expect(screen).toContain('report.md  Summary')
    expect(screen).toContain('session-kid  inactive  one-shot')
    expect(screen).toContain('llm  @deepseek-ai/dsh-llm  enabled  active')
    const empty = await bench({
      projections: { snapshot: () => ({ asOfSeq: 1, values: { turnOutline: [] } }), onChanged: () => () => {} },
      before: (ctx) => {
        ctx.provide('sessionQuery', { observeSession: () => Promise.resolve({ events: [], [Symbol.dispose]: () => {} }) } as never)
        ctx.provide('subagents', { listDescendants: () => Promise.resolve([]) } as never)
        ctx.provide('loader', { * entries() { /* nothing composed */ } } as never)
      },
    })
    typeLine(empty.terminal, '/outline')
    typeLine(empty.terminal, '/deliverables')
    typeLine(empty.terminal, '/subagents')
    typeLine(empty.terminal, '/plugins')
    await empty.settle()
    const blank = empty.terminal.text()
    expect(blank).toContain('no completed turn yet')
    expect(blank).toContain('nothing presented yet')
    expect(blank).toContain('no subagent sessions')
    expect(blank).toContain('no plugins are listed')
    const bare = await bench()
    typeLine(bare.terminal, '/subagents')
    await bare.settle()
    expect(bare.terminal.text()).toContain('/subagents failed: subagents are not mounted in this profile')
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
