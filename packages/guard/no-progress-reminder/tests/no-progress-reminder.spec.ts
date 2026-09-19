import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import * as NoProgressReminder from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const testToolSignal = new AbortController().signal

const NUDGE = (n: number) =>
  `No file has changed in ${n} turns. Your next tool call must be read, edit, write, or bash, or explain what blocks you.`

const guardSource = {
  kind: 'plugin',
  plugin: 'no-progress-reminder',
  form: 'notice',
  summary: 'no progress',
} as const

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Boot the core spine + the guard. The caller registers adapters and extra plugins. */
async function harness(config: Config = {}, options: { goals?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.goals === true) await ctx.plugin(GoalService)
  await ctx.plugin(NoProgressReminder, { providers: ['mock'], ...config })
  ctx.tools.register(defineContentToolFixture({
    name: 'todo_write',
    description: 't',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'todo' }] },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'skill',
    description: 's',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'skill' }] },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'edit',
    description: 'e',
    parameters: { fail: { type: 'boolean' } },
    async execute(args) {
      if (args.fail === true) throw new Error('edit failed')
      return [{ type: 'text', text: 'edited' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'write',
    description: 'w',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'written' }] },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'bash',
    description: 'b',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ran' }] },
  }))
  return ctx
}

/** Every injected-context user message in the agent's log. */
function reminders(agent: Agent): { text: string; source: unknown }[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind !== 'user')
    .map(e => ({
      text: e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: e.data.source,
    }))
}

async function runTurns(agent: Agent, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: i === 0 ? 'go' : 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
  }
}

function scriptIdleTurns(count: number, tool = 'todo_write'): ReturnType<typeof toolCallResponse>[] {
  const script: ReturnType<typeof toolCallResponse>[] = []
  for (let i = 0; i < count; i++) {
    script.push(toolCallResponse(`idle-${tool}-${i}`, tool, {}))
    script.push(textResponse(`recap ${i}`))
  }
  return script
}

describe('default idle threshold with an active goal', () => {
  it('nudges after five todo-only turns and quotes the idle count', async () => {
    const ctx = await harness({}, { goals: true })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...scriptIdleTurns(5),
      textResponse('after nudge'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    ctx.goals.create(agent, { objective: 'Ship the feature' })
    await runTurns(agent, 5)
    expect(reminders(agent)).toHaveLength(0)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const found = reminders(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toBe(NUDGE(5))
    expect(found[0]!.source).toEqual(guardSource)
  })
})

describe('mutating reset and non-mutating tools', () => {
  it('resets the idle count on a successful edit', async () => {
    const ctx = await harness({ idleTurns: 2, requireGoal: false })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('t1', 'todo_write', {}),
      textResponse('turn 1'),
      toolCallResponse('e1', 'edit', {}),
      textResponse('turn 2 mutated'),
      toolCallResponse('t2', 'todo_write', {}),
      textResponse('turn 3'),
      textResponse('turn 4'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await runTurns(agent, 3)
    expect(reminders(agent)).toHaveLength(0)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toHaveLength(0)
  })

  it('does not reset on a failed edit or on skill/todo tools', async () => {
    const ctx = await harness({ idleTurns: 2, requireGoal: false })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('s1', 'skill', {}),
      textResponse('turn 1'),
      toolCallResponse('e1', 'edit', { fail: true }),
      textResponse('turn 2 failed edit'),
      textResponse('turn 3'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await runTurns(agent, 2)
    expect(reminders(agent)).toHaveLength(0)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toEqual([{ text: NUDGE(2), source: guardSource }])
  })

  it('treats include-style wildcards as mutating-tool patterns', async () => {
    const ctx = await harness({ idleTurns: 1, requireGoal: false, mutatingTools: ['ed*'] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('e1', 'edit', {}),
      textResponse('mutated'),
      toolCallResponse('t1', 'todo_write', {}),
      textResponse('idle'),
      textResponse('after'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await runTurns(agent, 2)
    expect(reminders(agent)).toHaveLength(0)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toEqual([{ text: NUDGE(1), source: guardSource }])
  })

  it('escapes regex metacharacters in mutating-tool patterns', async () => {
    const ctx = await harness({ idleTurns: 1, requireGoal: false, mutatingTools: ['ed.t'] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('e1', 'edit', {}),
      textResponse('not a match'),
      textResponse('after'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await runTurns(agent, 1)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toEqual([{ text: NUDGE(1), source: guardSource }])
  })

  it('ignores a successful mutating call with no agent', async () => {
    const ctx = await harness({ idleTurns: 1, requireGoal: false })
    const direct = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('d1'),
      name: 'edit',
      arguments: {},
    })
    expect(direct.isError).toBe(false)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('t1', 'todo_write', {}),
      textResponse('idle'),
      textResponse('after'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await runTurns(agent, 1)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toEqual([{ text: NUDGE(1), source: guardSource }])
  })
})

describe('goal gating', () => {
  it('does not nudge when requireGoal is true and no goals service is mounted', async () => {
    const ctx = await harness({ idleTurns: 1 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...scriptIdleTurns(1),
      textResponse('after'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await runTurns(agent, 1)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toHaveLength(0)
  })

  it('does not nudge when requireGoal is true and no goal is current', async () => {
    const ctx = await harness({ idleTurns: 1 }, { goals: true })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...scriptIdleTurns(1),
      textResponse('after'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await runTurns(agent, 1)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toHaveLength(0)
  })

  it('does not increment or inject while the current goal is paused', async () => {
    const ctx = await harness({ idleTurns: 1 }, { goals: true })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...scriptIdleTurns(1),
      toolCallResponse('t2', 'todo_write', {}),
      textResponse('paused turn'),
      textResponse('after'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const goal = ctx.goals.create(agent, { objective: 'Ship the feature' })
    await runTurns(agent, 1)
    ctx.goals.pause(agent, goal)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toHaveLength(0)
  })

  it('resets idle debt when the goal completes even if requireGoal is false', async () => {
    const ctx = await harness({ idleTurns: 1, requireGoal: false }, { goals: true })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...scriptIdleTurns(1),
      textResponse('after complete'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const goal = ctx.goals.create(agent, { objective: 'Ship the feature' })
    await runTurns(agent, 1)
    ctx.goals.complete(agent, goal)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toHaveLength(0)
  })

  it('resets idle debt when the goal is cleared', async () => {
    const ctx = await harness({ idleTurns: 1, requireGoal: false }, { goals: true })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...scriptIdleTurns(1),
      textResponse('after clear'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const goal = ctx.goals.create(agent, { objective: 'Ship the feature' })
    await runTurns(agent, 1)
    ctx.goals.clear(agent, goal)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toHaveLength(0)
  })
})

describe('turn counting and injection cadence', () => {
  it('counts a multi-step turn once and injects only on the first pre-step of a new turn', async () => {
    const ctx = await harness({ idleTurns: 1, requireGoal: false })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('t1a', 'todo_write', {}),
      toolCallResponse('t1b', 'skill', {}),
      textResponse('one turn'),
      toolCallResponse('t2a', 'todo_write', {}),
      toolCallResponse('t2b', 'todo_write', {}),
      textResponse('second turn'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await runTurns(agent, 1)
    expect(reminders(agent)).toHaveLength(0)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toEqual([{ text: NUDGE(1), source: guardSource }])
  })

  it('re-injects on each further idle turn and does not reset on a user continue', async () => {
    const ctx = await harness({ idleTurns: 1, requireGoal: false })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...scriptIdleTurns(1),
      textResponse('nudge 1'),
      textResponse('nudge 2'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await runTurns(agent, 1)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toEqual([
      { text: NUDGE(1), source: guardSource },
      { text: NUDGE(2), source: guardSource },
    ])
  })

  it('keeps idle debt per agent', async () => {
    const ctx = await harness({
      idleTurns: 1,
      requireGoal: false,
      providers: ['mock-a', 'mock-b'],
    })
    ctx.llm.registerAdapter(['mock-a'], new MockAdapter([
      toolCallResponse('a1', 'todo_write', {}),
      textResponse('a done'),
    ]))
    ctx.llm.registerAdapter(['mock-b'], new MockAdapter([
      ...scriptIdleTurns(1),
      textResponse('b after'),
    ]))
    const agentA = await ctx.agentLoop.create(SessionId('a'), { provider: 'mock-a', model: 'a' })
    const agentB = await ctx.agentLoop.create(SessionId('b'), { provider: 'mock-b', model: 'b' })
    await runTurns(agentA, 1)
    await runTurns(agentB, 1)
    agentB.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agentB.whenIdle()
    expect(reminders(agentA)).toHaveLength(0)
    expect(reminders(agentB)).toEqual([{ text: NUDGE(1), source: guardSource }])
  })

  it('does not inject when a later listener rejects the step', async () => {
    const ctx = await harness({ idleTurns: 1, requireGoal: false })
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const signal = new AbortController().signal
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      {
        messages: [createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })],
        turn: 1,
        step: 1,
        signal,
      },
      () => Promise.resolve({ kind: 'reject' as const }),
    )
    expect(decision).toEqual({ kind: 'reject' })
    expect(reminders(agent)).toHaveLength(0)
  })

  it('does not throw when pre-step sees a non-live agent while goals are mounted', async () => {
    const ctx = await harness({ idleTurns: 1 }, { goals: true })
    const agent = await ctx.agentLoop.create(SessionId('dsh-badge-snapshot'), { provider: 'mock', model: 'mock' })
    ctx.goals.create(agent, { objective: 'Ship the feature' })
    const stale = Object.create(agent) as Agent
    const signal = new AbortController().signal
    await expect(agentEvents(ctx, stale).waterfall(
      'agent/pre-step',
      {
        messages: [createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })],
        turn: 1,
        step: 1,
        signal,
      },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )).resolves.toEqual({ kind: 'enter', messages: [] })
  })

  it('ignores turn/end on a session with no live agent', async () => {
    const ctx = await harness({ idleTurns: 1, requireGoal: false })
    const orphan = ctx.sessions.create(SessionId('orphan'))
    orphan.append('turn/start', { turn: 1 })
    orphan.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...scriptIdleTurns(1),
      textResponse('after'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await runTurns(agent, 1)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toEqual([{ text: NUDGE(1), source: guardSource }])
  })
})

describe('HMR safety', () => {
  it('stops injecting after the plugin fiber is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const fiber = await ctx.plugin(NoProgressReminder, { idleTurns: 1, requireGoal: false })
    ctx.tools.register(defineContentToolFixture({
      name: 'todo_write',
      description: 't',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'todo' }] },
    }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...scriptIdleTurns(1),
      textResponse('after dispose'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('hmr'), { provider: 'mock', model: 'mock' })
    await runTurns(agent, 1)
    await fiber.dispose()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toHaveLength(0)
  })
})

describe('config validation fails loud', () => {
  async function spine(): Promise<Context> {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    return ctx
  }

  it('rejects idleTurns below 1', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(NoProgressReminder, { idleTurns: 0 })).rejects.toThrow(/idleTurns/)
  })

  it('rejects a non-integer idleTurns', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(NoProgressReminder, { idleTurns: 1.5 })).rejects.toThrow(/integer >= 1/)
  })

  it('rejects an empty providers entry', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(NoProgressReminder, { providers: [''] })).rejects.toThrow(/providers/)
  })
})

describe('Cursor subscription route', () => {
  it('does not nudge a mock-provider agent under the shipped providers default', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(NoProgressReminder, { idleTurns: 1, requireGoal: false })
    ctx.tools.register(defineContentToolFixture({
      name: 'todo_write',
      description: 't',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'todo' }] },
    }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...scriptIdleTurns(1),
      textResponse('after'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('not-cursor'), { provider: 'mock', model: 'mock' })
    await runTurns(agent, 1)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toHaveLength(0)
  })

  it('nudges when the routed provider is the Cursor subscription route', async () => {
    const ctx = await harness({ idleTurns: 1, requireGoal: false, providers: ['cursor'] })
    ctx.llm.registerAdapter(['cursor'], new MockAdapter([
      ...scriptIdleTurns(1),
      textResponse('after'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('cursor-route'), {
      provider: 'cursor',
      model: 'composer-2',
    })
    await runTurns(agent, 1)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(reminders(agent)).toEqual([{ text: NUDGE(1), source: guardSource }])
  })
})
