/** Cursor Runs parked across DSH steps. */
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ExecServerMessageSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from '../src/native/agent_pb.ts'
import type { AgentClientMessage } from '../src/native/agent_pb.ts'
import type { ConnectFrame } from '../src/connect.ts'
import { CursorRunRegistry } from '../src/park.ts'
import { streamCursorRun } from '../src/stream.ts'
import type { OpenCursorStream } from '../src/stream.ts'

const TIMING = { streamIdleTimeoutMs: 5_000, parkedRunTimeoutMs: 60_000, toolCallSettleMs: 50 }

afterEach(() => {
  vi.useRealTimers()
})

type ServerMessage = ReturnType<typeof create<typeof AgentServerMessageSchema>>

/** One scripted Connect stream whose frames the test pushes while the adapter reads. */
interface LiveStream {
  written: AgentClientMessage[]
  destroyed: boolean
  push(message: ServerMessage): void
  fail(error: Error): void
}

/** Opener that hands out one {@link LiveStream} per Run. */
function liveStreams(): { open: OpenCursorStream; streams: LiveStream[] } {
  const streams: LiveStream[] = []
  const open: OpenCursorStream = () => {
    const queue: ConnectFrame[] = []
    const waiters: Array<{ resolve: (result: IteratorResult<ConnectFrame>) => void; reject: (error: Error) => void }> = []
    let failure: Error | undefined
    const live: LiveStream = {
      written: [],
      destroyed: false,
      push(message) {
        const frame = { endStream: false, payload: toBinary(AgentServerMessageSchema, message) }
        const waiter = waiters.shift()
        if (waiter !== undefined) waiter.resolve({ done: false, value: frame })
        else queue.push(frame)
      },
      fail(error) {
        failure = error
        while (waiters.length > 0) waiters.shift()?.reject(error)
      },
    }
    streams.push(live)
    return {
      write: (bytes) => { live.written.push(fromBinary(AgentClientMessageSchema, bytes)) },
      end: () => {},
      destroy: () => { live.destroyed = true },
      frames: {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const frame = queue.shift()
            if (frame !== undefined) return Promise.resolve({ done: false, value: frame })
            if (failure !== undefined) return Promise.reject(failure)
            return new Promise((resolve, reject) => { waiters.push({ resolve, reject }) })
          },
        }),
      },
    }
  }
  return { open, streams }
}

function update(message: ReturnType<typeof create<typeof InteractionUpdateSchema>>['message']): ServerMessage {
  return create(AgentServerMessageSchema, {
    message: { case: 'interactionUpdate', value: create(InteractionUpdateSchema, { message }) },
  })
}

const text = (value: string) => update({ case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: value }) })
const turnEnded = () => update({ case: 'turnEnded', value: create(TurnEndedUpdateSchema, {}) })
const checkpoint = () => create(AgentServerMessageSchema, {
  message: { case: 'conversationCheckpointUpdate', value: create(ConversationStateStructureSchema, {}) },
})

function mcpCall(id: number, toolCallId: string): ServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: 'execServerMessage',
      value: create(ExecServerMessageSchema, {
        id,
        execId: `exec-${id}`,
        message: { case: 'mcpArgs', value: create(McpArgsSchema, { name: 'dsh-read', toolName: 'read', toolCallId, args: {} }) },
      }),
    },
  })
}

const SESSION = brandString<NonNullable<GenerateOptions['sessionId']>>('session-1')
const prompt = createUserMessage({ content: [{ type: 'text', text: 'read two files' }], source: { kind: 'user' } })
const firstStep: GenerateOptions = {
  provider: 'cursor',
  model: 'composer-2',
  messages: [prompt],
  tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
  sessionId: SESSION,
}

function toolSteps(steps: readonly (readonly string[])[]): Message[] {
  return steps.flatMap(ids => [
    createAssistantMessage({
      source: { provider: 'cursor', model: 'composer-2' },
      content: [
        { type: 'text' as const, text: 'Reading.' },
        ...ids.map(id => ({ type: 'tool-call' as const, id: ToolCallId(id), name: 'read', arguments: '{}' })),
      ],
    }),
    ...ids.map(id => createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text: `body of ${id}` }], isError: id === 'c2' })),
  ])
}

function toolTurn(ids: readonly string[], extra: Message[] = [], earlier: readonly (readonly string[])[] = []): GenerateOptions {
  return { ...firstStep, messages: [prompt, ...toolSteps([...earlier, ids]), ...extra] }
}

/** Run the first step on a fresh registry and park it on the given MCP calls. */
async function parkedFirstStep(ids: readonly string[], options: GenerateOptions = firstStep) {
  const { open, streams } = liveStreams()
  const registry = new CursorRunRegistry()
  const first = drain(streamCursorRun(options, 'tok', TIMING, open, registry))
  await vi.waitFor(() => { expect(streams).toHaveLength(1) })
  ids.forEach((id, index) => { streams[0]!.push(mcpCall(5 + index, id)) })
  streams[0]!.push(checkpoint())
  await first
  return { open, streams, registry }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  return await Array.fromAsync(stream)
}

function mcpResults(written: readonly AgentClientMessage[]) {
  return written.flatMap((message) => {
    if (message.message.case !== 'execClientMessage' || message.message.value.message.case !== 'mcpResult') return []
    const result = message.message.value.message.value.result
    if (result.case !== 'success') return []
    const content = result.value.content[0]?.content
    return [{
      id: message.message.value.id,
      execId: message.message.value.execId,
      text: content?.case === 'text' ? content.value.text : '',
      isError: result.value.isError,
    }]
  })
}

const cancelled = (written: readonly AgentClientMessage[]) =>
  written.some(message => message.message.case === 'conversationAction' && message.message.value.action.case === 'cancelAction')

describe('parked Cursor Runs', () => {
  it('batches parallel MCP calls until the checkpoint, parks the Run, and resumes it with the tool results', async () => {
    const { open, streams } = liveStreams()
    const registry = new CursorRunRegistry()
    const first = drain(streamCursorRun(firstStep, 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(streams).toHaveLength(1) })
    const live = streams[0]!
    live.push(text('Reading both.'))
    live.push(mcpCall(5, 'c1'))
    live.push(mcpCall(6, 'c2'))
    live.push(checkpoint())
    const step1 = await first
    const calls = step1.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block.id] : [])
    expect(calls).toEqual(['c1', 'c2'])
    expect(step1.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(live.destroyed).toBe(false)

    const second = drain(streamCursorRun(toolTurn(['c1', 'c2']), 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(mcpResults(live.written)).toHaveLength(2) })
    expect(mcpResults(live.written)).toEqual([
      { id: 5, execId: 'exec-5', text: 'body of c1', isError: false },
      { id: 6, execId: 'exec-6', text: 'body of c2', isError: true },
    ])
    live.push(text('Both read.'))
    live.push(turnEnded())
    const step2 = await second
    expect(streams).toHaveLength(1)
    expect(step2.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : [])).toEqual(['Both read.'])
    expect(step2.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(live.destroyed).toBe(true)
    expect(cancelled(live.written)).toBe(false)
  })

  it('ends the tool batch after the settle wait when no checkpoint follows', async () => {
    const { open, streams } = liveStreams()
    const registry = new CursorRunRegistry()
    const first = drain(streamCursorRun(firstStep, 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(streams).toHaveLength(1) })
    streams[0]!.push(mcpCall(5, 'c1'))
    expect((await first).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(streams[0]!.destroyed).toBe(false)
    registry.closeAll()
    expect(streams[0]!.destroyed).toBe(true)
    expect(cancelled(streams[0]!.written)).toBe(true)
  })

  it('appends harness context that followed the tool results to the last result it sends', async () => {
    const { open, streams } = liveStreams()
    const registry = new CursorRunRegistry()
    const first = drain(streamCursorRun(firstStep, 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(streams).toHaveLength(1) })
    streams[0]!.push(mcpCall(5, 'c1'))
    streams[0]!.push(mcpCall(6, 'c3'))
    streams[0]!.push(checkpoint())
    await first
    const notice = createUserMessage({ content: [{ type: 'text', text: 'nested instructions' }], source: { kind: 'agent-instructions', form: 'instructions' } as never })
    const second = drain(streamCursorRun(toolTurn(['c1', 'c3'], [notice]), 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(mcpResults(streams[0]!.written)).toHaveLength(2) })
    expect(mcpResults(streams[0]!.written).map(result => result.text)).toEqual(['body of c1', 'body of c3\n\nnested instructions'])
    streams[0]!.push(text('done'))
    streams[0]!.push(turnEnded())
    expect((await second).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(streams).toHaveLength(1)
  })

  it('opens a new Run and cancels the parked one when a human message followed the tool results', async () => {
    const { open, streams } = liveStreams()
    const registry = new CursorRunRegistry()
    const first = drain(streamCursorRun(firstStep, 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(streams).toHaveLength(1) })
    streams[0]!.push(mcpCall(5, 'c1'))
    streams[0]!.push(checkpoint())
    await first
    const steer = createUserMessage({ content: [{ type: 'text', text: 'also check README' }], source: { kind: 'user' } })
    const second = drain(streamCursorRun(toolTurn(['c1'], [steer]), 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(streams).toHaveLength(2) })
    expect(streams[0]!.destroyed).toBe(true)
    expect(cancelled(streams[0]!.written)).toBe(true)
    expect(mcpResults(streams[0]!.written)).toEqual([])
    streams[1]!.push(text('done'))
    streams[1]!.push(turnEnded())
    expect((await second).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('rebuilds on a new Run when the parked Run died before the tool results arrived', async () => {
    const { open, streams } = liveStreams()
    const registry = new CursorRunRegistry()
    const first = drain(streamCursorRun(firstStep, 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(streams).toHaveLength(1) })
    streams[0]!.push(mcpCall(5, 'c1'))
    streams[0]!.push(checkpoint())
    await first
    streams[0]!.fail(new Error('GOAWAY'))
    const second = drain(streamCursorRun(toolTurn(['c1']), 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(streams).toHaveLength(2) })
    expect(streams[1]!.written[0]?.message.case).toBe('runRequest')
    streams[1]!.push(text('done'))
    streams[1]!.push(turnEnded())
    expect((await second).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('keeps side requests and Session-less requests off the registry', async () => {
    const { open, streams } = liveStreams()
    const registry = new CursorRunRegistry()
    const { sessionId: _sessionId, ...sessionless } = firstStep
    for (const options of [{ ...firstStep, purpose: 'session-title' as const }, sessionless]) {
      const step = drain(streamCursorRun(options, 'tok', TIMING, open, registry))
      await vi.waitFor(() => { expect(streams.at(-1)?.destroyed).toBe(false) })
      streams.at(-1)!.push(mcpCall(5, 'c1'))
      streams.at(-1)!.push(checkpoint())
      await step
      expect(streams.at(-1)!.destroyed).toBe(true)
    }
    const resumed = drain(streamCursorRun(toolTurn(['c1']), 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(streams).toHaveLength(3) })
    streams[2]!.push(turnEnded())
    await expect(resumed).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it('heartbeats a parked Run and cancels it when its tool results never arrive', async () => {
    vi.useFakeTimers()
    const { open, streams } = liveStreams()
    const registry = new CursorRunRegistry()
    const first = drain(streamCursorRun(firstStep, 'tok', { ...TIMING, parkedRunTimeoutMs: 12_000 }, open, registry))
    await vi.waitFor(() => { expect(streams).toHaveLength(1) })
    streams[0]!.push(mcpCall(5, 'c1'))
    streams[0]!.push(checkpoint())
    await first
    await vi.advanceTimersByTimeAsync(11_000)
    expect(streams[0]!.written.filter(message => message.message.case === 'clientHeartbeat')).toHaveLength(2)
    expect(streams[0]!.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(streams[0]!.destroyed).toBe(true)
    expect(cancelled(streams[0]!.written)).toBe(true)
  })

  it('parks again on a resumed Run whose history already holds tool results', async () => {
    const { open, streams, registry } = await parkedFirstStep(['c1'])
    const second = drain(streamCursorRun(toolTurn(['c1']), 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(mcpResults(streams[0]!.written)).toHaveLength(1) })
    streams[0]!.push(mcpCall(9, 'c3'))
    streams[0]!.push(checkpoint())
    expect((await second).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    const third = drain(streamCursorRun(toolTurn(['c3'], [], [['c1']]), 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(mcpResults(streams[0]!.written)).toHaveLength(2) })
    expect(mcpResults(streams[0]!.written)[1]).toMatchObject({ id: 9, text: 'body of c3' })
    streams[0]!.push(text('done'))
    streams[0]!.push(turnEnded())
    await third
    expect(streams).toHaveLength(1)
  })

  it('opens a new Run when the request lacks a pending result or has no assistant message', async () => {
    for (const next of [
      { ...toolTurn(['c1', 'c2']), messages: toolTurn(['c1', 'c2']).messages.slice(0, -1) },
      firstStep,
    ]) {
      const { open, streams, registry } = await parkedFirstStep(['c1', 'c2'])
      const step = drain(streamCursorRun(next, 'tok', TIMING, open, registry))
      await vi.waitFor(() => { expect(streams).toHaveLength(2) })
      expect(cancelled(streams[0]!.written)).toBe(true)
      streams[1]!.push(text('fresh'))
      streams[1]!.push(turnEnded())
      await step
    }
  })

  it('hands a read abandoned by the settle wait to the resumed step', async () => {
    const { open, streams } = liveStreams()
    const registry = new CursorRunRegistry()
    const first = drain(streamCursorRun(firstStep, 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(streams).toHaveLength(1) })
    streams[0]!.push(mcpCall(5, 'c1'))
    await first
    const second = drain(streamCursorRun(toolTurn(['c1']), 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(mcpResults(streams[0]!.written)).toHaveLength(1) })
    streams[0]!.push(text('after'))
    streams[0]!.push(turnEnded())
    const texts = (await second).flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : [])
    expect(texts).toEqual(['after'])
  })

  it('keeps a parked Run when the finished step signal aborts, and does not rebuild when a resumed step is cancelled', async () => {
    const stepSignal = new AbortController()
    const { open, streams, registry } = await parkedFirstStep(['c1'], { ...firstStep, signal: stepSignal.signal })
    stepSignal.abort()
    expect(streams[0]!.destroyed).toBe(false)
    const cancel = new AbortController()
    const second = drain(streamCursorRun({ ...toolTurn(['c1']), signal: cancel.signal }, 'tok', TIMING, open, registry))
    await vi.waitFor(() => { expect(mcpResults(streams[0]!.written)).toHaveLength(1) })
    cancel.abort()
    await expect(second).rejects.toMatchObject({ code: 'ABORTED' })
    expect(streams).toHaveLength(1)
    expect(streams[0]!.destroyed).toBe(true)
  })

  it('keeps a parked Run when the step signal aborts before the caller finishes iterating', async () => {
    const { open, streams } = liveStreams()
    const registry = new CursorRunRegistry()
    const stepSignal = new AbortController()
    const iterator = streamCursorRun({ ...firstStep, signal: stepSignal.signal }, 'tok', TIMING, open, registry)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(streams).toHaveLength(1) })
    streams[0]!.push(mcpCall(5, 'c1'))
    streams[0]!.push(checkpoint())
    let chunk = await pending
    while (chunk.done !== true && chunk.value.type !== 'finish') chunk = await iterator.next()
    stepSignal.abort()
    expect(streams[0]!.destroyed).toBe(false)
    await iterator.return?.()
    expect(streams[0]!.destroyed).toBe(false)
    registry.closeAll()
  })

  it('reports a resumed step that times out instead of rebuilding it', async () => {
    const { open, streams, registry } = await parkedFirstStep(['c1'])
    await expect(drain(streamCursorRun(toolTurn(['c1']), 'tok', { ...TIMING, streamIdleTimeoutMs: 30 }, open, registry)))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(streams).toHaveLength(1)
  })
})
