/** Durable failed-attempt content in the assembled terminal and its reader. */
import { afterEach, expect, it } from 'vitest'
import { AssistantStreamAccumulator, ToolCallId, createAssistantMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { NOTHING_TO_READ_TOAST } from '../src/toast.ts'
import { KEY, bench, spinning, type Bench } from './bench.ts'

const opened: Bench[] = []

afterEach(async () => {
  const current = opened.splice(0)
  for (const test of current) test.app.stop()
  await Promise.all(current.map(test => test.ctx.fiber.dispose()))
})

async function terminal(options: Parameters<typeof bench>[0] = {}): Promise<Bench> {
  const test = await bench(options)
  opened.push(test)
  return test
}

function startTurn(test: Bench): void {
  test.session.append('turn/start', { turn: 1 })
  test.session.append('step/start', { turn: 1, step: 1 })
}

function attempt(test: Bench, chunks: readonly StreamChunk[], live = false): SessionEvent<'assistant/attempt'> {
  const accumulator = new AssistantStreamAccumulator()
  if (live) test.stream.start()
  for (const chunk of chunks) {
    accumulator.push({ time: 1, chunk })
    if (live) test.stream.chunk(chunk)
  }
  const event = test.session.append('assistant/attempt', { turn: 1, step: 1, stream: [...accumulator.snapshot()] })
  if (live) test.stream.end({ kind: 'committed', eventType: 'assistant/attempt', seq: event.seq })
  return event
}

const failure: StreamChunk = {
  type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'temporary provider failure' } },
}

it.each([0, 8])('settles a live attempt once and replays its text and reasoning (pacing %s)', async (streamPaceFrames) => {
  const live = await terminal({ running: true, streamPaceFrames, color: true })
  startTurn(live)
  attempt(live, [
    { type: 'reasoning-delta', index: 0, text: 'provisional thought' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'retained thought' } },
    { type: 'text-delta', index: 1, text: 'provisional reply' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'retained reply' } },
    { type: 'tool-call-delta', index: 2, id: ToolCallId('unexecuted'), name: 'write', argumentsDelta: '{"path":"never.txt"}' },
    { type: 'usage', usage: { inputTokens: 999_999, outputTokens: 999_999 } },
    failure,
  ], true)
  const verify = (screen: string): void => {
    expect(screen.split('retained thought')).toHaveLength(2)
    expect(screen.split('retained reply')).toHaveLength(2)
    expect(screen).not.toContain('provisional')
    expect(screen).not.toContain('never.txt')
    expect(screen).not.toMatch(spinning('write', 'tool'))
    expect(screen).toContain('✻ Thinking')
    expect(screen).not.toContain('[interrupted]')
    expect(screen).not.toContain('↓1M')
  }
  verify(await live.screen())
  live.runTick(16)
  verify(await live.screen())
  const replay = await terminal({ history: live.session.ownEvents() })
  verify(await replay.screen())
  replay.terminal.type(KEY.shiftUp)
  let screen = await replay.screen()
  expect(screen).toContain('READ')
  expect(screen).toContain('retained thought')
  replay.terminal.type(KEY.ctrlG)
  screen = await replay.screen()
  expect(screen).toContain('READER')
  expect(screen).toContain('retained thought')
  expect(screen).toContain('retained reply')
})

it('keeps failed attempts ordered before the successful message without adding their usage', async () => {
  const live = await terminal()
  startTurn(live)
  attempt(live, [
    { type: 'text-delta', index: 0, text: 'first ' },
    { type: 'text-delta', index: 0, text: 'attempt' },
    { type: 'usage', usage: { inputTokens: 999_999, outputTokens: 999_999 } },
    failure,
  ])
  attempt(live, [{ type: 'reasoning-delta', index: 0, text: 'reasoning without a finish' }])
  live.session.append('assistant/message', {
    turn: 1, step: 1, stream: [], usage: { inputTokens: 1200, outputTokens: 34 },
    message: createAssistantMessage({ content: [{ type: 'text', text: 'successful reply' }], source: { provider: 'test', model: 'test' } }),
  }, { surfaceOp: 'append' })
  live.session.append('step/end', { turn: 1, step: 1 })
  live.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const replay = await terminal({ history: live.session.ownEvents() })
  for (const test of [live, replay]) {
    test.terminal.type(KEY.shiftDown)
    const screen = await test.screen()
    expect(screen.indexOf('first attempt')).toBeGreaterThanOrEqual(0)
    expect(screen.indexOf('reasoning without a finish')).toBeGreaterThan(screen.indexOf('first attempt'))
    expect(screen.indexOf('successful reply')).toBeGreaterThan(screen.indexOf('reasoning without a finish'))
    expect(screen).toContain('↑1.2k ↓34')
    expect(screen).not.toContain('[interrupted]')
  }
})

it.each([
  { name: 'empty', chunks: [] },
  { name: 'tool-only', chunks: [{ type: 'tool-call-delta', index: 0, id: ToolCallId('unused'), name: 'write', argumentsDelta: '{}' }] },
  { name: 'usage-only', chunks: [{ type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }] },
] satisfies { name: string; chunks: StreamChunk[] }[])('omits $name attempts from transcript navigation', async ({ chunks }) => {
  const live = await terminal()
  startTurn(live)
  attempt(live, chunks, true)
  const replay = await terminal({ history: live.session.ownEvents() })
  for (const test of [live, replay]) {
    test.terminal.type(KEY.ctrlG)
    const screen = await test.screen()
    expect(screen).toContain(NOTHING_TO_READ_TOAST)
    expect(screen).not.toContain('READER')
    expect(screen).not.toMatch(spinning('write', 'tool'))
  }
})

it.each([0, 8])('discards speculative content when closed attempt blocks are empty (pacing %s)', async (streamPaceFrames) => {
  const test = await terminal({ streamPaceFrames, color: true })
  startTurn(test)
  attempt(test, [
    { type: 'reasoning-delta', index: 0, text: 'discarded thought' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '  ' } },
    { type: 'text-delta', index: 1, text: 'discarded reply' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '' } },
    failure,
  ], true)
  test.runTick(16)
  test.terminal.type(KEY.ctrlG)
  const screen = await test.screen()
  expect(screen).not.toContain('discarded')
  expect(screen).toContain(NOTHING_TO_READ_TOAST)
})

it('keeps interrupted assistant messages and their accounting unchanged', async () => {
  const test = await terminal()
  test.stream.start()
  test.stream.chunk({ type: 'text-delta', index: 0, text: 'cancelled prefix' })
  test.appendAssistant([{ type: 'text', text: 'cancelled prefix' }], { interrupted: true, usage: { inputTokens: 1200, outputTokens: 34 } })
  const settlement = test.session.ownEvents().findLast(event => event.type === 'assistant/message')
  if (settlement === undefined) throw new Error('missing interrupted assistant message')
  test.stream.end({ kind: 'committed', eventType: 'assistant/message', seq: settlement.seq })
  const replay = await terminal({ history: test.session.ownEvents() })
  for (const current of [test, replay]) {
    current.terminal.type(KEY.shiftDown)
    const screen = await current.screen()
    expect(screen.split('cancelled prefix')).toHaveLength(2)
    expect(screen.split('[interrupted]')).toHaveLength(2)
    expect(screen).toContain('↑1.2k ↓34')
  }
})
