/** The runner plugin: Agent creation or resume, the quit flow, and failure reporting. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionLogOffset, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, internals } from '../src/index.ts'
import { FakeTerminal, KEY } from './bench.ts'

const originalInternals = { ...internals }
afterEach(() => { Object.assign(internals, originalInternals) })

interface Observed {
  terminal: FakeTerminal
  err: string
  exits: number[]
  order: string[]
  created: CreateAgentOptions[]
  resumed: ResumeAgentOptions[]
  cancels: number
}

/** Mount the real registries around a scripted Agent factory and capture the process effects. */
async function bench(
  options: { history?: SessionEvent[]; failCreate?: boolean; noPersistence?: boolean; observed?: SessionEvent[] } = {},
): Promise<{ ctx: Context; observed: Observed }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  const terminal = new FakeTerminal()
  const observed: Observed = { terminal, err: '', exits: [], order: [], created: [], resumed: [], cancels: 0 }
  const makeAgent = async (ownerCtx: Context, id: SessionId, setup: CreateAgentOptions['setup'], meta?: CreateAgentOptions['meta'], seed?: readonly SessionEvent[]): Promise<AgentHandle> => {
    const session = ctx.sessions.create(id, {
      ...meta === undefined ? {} : { meta },
      ...seed === undefined ? {} : { seed, inheritedEventCount: SessionLogOffset(seed.length) },
    })
    const agent: Agent = {
      id: session.id,
      options: { provider: 'test-provider', model: 'test-model' },
      session,
      inbox: createInboxStub(),
      status: 'idle',
      ctx: ownerCtx,
      cancel: () => { observed.cancels += 1; observed.order.push('cancel') },
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      followup: () => { observed.order.push('followup') },
      steer: () => {},
      inject: () => {},
      whenIdle: () => Promise.resolve(),
    }
    await setup?.(ownerCtx, agent)
    ctx.agents.register(agent)
    return { agent, dispose: () => { observed.order.push('dispose'); return Promise.resolve() } }
  }
  ctx.agents.setFactory({
    createAgent(ownerCtx, createOptions) {
      observed.created.push(createOptions)
      if (options.failCreate === true) return Promise.reject(new Error('factory refused'))
      return makeAgent(ownerCtx, createOptions.sessionId, createOptions.setup, createOptions.meta, createOptions.seed)
    },
    resume(ownerCtx, resumeOptions) {
      observed.resumed.push(resumeOptions)
      return makeAgent(ownerCtx, resumeOptions.resumeSessionId, resumeOptions.setup)
    },
  })
  if (options.noPersistence !== true) {
    const history = options.history ?? []
    ctx.provide('sessionPersistence', {
      open: (id: SessionId, access: string) => {
        observed.order.push(`open:${id}:${access}`)
        return Promise.resolve({
          read: (offset: number, length: number) => Promise.resolve({ eventState: 'complete', events: history.slice(offset, offset + length) }),
          [Symbol.asyncDispose]: () => { observed.order.push('close'); return Promise.resolve() },
        })
      },
    } as never)
  }
  if (options.observed !== undefined) {
    const events = options.observed
    ctx.provide('sessionQuery', {
      observeSession: (id: SessionId) => {
        observed.order.push(`observe:${id}`)
        return Promise.resolve({ events, [Symbol.dispose]: () => { observed.order.push('release-observation') } })
      },
      listSessions: () => Promise.resolve([{ header: { id: 'session-old', createdAt: 1 } }]),
      readTitleSnapshots: () => Promise.resolve([{ status: 'fulfilled', value: {} }]),
    } as never)
  }
  ctx.on('session/flush', () => { observed.order.push('flush') })
  internals.createTerminal = () => terminal
  internals.releaseInput = () => { observed.order.push('release') }
  internals.stderr = { write: (chunk: string) => { observed.err += chunk; return true } }
  internals.color = false
  ctx.provide('appExit', (code: number) => { observed.order.push(`exit:${String(code)}`); observed.exits.push(code) })
  return { ctx, observed }
}

function typeLine(terminal: FakeTerminal, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

async function settled(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 40))
}

describe('tui runner', () => {
  it('refuses to mount without the launcher exit request', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, { toolPreviewLines: 8 }) }).toThrow('ctx.appExit')
  })

  it('creates a fresh Agent with the default model, submits the prompt, and quits through flush and dispose', async () => {
    const { ctx, observed } = await bench()
    apply(ctx, { toolPreviewLines: 8, prompt: 'first' })
    await settled()
    expect(observed.created).toHaveLength(1)
    expect(observed.created[0]?.meta).toEqual({ cwd: process.cwd() })
    expect(observed.created[0]?.agentOptions).toEqual({ provider: 'test-provider', model: 'test-model' })
    expect(observed.terminal.started).toBe(true)
    expect(observed.order).toEqual(['followup'])
    expect(observed.terminal.text()).toContain('› first')
    observed.terminal.type(KEY.ctrlD)
    await settled()
    expect(observed.order).toEqual(['followup', 'release', 'cancel', 'flush', 'dispose', 'exit:0'])
    expect(observed.err).toContain('saved; resume with: dsh --profile tui --resume session-')
    expect(observed.terminal.stopped).toBe(true)
  })

  it('resumes a persisted session after paging its history through a read handle', async () => {
    const history: SessionEvent[] = Array.from({ length: 300 }, (_, seq) => ({
      type: 'user/message',
      seq,
      time: 1,
      data: createUserMessage({ content: [{ type: 'text', text: `prompt ${String(seq)}` }], source: { kind: 'user' } }),
    })) as never[]
    const { ctx, observed } = await bench({ history })
    apply(ctx, { toolPreviewLines: 8, resume: 'session-old' })
    await settled()
    expect(observed.order.slice(0, 2)).toEqual(['open:session-old:read', 'close'])
    expect(observed.resumed.map(options => options.resumeSessionId)).toEqual(['session-old'])
    expect(observed.created).toHaveLength(0)
    expect(observed.terminal.text()).toContain('› prompt 0')
    expect(observed.terminal.text()).toContain('› prompt 299')
    expect(observed.exits).toEqual([])
  })

  it('fails loud when --resume has no persistence provider', async () => {
    const { ctx, observed } = await bench({ noPersistence: true })
    apply(ctx, { toolPreviewLines: 8, resume: 'session-old' })
    await settled()
    expect(observed.err).toContain('resuming a session needs a composed session persistence provider')
    expect(observed.exits).toEqual([1])
  })

  it('forks at the last completed turn, resumes through the picker, and starts new sessions from the terminal', async () => {
    const at = (type: string, seq: number, data: unknown): SessionEvent => ({ type, seq, time: 1, data }) as never
    const events = [
      at('turn/start', 0, { turn: 1 }),
      at('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
      at('session/title', 2, { title: 'T', messageSeqs: [], source: { kind: 'user' } }),
      at('turn/start', 3, { turn: 2 }),
    ]
    const { ctx, observed } = await bench({ observed: events })
    apply(ctx, { toolPreviewLines: 8 })
    await settled()
    const first = observed.created[0]?.sessionId
    typeLine(observed.terminal, '/fork')
    await settled()
    expect(observed.order).toEqual([`observe:${String(first)}`, 'release-observation', 'dispose'])
    const fork = observed.created[1]
    expect(fork?.seed).toEqual(events.slice(0, 3))
    expect(fork?.inheritedEventCount).toBe(3)
    expect(fork?.meta).toEqual({ cwd: process.cwd(), parentSession: first, isSeeded: true })
    expect(observed.terminal.text()).toContain('forked: session session-')
    typeLine(observed.terminal, '/new')
    await settled()
    expect(observed.created).toHaveLength(3)
    expect(observed.created[2]?.meta).toEqual({ cwd: process.cwd() })
    typeLine(observed.terminal, '/sessions')
    await settled()
    observed.terminal.type(KEY.enter)
    await settled()
    expect(observed.resumed.map(options => options.resumeSessionId)).toEqual(['session-old'])
    expect(observed.order.slice(-3)).toEqual(['open:session-old:read', 'close', 'dispose'])
    observed.terminal.type(KEY.ctrlD)
    await settled()
    expect(observed.err).toContain('session session-old saved')
    expect(observed.exits).toEqual([0])
  })

  it('refuses to fork without a query engine or a completed turn', async () => {
    const bare = await bench()
    apply(bare.ctx, { toolPreviewLines: 8 })
    await settled()
    typeLine(bare.observed.terminal, '/fork')
    await settled()
    expect(bare.observed.terminal.text()).toContain('forked failed: forking a session needs a composed session query engine')
    const open = await bench({ observed: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as never] })
    apply(open.ctx, { toolPreviewLines: 8 })
    await settled()
    typeLine(open.observed.terminal, '/fork')
    await settled()
    expect(open.observed.terminal.text()).toContain('has no completed turn')
    expect(open.observed.created).toHaveLength(1)
    const two = await bench({ observed: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 2, time: 1, data: { turn: 2 } },
      { type: 'turn/end', seq: 3, time: 1, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as never[] })
    apply(two.ctx, { toolPreviewLines: 8 })
    await settled()
    typeLine(two.observed.terminal, '/fork 1')
    await settled()
    expect(two.observed.created[1]?.inheritedEventCount).toBe(2)
    typeLine(two.observed.terminal, '/fork 7')
    await settled()
    expect(two.observed.terminal.text()).toContain('has no completed turn 7')
  })

  it('reports an Agent creation failure and exits 1', async () => {
    const { ctx, observed } = await bench({ failCreate: true })
    apply(ctx, { toolPreviewLines: 8 })
    await settled()
    expect(observed.err).toBe('dsh: factory refused\n')
    expect(observed.exits).toEqual([1])
    expect(observed.terminal.started).toBe(false)
  })

  it('reports a failure during quit and exits 1', async () => {
    const { ctx, observed } = await bench()
    apply(ctx, { toolPreviewLines: 8 })
    await settled()
    ctx.on('session/flush', () => { throw new Error('disk gone') })
    observed.terminal.type(KEY.ctrlD)
    await settled()
    expect(observed.err).toContain('disk gone')
    expect(observed.exits).toEqual([1])
  })

  it('renders a non-error failure reason', async () => {
    const { ctx, observed } = await bench()
    apply(ctx, { toolPreviewLines: 8 })
    await settled()
    ctx.on('session/flush', () => { throw 'plain failure' })
    observed.terminal.type(KEY.ctrlD)
    await settled()
    expect(observed.err).toContain('dsh: plain failure')
    expect(observed.exits).toEqual([1])
  })

  it('returns quietly when the tree was disposed before the services resolved', async () => {
    const ctx = new Context()
    let exits = 0
    ctx.provide('appExit', () => { exits += 1 })
    apply(ctx, { toolPreviewLines: 8 })
    await settled()
    expect(exits).toBe(0)
  })
})
