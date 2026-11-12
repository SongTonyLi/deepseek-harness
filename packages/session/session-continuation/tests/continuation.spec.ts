/** Continuation admission through real Agent and Session lifecycles. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { BuiltinLlmFailureCode, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import SessionContinuation, { SessionContinuationBusyError } from '../src/index.ts'
import type { RetrySource, SessionRequestId } from '../src/types.ts'

/** Two failed requests followed by one completed response. */
class ContinuationAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly failure: BuiltinLlmFailureCode) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length <= 2) throw new LlmError('failed', this.failure)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const source = (id: string): RetrySource => ({
  kind: 'retry', rpcId: brandString<SessionRequestId>(id), clientTimeZone: 'UTC',
})
const human = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function setup(code: BuiltinLlmFailureCode = 'SERVER') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ContinuationAdapter(code)
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  const fiber = await ctx.plugin(SessionContinuation)
  const agent = await ctx.agentLoop.create(SessionId('continuation-test'), { provider: 'mock', model: 'mock' })
  return { ctx, fiber, agent, adapter }
}

it('admits exact empty retry messages after failures and preserves injected context', async () => {
  const { ctx, agent, adapter } = await setup()
  expect(await ctx.sessionContinuation.retry(agent, source('fresh'))).toBe('unavailable')
  expect(adapter.requests).toHaveLength(0)
  agent.followup(human('original task'))
  await agent.whenIdle()
  agent.inject(createUserMessage({ content: [{ type: 'text', text: 'injected context' }], source: { kind: 'user' } }))
  // A user-sourced next-step message is human input and cannot be bypassed.
  expect(await ctx.sessionContinuation.retry(agent, source('pending'))).toBe('unavailable')
  agent.inbox.clear()
  agent.inject(createUserMessage({ content: [{ type: 'text', text: 'injected context' }], source: { kind: 'system-prompt' } }))
  expect(await ctx.sessionContinuation.retry(agent, source('first'))).toBe('accepted')
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('injected context')
  expect(await ctx.sessionContinuation.retry(agent, source('second'))).toBe('accepted')
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(3)
  const events = agent.session.snapshotEvents()
  const retries = events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'retry' ? [event.data] : [])
  expect(retries.map(message => ({ content: message.content, source: message.source }))).toEqual([
    { content: [], source: source('first') }, { content: [], source: source('second') },
  ])
  expect(events.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : []))
    .toEqual(['error', 'error', 'completed'])
  expect(await ctx.sessionContinuation.retry(agent, source('completed'))).toBe('unavailable')
})

it('refuses ineligible failures and queued human work without waking the Agent', async () => {
  const { ctx, agent, adapter } = await setup('AUTH')
  agent.followup(human('task'))
  await agent.whenIdle()
  expect(await ctx.sessionContinuation.retry(agent, source('auth'))).toBe('unavailable')
  expect(adapter.requests).toHaveLength(1)
})

it('refuses pending next-turn work and active maintenance', async () => {
  const { ctx, agent, adapter } = await setup()
  agent.followup(human('task'))
  await agent.whenIdle()
  agent.inbox.append('next-turn', human('queued'))
  expect(await ctx.sessionContinuation.retry(agent, source('queued'))).toBe('unavailable')
  expect(adapter.requests).toHaveLength(1)
  agent.inbox.clear()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { release.resolve() })
  const maintenance = agent.runMaintenance(() => release.promise)
  try {
    await expect(ctx.sessionContinuation.retry(agent, source('busy'))).rejects.toMatchObject({
      name: 'SessionContinuationBusyError', code: 'AGENT_BUSY', cause: expect.any(Error) as Error,
    })
    await expect(ctx.sessionContinuation.retry(agent, source('busy-again'))).rejects.toBeInstanceOf(SessionContinuationBusyError)
  } finally {
    release.resolve()
    await maintenance
  }
  expect(adapter.requests).toHaveLength(1)
})

it('preserves an admission failure instead of reporting it as busy', async () => {
  const { ctx, agent } = await setup()
  agent.followup(human('task'))
  await agent.whenIdle()
  const failure = new Error('inbox write failed')
  vi.spyOn(agent, 'followup').mockImplementationOnce(() => { throw failure })
  await expect(ctx.sessionContinuation.retry(agent, source('fails'))).rejects.toBe(failure)
})

it('restores the projection from its checkpoint and unregisters it on disposal', async () => {
  const { ctx, fiber, agent } = await setup()
  agent.followup(human('task'))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const expected = ctx.sessionProjections.snapshot(agent.session).values.conversationContinuation
  expect(expected).not.toBeNull()
  const checkpoint = ctx.sessionProjections.checkpoint(agent.session)
  expect(checkpoint.conversationContinuation?.ver).toBe(4)
  const restored = ctx.sessionProjections.restore(
    checkpoint,
    [],
    SessionLogOffset(events.length),
    agent.session.header,
    agent.session.inheritedEventCount,
  )
  expect(restored.snapshot.values.conversationContinuation).toBe(expected)
  const replayed = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), agent.session.header, agent.session.inheritedEventCount)
  expect(replayed.snapshot.values.conversationContinuation).toBe(expected)
  await fiber.dispose()
  expect(ctx.sessionProjections.snapshot(agent.session).values).not.toHaveProperty('conversationContinuation')
})
