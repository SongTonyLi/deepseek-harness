import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService, { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { createToolResultMessage, createUserMessage, LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { applyContinueIntent, attachContinueNotice } from '../src/continue.ts'
import * as goalSession from '../src/index.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

type ScriptEntry = StreamChunk[] | Error | 'hang' | ((options: GenerateOptions) => StreamChunk[])

/** Small request-recording adapter with controllable failure and cancellation. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry instanceof Error) throw entry
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) yield chunk
  }
}

/** One successful text response. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One successful response cut off at the model output limit. */
function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** Complete request history as a single string for ordering assertions. */
function requestText(request: GenerateOptions): string {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly agent: Agent
  readonly driver: Awaited<ReturnType<Context['plugin']>>
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

/** Mount a real loop with only its model scripted. */
async function harness(script: ScriptEntry[]): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  const driver = await ctx.plugin(goalSession)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`goal-session-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, adapter, agent, driver }
}

/** Observe inserted inbox messages after the live projection accepts them. */
function onInboxMessage(
  ctx: Context,
  agent: Agent,
  listener: (message: UserMessage) => void,
): () => void {
  return ctx.on('agent/inbox/inserted', ({ agent: subject, message }) => {
    if (subject === agent) listener(message)
  })
}

/** Observe one claimed message at its exclusive pre-step ownership transfer. */
function onClaimedMessage(
  ctx: Context,
  agent: Agent,
  listener: (message: UserMessage) => void,
): () => void {
  return ctx.on('agent/inbox/claimed', ({ agent: subject, message }) => {
    if (subject === agent) listener(message)
  })
}

/** Await a stable goal projection selected by the caller. */
async function waitForGoal(
  ctx: Context,
  agent: Agent,
  predicate: (goal: GoalView | undefined) => boolean,
): Promise<GoalView | undefined> {
  await vi.waitFor(() => {
    expect(predicate(ctx.goals.get(agent))).toBe(true)
  })
  return ctx.goals.get(agent)
}

/** Await a specific number of dispatched model requests. */
async function waitForRequests(adapter: ScriptedAdapter, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(adapter.requests).toHaveLength(count)
  })
}

/** One successful tool-call stream used to close a prior turn with named tools. */
function toolCallResponse(rawCallId: string, name: string, args: object = {}): StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Register a named fixture tool that returns text or throws. */
function registerNamedTool(ctx: Context, name: string, result: 'ok' | 'throw'): void {
  ctx.tools.register(defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute() {
      if (result === 'throw') throw new Error(`${name} failed`)
      return [{ type: 'text', text: `${name} ok` }]
    },
  }))
}

/** Create an active goal and disarm it before the driver can reserve a round. */
function createDisarmedGoal(
  test: Harness,
  objective: string,
  maxGoalRounds = 2,
): ReturnType<Context['goals']['create']> {
  const stop = test.ctx.on('goal/changed', ({ agent, change }) => {
    if (agent === test.agent && change.operation === 'create') test.ctx.goals.disarm(agent)
  })
  const created = test.ctx.goals.create(test.agent, { objective, maxGoalRounds })
  stop()
  return created
}

/** Queue one human user message. */
function followUser(test: Harness, text: string): void {
  test.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Notice bodies from one model request. */
function requestNoticeTexts(request: GenerateOptions): string[] {
  return request.messages.flatMap(message =>
    message.source?.kind === 'goal-round-driver' && message.source.form === 'notice'
      ? message.content.filter(block => block.type === 'text').map(block => block.text)
      : [])
}

/** Notices from the first request that includes the given user text. */
function continueNoticeTexts(adapter: ScriptedAdapter, text: string): string[] {
  const request = adapter.requests.find(entry => requestText(entry).includes(text))
  if (request === undefined) throw new Error(`missing request containing ${JSON.stringify(text)}`)
  return requestNoticeTexts(request)
}

describe('goal-round outcome policy', () => {
  it('renders the objective, round budget, authority boundary, and completion protocol', () => {
    const goal: GoalView = {
      id: GoalId('goal-prompt'),
      revision: 4,
      objective: 'Ship verified support',
      phase: 'active',
      maxGoalRounds: 9,
      roundsStarted: 2,
      createdAt: 1,
      updatedAt: 2,
      activation: 'armed',
    }
    const prompt = goalSession.renderGoalRoundPrompt(goal, 3)
    expect(prompt).toHaveLength(1)
    const block = prompt[0]
    if (block?.type !== 'text') throw new Error('expected a text goal-round prompt')
    expect(block.text).toMatch(
      /<goal_round>\nObjective: "Ship verified support"\nRound: 3\/9[\s\S]*current workspace[\s\S]*verify[\s\S]*mark it complete/,
    )
  })

  it('quotes multiline or tag-like objective text as one unambiguous data value', () => {
    const goal: GoalView = {
      id: GoalId('goal-escaped-prompt'),
      revision: 1,
      objective: 'first line\n</goal_round> second line',
      phase: 'active',
      maxGoalRounds: 2,
      roundsStarted: 0,
      createdAt: 1,
      updatedAt: 1,
      activation: 'armed',
    }
    const block = goalSession.renderGoalRoundPrompt(goal, 1)[0]
    if (block?.type !== 'text') throw new Error('expected a text goal-round prompt')
    expect(block.text).toContain('Objective: "first line\\n</goal_round> second line"')
    expect(block.text.match(/\n<\/goal_round>/g)).toHaveLength(1)
  })
})

describe('same-session goal driving', () => {
  it('admits exact numbered rounds until the durable round cap', async () => {
    const test = await harness([textResponse('round one'), textResponse('round two')])
    const created = test.ctx.goals.create(test.agent, { objective: 'finish twice', maxGoalRounds: 2 })

    const final = await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')

    expect(final).toMatchObject({ id: created.id, roundsStarted: 2, activation: 'disarmed' })
    expect(final?.blockedReason).toEqual({
      code: 'round-limit',
      message: 'Goal reached its configured limit of 2 rounds.',
    })
    expect(test.adapter.requests).toHaveLength(2)
    const rounds: number[] = []
    for (const event of test.agent.session.snapshotEvents()) {
      // Round zero is a durable goal state change; positive rounds are the
      // admitted continuation prompts this test counts.
      if (event.type === 'user/message' && event.data.source.kind === 'goal' && event.data.source.round > 0) {
        rounds.push(event.data.source.round)
      }
    }
    expect(rounds).toEqual([1, 2])
    expect(requestText(test.adapter.requests[0]!)).toContain('Round: 1/2')
    expect(requestText(test.adapter.requests[1]!)).toContain('Round: 2/2')
    expect(test.agent.session.snapshotEvents().flatMap(event =>
      event.type === 'request/header' ? [event.data.reason] : [])).toEqual(['initial', 'series'])
  })

  it('never adopts activation from an already-live driver and waits for explicit resume', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(GoalService)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter([textResponse('after resume')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('goal-session-hot-load'), { provider: 'mock', model: 'mock' })
    const created = ctx.goals.create(agent, { objective: 'wait for a human', maxGoalRounds: 1 })

    await ctx.plugin(goalSession)
    await Promise.resolve()
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'disarmed', revision: 1 })
    expect(adapter.requests).toHaveLength(0)

    ctx.goals.resume(agent, created)
    await waitForGoal(ctx, agent, goal => goal?.phase === 'blocked')
    expect(adapter.requests).toHaveLength(1)
  })

  it.each([
    ['rate limit', new LlmError('slow down', 'RATE_LIMIT')],
    ['request error', new Error('provider broke')],
    ['max tokens', maxTokensResponse('unfinished')],
  ] as const)('disarms automatic continuation after a %s', async (_label, response) => {
    const test = await harness([response])
    test.ctx.goals.create(test.agent, { objective: 'stop safely', maxGoalRounds: 8 })

    const goal = await waitForGoal(test.ctx, test.agent, current =>
      current?.phase === 'active' && current.activation === 'disarmed')

    expect(goal).toMatchObject({ roundsStarted: 1, activation: 'disarmed' })
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('maps a downstream step rejection to blocked without entering the round', async () => {
    const test = await harness([])
    test.ctx.on('agent/pre-step', ({ messages }, next) => messages[0]?.source.kind === 'goal'
      ? Promise.resolve({ kind: 'reject' as const })
      : next())
    test.ctx.goals.create(test.agent, { objective: 'respect policy' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal?.roundsStarted).toBe(0)
    expect(goal?.blockedReason).toEqual({
      code: 'prompt-rejected',
      message: 'Goal round was rejected before entering its step.',
    })
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
  })

  it('does not reserve again when a stopped-goal observer queues cancel-scoped work', async () => {
    const test = await harness([textResponse('human follow-up')])
    test.ctx.on('agent/pre-step', ({ messages }, next) => messages[0]?.source.kind === 'goal'
      ? Promise.resolve({ kind: 'reject' as const })
      : next())
    test.ctx.on('goal/changed', ({ agent, change }) => {
      if (change.operation === 'block') agent.followup(createUserMessage({ content: [{ type: 'text', text: 'inspect the blocker' }], source: { kind: 'user' } }))
    })
    test.ctx.goals.create(test.agent, { objective: 'stop and inspect' })

    await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')
    await test.agent.whenIdle()

    expect(test.adapter.requests).toHaveLength(0)
    expect(test.agent.inbox.nextTurn.map(message => message.content[0]))
      .toEqual([{ type: 'text', text: 'inspect the blocker' }])
  })

  it('pauses and drops a reserved round when cancellation lands before pre-step', async () => {
    const test = await harness([])
    const cancel = onClaimedMessage(test.ctx, test.agent, (message) => {
      if (message.source.kind === 'goal' && message.source.round > 0) {
        cancel()
        test.agent.cancel({ kind: 'user' })
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'do not start yet' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')

    expect(goal).toMatchObject({ roundsStarted: 0, activation: 'disarmed' })
    expect(test.adapter.requests).toHaveLength(0)
    // No admitted continuation round reached the model; goal state changes are
    // represented by their own durable event.
    expect(test.agent.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.source.kind === 'goal' && event.data.source.round > 0)).toBe(false)
  })

  it('pauses an admitted round when cancellation aborts an active step', async () => {
    const test = await harness(['hang'])
    test.ctx.goals.create(test.agent, { objective: 'stop in flight' })
    await waitForRequests(test.adapter, 1)

    test.agent.cancel({ kind: 'user' })
    await test.agent.whenIdle()
    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')

    expect(goal).toMatchObject({ roundsStarted: 1, activation: 'disarmed' })
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('aborts an in-flight round when a host-initiated pause lands mid-step', async () => {
    const test = await harness(['hang'])
    test.ctx.goals.create(test.agent, { objective: 'stop on host pause' })
    await waitForRequests(test.adapter, 1)

    // A host pause (Web button) runs outside the agent's own turn, so the
    // round driver must stop the live round rather than let the model keep
    // acting or resume the just-paused goal.
    const current = test.ctx.goals.get(test.agent)
    if (current === undefined) throw new Error('missing goal before host pause')
    test.ctx.goals.pause(test.agent, { id: current.id, revision: current.revision })

    await test.agent.whenIdle()
    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')

    expect(goal).toMatchObject({ roundsStarted: 1, activation: 'disarmed' })
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('keeps a resumed goal running when the pause-turn has not yet converged', async () => {
    const test = await harness(['hang', textResponse('resumed round')])
    test.ctx.goals.create(test.agent, { objective: 'pause then resume', maxGoalRounds: 2 })
    await waitForRequests(test.adapter, 1)

    const current = test.ctx.goals.get(test.agent)
    if (current === undefined) throw new Error('missing goal before pause')
    const paused = test.ctx.goals.pause(test.agent, { id: current.id, revision: current.revision })
    // Resume before the aborted turn converges to idle. The revision fence in the
    // idle handler must not re-pause this freshly resumed goal.
    test.ctx.goals.resume(test.agent, { id: paused.id, revision: paused.revision })

    const goal = await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')

    expect(goal).toMatchObject({ phase: 'blocked', roundsStarted: 2 })
    expect(goal?.blockedReason?.code).toBe('round-limit')
    expect(test.adapter.requests).toHaveLength(2)
  })

  it('lets a model-initiated pause finish its own turn', async () => {
    const holder: { ctx?: Context; agent?: Agent } = {}
    const test = await harness([
      () => {
        if (holder.ctx !== undefined && holder.agent !== undefined) {
          const goal = holder.ctx.goals.get(holder.agent)
          if (goal !== undefined) {
            holder.ctx.goals.pause(holder.agent, { id: goal.id, revision: goal.revision })
          }
        }
        return textResponse('paused myself')
      },
    ])
    holder.ctx = test.ctx
    holder.agent = test.agent

    test.ctx.goals.create(test.agent, { objective: 'pause myself', maxGoalRounds: 2 })

    const goal = await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'paused')
    await test.agent.whenIdle()

    expect(goal).toMatchObject({ phase: 'paused', roundsStarted: 1 })
    expect(test.adapter.requests).toHaveLength(1)
    const turnEndKinds = test.agent.session.snapshotEvents().flatMap(event =>
      event.type === 'turn/end' ? [event.data.reason.kind] : [])
    expect(turnEndKinds).toContain('completed')
    expect(turnEndKinds).not.toContain('aborted')
  })

  it('lets already-queued human work finish before reserving the next round', async () => {
    const test = await harness([textResponse('human answer'), textResponse('goal answer')])
    test.ctx.goals.create(test.agent, { objective: 'continue after the human', maxGoalRounds: 1 })
    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'human goes first' }], source: { kind: 'user' } }))

    await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')

    expect(test.adapter.requests).toHaveLength(2)
    expect(requestText(test.adapter.requests[0]!)).toContain('human goes first')
    expect(requestText(test.adapter.requests[0]!)).not.toContain('<goal_round>')
    expect(requestText(test.adapter.requests[1]!)).toContain('<goal_round>')
    expect(test.agent.session.snapshotEvents().flatMap(event =>
      event.type === 'request/header' ? [event.data.reason] : [])).toEqual(['initial', 'series'])
  })

  it('makes a reserved round stale when a listener queues human work behind it', async () => {
    const test = await harness([textResponse('human batch'), textResponse('later goal')])
    let inserted = false
    onInboxMessage(test.ctx, test.agent, (message) => {
      if (message.source.kind !== 'goal' || inserted) return
      inserted = true
      test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'human joined the pending batch' }], source: { kind: 'user' } }))
    })
    test.ctx.goals.create(test.agent, { objective: 'yield to nested human input', maxGoalRounds: 1 })

    await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')

    expect(test.adapter.requests).toHaveLength(2)
    expect(requestText(test.adapter.requests[0]!)).toContain('human joined the pending batch')
    expect(requestText(test.adapter.requests[0]!)).not.toContain('<goal_round>')
    expect(requestText(test.adapter.requests[1]!)).toContain('<goal_round>')
  })

  it('blocks a queued reservation made stale by a goal edit and continues the new revision', async () => {
    const test = await harness([textResponse('new revision')])
    let edited = false
    onInboxMessage(test.ctx, test.agent, (message) => {
      if (message.source.kind !== 'goal' || edited) return
      edited = true
      const current = test.ctx.goals.get(test.agent)
      if (current === undefined) throw new Error('missing goal during queued edit')
      test.ctx.goals.edit(test.agent, current, { objective: 'new objective' })
    })
    test.ctx.goals.create(test.agent, { objective: 'old objective', maxGoalRounds: 1 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal).toMatchObject({ revision: 3, objective: 'new objective', roundsStarted: 1 })
    const admitted = test.agent.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source.kind === 'goal' && event.data.source.round > 0)
    expect(admitted?.type === 'user/message' && admitted.data.source.kind === 'goal'
      ? admitted.data.source.revision
      : undefined).toBe(2)
  })

  it('rechecks revision after downstream prompt hooks before admitting', async () => {
    const test = await harness([textResponse('new revision')])
    let edited = false
    test.ctx.on('agent/pre-step', ({ agent, messages }, next) => {
      if (messages[0]?.source.kind === 'goal' && !edited) {
        edited = true
        const current = test.ctx.goals.get(agent)
        if (current === undefined) throw new Error('missing goal during prompt edit')
        test.ctx.goals.edit(agent, current, { objective: 'edited downstream' })
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'edit during pre-step', maxGoalRounds: 1 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal).toMatchObject({ objective: 'edited downstream', roundsStarted: 1 })
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('does not block a goal that downstream paused before rejecting its prompt', async () => {
    const test = await harness([])
    test.ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      if (!messages.some(message => message.source.kind === 'goal' && message.source.round > 0)) {
        return next()
      }
      const goal = test.ctx.goals.get(agent)
      if (goal === undefined) throw new Error('missing goal before downstream pause')
      test.ctx.goals.pause(agent, { id: goal.id, revision: goal.revision })
      return { kind: 'reject' as const }
    })
    test.ctx.goals.create(test.agent, { objective: 'pause before rejection' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')

    expect(goal).toMatchObject({ phase: 'paused' })
    expect(test.adapter.requests).toEqual([])
  })

  it('restores non-goal step context when a claimed reservation becomes stale', async () => {
    const test = await harness([textResponse('side contexts'), textResponse('revised goal')])
    const claimedContext = createUserMessage({
      content: [{ type: 'text', text: 'claimed context to restore' }],
      source: { kind: 'test' },
    })
    const roundZeroContext = createUserMessage({
      content: [{ type: 'text', text: 'obsolete goal context' }],
      source: { kind: 'goal', goalId: GoalId('old-goal'), revision: 1, round: 0 },
    })
    const queuedStepContext = createUserMessage({
      content: [{ type: 'text', text: 'context already queued for the next step' }],
      source: { kind: 'test' },
    })
    const queuedTurnContext = createUserMessage({
      content: [{ type: 'text', text: 'context already queued for the next turn' }],
      source: { kind: 'test' },
    })
    let staged = false
    const stopInserted = onInboxMessage(test.ctx, test.agent, (message) => {
      if (message.source.kind !== 'goal' || message.source.round <= 0 || staged) return
      staged = true
      test.agent.inbox.prepend('next-step', claimedContext)
      test.agent.inbox.prepend('next-step', roundZeroContext)
    })
    let edited = false
    test.ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const decision = await next()
      if (!messages.some(message => message.source.kind === 'goal' && message.source.round > 0) || edited) return decision
      edited = true
      agent.inbox.prepend('next-step', queuedStepContext)
      agent.inbox.append('next-turn', queuedTurnContext)
      const goal = test.ctx.goals.get(agent)
      if (goal === undefined) throw new Error('missing claimed goal')
      test.ctx.goals.edit(agent, goal, { objective: 'revised after claim' })
      return decision.kind === 'reject' ? decision : {
        kind: 'enter' as const,
        messages: [...decision.messages, queuedStepContext, queuedTurnContext],
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'stale before admission', maxGoalRounds: 1 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')
    stopInserted()

    expect(goal).toMatchObject({ objective: 'revised after claim', roundsStarted: 1 })
    expect(test.adapter.requests).toHaveLength(2)
    expect(requestText(test.adapter.requests[0]!)).toContain('claimed context to restore')
    expect(requestText(test.adapter.requests[0]!)).toContain('context already queued for the next step')
    expect(requestText(test.adapter.requests[0]!)).toContain('context already queued for the next turn')
    expect(requestText(test.adapter.requests[0]!)).not.toContain('obsolete goal context')
    expect(requestText(test.adapter.requests[0]!)).not.toContain('<goal_round>')
    expect(requestText(test.adapter.requests[1]!)).toContain('revised after claim')
    expect(requestText(test.adapter.requests[1]!)).not.toContain('stale before admission')
  })

  it('disarms without dispatch when a durability checkpoint fails', async () => {
    const test = await harness([])
    test.ctx.on('session/flush', () => Promise.reject(new Error('disk unavailable')))
    test.ctx.goals.create(test.agent, { objective: 'do not outrun storage' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('disarms instead of reserving another round when the round checkpoint fails', async () => {
    const test = await harness([textResponse('round one ran')])
    // The loop persists eagerly with no turn-end flush, so the driver owns
    // the round durability barrier. Let goal creation's checkpoint pass, then
    // fail the flush that settles round one: no second round may be reserved
    // on state that was never persisted.
    let flushes = 0
    test.ctx.on('session/flush', () => {
      flushes += 1
      // Flush 1 is goal creation's checkpoint; flush 2 settles round one.
      return flushes >= 2 ? Promise.reject(new Error('round checkpoint failed')) : undefined
    })
    test.ctx.goals.create(test.agent, { objective: 'no autonomous rounds without durability', maxGoalRounds: 5 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 1 })
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('reserves the next round only after the settled round checkpoint succeeds', async () => {
    const test = await harness([textResponse('round one'), textResponse('round two')])
    const flushes: number[] = []
    test.ctx.on('session/flush', () => { flushes.push(test.adapter.requests.length) })
    test.ctx.goals.create(test.agent, { objective: 'checkpoint between rounds', maxGoalRounds: 2 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal?.blockedReason?.code).toBe('round-limit')
    expect(goal?.roundsStarted).toBe(2)
    expect(test.adapter.requests).toHaveLength(2)
    // A flush was observed after round one settled and before round two
    // dispatched (recorded request count 1 at flush time).
    expect(flushes).toContain(1)
  })

  it('contains a checkpoint failure after a clear notification leaves no current goal', async () => {
    const test = await harness([])
    test.ctx.on('session/flush', () => Promise.reject(new Error('clear checkpoint failed')))
    agentEvents(test.ctx, test.agent).emit('goal/changed', {
      change: {
        operation: 'clear',
        ref: { id: GoalId('cleared-goal'), revision: 2 },
      },
    })
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    expect(test.ctx.goals.get(test.agent)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('settles a goal round from its successful retry turn, not the failed original', async () => {
    const test = await harness([
      new LlmError('transient', 'SERVER'),
      textResponse('retry succeeded'),
    ])
    // The llm-retry shape: schedule one retry for the failed goal-round request.
    let retried = false
    test.ctx.on('agent/request-error', async (_payload) => {
      if (!retried) {
        retried = true
        return { kind: 'retry' }
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'survive a transient failure', maxGoalRounds: 1 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    // The retry turn's completed outcome settles the round: round-limit, not
    // the failed original turn's turn-error.
    expect(goal?.blockedReason?.code).toBe('round-limit')
    expect(goal?.roundsStarted).toBe(1)
    expect(test.adapter.requests).toHaveLength(2)
  })

  it('does not double-clear when a throwing hook already cancelled the round', async () => {
    const test = await harness([])
    // The downstream hook cancels (pausing the goal and clearing the queued
    // attempt through cancel-requested) and THEN throws: the catch finds no
    // matching reservation and must not reschedule a paused goal.
    let fired = false
    test.ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      if (messages[0]?.source.kind === 'goal' && !fired) {
        fired = true
        agent.cancel({ kind: 'user' })
        throw new Error('hook cancelled then exploded')
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'cancel then throw' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await test.agent.whenIdle()
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(goal?.roundsStarted).toBe(0)
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'paused' })
  })

  it('fails closed when a downstream pre-step hook throws', async () => {
    const test = await harness([])
    // Registered after goal-round-driver's own listener: the throw propagates back
    // through goal-round-driver's next() await, dropping the whole step proposal.
    let threw = false
    test.ctx.on('agent/pre-step', async ({ messages }, next) => {
      if (messages[0]?.source.kind === 'goal' && !threw) {
        threw = true
        throw new Error('downstream pre-step hook exploded')
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'survive a throwing hook', maxGoalRounds: 1 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')
    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.agent.inbox.nextTurn).toHaveLength(0)
  })

  it('a retry turn on a non-goal failure leaves the goal reservation untouched', async () => {
    const test = await harness([
      new LlmError('transient on human turn', 'SERVER'),
      textResponse('human retry succeeded'),
      textResponse('goal round ran'),
    ])
    let retried = false
    test.ctx.on('agent/request-error', async (_payload) => {
      if (!retried) {
        retried = true
        return { kind: 'retry' }
      }
    })
    // A human prompt fails and retries while a goal is armed but its round
    // is not yet reserved: the retry trigger must not adopt or clear
    // anything (the attempt is absent), and the goal proceeds normally.
    test.ctx.goals.create(test.agent, { objective: 'ignore foreign retries', maxGoalRounds: 1 })
    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'human work' }], source: { kind: 'user' } }))

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')
    expect(goal?.blockedReason?.code).toBe('round-limit')
    expect(goal?.roundsStarted).toBe(1)
  })

  it('blocks the goal when a custom agent rejects the otherwise valid follow-up', async () => {
    const test = await harness([])
    // Reject only the goal-sourced round follow-up, not the state-change injection
    // that precedes it.
    const realFollowup = test.agent.followup.bind(test.agent)
    vi.spyOn(test.agent, 'followup').mockImplementation((input) => {
      if (input.source.kind === 'goal') {
        throw new Error('queue rejected')
      }
      realFollowup(input)
    })
    test.ctx.goals.create(test.agent, { objective: 'handle queue failure' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal).toMatchObject({ roundsStarted: 0, activation: 'disarmed' })
    expect(goal?.blockedReason).toEqual({
      code: 'queue-failed',
      message: 'Could not queue goal round 1: queue rejected',
    })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('preserves a custom agent side effect when followup disarms before throwing', async () => {
    const test = await harness([])
    const realFollowup = test.agent.followup.bind(test.agent)
    vi.spyOn(test.agent, 'followup').mockImplementation((input) => {
      if (input.source.kind === 'goal') {
        test.ctx.goals.disarm(test.agent)
        throw new Error('queue rejected after disarm')
      }
      realFollowup(input)
    })
    test.ctx.goals.create(test.agent, { objective: 'preserve the newer activation state' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('contains a mutation failure inside the scheduler loop and fails closed', async () => {
    const test = await harness([textResponse('the only round')])
    // The only ctx.goals.block call in a completing one-round run is the
    // driver's round-limit stop, so the mock fails exactly that drive pass.
    vi.spyOn(test.ctx.goals, 'block').mockImplementationOnce(() => {
      throw new Error('round-limit block failed')
    })
    test.ctx.goals.create(test.agent, { objective: 'contain a driver failure', maxGoalRounds: 1 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 1 })
    expect(goal?.blockedReason).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('contains synchronous scheduler startup failure', async () => {
    const test = await harness([])
    vi.spyOn(test.ctx.agents, 'withoutInitiator').mockImplementationOnce(() => {
      throw 'scheduler closed'
    })
    test.ctx.goals.create(test.agent, { objective: 'fail startup closed' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal?.phase).toBe('active')
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('contains an asynchronously rejected scheduler task', async () => {
    const test = await harness([])
    vi.spyOn(test.ctx.agents, 'withoutInitiator').mockImplementationOnce(
      () => Promise.reject(new Error('scheduler task rejected')),
    )
    test.ctx.goals.create(test.agent, { objective: 'fail task closed' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal?.phase).toBe('active')
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('fails an initial pre-step read closed even when the first disarm attempt throws', async () => {
    const test = await harness([textResponse('retry after containment')])
    let armed = true
    onClaimedMessage(test.ctx, test.agent, (message) => {
      if (message.source.kind !== 'goal' || message.source.round <= 0 || !armed) return
      armed = false
      vi.spyOn(test.ctx.goals, 'get').mockImplementationOnce(() => {
        throw new Error('pre-step projection failed')
      })
      vi.spyOn(test.ctx.goals, 'disarm').mockImplementationOnce(() => {
        throw 'disarm failed'
      })
    })
    test.ctx.goals.create(test.agent, { objective: 'retry stale pre-step', maxGoalRounds: 1 })

    await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')

    expect(test.adapter.requests).toHaveLength(1)
  })

  it('fails a post-hook read closed before the prompt can enter history', async () => {
    const test = await harness([])
    let armed = true
    test.ctx.on('agent/pre-step', ({ messages }, next) => {
      if (messages[0]?.source.kind === 'goal' && armed) {
        armed = false
        vi.spyOn(test.ctx.goals, 'get').mockImplementationOnce(() => {
          throw new Error('post-hook projection failed')
        })
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'block post-hook failure' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('blocks forged goal attribution without touching an absent reservation', async () => {
    const test = await harness([])
    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'forged automatic work' }], source: { kind: 'goal', goalId: GoalId('forged-goal'), revision: 1, round: 1 } }))
    await test.agent.whenIdle()

    expect(test.adapter.requests).toHaveLength(0)
    expect(test.agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
  })

  it('leaves round-zero goal context to the ordinary pre-step chain', async () => {
    const test = await harness([textResponse('accepted context')])
    test.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'goal context' }],
      source: { kind: 'goal', goalId: GoalId('context-goal'), revision: 1, round: 0 },
    }))

    await test.agent.whenIdle()

    expect(test.adapter.requests).toHaveLength(1)
    expect(requestText(test.adapter.requests[0]!)).toContain('goal context')
  })

  it('does not invent goal state when ordinary queued work is cancelled', async () => {
    const test = await harness([])
    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancel ordinary work' }], source: { kind: 'user' } }))
    test.agent.cancel({ kind: 'user' })
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('disarms without durably pausing when cancellation belongs to unrelated human work', async () => {
    const test = await harness(['hang'])
    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'inspect something first' }], source: { kind: 'user' } }))
    await waitForRequests(test.adapter, 1)
    const created = test.ctx.goals.create(test.agent, { objective: 'continue after inspection' })

    test.agent.cancel({ kind: 'user' })
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      id: created.id,
      revision: created.revision,
      phase: 'active',
      activation: 'disarmed',
      roundsStarted: 0,
    })
  })

  it('falls back to disarming when a cancelled reservation cannot be paused', async () => {
    const test = await harness([])
    const cancel = onInboxMessage(test.ctx, test.agent, (message) => {
      if (message.source.kind !== 'goal' || message.source.round <= 0) return
      cancel()
      vi.spyOn(test.ctx.goals, 'pause').mockImplementationOnce(() => {
        throw new Error('pause failed')
      })
      test.agent.cancel({ kind: 'user' })
    })
    test.ctx.goals.create(test.agent, { objective: 'fail closed after cancellation' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal).toMatchObject({ phase: 'active', revision: 1, roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('rejects the step when downstream cancellation clears the reservation', async () => {
    const test = await harness([])
    let cancelled = false
    test.ctx.on('agent/pre-step', ({ agent, messages }, next) => {
      if (messages[0]?.source.kind === 'goal' && !cancelled) {
        cancelled = true
        agent.cancel({ kind: 'user' })
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'cancel during pre-step' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await test.agent.whenIdle()

    expect(goal?.roundsStarted).toBe(0)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('disarms and cancels an admitted round before driver teardown completes', async () => {
    const test = await harness(['hang'])
    test.ctx.goals.create(test.agent, { objective: 'survive plugin unload' })
    await waitForRequests(test.adapter, 1)

    await test.driver.dispose()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      phase: 'active',
      activation: 'disarmed',
      roundsStarted: 1,
    })
    expect(test.agent.status).toBe('idle')
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('cancels an accepted queued round and awaits its driver task during teardown', async () => {
    const test = await harness([])
    let unloading: Promise<void> | undefined
    onInboxMessage(test.ctx, test.agent, (message) => {
      if (message.source.kind === 'goal' && unloading === undefined) {
        unloading = Promise.resolve(test.driver.dispose())
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'unload while queued' })
    await vi.waitFor(() => { expect(unloading).toBeDefined() })
    await unloading

    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      phase: 'active',
      activation: 'disarmed',
      roundsStarted: 0,
    })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('resets process-local scheduling state at a session-start edge', async () => {
    const test = await harness([textResponse('after explicit resume')])
    const created = test.ctx.goals.create(test.agent, { objective: 'restart safely', maxGoalRounds: 1 })
    await agentEvents(test.ctx, test.agent).serial('agent/created', { source: 'resume' })
    await Promise.resolve()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({ activation: 'disarmed', roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)

    test.ctx.goals.resume(test.agent, created)
    await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('disarms when a round turn/end cannot commit', async () => {
    const test = await harness([textResponse('round ran')])
    test.ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as { type: string }
      if (event.type === 'turn/end') throw new Error('turn close permanently rejected')
    })
    test.ctx.goals.create(test.agent, { objective: 'survive a lost turn end' })
    await waitForRequests(test.adapter, 1)
    await test.agent.whenIdle()
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(test.adapter.requests).toHaveLength(1)
    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      phase: 'active',
      activation: 'disarmed',
    })
  })

  it('disarms instead of continuing when a plugin reports a post-turn persistence failure', async () => {
    const test = await harness([textResponse('round one')])
    test.ctx.on('session/event', (session, event) => {
      if (session === test.agent.session && event.type === 'turn/end') {
        agentEvents(test.ctx, test.agent).emit('agent/error', { turn: event.data.turn, step: 1, error: new Error('post-turn flush failed') })
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'stop when durability is lost', maxGoalRounds: 8 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')
    await test.agent.whenIdle()

    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 1 })
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('ignores a post-turn failure reported for a retired agent', async () => {
    const test = await harness([textResponse('ordinary work')])
    const handle = await test.ctx.agents.create({
      sessionId: SessionId('goal-session-retired'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one ordinary turn' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    const closed = handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (closed?.type !== 'turn/end') throw new Error('expected a closed turn')
    await handle.dispose()
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    agentEvents(test.ctx, handle.agent).emit('agent/error', { turn: closed.data.turn, step: 1, error: new Error('late flush failure') })

    expect(test.ctx.agents.get(handle.agent.id)).toBeUndefined()
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('goal-round-driver'))
  })

  it('keeps terminal agent failure disarmed and defers queued human work until another wakeup', async () => {
    const test = await harness([new Error('round one broke'), textResponse('human answer')])
    let queued = false
    test.ctx.on('session/event', (session, event) => {
      if (session !== test.agent.session || queued) return
      if (event.type === 'user/message' && event.data.source.kind === 'goal') {
        queued = true
        queueMicrotask(() => {
          test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'human interleaved' }], source: { kind: 'user' } }))
        })
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'survive a stale failure', maxGoalRounds: 1 })

    await waitForGoal(test.ctx, test.agent, current =>
      current?.phase === 'active' && current.activation === 'disarmed')

    expect(test.adapter.requests).toHaveLength(1)
    expect(test.agent.inbox.nextTurn).toHaveLength(1)

    test.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'resume after failure' }], source: { kind: 'user' } }))
    await test.agent.whenIdle()

    expect(test.adapter.requests).toHaveLength(2)
    expect(requestText(test.adapter.requests[1]!)).toContain('human interleaved')
    expect(requestText(test.adapter.requests[1]!)).toContain('resume after failure')
  })

  it('waits for work queued by a pause observer before considering the next round', async () => {
    const test = await harness(['hang', textResponse('inspection answer')])
    test.ctx.on('goal/changed', ({ agent, change }) => {
      if (agent === test.agent && change.operation === 'pause') {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'inspect the pause' }], source: { kind: 'user' } }))
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'pause then inspect' })
    await waitForRequests(test.adapter, 1)

    test.agent.cancel({ kind: 'user' })
    await waitForRequests(test.adapter, 2)
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      phase: 'paused',
      roundsStarted: 1,
      activation: 'disarmed',
    })
    expect(requestText(test.adapter.requests[1]!)).toContain('inspect the pause')
  })

  it('does not re-block a goal the downstream veto already saw cancelled', async () => {
    const test = await harness([])
    let vetoed = false
    test.ctx.on('agent/pre-step', ({ agent, messages }, next) => {
      if (messages[0]?.source.kind === 'goal' && !vetoed) {
        vetoed = true
        agent.cancel({ kind: 'user' })
        return Promise.resolve<PreStepDecision>({
          kind: 'reject',
        })
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'veto after cancellation' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await test.agent.whenIdle()

    // Cancellation already cleared the reservation and paused the goal, so the
    // veto neither touches an absent attempt nor blocks the paused goal.
    expect(goal).toMatchObject({ roundsStarted: 0, activation: 'disarmed' })
    expect(goal?.blockedReason).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('awaits a claimed reservation stuck in pre-step during teardown without cancelling', async () => {
    const test = await harness([])
    let release: (() => void) | undefined
    test.ctx.on('agent/pre-step', async ({ messages }, next) => {
      if (messages[0]?.source.kind === 'goal' && release === undefined) {
        await new Promise<void>((resolve) => { release = resolve })
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'unload during pre-step' })
    await vi.waitFor(() => { expect(release).toBeDefined() })

    const disposal = Promise.resolve(test.driver.dispose())
    await waitForGoal(test.ctx, test.agent, goal => goal?.activation === 'disarmed')
    release?.()
    await disposal

    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
  })

  it('ignores session events without an exact owning agent and retires disposed agent state', async () => {
    const test = await harness([])
    const orphan = test.ctx.sessions.create(SessionId('goal-session-orphan'))
    orphan.append('turn/start', {
      turn: 1,
    })
    orphan.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const handle = await test.ctx.agents.create({
      sessionId: SessionId('goal-session-disposed'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await handle.dispose()

    expect(test.ctx.agents.get(handle.agent.id)).toBeUndefined()
  })
})

describe('continue-intent helpers', () => {
  const continueMessage = createUserMessage({
    content: [{ type: 'text', text: 'continue' }],
    source: { kind: 'user' },
  })
  const notice = createUserMessage({
    content: [{ type: 'text', text: 'notice' }],
    source: { kind: 'goal-round-driver', form: 'notice', summary: 'notice' },
  })

  it('skips attaching a notice when the step is rejected or aborted', () => {
    expect(attachContinueNotice({ kind: 'reject' }, notice, false)).toEqual({ kind: 'reject' })
    expect(attachContinueNotice({ kind: 'enter', messages: [] }, notice, true))
      .toEqual({ kind: 'enter', messages: [] })
    expect(attachContinueNotice({ kind: 'enter', messages: [] }, undefined, false))
      .toEqual({ kind: 'enter', messages: [] })
  })

  it('names a blocked goal that has no stored reason and stringifies a non-error resume throw', () => {
    const warn = vi.fn()
    const blocked: GoalView = {
      id: GoalId('goal-blocked'),
      revision: 1,
      objective: 'blocked without reason',
      phase: 'blocked',
      maxGoalRounds: 2,
      roundsStarted: 0,
      createdAt: 1,
      updatedAt: 1,
      activation: 'disarmed',
    }
    const disarmed: GoalView = { ...blocked, phase: 'active', objective: 'resume throws' }
    const agent = { id: 'goal-continue-helper', session: { snapshotEvents: () => [] } }

    const blockedNotice = applyContinueIntent({
      goals: { get: () => blocked, resume() { throw new Error('unused') } },
      logger: { warn },
    } as never, agent as never, [continueMessage])
    expect(blockedNotice?.content).toEqual([{
      type: 'text',
      text: 'The goal was not resumed because it is blocked: blocked; the previous turn made no file changes; do not repeat its plan.',
    }])

    expect(applyContinueIntent({
      goals: {
        get: () => disarmed,
        resume() { throw 'resume rejected' },
      },
      logger: { warn },
    } as never, agent as never, [continueMessage])).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resume rejected'))

    const unpaired: SessionEvent[] = [
      { type: 'turn/start', seq: 0 as never, time: 1, data: { turn: 1 } },
      {
        type: 'tool/result',
        seq: 1 as never,
        time: 2,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId: ToolCallId('missing'),
            content: [],
            isError: false,
          }),
        },
      },
      { type: 'turn/end', seq: 2 as never, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const resumed = applyContinueIntent({
      goals: {
        get: () => disarmed,
        resume: () => ({ ...disarmed, activation: 'armed' as const }),
      },
      logger: { warn },
    } as never, { ...agent, session: { snapshotEvents: () => unpaired } } as never, [continueMessage])
    expect(resumed?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('the previous turn made no file changes; do not repeat its plan'),
    })
  })
})

describe('continue-intent rearm', () => {
  it.each([
    'continue',
    'Continue.',
    'keep going',
    'resume',
    'go on',
    'continue the work',
    'continue with the work',
    'continue\nplease fix tests',
  ])('rearms a disarmed active goal when the user says %j', async (text) => {
    const test = await harness([textResponse('after continue'), textResponse('goal round')])
    const created = createDisarmedGoal(test, 'finish after continue', 1)

    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      id: created.id,
      phase: 'active',
      activation: 'disarmed',
      roundsStarted: 0,
    })

    followUser(test, text)
    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal).toMatchObject({ id: created.id, phase: 'blocked', roundsStarted: 1 })
    expect(test.adapter.requests).toHaveLength(2)
    const notices = requestNoticeTexts(test.adapter.requests[0]!)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('The active goal was resumed')
    expect(notices[0]).toContain('the previous turn made no file changes; do not repeat its plan')
    expect(test.adapter.requests[0]!.messages.some(message =>
      message.source?.kind === 'goal-round-driver' && message.source.form === 'notice')).toBe(true)
    expect(requestText(test.adapter.requests[1]!)).toContain('<goal_round>')
  })

  it('does not resume a durable paused goal', async () => {
    const test = await harness([textResponse('acknowledged pause')])
    const created = test.ctx.goals.create(test.agent, { objective: 'stay paused' })
    const paused = test.ctx.goals.pause(test.agent, created)

    followUser(test, 'continue')
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      id: paused.id,
      revision: paused.revision,
      phase: 'paused',
      activation: 'disarmed',
    })
    expect(test.adapter.requests).toHaveLength(1)
    expect(requestNoticeTexts(test.adapter.requests[0]!)).toEqual([
      'The goal was not resumed because it is paused; the previous turn made no file changes; do not repeat its plan.',
    ])
    expect(requestText(test.adapter.requests[0]!)).not.toContain('<goal_round>')
  })

  it('injects the no-progress clause when the last turn used only todo or skill tools', async () => {
    const test = await harness([
      toolCallResponse('todo-1', 'todo'),
      textResponse('listed todos'),
      textResponse('after continue'),
      textResponse('goal round'),
    ])
    registerNamedTool(test.ctx, 'todo', 'ok')
    registerNamedTool(test.ctx, 'skill', 'ok')
    followUser(test, 'list the todos')
    await test.agent.whenIdle()
    createDisarmedGoal(test, 'continue after todos')

    followUser(test, 'keep going')
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', activation: 'armed' })
    const notices = continueNoticeTexts(test.adapter, 'keep going')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('the previous turn made no file changes; do not repeat its plan')
    expect(notices[0]).not.toContain('the previous turn changed the workspace; continue from the current files')
  })

  it('injects the mutation clause after a successful edit in the last closed turn', async () => {
    const test = await harness([
      toolCallResponse('edit-1', 'edit'),
      textResponse('edited'),
      textResponse('after continue'),
      textResponse('goal round'),
    ])
    registerNamedTool(test.ctx, 'edit', 'ok')
    followUser(test, 'edit the file')
    await test.agent.whenIdle()
    createDisarmedGoal(test, 'continue after edit')

    followUser(test, 'continue')
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', activation: 'armed' })
    expect(continueNoticeTexts(test.adapter, 'continue')).toEqual([
      'The active goal was resumed; the previous turn changed the workspace; continue from the current files.',
    ])
  })

  it('does not resume when ordinary user text merely mentions continue', async () => {
    const test = await harness([textResponse('starting over')])
    createDisarmedGoal(test, 'do not infer resume')

    followUser(test, 'Please continue working on the remaining tests in this file.')
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(test.adapter.requests).toHaveLength(1)
    expect(requestNoticeTexts(test.adapter.requests[0]!)).toEqual([])
    expect(requestText(test.adapter.requests[0]!)).not.toContain('The active goal was resumed')
  })

  it('does not resume a blocked goal and names the blocker', async () => {
    const test = await harness([textResponse('round one'), textResponse('after continue')])
    test.ctx.goals.create(test.agent, { objective: 'stop at the cap', maxGoalRounds: 1 })
    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    followUser(test, 'resume')
    await test.agent.whenIdle()

    const goal = test.ctx.goals.get(test.agent)
    expect(goal).toMatchObject({ phase: 'blocked', activation: 'disarmed', roundsStarted: 1 })
    expect(requestNoticeTexts(test.adapter.requests[1]!)).toEqual([
      'The goal was not resumed because it is blocked: Goal reached its configured limit of 1 rounds.; the previous turn made no file changes; do not repeat its plan.',
    ])
  })

  it('does not resume a complete goal', async () => {
    const test = await harness([textResponse('acknowledged complete')])
    const created = createDisarmedGoal(test, 'already done')
    test.ctx.goals.complete(test.agent, created)

    followUser(test, 'continue')
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'complete', activation: 'disarmed' })
    expect(requestNoticeTexts(test.adapter.requests[0]!)).toEqual([
      'The goal was not resumed because it is complete; the previous turn made no file changes; do not repeat its plan.',
    ])
  })

  it('notices that an already-armed goal stays armed', async () => {
    const test = await harness([textResponse('human continue'), textResponse('goal round')])
    test.ctx.goals.create(test.agent, { objective: 'already armed', maxGoalRounds: 1 })
    followUser(test, 'go on')

    await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(requestNoticeTexts(test.adapter.requests[0]!)).toEqual([
      'The active goal is already armed; the previous turn made no file changes; do not repeat its plan.',
    ])
    expect(requestText(test.adapter.requests[1]!)).toContain('<goal_round>')
  })

  it('does not treat a failed edit as a workspace mutation', async () => {
    const test = await harness([
      toolCallResponse('edit-fail', 'edit'),
      textResponse('edit failed'),
      textResponse('after continue'),
      textResponse('goal round'),
    ])
    registerNamedTool(test.ctx, 'edit', 'throw')
    followUser(test, 'edit the file')
    await test.agent.whenIdle()
    createDisarmedGoal(test, 'continue after failed edit')

    followUser(test, 'continue the work')
    await test.agent.whenIdle()

    expect(continueNoticeTexts(test.adapter, 'continue the work')[0])
      .toContain('the previous turn made no file changes; do not repeat its plan')
  })

  it('does not rearm from a plugin-sourced continue phrase', async () => {
    const test = await harness([textResponse('plugin text')])
    createDisarmedGoal(test, 'ignore plugin continue')
    test.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'test' },
    }))
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(requestNoticeTexts(test.adapter.requests[0]!)).toEqual([])
  })

  it('leaves the human step intact when resume throws', async () => {
    const test = await harness([textResponse('still answered')])
    createDisarmedGoal(test, 'resume failed')
    vi.spyOn(test.ctx.goals, 'resume').mockImplementationOnce(() => {
      throw new Error('resume rejected')
    })

    followUser(test, 'continue')
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(test.adapter.requests).toHaveLength(1)
    expect(requestNoticeTexts(test.adapter.requests[0]!)).toEqual([])
    expect(requestText(test.adapter.requests[0]!)).toContain('continue')
  })

  it('ignores a continue-intent when no goal is current', async () => {
    const test = await harness([textResponse('plain continue')])
    followUser(test, 'continue')
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toBeUndefined()
    expect(requestNoticeTexts(test.adapter.requests[0]!)).toEqual([])
  })

  it('still admits a continue message when continue-intent handling throws', async () => {
    const test = await harness([textResponse('answered')])
    createDisarmedGoal(test, 'projection failed')
    const realGet = test.ctx.goals.get.bind(test.ctx.goals)
    vi.spyOn(test.ctx.goals, 'get').mockImplementation((agent) => {
      if (agent.status === 'running') throw new Error('projection failed')
      return realGet(agent)
    })

    followUser(test, 'continue')
    await test.agent.whenIdle()

    expect(test.adapter.requests).toHaveLength(1)
    expect(requestText(test.adapter.requests[0]!)).toContain('continue')
    expect(requestNoticeTexts(test.adapter.requests[0]!)).toEqual([])
  })

  it('does not resume an active goal that has no remaining round capacity', async () => {
    const test = await harness([textResponse('round one'), textResponse('after continue')])
    let disarmed = false
    test.ctx.on('session/event', (session, event) => {
      if (disarmed || session !== test.agent.session || event.type !== 'turn/end') return
      disarmed = true
      test.ctx.goals.disarm(test.agent)
    })
    const created = test.ctx.goals.create(test.agent, { objective: 'cap already spent', maxGoalRounds: 2 })
    await waitForRequests(test.adapter, 1)
    await test.agent.whenIdle()
    const current = test.ctx.goals.get(test.agent)
    if (current === undefined) throw new Error('missing goal after first round')
    test.ctx.goals.edit(test.agent, current, { maxGoalRounds: 1 })

    followUser(test, 'continue')
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      id: created.id,
      phase: 'active',
      activation: 'disarmed',
      roundsStarted: 1,
      maxGoalRounds: 1,
    })
    expect(requestNoticeTexts(test.adapter.requests[1]!)).toEqual([])
  })
})
