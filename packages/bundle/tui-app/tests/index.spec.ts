/** The runner plugin: Agent creation or resume, the quit flow, and failure reporting. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, {
  assembleContextFor,
  type Agent,
  type AgentHandle,
  type CreateAgentOptions,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionLogOffset, type EpochHeader, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { BTW_SANDBOXED_TOOLS, BTW_TOOLS } from '../src/btw.ts'
import { Config, apply, internals } from '../src/index.ts'
import { FakeTerminal, KEY } from './bench.ts'

const originalInternals = { ...internals }
afterEach(() => {
  Object.assign(internals, originalInternals)
  vi.unstubAllEnvs()
})

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
  options: {
    history?: SessionEvent[]
    failCreate?: boolean
    noPersistence?: boolean
    observed?: SessionEvent[]
    resumeHeader?: EpochHeader
  } = {},
): Promise<{ ctx: Context; observed: Observed }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  await ctx.plugin(SystemPrompt)
  ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
  ctx.systemPrompt.variable('model', context => context.agent?.options.model)
  const terminal = new FakeTerminal()
  const observed: Observed = { terminal, err: '', exits: [], order: [], created: [], resumed: [], cancels: 0 }
  const makeAgent = async (
    ownerCtx: Context,
    id: SessionId,
    setup: CreateAgentOptions['setup'],
    meta?: CreateAgentOptions['meta'],
    seed?: readonly SessionEvent[],
    agentOptions?: CreateAgentOptions['agentOptions'],
    inheritedEventCount?: SessionLogOffset,
  ): Promise<AgentHandle> => {
    const session = ctx.sessions.create(id, {
      ...meta === undefined ? {} : { meta },
      ...seed === undefined ? {} : { seed, inheritedEventCount: inheritedEventCount ?? SessionLogOffset(seed.length) },
    })
    if (options.resumeHeader !== undefined && String(id) === 'session-old') {
      session.append('request/header', { header: options.resumeHeader, reason: 'initial' })
    }
    const agent: Agent = {
      id: session.id,
      options: {
        provider: agentOptions?.provider ?? 'test-provider',
        model: agentOptions?.model ?? 'test-model',
      },
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
      return makeAgent(
        ownerCtx,
        createOptions.sessionId,
        createOptions.setup,
        createOptions.meta,
        createOptions.seed,
        createOptions.agentOptions,
        createOptions.inheritedEventCount,
      )
    },
    resume(ownerCtx, resumeOptions) {
      observed.resumed.push(resumeOptions)
      observed.order.push(`resume:${resumeOptions.resumeSessionId}`)
      return makeAgent(
        ownerCtx,
        resumeOptions.resumeSessionId,
        resumeOptions.setup,
        undefined,
        undefined,
        resumeOptions.agentOptions,
      )
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
  if (options.observed !== undefined || options.history !== undefined) {
    ctx.provide('sessionQuery', {
      observeSession: (id: SessionId) => {
        observed.order.push(`observe:${id}`)
        const events = String(id) === 'session-old'
          ? (options.history ?? [])
          : (options.observed ?? [])
        return Promise.resolve({ events, [Symbol.dispose]: () => { observed.order.push('release-observation') } })
      },
      listSessions: () => Promise.resolve([{ header: { id: 'session-old', createdAt: 1 } }]),
    } as never)
  }
  ctx.on('session/flush', () => { observed.order.push('flush') })
  internals.createTerminal = () => terminal
  internals.releaseInput = () => { observed.order.push('release') }
  internals.stderr = { write: (chunk: string) => { observed.err += chunk; return true } }
  internals.color = false
  internals.canOpenUrl = () => false
  internals.openUrl = () => Promise.resolve()
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

/**
 * The validated config of one run, with every field a spec does not exercise
 * at the value the schema defaults it to.
 * @param overrides - the fields this spec drives.
 * @returns the config `apply` is mounted with.
 */
function config(overrides: Partial<Config> = {}): Config {
  return {
    toolPreviewLines: 8,
    contextPreviewLines: 4,
    focusPreviewLines: 12,
    readerMinColumns: 60,
    codeHighlight: true,
    toastMs: 2000,
    liveRefreshMs: 1000,
    streamFadeSteps: 24,
    streamFadeStepMs: 16,
    streamPaceFrames: 8,
    toolRevealFrames: 6,
    reducedMotion: false,
    openBrowser: true,
    btwTools: [...BTW_TOOLS],
    btwSandboxedTools: [...BTW_SANDBOXED_TOOLS],
    ...overrides,
  }
}

describe('tui runner', () => {
  it('refuses to mount without the launcher exit request', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, config()) }).toThrow('ctx.appExit')
  })

  it('creates a fresh Agent with the default model, submits the prompt, and quits through flush and dispose', async () => {
    const { ctx, observed } = await bench()
    apply(ctx, config({ prompt: 'first' }))
    await settled()
    expect(observed.created).toHaveLength(1)
    expect(observed.created[0]?.meta).toEqual({ cwd: process.cwd() })
    expect(observed.created[0]?.agentOptions).toEqual({ provider: 'test-provider', model: 'test-model' })
    expect(observed.terminal.started).toBe(true)
    expect(observed.order).toEqual(['followup'])
    expect(observed.terminal.text()).toContain('❯ first')
    observed.terminal.type(KEY.ctrlD)
    await settled()
    expect(observed.order).toEqual(['followup', 'release', 'cancel', 'flush', 'dispose', 'exit:0'])
    expect(observed.err).toContain('saved; resume with: dsh --profile tui --resume session-')
    expect(observed.terminal.stopped).toBe(true)
  })

  it('drives the live counter from a real interval and clears it on quit', async () => {
    const { ctx, observed } = await bench()
    apply(ctx, config({ liveRefreshMs: 120 }))
    await settled()
    const id = observed.created[0]?.sessionId
    if (id === undefined) throw new Error('the runner created no session')
    const session = ctx.agents.get(id)?.session
    if (session === undefined) throw new Error(`no live agent for ${id}`)
    // A running turn arms the interval, which is the only production caller
    // of the tick source; quitting disposes its effect.
    session.append('turn/start', { turn: 1 })
    await settled()
    expect(observed.terminal.text()).toContain('turn 0s')
    observed.terminal.type(KEY.ctrlD)
    await settled()
    expect(observed.order).toEqual(['release', 'cancel', 'flush', 'dispose', 'exit:0'])
  })

  it('resumes a persisted session from the Agent session after the write-handle load', async () => {
    const history: SessionEvent[] = Array.from({ length: 300 }, (_, seq) => ({
      type: 'user/message',
      seq,
      time: 1,
      data: createUserMessage({ content: [{ type: 'text', text: `prompt ${String(seq)}` }], source: { kind: 'user' } }),
    })) as never[]
    const { ctx, observed } = await bench({ history })
    apply(ctx, config({ resume: 'session-old' }))
    await settled()
    expect(observed.order).toEqual(['resume:session-old', 'observe:session-old', 'release-observation'])
    expect(observed.resumed.map(options => options.resumeSessionId)).toEqual(['session-old'])
    expect(observed.created).toHaveLength(0)
    expect(observed.terminal.text()).toContain('❯ prompt 0')
    expect(observed.terminal.text()).toContain('❯ prompt 299')
    expect(observed.exits).toEqual([])
  })

  it('draws interrupted-turn closers that resume appended after the write-handle read', async () => {
    const history: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
      },
      { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'interrupted' } } },
    ] as never[]
    const { ctx, observed } = await bench({ history })
    apply(ctx, config({ resume: 'session-old' }))
    await settled()
    expect(observed.order[0]).toBe('resume:session-old')
    expect(observed.terminal.text()).toContain('❯ hello')
    expect(observed.terminal.text()).toContain('turn was interrupted by an earlier process exit')
  })

  it('resumes with the default route and overlays the logged model for prompt assembly', async () => {
    const { ctx, observed } = await bench({
      history: [],
      resumeHeader: { config: { provider: 'logged', model: 'logged-model' } },
    })
    apply(ctx, config({ resume: 'session-old' }))
    await settled()
    expect(observed.resumed[0]?.agentOptions).toEqual({ provider: 'test-provider', model: 'test-model' })
    const agent = ctx.agents.get('session-old' as SessionId)
    if (agent === undefined) throw new Error('resume published no agent')
    agent.ctx.systemPrompt.section({ name: 'resume-model-check', order: 0, text: 'You run {{model}}' })
    const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(assembly.variables).toMatchObject({ provider: 'logged', model: 'logged-model' })
    expect(renderPrompt(assembly)).toContain('You run logged-model')
  })

  it('resumes with the launch default when the log has no request header', async () => {
    const { ctx, observed } = await bench({ history: [] })
    apply(ctx, config({ resume: 'session-old' }))
    await settled()
    expect(observed.resumed[0]?.agentOptions).toEqual({ provider: 'test-provider', model: 'test-model' })
    const agent = ctx.agents.get('session-old' as SessionId)
    if (agent === undefined) throw new Error('resume published no agent')
    agent.ctx.systemPrompt.section({ name: 'resume-model-check', order: 0, text: 'You run {{model}}' })
    const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(assembly.variables).toMatchObject({ provider: 'test-provider', model: 'test-model' })
    expect(renderPrompt(assembly)).toContain('You run test-model')
  })

  it('fails loud when --resume has no query engine', async () => {
    const { ctx, observed } = await bench()
    apply(ctx, config({ resume: 'session-old' }))
    await settled()
    expect(observed.err).toContain('resuming a session needs a composed session query engine')
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
    apply(ctx, config())
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
    typeLine(observed.terminal, '/resume')
    await settled()
    observed.terminal.type(KEY.enter)
    await settled()
    expect(observed.resumed.map(options => options.resumeSessionId)).toEqual(['session-old'])
    expect(observed.order.slice(-4)).toEqual(['resume:session-old', 'observe:session-old', 'release-observation', 'dispose'])
    observed.terminal.type(KEY.ctrlD)
    await settled()
    expect(observed.err).toContain('session session-old saved')
    expect(observed.exits).toEqual([0])
  })

  it('views a resident subagent without resuming it, and resumes and releases one that is not resident', async () => {
    const { ctx, observed } = await bench({ observed: [] })
    const child = (id: string, activity: string): unknown => ({ kind: 'child', id, activity, mode: 'one-shot', hasChildren: false, parentId: 'root', depth: 1 })
    ctx.provide('subagents', {
      listDescendants: () => Promise.resolve([child('session-kid', 'running'), child('session-old', 'inactive')]),
    } as never)
    apply(ctx, config())
    await settled()
    await ctx.agents.create({ sessionId: 'session-kid' as SessionId, meta: { cwd: process.cwd() } })
    const start = observed.order.length
    typeLine(observed.terminal, '/subagents')
    await settled()
    observed.terminal.type(KEY.enter)
    await settled()
    // The view reads the resident child's log; its detail rows read it again.
    expect(observed.order.slice(start, start + 2)).toEqual(['observe:session-kid', 'release-observation'])
    expect(observed.resumed).toEqual([])
    expect(observed.terminal.text()).toContain('subagent view')
    typeLine(observed.terminal, '/parent')
    await settled()
    // Returning re-reads the parent; the resident child is not released.
    expect(observed.order.slice(start + 2).filter(entry => entry === 'dispose')).toEqual([])
    typeLine(observed.terminal, '/subagents')
    await settled()
    observed.terminal.type(KEY.down)
    observed.terminal.type(KEY.enter)
    await settled()
    expect(observed.resumed.map(options => options.resumeSessionId)).toEqual(['session-old'])
    typeLine(observed.terminal, '/parent')
    await settled()
    expect(observed.order.at(-1)).toBe('dispose')
  })

  it('opens a /btw side agent from the whole live log on the logged model, and ends it on return', async () => {
    const logged: SessionEvent[] = []
    const { ctx, observed } = await bench({ observed: logged })
    apply(ctx, config())
    await settled()
    const root = observed.created[0]?.sessionId
    const agent = root === undefined ? undefined : ctx.agents.get(root)
    if (agent === undefined) throw new Error('the runner published no agent')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('request/header', { header: { config: { provider: 'logged', model: 'logged-model', reasoningEffort: 'high' } }, reason: 'initial' } as never)
    agent.session.append('step/start', { turn: 1, step: 1 })
    logged.push(...agent.session.ownEvents())
    typeLine(observed.terminal, '/btw what now')
    await settled()
    const side = observed.created[1]
    expect(side?.seed?.slice(0, 3).map(event => event.type)).toEqual(['turn/start', 'request/header', 'step/start'])
    expect(side?.seed?.slice(3).map(event => event.type)).toEqual(['session/end-seed', 'step/end', 'turn/end'])
    expect(side?.inheritedEventCount).toBe(3)
    expect(side?.parentAgent).toBeUndefined()
    expect(side?.meta).toEqual({ cwd: process.cwd(), parentSession: root, isSeeded: true, origin: 'subagent' })
    expect(side?.agentOptions).toEqual({ provider: 'logged', model: 'logged-model', reasoningEffort: 'high' })
    const sideAgent = side === undefined ? undefined : ctx.agents.get(side.sessionId)
    expect(sideAgent?.session.ownEvents().slice(-2).map(event => [event.type, event.data])).toEqual([
      ['sandbox/mode', { mode: 'read-only', source: 'delegation' }],
      ['approval/policy', { policy: 'never', source: 'delegation' }],
    ])
    expect(observed.terminal.text()).toContain('btw side agent')
    const start = observed.order.length
    typeLine(observed.terminal, '/parent')
    await settled()
    expect(observed.order.slice(start)).toEqual([`observe:${String(root)}`, 'release-observation', 'dispose'])
  })

  it('reports a /btw side agent that has no query engine to read the session from', async () => {
    const { ctx, observed } = await bench()
    apply(ctx, config())
    await settled()
    typeLine(observed.terminal, '/btw why')
    await settled()
    expect(observed.created).toHaveLength(1)
    expect(observed.terminal.text()).toContain('opening btw failed: btw needs a composed session query engine')
  })

  it('opens a /btw side agent over an empty session on the selected model', async () => {
    const { ctx, observed } = await bench({ observed: [] })
    apply(ctx, config())
    await settled()
    typeLine(observed.terminal, '/btw')
    await settled()
    const side = observed.created[1]
    expect(side?.seed).toBeUndefined()
    expect(side?.inheritedEventCount).toBeUndefined()
    expect(side?.agentOptions).toEqual({ provider: 'test-provider', model: 'test-model' })
  })

  it('opens a /btw side agent over a subagent view on the default model', async () => {
    const { ctx, observed } = await bench({ observed: [] })
    ctx.provide('subagents', {
      listDescendants: () => Promise.resolve([{ kind: 'child', id: 'session-kid', activity: 'running', mode: 'one-shot', hasChildren: false, parentId: 'root', depth: 1 }]),
    } as never)
    apply(ctx, config())
    await settled()
    await ctx.agents.create({ sessionId: 'session-kid' as SessionId, meta: { cwd: '/kid' } })
    typeLine(observed.terminal, '/subagents')
    await settled()
    observed.terminal.type(KEY.enter)
    await settled()
    typeLine(observed.terminal, '/btw why')
    await settled()
    const side = observed.created.at(-1)
    expect(side?.meta).toEqual({ cwd: '/kid', parentSession: 'session-kid', isSeeded: true, origin: 'subagent' })
    expect(side?.agentOptions).toEqual({ provider: 'test-provider', model: 'test-model' })
  })

  it('refuses to fork without a query engine or a completed turn', async () => {
    const bare = await bench()
    apply(bare.ctx, config())
    await settled()
    typeLine(bare.observed.terminal, '/fork')
    await settled()
    expect(bare.observed.terminal.text()).toContain('forked failed: forking a session needs a composed session query engine')
    const open = await bench({ observed: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as never] })
    apply(open.ctx, config())
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
    apply(two.ctx, config())
    await settled()
    typeLine(two.observed.terminal, '/fork 1')
    await settled()
    expect(two.observed.created[1]?.inheritedEventCount).toBe(2)
    typeLine(two.observed.terminal, '/fork 7')
    await settled()
    expect(two.observed.terminal.text()).toContain('has no completed turn 7')
  })

  it('hands marked sign-in pages to the browser only for local desktop launches', async () => {
    const provideAuth = (ctx: Context): void => {
      ctx.provide('authorization', {
        list: () => [{ key: 'codex', label: 'Codex', methods: [{ id: 'oauth', label: 'ChatGPT' }], inFlight: false }],
        begin: (request: { interaction: { notify(notice: unknown): void } }) => {
          request.interaction.notify({ message: 'open the page', url: 'https://auth.example', openInBrowser: true })
          return Promise.resolve({ status: 'authorized' })
        },
      } as never)
    }
    const opened: string[] = []
    // A launch with no SSH markers is the only case that receives the handoff.
    vi.stubEnv('SSH_CONNECTION', '')
    vi.stubEnv('SSH_TTY', '')
    const local = await bench()
    internals.canOpenUrl = () => true
    internals.openUrl = (url) => { opened.push(url); return Promise.resolve() }
    provideAuth(local.ctx)
    apply(local.ctx, config())
    await settled()
    typeLine(local.observed.terminal, '/login codex')
    await settled()
    expect(opened).toEqual(['https://auth.example'])

    const ssh = await bench()
    ssh.ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([
      { source: 'process', values: { SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' } },
    ]))
    provideAuth(ssh.ctx)
    apply(ssh.ctx, config())
    await settled()
    typeLine(ssh.observed.terminal, '/login codex')
    await settled()
    expect(opened).toHaveLength(1)
    expect(ssh.observed.terminal.text()).toContain('https://auth.example')

    const disabled = await bench()
    provideAuth(disabled.ctx)
    apply(disabled.ctx, config({ openBrowser: false }))
    await settled()
    typeLine(disabled.observed.terminal, '/login codex')
    await settled()
    expect(opened).toHaveLength(1)
    expect(disabled.observed.terminal.text()).toContain('https://auth.example')
  })

  it('reports an Agent creation failure and exits 1', async () => {
    const { ctx, observed } = await bench({ failCreate: true })
    apply(ctx, config())
    await settled()
    expect(observed.err).toBe('dsh: factory refused\n')
    expect(observed.exits).toEqual([1])
    expect(observed.terminal.started).toBe(false)
  })

  it('reports a failure during quit and exits 1', async () => {
    const { ctx, observed } = await bench()
    apply(ctx, config())
    await settled()
    ctx.on('session/flush', () => { throw new Error('disk gone') })
    observed.terminal.type(KEY.ctrlD)
    await settled()
    expect(observed.err).toContain('disk gone')
    expect(observed.exits).toEqual([1])
  })

  it('renders a non-error failure reason', async () => {
    const { ctx, observed } = await bench()
    apply(ctx, config())
    await settled()
    ctx.on('session/flush', () => { throw 'plain failure' })
    observed.terminal.type(KEY.ctrlD)
    await settled()
    expect(observed.err).toContain('dsh: plain failure')
    expect(observed.exits).toEqual([1])
  })

  it('detects desktop availability through the platform opener facts', () => {
    expect(typeof originalInternals.canOpenUrl()).toBe('boolean')
  })

  it('returns quietly when the tree was disposed before the services resolved', async () => {
    const ctx = new Context()
    let exits = 0
    ctx.provide('appExit', () => { exits += 1 })
    apply(ctx, config())
    await settled()
    expect(exits).toBe(0)
  })
})

/**
 * Run one cordis.yml entry through the plugin's schema, as the Loader does.
 * @param input - the fields the entry set.
 * @returns the validated config.
 */
function validate(input: Partial<Config>): Config {
  return Config(input as Config)
}

describe('the presentation tunables', () => {
  it('default to the shipped terminal settings', () => {
    expect(validate({})).toEqual({
      toolPreviewLines: 8,
      contextPreviewLines: 4,
      focusPreviewLines: 12,
      readerMinColumns: 60,
      codeHighlight: true,
      toastMs: 2000,
      liveRefreshMs: 1000,
      streamFadeSteps: 24,
      streamFadeStepMs: 16,
      streamPaceFrames: 8,
      toolRevealFrames: 6,
      reducedMotion: false,
      openBrowser: true,
      btwTools: [...BTW_TOOLS],
      btwSandboxedTools: [...BTW_SANDBOXED_TOOLS],
    })
  })

  it('refuse a reader narrower than two readable panels', () => {
    expect(() => validate({ readerMinColumns: 39 })).toThrow()
    expect(validate({ readerMinColumns: 90 })).toMatchObject({ readerMinColumns: 90 })
  })

  it('refuse a fold that would draw no row of what it folds', () => {
    expect(() => validate({ contextPreviewLines: 0 })).toThrow()
    expect(() => validate({ toolPreviewLines: 0 })).toThrow()
    expect(() => validate({ focusPreviewLines: 0 })).toThrow()
    expect(validate({ contextPreviewLines: 1, toolPreviewLines: 1, focusPreviewLines: 1 })).toMatchObject({
      contextPreviewLines: 1,
      toolPreviewLines: 1,
      focusPreviewLines: 1,
    })
  })

  // The transient line is the clock of the second `Esc` that stops a turn, so
  // a window too short to press twice in would leave a running turn with no
  // way to stop it from the input.
  it('refuse a transient line too short to answer', () => {
    expect(() => validate({ toastMs: 0 })).toThrow()
    expect(() => validate({ toastMs: 499 })).toThrow()
    expect(validate({ toastMs: 500 })).toMatchObject({ toastMs: 500 })
  })

  it('refuse a fade shorter than two levels or faster than one frame', () => {
    expect(() => validate({ streamFadeSteps: 1 })).toThrow()
    expect(() => validate({ streamFadeStepMs: 15 })).toThrow()
    expect(validate({ streamFadeSteps: 2, streamFadeStepMs: 16, reducedMotion: true })).toMatchObject({
      streamFadeSteps: 2,
      streamFadeStepMs: 16,
      reducedMotion: true,
    })
  })

  it('refuse a fractional or negative pace and accept 0, which draws deltas as they arrive', () => {
    expect(() => validate({ streamPaceFrames: -1 })).toThrow()
    expect(() => validate({ streamPaceFrames: 1.5 })).toThrow()
    expect(validate({ streamPaceFrames: 0 })).toMatchObject({ streamPaceFrames: 0 })
    expect(() => validate({ toolRevealFrames: -1 })).toThrow()
    expect(validate({ toolRevealFrames: 0 })).toMatchObject({ toolRevealFrames: 0 })
  })
})
