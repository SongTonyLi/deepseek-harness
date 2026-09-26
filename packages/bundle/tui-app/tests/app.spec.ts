/** The terminal application over a scripted Agent: rendering, keys, commands, and the two interaction seams. */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { TOOL_RUNNING_ROW } from '../src/blocks.ts'
import { FADE_TICK_MS } from '../src/fade.ts'
import { ENTRY_HINTS, ESCAPE_HANDOFF_MS, FOCUS_REGIONS, HINTS, KEY_LINES, QUEUE_ENTRY_HINT, REGION_LABELS, entryHints, widestHint } from '../src/keys.ts'
import { READER_HINTS, TOO_SMALL } from '../src/reader.ts'
import { SPINNER_MS, shimmer } from '../src/spinner.ts'
import { createPalette } from '../src/style.ts'
import { NOTHING_TO_READ_TOAST, QUIT_TOAST } from '../src/toast.ts'
import { foldMarker } from '../src/transcript.ts'
import { BENCH_NOW, KEY, bench, spinning, type Bench } from './bench.ts'
import { testContextSource } from './message-sources.ts'

function typeLine(terminal: { type(data: string): void }, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

/** A projection registry stub whose snapshot the test controls. */
function projectionsStub(values: () => Record<string, unknown>): NonNullable<Exclude<Parameters<typeof bench>[0], undefined>['projections']> {
  return {
    snapshot: () => ({ asOfSeq: 1, values: values() }),
    onChanged() { return () => {} },
  }
}

/** Open a turn and log `next` as the current todo list. */
function writeTodos(test: Bench, next: TodoItem[], turn = 1): void {
  test.session.append('turn/start', { turn })
  test.session.append('todo/write', { todos: next })
}

/** A system prompt longer than any fold budget. */
const RULES = Array.from({ length: 6 }, (_, index) => `rule ${String(index)}`).join('\n')

describe('TuiApp', () => {
  it('draws the header, footer, and a submitted prompt, and hands the prompt to the idle Agent', async () => {
    const test = await bench()
    await test.settle()
    expect(test.terminal.started).toBe(true)
    expect(test.terminal.title).toBe('dsh · /work')
    const screen = test.terminal.text()
    expect(screen).toContain('session session-tui-test')
    expect(screen).toContain('test-model · effort default')
    expect(screen).toContain('/work')

    typeLine(test.terminal, 'hello there')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'hello there' }]])
    expect(test.terminal.text()).toContain('❯ hello there')
    // The durable echo of that same message is not drawn twice.
    const [submitted] = test.calls.followups
    test.session.append('turn/start', { turn: 1 })
    test.session.append('user/message', submitted!, { surfaceOp: 'append' })
    await test.settle()
    expect(test.terminal.text().split('❯ hello there')).toHaveLength(2)
  })

  it('ignores blank input, queues Enter for the next turn while running, and steers on Ctrl+S', async () => {
    const test = await bench()
    test.terminal.type(KEY.enter)
    test.terminal.type(' ')
    test.terminal.type(KEY.enter)
    test.terminal.type(KEY.ctrlS)
    expect(test.calls.followups).toHaveLength(0)
    test.setStatus('running')
    typeLine(test.terminal, 'also do this')
    await test.settle()
    expect(test.calls.followups).toHaveLength(1)
    expect(test.calls.steers).toHaveLength(0)
    expect(test.terminal.text()).toContain('queued for the next turn')
    for (const char of 'right now') test.terminal.type(char)
    test.terminal.type(KEY.ctrlS)
    await test.settle()
    expect(test.calls.steers).toHaveLength(1)
    expect(test.terminal.text()).toContain('steering the running turn')
    expect(test.terminal.text()).toContain('thinking')
    test.setStatus('idle')
    test.setStatus('idle')
    await test.settle()
  })

  it('focuses the framed queue to inject, steer, or edit its selected prompt', async () => {
    const test = await bench({ running: true })
    const inject = createUserMessage({ content: [{ type: 'text', text: 'context only' }], source: { kind: 'user' } })
    test.agent.inbox.append('next-turn', inject)
    test.agent.ctx.emit('agent/inbox/inserted', { agent: test.agent, message: inject })
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('↑↓ select · Enter steer · E edit · I inject · Esc input')
    test.terminal.type('i')
    expect(test.calls.injections).toEqual([inject])
    expect(test.calls.steers).toHaveLength(0)

    const steer = createUserMessage({ content: [{ type: 'text', text: 'change course' }], source: { kind: 'user' } })
    test.agent.inbox.append('next-turn', steer)
    test.agent.ctx.emit('agent/inbox/inserted', { agent: test.agent, message: steer })
    test.terminal.type(KEY.shiftUp)
    test.terminal.type('s')
    expect(test.calls.steers).toEqual([steer])

    const edit = createUserMessage({ content: [{ type: 'text', text: 'draft answer' }], source: { kind: 'user' } })
    test.agent.inbox.append('next-turn', edit)
    test.agent.ctx.emit('agent/inbox/inserted', { agent: test.agent, message: edit })
    test.terminal.type(KEY.shiftUp)
    test.terminal.type('e')
    test.terminal.type(' revised')
    test.terminal.type(KEY.enter)
    expect(test.calls.followups.at(-1)?.content).toEqual([{ type: 'text', text: 'draft answer revised' }])
  })

  it('restores the original queued prompt when an edit is canceled', async () => {
    const test = await bench({ running: true })
    const original = createUserMessage({ content: [{ type: 'text', text: 'keep this' }], source: { kind: 'user' } })
    test.agent.inbox.append('next-turn', original)
    test.agent.ctx.emit('agent/inbox/inserted', { agent: test.agent, message: original })
    test.terminal.type(KEY.shiftUp)
    test.terminal.type('e')
    expect(test.agent.inbox.nextTurn).toEqual([])
    test.terminal.type(KEY.ctrlC)
    expect(test.agent.inbox.nextTurn).toEqual([original])
    expect(test.calls.followups).toHaveLength(0)
    await test.settle()
    expect(await test.screen()).toContain('○ keep this')
  })

  it('opens the newest queued prompt for editing on Up from an empty input, and leaves Up to a draft', async () => {
    const test = await bench({ running: true })
    const first = createUserMessage({ content: [{ type: 'text', text: 'first follow-up' }], source: { kind: 'user' } })
    const newest = createUserMessage({ content: [{ type: 'text', text: 'newest follow-up' }], source: { kind: 'user' } })
    test.agent.inbox.append('next-turn', first)
    test.agent.inbox.append('next-turn', newest)
    test.agent.ctx.emit('agent/inbox/inserted', { agent: test.agent, message: newest })
    for (const char of 'draft') test.terminal.type(char)
    test.terminal.type(KEY.up)
    expect(test.agent.inbox.nextTurn).toEqual([first, newest])
    test.terminal.type(KEY.ctrlC)

    test.terminal.type(KEY.up)
    expect(test.agent.inbox.nextTurn).toEqual([first])
    test.terminal.type(' revised')
    test.terminal.type(KEY.enter)
    expect(test.calls.followups.at(-1)?.content).toEqual([{ type: 'text', text: 'newest follow-up revised' }])
  })

  it('enters follow-ups on Shift+Up and the status bar on Shift+Down while prompts wait', async () => {
    const test = await bench({ running: true })
    const later = createUserMessage({ content: [{ type: 'text', text: 'what\'s the current progress' }], source: { kind: 'user' } })
    test.agent.inbox.append('next-turn', later)
    test.agent.ctx.emit('agent/inbox/inserted', { agent: test.agent, message: later })
    await test.settle()
    const idle = await test.screen()
    expect(idle).toContain(QUEUE_ENTRY_HINT)
    expect(idle).not.toContain('shift+↓ select')
    expect(idle).toContain('Shift+↑ select · Shift+↓ status')
    expect(idle).not.toContain('Shift+↑ read · Shift+↓ status')

    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    test.terminal.type(KEY.escape)
    await test.settle()

    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('↑↓ select · Enter steer · E edit · I inject · Esc input')
  })

  it('holds a queued prompt above the editor until the loop claims it, and draws it in the conversation then', async () => {
    const test = await bench({ running: true })
    // The inbox is scripted, so the bench appends what the Agent's followup
    // would have and emits the insertion the live inbox emits.
    const later = createUserMessage({ content: [{ type: 'text', text: 'later on\nsecond line' }], source: { kind: 'user' } })
    const soon = createUserMessage({ content: [{ type: 'text', text: 'right now' }], source: { kind: 'user' } })
    test.agent.inbox.append('next-turn', later)
    test.agent.inbox.append('next-step', soon)
    test.agent.ctx.emit('agent/inbox/inserted', { agent: test.agent, message: later })
    await test.settle()
    let screen = await test.screen()
    // The steer row comes first, as the loop takes it first; a multi-line
    // prompt shows its first line. Neither is a conversation block yet.
    expect(screen).toContain('follow-ups')
    expect(screen).toContain('○ right now')
    expect(screen).toContain('○ later on')
    expect(screen).not.toContain('second line')
    expect(screen).not.toContain('❯ later on')
    expect(screen.indexOf('○ right now')).toBeLessThan(screen.indexOf('○ later on'))
    // Claimed: it leaves the queue and its durable message draws the block.
    test.agent.inbox.remove(soon.id)
    test.agent.ctx.emit('agent/inbox/claimed', { agent: test.agent, message: soon, turn: 1 })
    test.session.append('user/message', soon, { surfaceOp: 'append' })
    await test.settle()
    screen = await test.screen()
    expect(screen).not.toContain('○ right now')
    expect(screen).toContain('❯ right now')
    expect(screen).toContain('○ later on')
    // Discarded: the row goes and no block is drawn for it.
    test.agent.inbox.remove(later.id)
    test.agent.ctx.emit('agent/inbox/discarded', { agent: test.agent, message: later })
    await test.settle()
    screen = await test.screen()
    expect(screen).not.toContain('follow-ups')
    expect(screen).not.toContain('later on')
    // Another Agent's inbox is not this terminal's queue, whichever way it moves.
    const other = { id: 'other' } as never
    test.agent.inbox.append('next-turn', later)
    test.agent.ctx.emit('agent/inbox/inserted', { agent: other, message: later })
    test.agent.ctx.emit('agent/inbox/claimed', { agent: other, message: later, turn: 1 })
    test.agent.ctx.emit('agent/inbox/discarded', { agent: other, message: later })
    await test.settle()
    expect(await test.screen()).not.toContain('follow-ups')
  })

  it('streams reasoning and text, then replaces them with the committed message and its usage', async () => {
    const test = await bench()
    test.stream.start()
    test.stream.chunk({ type: 'text-delta', index: 0, text: '' })
    test.stream.chunk({ type: 'reasoning-delta', index: 0, text: '' })
    test.stream.chunk({ type: 'reasoning-delta', index: 0, text: 'let me think' })
    test.stream.chunk({ type: 'text-delta', index: 1, text: 'Hello ' })
    test.stream.chunk({ type: 'text-delta', index: 1, text: '**world**' })
    test.stream.chunk({ type: 'tool-call-delta', index: 2, id: 'call-1' as never, name: 'bash', argumentsDelta: '{' })
    test.stream.chunk({ type: 'tool-call-delta', index: 2, id: 'call-1' as never, argumentsDelta: '}' })
    test.stream.chunk({ type: 'block-start', index: 3, blockType: 'text' })
    test.stream.chunk({ type: 'block-end', index: 3, block: { type: 'text', text: '' } })
    test.stream.chunk({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } })
    test.stream.chunk({ type: 'finish', reason: { kind: 'stop' } })
    await test.settle()
    expect(test.terminal.text()).toContain('let me think')
    expect(test.terminal.text()).toContain('Hello world')
    test.appendAssistant(
      [{ type: 'reasoning', text: 'final thought' }, { type: 'text', text: 'Hello **there**' }],
      { usage: { inputTokens: 1200, outputTokens: 34 } },
    )
    test.stream.end({ kind: 'committed', eventType: 'assistant/message', seq: test.session.seq as never })
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('final thought')
    expect(screen).toContain('Hello there')
    expect(screen).toContain('+1')
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('↑1.2k ↓34 ctx 1.2k')
  })

  it('drops an abandoned attempt that streamed nothing and keeps one that did', async () => {
    const test = await bench()
    test.stream.start()
    test.stream.end({ kind: 'abandoned' })
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'text-delta', index: 0, text: 'partial' })
    test.stream.end({ kind: 'abandoned' })
    await test.settle()
    expect(test.terminal.text()).toContain('partial')
    // A committed message with no streamed frames still renders.
    test.appendAssistant([{ type: 'text', text: 'direct' }], { interrupted: true })
    await test.settle()
    expect(test.terminal.text()).toContain('direct')
    expect(test.terminal.text()).toContain('[interrupted]')
  })

  it('shows live send and receive tokens on the spinner for each model call', async () => {
    const contextPressure = { projectedTokens: 141_100, pressureTokens: 50_000, contextWindow: 200_000 }
    const test = await bench({
      running: true,
      projections: {
        snapshot: () => ({ asOfSeq: -1, values: { contextPressure } }),
        onChanged: () => () => {},
      },
    })
    test.stream.start()
    await test.settle()
    expect(test.terminal.text()).toContain('thinking ↑141.1k tokens')
    test.stream.chunk({ type: 'text-delta', index: 0, text: 'abcd' })
    await test.settle()
    expect(test.terminal.text()).toContain('writing ↑141.1k ↓1 tokens')
    test.stream.chunk({ type: 'tool-call-delta', index: 1, id: 'call-1' as never, name: 'read', argumentsDelta: '' })
    await test.settle()
    expect(test.terminal.text()).toContain('calling read ↑141.1k ↓1 tokens')
    test.stream.chunk({ type: 'usage', usage: { inputTokens: 1200, outputTokens: 34 } })
    test.stream.chunk({ type: 'text-delta', index: 2, text: 'xxxxxxxx' })
    await test.settle()
    expect(test.terminal.text()).toContain('calling read ↑1.2k ↓34 tokens')
    expect(test.terminal.text()).not.toContain('↓36')
    test.stream.end({ kind: 'committed', eventType: 'assistant/message', seq: 1 as never })
    await test.settle()
    expect(test.terminal.text()).toContain('calling read ↑1.2k ↓34 tokens')
    test.stream.start()
    const nextCall = await test.screen()
    expect(nextCall).toContain('thinking ↑141.1k tokens')
    expect(nextCall).not.toContain('thinking ↑141.1k ↓')
    test.appendAssistant(
      [{ type: 'text', text: 'done' }],
      { usage: { inputTokens: 1200, outputTokens: 34 } },
    )
    test.terminal.type(KEY.shiftDown)
    const screen = await test.screen()
    expect(screen).toContain('↑1.2k ↓34 ctx 1.2k')
    expect(screen).not.toContain('thinking ↑')
    test.setStatus('idle')
    const idle = await test.screen()
    expect(idle).not.toContain('thinking')
    expect(idle).toContain('↑1.2k ↓34 ctx 1.2k')
  })

  it('seeds the next call\'s send from the last committed prompt when context is unknown', async () => {
    const test = await bench({ running: true })
    test.appendAssistant(
      [{ type: 'text', text: 'first' }],
      { usage: { inputTokens: 1200, outputTokens: 34 } },
    )
    await test.settle()
    test.stream.start()
    await test.settle()
    expect(test.terminal.text()).toContain('thinking ↑1.2k tokens')
    test.stream.chunk({ type: 'text-delta', index: 0, text: 'abcd' })
    await test.settle()
    expect(test.terminal.text()).toContain('writing ↑1.2k ↓1 tokens')
  })

  it('estimates receive from a stream that never sent start, and ignores a zero context seed', async () => {
    const test = await bench({
      running: true,
      projections: {
        snapshot: () => ({
          asOfSeq: -1,
          values: { contextPressure: { projectedTokens: 0, pressureTokens: 0, contextWindow: 128_000 } },
        }),
        onChanged: () => () => {},
      },
    })
    test.stream.chunk({ type: 'text-delta', index: 0, text: 'abcd' })
    await test.settle()
    expect(test.terminal.text()).toContain('writing ↓1 tokens')
    expect(test.terminal.text()).not.toContain('writing ↑')
  })

  it('labels the spinner from reasoning, text, unnamed tool deltas, and in-flight tools', async () => {
    const test = await bench({ running: true })
    test.stream.start()
    test.stream.chunk({ type: 'reasoning-delta', index: 0, text: 'hmm' })
    await test.settle()
    expect(await test.screen()).toContain('thinking')
    test.stream.chunk({ type: 'text-delta', index: 1, text: 'hello' })
    expect(await test.screen()).toContain('writing')
    expect(await test.screen()).not.toContain('thinking')
    test.stream.chunk({ type: 'tool-call-delta', index: 2, id: 'call-1' as never, argumentsDelta: '{' })
    expect(await test.screen()).toContain('calling')
    expect(await test.screen()).not.toContain('writing')
    expect(await test.screen()).not.toContain('thinking')
    test.stream.chunk({ type: 'text-delta', index: 3, text: 'keep the tool label' })
    expect(await test.screen()).toContain('calling')
    expect(await test.screen()).not.toContain('writing')
    test.stream.chunk({ type: 'tool-call-delta', index: 2, id: 'call-1' as never, name: 'read', argumentsDelta: '}' })
    expect(await test.screen()).toContain('calling read')
    test.stream.end({ kind: 'committed', eventType: 'assistant/message', seq: 1 as never })
    test.appendToolCall('call-1', 'read', { path: 'package.json' })
    test.appendToolCall('call-2', 'grep', { pattern: 'name' })
    expect(await test.screen()).toContain('calling grep')
    test.stream.start()
    expect(await test.screen()).toContain('calling grep')
    test.appendToolResult('call-2', [{ type: 'text', text: 'name' }])
    expect(await test.screen()).toContain('calling read')
    expect(await test.screen()).not.toContain('thinking')
    test.appendToolResult('call-1', [{ type: 'text', text: '{}' }])
    expect(await test.screen()).toContain('thinking')
    expect(await test.screen()).not.toContain('calling')
  })

  it('draws a subagent call as one row that settles on its outcome', async () => {
    const test = await bench()
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'tool-call-delta', index: 0, id: 'call-1' as never, name: 'subagent', argumentsDelta: '{"description":"Explore' })
    expect(await test.screen()).toContain('subagent')
    test.stream.end({ kind: 'committed', eventType: 'assistant/message', seq: 1 as never })
    test.appendToolCall('call-1', 'subagent', { description: 'Explore order services', prompt: 'Read the order code.' })
    const running = await test.screen()
    expect(running).toContain('subagent  Explore order services')
    expect(running).not.toContain('Read the order code.')
    test.appendToolResult('call-1', [{ type: 'text', text: 'orders live in svc/' }])
    const settled = await test.screen()
    expect(settled).toMatch(/◆ Explore order services +\[done\]/)
    expect(settled).not.toContain('orders live in svc/')
  })

  it('draws a tool card as soon as the model names the call, then replaces the loading row with the result', async () => {
    const test = await bench({
      before: async (ctx) => {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        ctx.tools.register({
          name: 'read',
          description: 'read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: () => Promise.resolve('unused'),
          presentCall: args => ({ card: 'generic', title: (args as { path: string }).path }),
          presentResult: (_args, result) => ({
            card: 'generic',
            content: result.content,
          }),
        })
      },
    })
    test.stream.start()
    test.stream.chunk({ type: 'tool-call-delta', index: 0, id: 'call-1' as never, name: 'read', argumentsDelta: '' })
    await test.settle()
    let screen = test.terminal.text()
    expect(screen).toMatch(spinning('read'))
    expect(screen).toContain(TOOL_RUNNING_ROW)
    expect(screen).not.toContain('a.ts')
    test.stream.chunk({ type: 'tool-call-delta', index: 0, id: 'call-1' as never, argumentsDelta: '{"path":"a.ts"}' })
    await test.settle()
    screen = test.terminal.text()
    expect(screen).toMatch(spinning('read a.ts'))
    expect(screen).toContain(TOOL_RUNNING_ROW)
    test.stream.end({ kind: 'committed', eventType: 'assistant/message', seq: 1 as never })
    test.appendToolCall('call-1', 'read', { path: 'a.ts' })
    await test.settle()
    expect(test.terminal.text().split(spinning('read a.ts'))).toHaveLength(2)
    test.appendToolResult('call-1', [{ type: 'text', text: 'export const a = 1' }])
    screen = await test.screen()
    expect(screen).toContain('read a.ts')
    expect(screen).toContain('export const a = 1')
    expect(screen.split('\n').some(line => line.trim() === `│ ${TOOL_RUNNING_ROW}`)).toBe(false)
  })

  it('drops a streamed tool card when the attempt is abandoned', async () => {
    const test = await bench()
    test.stream.start()
    test.stream.chunk({ type: 'tool-call-delta', index: 0, id: 'call-1' as never, name: 'write', argumentsDelta: '' })
    await test.settle()
    expect(test.terminal.text()).toMatch(spinning('write'))
    expect(test.terminal.text()).toContain(TOOL_RUNNING_ROW)
    test.stream.end({ kind: 'abandoned' })
    const screen = await test.screen()
    expect(screen).not.toMatch(spinning('write'))
    expect(screen.split('\n').some(line => line.trim() === `│ ${TOOL_RUNNING_ROW}`)).toBe(false)
  })

  it('ignores unnamed or id-less tool-call deltas and drops a card on an abandoned attempt retry', async () => {
    const test = await bench({ running: true })
    test.stream.start()
    test.stream.chunk({ type: 'tool-call-delta', index: 0, id: '' as never, name: 'read', argumentsDelta: '' })
    test.stream.chunk({ type: 'tool-call-delta', index: 1, id: 'call-x' as never, argumentsDelta: '{' })
    test.stream.chunk({ type: 'tool-call-delta', index: 2, id: 'call-y' as never, name: '', argumentsDelta: '' })
    await test.settle()
    expect(test.terminal.text()).toContain('calling read')
    expect(test.terminal.text()).not.toMatch(spinning('read'))
    test.stream.chunk({ type: 'tool-call-delta', index: 3, id: 'call-2' as never, name: 'edit', argumentsDelta: '' })
    await test.settle()
    expect(test.terminal.text()).toMatch(spinning('edit'))
    test.stream.end({ kind: 'committed', eventType: 'assistant/attempt', seq: 1 as never })
    const dropped = await test.screen()
    expect(dropped).not.toMatch(spinning('edit'))
    test.session.append('tool/call', { turn: 1, step: 1, callId: 'call-bad' as never, name: 'mystery', arguments: '{bad' })
    await test.settle()
    expect(test.terminal.text()).toMatch(spinning('mystery'))
    expect(test.terminal.text()).toContain('{bad')
  })

  it('renders tool cards from presenters, folds their bodies, and toggles them with Ctrl+O', async () => {
    const test = await bench({
      toolPreviewLines: 2,
      before: async (ctx) => {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        ctx.tools.register({
          name: 'bash',
          description: 'run',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: () => Promise.resolve('unused'),
          presentCall: args => ({ card: 'terminal', title: (args as { command: string }).command, cwd: '/work' }),
          presentResult: (_args, result) => ({ card: 'terminal', output: result.content.map(block => block.type === 'text' ? block.text : '').join(''), exitCode: result.isError ? 2 : 0 }),
        })
        ctx.tools.register({
          name: 'broken',
          description: 'throws in its presenters',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: () => Promise.resolve('unused'),
          presentCall: () => { throw new Error('bad call presenter') },
          presentResult: () => { throw new Error('bad result presenter') },
        })
      },
    })
    test.appendToolCall('call-1', 'bash', { command: 'ls -la' })
    await test.settle()
    // The command is drawn once, as the card's own `$` row under the header.
    expect(test.terminal.text()).toContain('$ ls -la')
    expect(test.terminal.text()).not.toContain('bash ls -la')
    expect(test.terminal.text()).toContain('cwd: /work')
    expect(test.terminal.text()).toContain(TOOL_RUNNING_ROW)
    test.appendToolResult('call-1', [{ type: 'text', text: 'a\nb\nc\nd\n' }], true, { extra: 1 })
    await test.settle()
    expect(test.terminal.text()).toContain('… 5 more rows · Ctrl+O expands')
    expect(test.terminal.text()).not.toContain('exit 2')
    test.terminal.type(KEY.ctrlO)
    await test.settle()
    expect(test.terminal.text()).toContain('exit 2')
    typeLine(test.terminal, '/tools')
    await test.settle()
    // A presenter that throws falls back to the raw arguments and result text.
    test.appendToolCall('call-2', 'broken', { x: 1 })
    test.appendToolResult('call-2', [{ type: 'text', text: 'raw result' }])
    // A result for an unknown call is ignored.
    test.appendToolResult('call-9', [{ type: 'text', text: 'orphan' }])
    // A tool with no definition renders its raw arguments and raw result.
    test.appendToolCall('call-3', 'mystery', { path: 'x' })
    test.appendToolResult('call-3', [{ type: 'text', text: 'mystery output' }])
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('broken')
    expect(screen).toContain('{"x":1}')
    expect(screen).toContain('raw result')
    expect(screen).toContain('mystery')
    expect(screen).toContain('{"path":"x"}')
    expect(screen).toContain('mystery output')
    expect(screen).not.toContain('orphan')
  })

  it('folds every tool card and context block together with Ctrl+O and /tools', async () => {
    const history = [
      { type: 'system/message', seq: 0, time: 1, data: { turn: 0, step: 1, message: createSystemMessage(RULES) } },
    ] as never[]
    const test = await bench({ history, toolPreviewLines: 1, contextPreviewLines: 2 })
    test.appendToolCall('call-1', 'bash', { command: 'ls' })
    test.appendToolResult('call-1', [{ type: 'text', text: 'a\nb\nc' }])
    await test.settle()
    const folded = await test.screen()
    expect(folded).toContain('rule 1')
    expect(folded).not.toContain('rule 5')
    expect(folded).toContain('… 4 more rows · Ctrl+O expands')
    expect(folded).not.toContain('  │ c')

    // One key reaches every foldable block, whatever kind it is.
    test.terminal.type(KEY.ctrlO)
    await test.settle()
    const open = await test.screen()
    expect(open).toContain('rule 5')
    expect(open).toContain('  │ c')
    expect(open).not.toContain('more rows')

    typeLine(test.terminal, '/tools')
    await test.settle()
    const closed = await test.screen()
    expect(closed).not.toContain('rule 5')
    expect(closed).not.toContain('  │ c')
    expect(closed).toContain('… 4 more rows · Ctrl+O expands')
  })

  it('draws a long injected snapshot folded at the configured budget', async () => {
    const history = [
      { type: 'user/message', seq: 0, time: 1, data: createUserMessage({
        content: [{ type: 'text', text: 'assembled' }],
        source: testContextSource({ form: 'snapshot', sections: [
          { name: 'sandbox', text: 'allow python' },
          { name: 'git', text: Array.from({ length: 20 }, (_, index) => `changed file ${String(index)}`).join('\n') },
        ] }),
      }) },
    ] as never[]
    const test = await bench({ history })
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain('⬡ snapshot · tui-test-context')
    // Four rows of body, and the injection is no longer than the conversation.
    expect(screen).toContain('  sandbox')
    expect(screen).toContain('  allow python')
    expect(screen).toContain('  changed file 0')
    expect(screen).not.toContain('changed file 1')
    expect(screen).toContain('… 19 more rows · Ctrl+O expands')
  })

  it('draws resumed history, notices, and turn-end reasons', async () => {
    const history = [
      { type: 'system/message', seq: 0, time: 1, data: { turn: 0, step: 1, message: createSystemMessage('You are the agent.') } },
      { type: 'system/message', seq: 1, time: 1, data: { turn: 0, step: 1, message: createSystemMessage('') } },
      { type: 'system/message', seq: 2, time: 1, data: { turn: 0, step: 1, message: createSystemMessage('Updated prompt.') } },
      { type: 'user/message', seq: 3, time: 1, data: createUserMessage({ content: [{ type: 'text', text: 'earlier prompt' }], source: { kind: 'user' } }) },
      { type: 'user/message', seq: 4, time: 1, data: createUserMessage({ content: [{ type: 'text', text: 'full notice body' }], source: testContextSource({ form: 'notice', summary: 'skill loaded' }) }) },
      { type: 'user/message', seq: 5, time: 1, data: createUserMessage({ content: [{ type: 'text', text: '# AGENTS.md' }], source: testContextSource({ form: 'instructions' }) }) },
      { type: 'user/message', seq: 6, time: 1, data: createUserMessage({
        content: [{ type: 'text', text: 'assembled' }],
        source: testContextSource({ form: 'snapshot', sections: [{ name: 'sandbox', text: 'allow python' }, { name: 'git', text: 'clean tree' }] }),
      }) },
      { type: 'turn/end', seq: 8, time: 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'E_TEST', message: 'boom' } } } },
      { type: 'turn/end', seq: 9, time: 1, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
      { type: 'step/start', seq: 10, time: 1, data: { turn: 3, step: 1 } },
      { type: 'tool/result', seq: 11, time: 1, data: { turn: 3, step: 1, message: createToolResultMessage({ callId: 'c' as ToolCallId, content: [{ type: 'text', text: 'tool text' }], isError: false }) } },
    ] as never[]
    const test = await bench({ history })
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('⬡ system prompt')
    expect(screen).toContain('You are the agent.')
    expect(screen).toContain('⬡ system prompt update')
    expect(screen).toContain('Updated prompt.')
    expect(screen).toContain('❯ earlier prompt')
    expect(screen).toContain('⬡ notice · skill loaded')
    expect(screen).toContain('full notice body')
    expect(screen).toContain('⬡ instructions · tui-test-context')
    expect(screen).toContain('# AGENTS.md')
    expect(screen).toContain('⬡ snapshot · tui-test-context')
    expect(screen).toContain('sandbox')
    expect(screen).toContain('allow python')
    expect(screen).toContain('clean tree')
    expect(screen).not.toContain('hidden compact')
    expect(screen).toContain('turn failed: E_TEST: boom')
    expect(screen).toContain('turn stopped')
    expect(screen).not.toContain('tool text')
    // Events of another session are ignored.
    const other = test.ctx.sessions.create('session-other' as Agent['id'])
    other.append('turn/start', { turn: 1 })
    other.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    await test.settle()
    expect(test.terminal.text()).not.toContain('turn blocked')
  })

  it('arms the stop on Escape and stops the running turn on a second press, clears on Ctrl+C, and quits on a double Ctrl+C or Ctrl+D', async () => {
    const test = await bench()
    test.terminal.type(KEY.escape)
    expect(test.calls.cancels).toBe(0)
    test.setStatus('running')
    // The first press only arms the stop and says so.
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.calls.cancels).toBe(0)
    expect(test.terminal.text()).toContain('press Esc again to stop turn 0')
    test.terminal.type(KEY.escape)
    expect(test.calls.cancels).toBe(1)
    expect(test.calls.cancelOptions).toEqual({ keepInbox: true })
    await test.settle()
    expect(test.terminal.text()).toContain('stopping the turn…')
    test.agent.inbox.append('next-turn', createUserMessage({ content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } }))
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.text()).toContain('1 queued message(s) stay queued')
    test.terminal.type('d')
    test.terminal.type('r')
    test.terminal.type('a')
    test.terminal.type('f')
    test.terminal.type('t')
    test.terminal.type(KEY.ctrlD)
    expect(test.quits).toEqual([])
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.terminal.text()).toContain('press Ctrl+C again to quit')
    test.terminal.type(KEY.ctrlD)
    expect(test.quits).toHaveLength(1)
    expect(test.terminal.stopped).toBe(true)
    // Further stops are no-ops.
    test.app.stop()
    expect(test.quits).toHaveLength(1)
  })

  it('quits on a second Ctrl+C inside the double-press window', async () => {
    const test = await bench()
    test.terminal.type(KEY.ctrlC)
    test.terminal.type(KEY.ctrlC)
    expect(test.quits).toHaveLength(1)
  })

  it('takes the stop arm back down when the editor takes another key', async () => {
    const test = await bench({ running: true })
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.text()).toContain('press Esc again to stop turn 0')
    // Typing takes the notice down and disarms with it, so a press at the end
    // of a sentence arms again instead of stopping the turn.
    test.terminal.type('a')
    await test.settle()
    expect(await test.screen()).not.toContain('press Esc again to stop turn')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.calls.cancels).toBe(0)
    test.terminal.type(KEY.escape)
    expect(test.calls.cancels).toBe(1)
  })

  it('takes the stop arm down with the line Ctrl+C put in its place', async () => {
    const test = await bench({ running: true })
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.text()).toContain('press Esc again to stop turn 0')
    // Ctrl+C takes the arming line down and says something else instead, so
    // the next Escape must arm again rather than stop a turn with nothing on
    // screen that said it would.
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    const shown = await test.screen()
    expect(shown).toContain('press Ctrl+C again to quit')
    expect(shown).not.toContain('press Esc again to stop turn')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.calls.cancels).toBe(0)
    expect(test.terminal.text()).toContain('press Esc again to stop turn 0')
    test.terminal.type(KEY.escape)
    expect(test.calls.cancels).toBe(1)
  })

  it('arms no timer for a line the next key press took down', async () => {
    const test = await bench({ toastMs: 2000 })
    await test.settle()
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)
    test.terminal.type('a')
    await test.settle()
    expect(await test.screen()).not.toContain('press Ctrl+C again to quit')
    // The line is gone, so nothing is left to repaint for the rest of what
    // would have been its flight.
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('arms again instead of stopping once the notice has come down', async () => {
    const test = await bench({ running: true, toastMs: 800 })
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.text()).toContain('press Esc again to stop turn 0')
    test.setNow(BENCH_NOW + 800)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.calls.cancels).toBe(0)
    test.terminal.type(KEY.escape)
    expect(test.calls.cancels).toBe(1)
  })

  it('floats key feedback over the conversation, takes it down again, and arms no timer afterwards', async () => {
    const test = await bench({ toastMs: 900 })
    await test.settle()
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    const shown = await test.screen()
    expect(shown).toContain('press Ctrl+C again to quit')
    // The line is an overlay, so it costs the conversation no row of its own.
    expect(shown).not.toContain('· press Ctrl+C again to quit')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)
    test.runTick(FADE_TICK_MS, 900)
    await test.settle()
    expect(await test.screen()).not.toContain('press Ctrl+C again to quit')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('fades the line out on a terminal that draws a ramp, and holds the arm for the whole flight', async () => {
    const test = await bench({ color: true, background: 'rgb:0000/0000/0000', toastMs: 500, fadeSteps: 4, fadeStepMs: 50, running: true })
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    // Held at full strength, then recolored for the fade, then gone.
    test.runTick(FADE_TICK_MS, 500)
    await test.settle()
    expect(await test.screen()).toContain('press Esc again to stop turn 0')
    test.runTick(FADE_TICK_MS, 100)
    await test.settle()
    expect(await test.screen()).toContain('press Esc again to stop turn 0')
    // The arm covers the hold and the fade together: 500 + 4 x 50.
    test.setNow(BENCH_NOW + 699)
    test.terminal.type(KEY.escape)
    expect(test.calls.cancels).toBe(1)
  })

  it('reads the newest section full screen from the input and from /turns', async () => {
    const test = await bench()
    typeLine(test.terminal, 'read the spec')
    test.appendAssistant([{ type: 'text', text: 'the reply' }])
    await test.settle()

    test.terminal.type(KEY.ctrlG)
    await test.settle()
    const reading = await test.screen()
    expect(reading).toContain(' ● READER ')
    expect(reading).toContain('❯ 1  read the spec')
    expect(reading).toContain('the reply')
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    expect(await test.screen()).not.toContain(' ● READER ')

    typeLine(test.terminal, '/turns')
    await test.settle()
    expect(await test.screen()).toContain('│ ┃ ¶ Reply')
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(await test.screen()).not.toContain(' ● READER ')
  })

  it('says there is nothing to read yet and opens nothing', async () => {
    const test = await bench()
    await test.settle()
    typeLine(test.terminal, '/turns')
    await test.settle()
    expect(test.terminal.text()).toContain('nothing in the transcript to read yet')
    expect(await test.screen()).not.toContain(' ● READER ')
    // The keyboard never left the input.
    typeLine(test.terminal, 'hello')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'hello' }]])
  })

  it('steps the reader aside for an approval and brings it back afterwards', async () => {
    const test = await bench()
    typeLine(test.terminal, 'read the spec')
    test.appendAssistant([{ type: 'text', text: 'the reply' }])
    await test.settle()
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    expect(await test.screen()).toContain(' ● READER ')

    const asked = test.ctx.waterfall(
      'approval/request',
      { agent: test.agent, toolName: 'bash', reason: 'writes outside the workspace' },
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    await test.settle()
    const prompted = await test.screen()
    expect(prompted).toContain('Allow bash?')
    expect(prompted).not.toContain(' ● READER ')
    test.terminal.type(KEY.enter)
    await expect(asked).resolves.toBe('allowed-once')
    await test.settle()
    // The seam is answered, so the reader has the screen and the keyboard back.
    expect(await test.screen()).toContain(' ● READER ')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(await test.screen()).toContain('2/2 · turn 1 · reply')
  })

  it('keeps the reader aside until the last queued prompt has been answered', async () => {
    const test = await bench()
    typeLine(test.terminal, 'read the spec')
    test.appendAssistant([{ type: 'text', text: 'the reply' }])
    await test.settle()
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    expect(await test.screen()).toContain(' ● READER ')

    const ask = (toolName: string): Promise<ApprovalOutcome> => test.ctx.waterfall(
      'approval/request',
      { agent: test.agent, toolName, reason: 'writes outside the workspace' },
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    const first = ask('bash')
    const second = ask('write')
    await test.settle()
    expect(await test.screen()).toContain('Allow bash?')
    test.terminal.type(KEY.enter)
    await expect(first).resolves.toBe('allowed-once')
    await test.settle()
    // The queue shows the second seam next, and the reader would cover it if
    // it came back between the two.
    const queued = await test.screen()
    expect(queued).toContain('Allow write?')
    expect(queued).not.toContain(' ● READER ')
    test.terminal.type(KEY.enter)
    await expect(second).resolves.toBe('allowed-once')
    await test.settle()
    expect(await test.screen()).toContain(' ● READER ')
  })

  it('closes the reader and says so when a session switch takes the conversation', async () => {
    const gate = { release: () => {} }
    const test = await bench({ hostGate: gate })
    typeLine(test.terminal, 'read the spec')
    test.appendAssistant([{ type: 'text', text: 'the reply' }])
    await test.settle()
    typeLine(test.terminal, '/new')
    await test.settle()
    // The host is still opening the next session, so the conversation still
    // takes the keyboard and the reader still opens on it.
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(await test.screen()).toContain(' ● READER ')
    const reading = test.terminal.written.length
    gate.release()
    await test.settle()
    // The reader had the terminal, so the switch gives the conversation's own
    // screen back before it draws the session that replaced it.
    expect(test.terminal.written.slice(reading)).toContain('[?1049l')
    const after = await test.screen()
    expect(after).not.toContain(' ● READER ')
    expect(after).toContain('the transcript changed · reader closed')
  })

  it('closes the reader over a switch whose session brings a history of its own', async () => {
    const gate = { release: () => {} }
    const test = await bench({
      hostGate: gate,
      openedHistory: [{
        type: 'user/message',
        seq: 0,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'earlier prompt' }], source: { kind: 'user' } }),
      }] as never[],
    })
    typeLine(test.terminal, 'read the spec')
    test.appendAssistant([{ type: 'text', text: 'the reply' }])
    await test.settle()
    typeLine(test.terminal, '/fork')
    await test.settle()
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    expect(await test.screen()).toContain(' ● READER ')
    gate.release()
    await test.settle()
    // The replayed history leaves the new transcript full, so nothing but the
    // switch itself can take the reader down - and the keyboard is back in the
    // input rather than reading a conversation nobody opened.
    const after = await test.screen()
    expect(after).not.toContain(' ● READER ')
    expect(after).toContain('❯ earlier prompt')
    expect(after).toContain('the transcript changed · reader closed')
    typeLine(test.terminal, 'hello again')
    await test.settle()
    expect(test.calls.followups.map(message => message.content).at(-1)).toEqual([{ type: 'text', text: 'hello again' }])
  })

  it('takes the reader down with the terminal when the application stops', async () => {
    const test = await bench()
    typeLine(test.terminal, 'read the spec')
    test.appendAssistant([{ type: 'text', text: 'the reply' }])
    await test.settle()
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    expect(await test.screen()).toContain(' ● READER ')
    test.app.stop()
    await test.settle()
    expect(test.terminal.stopped).toBe(true)
    expect(test.quits).toHaveLength(1)
  })

  it('answers /help, /quit, /model, and unknown commands locally', async () => {
    const test = await bench({
      before: async (ctx) => {
        await ctx.plugin(CommandRuntime)
        ctx.commands.register({
          name: 'echo',
          description: 'echo the input',
          handler: invocation => ({ kind: 'success', text: `echoed ${invocation.rawInput.trim()}` }),
        })
        ctx.commands.register({
          name: 'fail',
          description: 'fail',
          handler: () => ({ kind: 'error', text: 'nope' }),
        })
        ctx.commands.register({
          name: 'silent',
          description: 'no text',
          handler: () => ({ kind: 'success' }),
        })
        ctx.commands.register({
          name: 'throws',
          description: 'throws',
          handler: () => { throw new Error('handler exploded') },
        })
        ctx.commands.register({
          name: 'odd',
          description: 'rejects with a non-error',
          handler: () => Promise.reject('plain reason'),
        })
      },
    })
    typeLine(test.terminal, '/help')
    await test.settle()
    expect(test.terminal.text()).toContain('/echo')
    expect(test.terminal.text()).toContain('Esc arms the stop · Esc again stops the turn')
    expect(test.terminal.text()).toContain('@ completes paths and sessions · / completes commands')
    typeLine(test.terminal, '/echo one two')
    typeLine(test.terminal, '/fail')
    typeLine(test.terminal, '/silent')
    typeLine(test.terminal, '/throws')
    typeLine(test.terminal, '/odd')
    typeLine(test.terminal, '/nosuch')
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('/echo: echoed one two')
    expect(screen).toContain('/fail: nope')
    expect(screen).toContain('/silent done')
    expect(screen).toContain('/throws failed: handler exploded')
    expect(screen).toContain('/odd failed: command handler rejected with a non-Error value: plain reason')
    expect(screen).toContain('unknown command /nosuch')
    typeLine(test.terminal, '/model broken')
    await test.settle()
    expect(test.terminal.text()).toContain('usage: /model <provider>/<model>')
    typeLine(test.terminal, '/model other/big')
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'other', model: 'big' })
    expect(test.terminal.text()).toContain('other/big')
    typeLine(test.terminal, '/exit')
    expect(test.quits).toHaveLength(1)
  })

  it('lists one /help row per focus state, in the words that state draws', async () => {
    const test = await bench()
    typeLine(test.terminal, '/help')
    await test.settle()
    const lines = test.terminal.text().split('\n').map(line => line.trimEnd())
    /** The printed row whose keys are `line`, or undefined when nothing lists it. */
    const rowOf = (line: string): string | undefined => lines.find(printed => printed.endsWith(line))
    for (const region of FOCUS_REGIONS) {
      const [first, ...rest] = KEY_LINES[region]
      // The state names itself once, on the row carrying its first line, which
      // starts at the page margin every frame is drawn inside.
      expect(rowOf(first as string)?.trimStart().startsWith(REGION_LABELS[region]), region).toBe(true)
      // Its further lines are listed under a blank name column.
      for (const line of rest) expect(rowOf(line)?.trimStart(), region).toBe(line)
    }
    // Every docked legend is the one its own surface draws, not a second copy.
    for (const region of ['transcript', 'panel', 'bar'] as const) {
      expect(rowOf(widestHint(region)), region).toBeDefined()
    }
    // The reader is a focus state of its own, with both its columns named.
    expect(rowOf(READER_HINTS.list[0])?.trimStart().startsWith('reader')).toBe(true)
    expect(rowOf(READER_HINTS.pane[0])).toBeDefined()
    const shown = lines.join('\n')
    for (const key of ['Space folds', 'Ctrl+G reader', 'Tab regions', 'PgUp PgDn turns', 'Home End ends']) {
      expect(shown, key).toContain(key)
    }
    expect(shown).toContain('Esc arms the stop · Esc again stops the turn')
    expect(shown).toContain('!cmd runs here · the next prompt can read it · !!cmd stays local')
  })

  it('writes every legend step, fold marker, and transient line in exactly one module', () => {
    /** The string literals one module declares, its comments removed. */
    const literals = (source: string): string[] => {
      const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
      return [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu)].map(match => match[0].slice(1, -1))
    }
    const directory = fileURLToPath(new URL('../src', import.meta.url))
    const modules = readdirSync(directory)
      .filter(name => name.endsWith('.ts'))
      .map(name => [name, literals(readFileSync(join(directory, name), 'utf8'))] as const)
    /** Which modules declare `words`; a parameterized line is matched by its fixed head. */
    const owners = (words: string): string[] => modules
      .filter(([, declared]) => declared.some(literal => literal === words || literal.startsWith(`${words}$`)))
      .map(([name]) => name)
    const catalog: readonly (readonly [string, string])[] = [
      // The one editor line built from the entry keys is a template there, so
      // its fixed head is covered by the entry hints themselves.
      ...[...HINTS.transcript, ...HINTS.panel, ...HINTS.bar, ...ENTRY_HINTS, ...entryHints({ queue: true }),
        QUEUE_ENTRY_HINT, ...KEY_LINES.transcript,
        ...KEY_LINES.editor.filter(line => !line.startsWith(ENTRY_HINTS[0] as string))]
        .map(step => [step, 'keys.ts'] as const),
      ...[...READER_HINTS.list, ...READER_HINTS.pane].map(step => [step, 'reader.ts'] as const),
      ['terminal too small for the reader (needs ', 'reader.ts'],
      [QUIT_TOAST, 'toast.ts'],
      [NOTHING_TO_READ_TOAST, 'toast.ts'],
      ['above the repaint window · opened in the reader', 'app.ts'],
      ['press Esc again to stop turn ', 'toast.ts'],
      ['Space expands', 'transcript.ts'],
      ['Ctrl+O expands', 'transcript.ts'],
      ['Ctrl+G reads it', 'transcript.ts'],
      ['stopping the turn…', 'app.ts'],
      ['the transcript changed · reader closed', 'app.ts'],
      ['wait for the session switch to finish', 'app.ts'],
    ]
    for (const [words, owner] of catalog) expect(owners(words), words).toEqual([owner])
    expect(TOO_SMALL).toContain('terminal too small for the reader (needs ')
    // The three fold markers are one grammar with three named openers.
    expect(foldMarker(1, 'marked')).toBe('… 1 more row · Space expands')
    expect(foldMarker(41, 'transcript')).toBe('… 41 more rows · Ctrl+O expands')
    expect(foldMarker(41, 'inspector')).toBe('… 41 more rows · Ctrl+G reads it')
  })

  it('reports unknown commands when no registry is composed', async () => {
    const test = await bench()
    typeLine(test.terminal, '/nosuch')
    typeLine(test.terminal, '/help')
    await test.settle()
    expect(test.terminal.text()).toContain('unknown command /nosuch')
    expect(test.terminal.text()).toContain('/tools')
  })

  it('answers approvals through a prompt and withdraws them on abort', async () => {
    const test = await bench()
    const ask = (signal?: AbortSignal): Promise<ApprovalOutcome> => test.ctx.waterfall(
      'approval/request',
      { agent: test.agent, toolName: 'bash', reason: 'writes outside the workspace', ...signal === undefined ? {} : { signal } },
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    const first = ask()
    await test.settle()
    expect(test.terminal.text()).toContain('Allow bash?')
    expect(test.terminal.text()).toContain('writes outside the workspace')
    test.terminal.type(KEY.enter)
    await expect(first).resolves.toBe('allowed-once')
    const bare = test.ctx.waterfall('approval/request', { agent: test.agent, toolName: 'edit' }, () => Promise.resolve<ApprovalOutcome>('unavailable'))
    await test.settle()
    expect(test.terminal.text()).toContain('Allow edit?')
    test.terminal.type(KEY.enter)
    await expect(bare).resolves.toBe('allowed-once')
    const again = ask()
    await test.settle()
    test.terminal.type(KEY.enter)
    await expect(again).resolves.toBe('allowed-once')
    await test.settle()
    expect(test.terminal.text()).toContain('bash: allowed once')

    const second = ask()
    await test.settle()
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await expect(second).resolves.toBe('rejected')

    const third = ask()
    await test.settle()
    test.terminal.type(KEY.escape)
    await expect(third).resolves.toBe('rejected')

    const controller = new AbortController()
    const fourth = ask(controller.signal)
    await test.settle()
    controller.abort()
    await expect(fourth).resolves.toBe('cancelled')

    const aborted = new AbortController()
    aborted.abort()
    await expect(ask(aborted.signal)).resolves.toBe('cancelled')

    const fifth = ask()
    await test.settle()
    test.terminal.type(KEY.ctrlC)
    await expect(fifth).resolves.toBe('cancelled')

    // Another agent's request passes through untouched.
    const other = { id: 'session-other' } as Agent
    await expect(test.ctx.waterfall('approval/request', { agent: other, toolName: 'bash' }, () => Promise.resolve<ApprovalOutcome>('unavailable')))
      .resolves.toBe('unavailable')
  })

  it('answers user questions with options, multi-select, and free text', async () => {
    const test = await bench()
    const ask = (questions: unknown[], signal?: AbortSignal): Promise<AskUserQuestionAnswer> => test.ctx.waterfall(
      'user-questions/request',
      { agent: test.agent, questions: questions as never, ...signal === undefined ? {} : { signal } },
      () => Promise.reject(new Error('no answerer')),
    )
    const single = ask([{ id: 'q1', header: 'Setup', question: 'Which color?', detail: 'Pick one', options: [{ label: 'red', description: 'warm' }, { label: 'blue' }] }])
    await test.settle()
    expect(test.terminal.text()).toContain('Which color?')
    expect(test.terminal.text()).toContain('Pick one')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await expect(single).resolves.toEqual({ answers: [{ id: 'q1', selected: ['blue'] }] })

    const multi = ask([{ id: 'q2', question: 'Which sizes?', multiSelect: true, options: [{ label: 's' }, { label: 'm' }, { label: 'l' }] }])
    await test.settle()
    test.terminal.type(KEY.space)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    test.terminal.type(KEY.space)
    test.terminal.type(KEY.space)
    await test.settle()
    expect(test.terminal.text()).toContain('selected: s')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await expect(multi).resolves.toEqual({ answers: [{ id: 'q2', selected: ['s', 'm'] }] })

    const custom = ask([{ id: 'q3', question: 'Name?', options: [{ label: 'a' }] }])
    await test.settle()
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    // An empty free-text answer is ignored; Escape returns to the options.
    test.terminal.type(KEY.enter)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.text()).toContain('Type an answer')
    test.terminal.type(KEY.enter)
    test.terminal.type('z')
    test.terminal.type('q')
    test.terminal.type(KEY.enter)
    await expect(custom).resolves.toEqual({ answers: [{ id: 'q3', selected: [], custom: 'zq' }] })

    const free = ask([{ id: 'q4', question: 'Anything?' }])
    await test.settle()
    test.terminal.type('o')
    test.terminal.type('k')
    test.terminal.type(KEY.enter)
    await expect(free).resolves.toEqual({ answers: [{ id: 'q4', selected: [], custom: 'ok' }] })

    const dismissedFree = ask([{ id: 'q5', question: 'Anything?' }])
    await test.settle()
    expect(test.terminal.text()).toContain('Esc back to the options')
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    await expect(dismissedFree).rejects.toThrow('dismissed')

    const dismissed = ask([{ id: 'q6', question: 'Pick', options: [{ label: 'a' }] }])
    await test.settle()
    test.terminal.type(KEY.escape)
    await expect(dismissed).rejects.toThrow('dismissed')

    const controller = new AbortController()
    const withdrawn = ask([{ id: 'q7', question: 'Pick', options: [{ label: 'a' }] }], controller.signal)
    await test.settle()
    controller.abort()
    await expect(withdrawn).rejects.toThrow('dismissed')

    const other = { id: 'session-other' } as Agent
    await expect(test.ctx.waterfall('user-questions/request', { agent: other, questions: [] }, () => Promise.reject(new Error('no answerer'))))
      .rejects.toThrow('no answerer')
  })

  it('submits an initial prompt and keeps the loader when the Agent is already running', async () => {
    const test = await bench({ initialPrompt: 'first task', color: true, running: true })
    await test.settle()
    expect(test.calls.followups).toHaveLength(1)
    // The running turn has not claimed the prompt, so it is not yet a
    // transcript block; it enters through its `user/message` when claimed.
    expect(test.terminal.text()).not.toContain('❯ first task')
    expect(test.terminal.text()).toContain('queued for the next turn')
    expect(test.terminal.text()).toContain('thinking')
    test.setStatus('running')
    test.terminal.resize(60)
    await test.settle()
  })

  it('ignores frames and status of other Agents', async () => {
    const test = await bench()
    const other = { id: 'session-other' } as Agent
    test.agent.ctx.emit('agent/assistant-stream', { agent: other, frame: { type: 'start', attemptId: 'x' as never, revision: 1, turn: 1, step: 1 } })
    test.agent.ctx.emit('agent/status', { agent: other, status: 'running' })
    await test.settle()
    expect(test.terminal.text()).not.toContain('thinking')
  })

  it('falls back to the logged request header and then the Agent options for the footer model', async () => {
    const unselected = await bench({ unselected: true })
    await unselected.settle()
    expect(unselected.terminal.text()).toContain('default/default')
    unselected.session.append('turn/start', { turn: 1 })
    unselected.session.append('step/start', { turn: 1, step: 1 })
    unselected.session.append('request/header', { header: { config: { provider: 'logged', model: 'header-model' } }, reason: 'initial' })
    unselected.appendAssistant([{ type: 'text', text: 'x' }], { usage: { inputTokens: 1, outputTokens: 1 } })
    await unselected.settle()
    expect(unselected.terminal.text()).toContain('logged/header-model')
  })

  it('completes slash commands from the editor', async () => {
    const test = await bench()
    test.terminal.type('/')
    await test.settle()
    expect(test.terminal.text()).toContain('/model')
    for (const char of 'qui') test.terminal.type(char)
    await test.settle()
    test.terminal.type(KEY.enter)
    await test.settle()
    // Completion keeps `/quit` in the editor; Enter then submits it.
    test.terminal.type(KEY.enter)
    expect(test.quits).toHaveLength(1)
  })

  it('lets Escape close the completion list instead of arming the stop', async () => {
    const test = await bench({ running: true })
    test.terminal.type('/')
    await test.settle()
    expect(test.terminal.text()).toContain('/sessions')
    test.terminal.type(KEY.escape)
    await test.settle()
    const closed = await test.screen()
    expect(closed).not.toContain('/sessions')
    expect(closed).not.toContain('press Esc again to stop turn')
    expect(test.calls.cancels).toBe(0)
  })

  it('picks a model from the composed providers', async () => {
    const test = await bench({
      before: (ctx) => {
        ctx.provide('llm', {
          listProviders: () => [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }, { id: 'p3', name: 'Three' }],
          resolveModelInfo: () => Promise.resolve({}),
          listModels: (provider: string) => {
            if (provider === 'p3') return Promise.reject(new Error('offline'))
            return Promise.resolve(provider === 'p1'
              ? [{ provider, id: 'a', name: 'A', description: 'first' }]
              : [{ provider, id: 'b', name: 'B' }])
          },
        } as never)
      },
    })
    typeLine(test.terminal, '/model')
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('p3: offline')
    expect(screen).toContain('p1/a')
    expect(screen).toContain('p2/b')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p2', model: 'b' })
    typeLine(test.terminal, '/model')
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p2', model: 'b' })
  })

  it('reports when no provider offers a model', async () => {
    const test = await bench()
    typeLine(test.terminal, '/model')
    await test.settle()
    expect(test.terminal.text()).toContain('no models are available')
    typeLine(test.terminal, '/help')
    typeLine(test.terminal, '/quit')
    expect(test.quits).toHaveLength(1)
  })
})

describe('the status bar', () => {
  /** A bench whose context projection gives the bar a segment between the model and the workspace. */
  function benchWithContext(): Promise<Awaited<ReturnType<typeof bench>>> {
    const contextPressure = { projectedTokens: 54_000, pressureTokens: 50_000, contextWindow: 128_000 }
    return bench({
      projections: {
        snapshot: () => ({ asOfSeq: -1, values: { contextPressure } }),
        onChanged: () => () => {},
      },
    })
  }

  it('advertises the status-bar entry key on the one unfocused footer line', async () => {
    const test = await bench()
    await test.settle()
    expect(test.terminal.text()).toContain('Shift+↓')
    expect(test.terminal.text()).not.toContain('Shift+↑ transcript')
    expect(test.terminal.text()).not.toContain('Enter sends')
    expect(test.terminal.text()).not.toContain('←→ segments')
  })

  it('takes focus on Shift+Down, swaps the hints, and types a printable key back into the editor', async () => {
    const test = await bench()
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    // The first printable key hands the keyboard back and lands at the caret.
    for (const char of 'zzz') test.terminal.type(char)
    await test.settle()
    expect(test.terminal.text()).toContain('Shift+↓')
    expect(test.calls.followups).toHaveLength(0)
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.ctrlO)
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    typeLine(test.terminal, ' hello')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'zzz hello' }]])
  })

  it('leaves a running turn alone while Esc returns focus to the editor, and for the whole handoff window after it', async () => {
    const test = await bench({ running: true })
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.calls.cancels).toBe(0)
    // A habitual second press lands inside the handoff window and does nothing
    // at all: it does not even arm the stop.
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.calls.cancels).toBe(0)
    expect(test.terminal.text()).not.toContain('press Esc again to stop turn')
    test.setNow(BENCH_NOW + ESCAPE_HANDOFF_MS)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.calls.cancels).toBe(0)
    expect(test.terminal.text()).toContain('press Esc again to stop turn 0')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.calls.cancels).toBe(1)
  })

  it('moves the selection with Left and Right, wrapping at both ends', async () => {
    const test = await benchWithContext()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('reasoning effort: the model\'s own default')
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('context: ~54k / 128k (42%)')
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('workspace: /work')
    // Past the last segment the selection wraps to the model.
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('model: test-model')
    // And before the first one it wraps to the workspace again.
    test.terminal.type(KEY.left)
    await test.settle()
    expect(await test.screen()).toContain('workspace: /work · ←→ segments')
    test.terminal.type(KEY.left)
    await test.settle()
    expect(await test.screen()).toContain('context: ~54k / 128k (42%) · ←→ segments')
  })

  it('lands Right from context on the todo details instead of jumping to the workspace', async () => {
    const contextPressure = { projectedTokens: 54_000, pressureTokens: 50_000, contextWindow: 128_000 }
    const test = await bench({
      projections: {
        snapshot: () => ({
          asOfSeq: -1,
          values: {
            contextPressure,
            todos: [
              { content: 'read the spec', status: 'completed' },
              { content: 'write the data layer', status: 'in_progress' },
              { content: 'wire the picker', status: 'pending' },
            ],
          },
        }),
        onChanged: () => () => {},
      },
    })
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.right)
    await test.settle()
    expect(await test.screen()).toContain('context: ~54k / 128k (42%) · ←→ segments')
    test.terminal.type(KEY.right)
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain('todos: 1 done · 1 active · 1 pending')
    expect(screen).not.toContain('workspace: /work · ←→ segments')
  })

  it('opens the effort picker with Shift+Tab only while the editor has focus', async () => {
    const test = await bench({
      before: (ctx) => {
        ctx.provide('llm', {
          resolveModelInfo: () => Promise.resolve({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }),
        } as never)
      },
    })
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    expect(test.terminal.text()).toContain('Reasoning effort · test-provider/test-model')
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model' })
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'low' })
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    // At the bar the same key walks the regions instead, leaving the effort
    // in force; this session draws no panel and has nothing to read, so the
    // walk comes back to the bar itself.
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'low' })
    test.terminal.type(KEY.left)
    test.terminal.type(KEY.enter)
    await test.settle()
    // Backward from the model wraps to the last segment, not the effort one.
    expect(test.terminal.text()).toContain('workspace: /work')
  })

  it('prints the details of the selected segment and keeps the bar focused', async () => {
    const test = await bench()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.enter)
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('provider: test-provider')
    expect(screen).toContain('reasoning effort: the model\'s own default')
    expect(screen).toContain('/model picks the provider and model for the next request')
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')
  })

  it('keeps the bar when an empty transcript cannot take the keyboard, and leaves it for the editor', async () => {
    const test = await bench()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(test.terminal.text()).toContain('nothing in the transcript to read yet')
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    // With no panel between them, Up at the bar reaches the editor, where the
    // next character is typed.
    test.terminal.type(KEY.up)
    await test.settle()
    expect(await test.screen()).not.toContain('←→ segments · Enter details · Tab regions · Esc input')
    typeLine(test.terminal, 'hello')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'hello' }]])
  })

  it('returns the selection to the first segment on Shift+Down', async () => {
    const test = await benchWithContext()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('model: test-model')
  })

  it('keeps Ctrl+C and Ctrl+D global and hands focus back to the editor', async () => {
    const test = await bench()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.terminal.text()).toContain('press Ctrl+C again to quit')
    expect(test.terminal.text()).toContain('Shift+↓')
    const quitting = await bench()
    quitting.terminal.type(KEY.shiftDown)
    quitting.terminal.type(KEY.ctrlD)
    await quitting.settle()
    expect(quitting.quits).toHaveLength(1)
  })

  it('gives the keyboard to the editor after a modal opened while the bar held it', async () => {
    const test = await bench()
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    const answered = test.ctx.waterfall(
      'approval/request',
      { agent: test.agent, toolName: 'bash' },
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    await test.settle()
    expect(test.terminal.text()).toContain('Allow bash?')
    test.terminal.type(KEY.enter)
    await expect(answered).resolves.toBe('allowed-once')
    await test.settle()
    expect(test.terminal.text()).toContain('Shift+↓')
    typeLine(test.terminal, 'after the modal')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'after the modal' }]])
  })

  it('keeps the bar usable after the fact behind the selection disappears', async () => {
    const test = await bench()
    test.appendAssistant([{ type: 'text', text: 'done' }], { usage: { inputTokens: 10, outputTokens: 4 } })
    await test.settle()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('this terminal: ↑10 ↓4 ctx 10')
    // A session switch drops the terminal's own totals, so the usage segment goes with them.
    test.terminal.type(KEY.escape)
    typeLine(test.terminal, '/new')
    await test.settle()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('model: opened-model')
  })

  it('reaches the last segment on Shift+Right and the first on Shift+Left', async () => {
    const test = await bench()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.shiftRight)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('workspace: /work')
    expect(test.terminal.text()).not.toContain('provider: test-provider')
    test.terminal.type(KEY.shiftLeft)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('provider: test-provider')
  })

  it('lands Right on the effort picked through Shift+Tab', async () => {
    const test = await bench({
      before: (ctx) => {
        ctx.provide('llm', {
          resolveModelInfo: () => Promise.resolve({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }),
        } as never)
      },
    })
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    expect(test.terminal.text()).toContain('Reasoning effort · test-provider/test-model')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('reasoning effort: low')
    expect(test.terminal.text()).toContain('Shift+Tab or /effort opens the effort list')
    expect(test.terminal.text()).not.toContain('provider: test-provider')
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'low' })
  })

  it('treats a Shift+Right sequence as one move, whatever the bar draws between the ends', async () => {
    const test = await benchWithContext()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.shiftRight)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('workspace: /work')
    expect(test.terminal.text()).not.toContain('context: ~54k / 128k (42%)')
    test.terminal.type(KEY.shiftLeft)
    await test.settle()
    expect(await test.screen()).toContain('provider: test-provider · ←→ segments')
    // One step back from the first segment wraps to the last one, which is
    // where Shift+Right had already landed.
    test.terminal.type(KEY.left)
    await test.settle()
    expect(await test.screen()).toContain('workspace: /work · ←→ segments')
  })

  it('moves by words with Shift+Left and Shift+Right while the editor has the keyboard', async () => {
    const test = await bench()
    for (const char of 'I want to do') test.terminal.type(char)
    test.terminal.type(KEY.shiftLeft)
    for (const char of 'quickly ') test.terminal.type(char)
    test.terminal.type(KEY.shiftRight)
    test.terminal.type('!')
    await test.settle()
    expect(test.terminal.text()).not.toContain('←→ segments')
    typeLine(test.terminal, '')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'I want to quickly do!' }]])
  })
})

/**
 * Open a turn on the bound session and put the bench clock `elapsedMs` past
 * the start the log recorded, so the readout is the spec's own number.
 * @param test - the running bench.
 * @param turn - the turn number the event carries.
 * @param elapsedMs - how far past the start the clock sits.
 */
function startTurn(test: Awaited<ReturnType<typeof bench>>, turn: number, elapsedMs: number): void {
  test.session.append('turn/start', { turn })
  const started = test.session.ownEvents().at(-1)?.time ?? 0
  test.setNow(started + elapsedMs)
}

describe('the running-turn counter', () => {
  it('appears on turn/start, advances on a tick, and goes away on turn/end', async () => {
    const test = await bench()
    await test.settle()
    expect(await test.screen()).not.toContain('turn 0s')
    startTurn(test, 4, 0)
    await test.settle()
    expect(test.terminal.text()).toContain('turn 0s')
    expect(test.tickArmed()).toBe(true)
    // One period with nothing else happening still moves the readout.
    test.tick()
    await test.settle()
    expect(test.terminal.text()).toContain('turn 1s')
    test.session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    await test.settle()
    expect(await test.screen()).not.toContain('turn 1s')
    expect(test.tickArmed()).toBe(false)
  })

  it('details the turn, when it started, and what is queued behind it', async () => {
    const test = await bench({ running: true })
    startTurn(test, 4, 72_000)
    const later = createUserMessage({ content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } })
    test.agent.inbox.append('next-turn', later)
    test.agent.ctx.emit('agent/inbox/inserted', { agent: test.agent, message: later })
    await test.settle()
    // Follow-ups are drawn; Shift+Down still reaches the bar, not the list.
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.right)
    test.terminal.type(KEY.enter)
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('turn 4')
    expect(screen).toContain('elapsed: 1m12s')
    expect(screen).toContain('queued: 1 for the next turn · 0 for the next step')
    expect(screen).toMatch(/started: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/u)
  })
})

describe('the activity board', () => {
  it('mounts todo rows above the editor, scratches a completed item, and leaves with turn/end', async () => {
    let todos: TodoItem[] = []
    const test = await bench({ color: true, projections: projectionsStub(() => ({ todos })) })
    todos = [
      { content: 'read the spec', status: 'pending' },
      { content: 'write the layer', status: 'in_progress' },
    ]
    writeTodos(test, todos)
    const later = createUserMessage({ content: [{ type: 'text', text: 'later on' }], source: { kind: 'user' } })
    test.agent.inbox.append('next-turn', later)
    test.agent.ctx.emit('agent/inbox/inserted', { agent: test.agent, message: later })
    let screen = await test.screen()
    expect(screen).toContain('○ read the spec')
    expect(screen).toMatch(spinning('write the layer'))
    expect(screen.indexOf('follow-ups')).toBeLessThan(screen.indexOf('○ read the spec'))
    expect(screen.indexOf('○ read the spec')).toBeLessThan(screen.indexOf('test-model'))

    todos = [
      { content: 'read the spec', status: 'completed' },
      { content: 'write the layer', status: 'in_progress' },
    ]
    test.session.append('todo/write', { todos })
    screen = await test.screen()
    expect(screen).toContain('✓ read the spec')
    expect(test.terminal.output).toContain('\u001b[9m')

    test.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    screen = await test.screen()
    expect(screen).not.toContain('read the spec')
    expect(screen).not.toContain('write the layer')
  })

  it('replaces the one-line descendant summary and ignores a session that is not a descendant', async () => {
    const test = await bench()
    const kid = await test.createChild({ id: 'session-kid' })
    test.ctx.emit('subagent/start', { runId: 'run-kid', provider: 'test', id: kid.id, local: true } as never)
    let screen = await test.screen()
    expect(screen).toContain('session-kid · running')

    kid.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1' as ToolCallId,
      name: 'bash',
      arguments: '{"command":"ls"}',
    })
    screen = await test.screen()
    expect(screen).toContain('session-kid · calling bash')

    kid.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: 'call-1' as ToolCallId,
        content: [{ type: 'text', text: 'listed files' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    screen = await test.screen()
    expect(screen).toContain('session-kid · listed files')
    expect(screen).not.toContain('calling bash')

    kid.session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'child assistant prose' }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    kid.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    screen = await test.screen()
    expect(screen).toContain('session-kid · done')
    expect(screen).not.toContain('child assistant prose')
    expect(screen).not.toContain('listed files')

    const stranger = await test.createChild({ id: 'session-stranger', parent: 'session-other' as SessionId })
    test.ctx.emit('subagent/start', { runId: 'run-stranger', provider: 'test', id: stranger.id, local: true } as never)
    screen = await test.screen()
    expect(screen).not.toContain('session-stranger · running')
    stranger.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: 'call-x' as ToolCallId,
        content: [{ type: 'text', text: 'stranger output' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    screen = await test.screen()
    expect(screen).not.toContain('stranger output')
    expect(screen).toContain('session-kid · done')

    const orphan = await test.createChild({ id: 'session-orphan' })
    orphan.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: 'call-orphan' as ToolCallId,
        content: [{ type: 'text', text: 'result without a call' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    screen = await test.screen()
    expect(screen).toContain('session-orphan · result without a call')
  })

  it('names a listed descendant and a bound-parent stop reason without the last assistant message', async () => {
    const entries: SubagentDescendantListEntry[] = []
    const test = await bench({ subagents: () => Promise.resolve(entries) })
    const listed = await test.createChild({ id: 'session-listed', parent: 'session-other' as SessionId })
    entries.push({
      kind: 'child',
      id: listed.id,
      activity: 'running',
      mode: 'one-shot',
      hasChildren: false,
      parentId: 'session-other' as SessionId,
      depth: 1,
      label: 'reviewer',
    })
    listed.setStatus('running')
    test.tick()
    await test.settle()
    listed.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-2' as ToolCallId,
      name: 'read',
      arguments: '{',
    })
    let screen = await test.screen()
    expect(screen).toContain('reviewer · calling read')

    const start = { runId: 'run-1', provider: 'test', id: listed.id, local: true }
    test.ctx.emit('subagent/start', start as never)
    test.ctx.emit('subagent/start', start as never)
    screen = await test.screen()
    expect(screen).toContain('reviewer · running')

    test.ctx.emit('subagent/end', {
      runId: 'run-1',
      provider: 'test',
      id: listed.id,
      local: true,
      stopReason: 'aborted',
      lastAssistantMessage: [{ type: 'text', text: 'secret child reply' }],
    } as never)
    screen = await test.screen()
    expect(screen).toContain('reviewer · aborted')
    expect(screen).not.toContain('secret child reply')

    test.ctx.emit('subagent/end', {
      runId: 'run-2',
      provider: 'test',
      id: 'session-elsewhere',
      local: true,
      stopReason: 'error',
      lastAssistantMessage: [{ type: 'text', text: 'other parent reply' }],
    } as never)
    screen = await test.screen()
    expect(screen).not.toContain('other parent reply')
    expect(screen).toContain('reviewer · aborted')
  })

  it('leaves the board unmounted after replaying a finished session', async () => {
    const todos: TodoItem[] = [{ content: 'replayed task', status: 'pending' }]
    const test = await bench({
      projections: projectionsStub(() => ({ todos })),
      history: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'todo/write', seq: 1, time: 2, data: { todos } },
        { type: 'todo/write', seq: 2, time: 3, data: { todos } },
        { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never[],
    })
    const screen = await test.screen()
    expect(screen).not.toContain('replayed task')
  })

  it('repaints a fading board row on the shared fade tick', async () => {
    let todos: TodoItem[] = []
    const test = await bench({
      color: true,
      env: { COLORTERM: 'truecolor' },
      background: 'rgb:0000/0000/0000',
      projections: projectionsStub(() => ({ todos })),
    })
    todos = [{ content: 'fade me', status: 'pending' }]
    writeTodos(test, todos)
    const kid = await test.createChild({ id: 'session-fade' })
    kid.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-fade' as ToolCallId,
      name: 'bash',
      arguments: '{}',
    })
    await test.settle()
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)
    test.runTick(FADE_TICK_MS)
    const screen = await test.screen()
    expect(screen).toContain('○ fade me')
    expect(screen).toContain('session-fade · calling bash')
  })

  it('draws no todo rows when the projection has not published the list', async () => {
    const test = await bench({ projections: projectionsStub(() => ({ todos: null })) })
    test.session.append('turn/start', { turn: 1 })
    test.session.append('todo/write', { todos: [{ content: 'hidden until projected', status: 'pending' }] })
    expect(await test.screen()).not.toContain('hidden until projected')
  })

  it('spins an in-progress todo on the spinner tick and stops once none is in progress', async () => {
    let todos: TodoItem[] = [{ content: 'write the layer', status: 'in_progress' }]
    const test = await bench({ projections: projectionsStub(() => ({ todos })) })
    writeTodos(test, todos)
    await test.settle()
    expect(test.tickArmed(SPINNER_MS)).toBe(true)
    const first = (await test.screen()).match(spinning('write the layer'))?.[0]
    test.runTick(SPINNER_MS)
    const next = (await test.screen()).match(spinning('write the layer'))?.[0]
    expect(next).toBeDefined()
    expect(next).not.toBe(first)
    todos = [{ content: 'write the layer', status: 'completed' }]
    test.session.append('todo/write', { todos })
    await test.settle()
    expect(test.tickArmed(SPINNER_MS)).toBe(false)
  })
})

describe('working indicators', () => {
  it('spins a running tool card on its own tick and disarms it when the result lands', async () => {
    const test = await bench()
    await test.settle()
    test.appendToolCall('call-1', 'bash', { command: 'ls' })
    await test.settle()
    expect(test.tickArmed(SPINNER_MS)).toBe(true)
    const first = (await test.screen()).match(spinning('bash'))?.[0]
    expect(first).toBeDefined()
    test.runTick(SPINNER_MS)
    const next = (await test.screen()).match(spinning('bash'))?.[0]
    expect(next).toBeDefined()
    expect(next).not.toBe(first)
    test.appendToolResult('call-1', [{ type: 'text', text: 'ok' }])
    test.runTick(SPINNER_MS)
    const settled = await test.screen()
    expect(settled).toContain('◆ bash')
    expect(settled).not.toMatch(spinning('bash'))
    expect(test.tickArmed(SPINNER_MS)).toBe(false)
  })

  it('draws a static glyph and arms no spinner tick under reduced motion or for a replayed card', async () => {
    const reduced = await bench({ reducedMotion: true })
    reduced.appendToolCall('call-1', 'bash', { command: 'ls' })
    expect(await reduced.screen()).toContain('◆ bash')
    expect(reduced.tickArmed(SPINNER_MS)).toBe(false)

    const history = [
      { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{"command":"ls"}' } },
    ] as never[]
    const replayed = await bench({ history })
    expect(await replayed.screen()).toContain('◆ bash')
    expect(replayed.tickArmed(SPINNER_MS)).toBe(false)
  })

  it('shimmers the working spinner word, and leaves it dim under reduced motion', async () => {
    const test = await bench({ running: true, color: true })
    await test.settle()
    expect(test.terminal.output).toContain(shimmer(createPalette(true), 'thinking', BENCH_NOW))
    expect(test.terminal.output).not.toContain('\u001b[2mthinking\u001b[22m')
    const reduced = await bench({ running: true, color: true, reducedMotion: true })
    await reduced.settle()
    expect(reduced.terminal.output).toContain('\u001b[2mthinking\u001b[22m')
  })

  it('draws a prompt steered into a stepped turn on the darker band, and the turn-opening prompt on the ordinary one', async () => {
    const test = await bench({ color: true })
    const opening = createUserMessage({ content: [{ type: 'text', text: 'open the turn' }], source: { kind: 'user' } })
    const steered = createUserMessage({ content: [{ type: 'text', text: 'change course' }], source: { kind: 'user' } })
    test.session.append('turn/start', { turn: 1 })
    test.session.append('user/message', opening, { surfaceOp: 'append' })
    test.session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'working' }], source: { provider: 'test-provider', model: 'test-model' } }),
    }, { surfaceOp: 'append' })
    test.session.append('user/message', steered, { surfaceOp: 'append' })
    await test.settle()
    const output = test.terminal.output
    expect(output).toMatch(/\u001b\[48;5;236m[^\n]*open the turn/u)
    expect(output).toMatch(/\u001b\[48;5;234m[^\n]*change course/u)
    expect(output).not.toMatch(/\u001b\[48;5;234m[^\n]*open the turn/u)
  })
})
