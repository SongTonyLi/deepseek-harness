/**
 * Test bench: the real registries around a scripted Agent, a captured fake
 * terminal, and helpers that type keys and read the rendered screen.
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, AssistantStreamFrame, CreateAgentOptions, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAttemptId, createAssistantMessage, createToolResultMessage, type StreamChunk, type ContentBlock, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Terminal } from '@earendil-works/pi-tui'
import { TuiApp } from '../src/app.ts'
import { createPalette } from '../src/style.ts'

/** A terminal that records what the tree writes and lets tests type into it. */
export class FakeTerminal implements Terminal {
  output = ''
  title = ''
  columns = 100
  rows = 40
  kittyProtocolActive = false
  started = false
  stopped = false
  private onInput: ((data: string) => void) | undefined
  private onResize: (() => void) | undefined

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.started = true
    this.onInput = onInput
    this.onResize = onResize
  }

  stop(): void {
    this.stopped = true
  }

  drainInput(): Promise<void> {
    return Promise.resolve()
  }

  write(data: string): void {
    this.output += data
  }

  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setProgress(): void {}

  setTitle(title: string): void {
    this.title = title
  }

  /** Feed one key or a string of printable characters as the terminal would. */
  type(data: string): void {
    if (this.onInput === undefined) throw new Error('the terminal has not been started')
    this.onInput(data)
  }

  /** Simulate a terminal resize. */
  resize(columns: number): void {
    this.columns = columns
    this.onResize?.()
  }

  /** Everything written so far, without CSI, OSC, or APC sequences. */
  text(): string {
    return this.output
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
      .replace(/\u001b_[^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
  }
}

/** Keys as the raw bytes a terminal sends. */
export const KEY = {
  enter: '\r',
  escape: '\u001b',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  ctrlO: '\u000f',
  up: '\u001b[A',
  down: '\u001b[B',
  space: ' ',
} as const

/** What the scripted Agent observed. */
export interface AgentCalls {
  followups: UserMessage[]
  steers: UserMessage[]
  cancels: number
}

export interface Bench {
  ctx: Context
  agent: Agent
  session: Session
  calls: AgentCalls
  terminal: FakeTerminal
  selection: ModelSelectionRef
  app: TuiApp
  quits: number[]
  /** Set the scripted Agent's status and publish the transition. */
  setStatus(status: 'idle' | 'running'): void
  /** Wait for the throttled renderer to draw pending changes. */
  settle(): Promise<void>
  /** Emit assistant stream frames for the Agent. */
  stream: {
    start(): void
    chunk(chunk: StreamChunk): void
    end(outcome: Extract<AssistantStreamFrame, { type: 'end' }>['outcome']): void
  }
  /** Append a durable turn around `content` from the model. */
  appendAssistant(content: ContentBlock[], options?: { usage?: { inputTokens: number; outputTokens: number }; interrupted?: true }): void
  appendToolCall(callId: string, name: string, args: unknown): void
  appendToolResult(callId: string, content: ContentBlock[], isError?: boolean, meta?: unknown): void
}

/**
 * Mount the registries, create one scripted Agent, and start the app on a
 * fake terminal.
 * @param options - bench options.
 * @returns the running bench.
 */
export async function bench(options: {
  history?: readonly SessionEvent[]
  initialPrompt?: string
  toolPreviewLines?: number
  color?: boolean
  /** Start with the Agent already running. */
  running?: boolean
  /** Omit the model selection and the Agent's model options. */
  unselected?: boolean
  before?(ctx: Context): Promise<void> | void
} = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  await options.before?.(ctx)
  const calls: AgentCalls = { followups: [], steers: [], cancels: 0 }
  let status: 'idle' | 'running' = options.running === true ? 'running' : 'idle'
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, createOptions: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(createOptions.sessionId, {
        ...createOptions.meta === undefined ? {} : { meta: createOptions.meta },
      })
      const agent: Agent = {
        id: session.id,
        options: createOptions.agentOptions ?? {},
        session,
        inbox: createInboxStub(),
        get status() { return status },
        ctx: ownerCtx,
        cancel: () => { calls.cancels += 1 },
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (message) => { calls.followups.push(message) },
        steer: (message) => { calls.steers.push(message) },
        inject: () => {},
        whenIdle: () => Promise.resolve(),
      }
      await createOptions.setup?.(ownerCtx, agent)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('not used')),
  })
  const selection: ModelSelectionRef = {
    current: options.unselected === true ? undefined : { provider: 'test-provider', model: 'test-model' },
    assembled: undefined,
  }
  const { agent } = await ctx.agents.create({
    sessionId: 'session-tui-test' as Agent['id'],
    meta: { cwd: '/work' },
    ...options.unselected === true ? {} : { agentOptions: { provider: 'test-provider', model: 'test-model' } },
  })
  const terminal = new FakeTerminal()
  const quits: number[] = []
  const app = new TuiApp({
    ctx,
    agent,
    selection,
    terminal,
    palette: createPalette(options.color ?? false),
    toolPreviewLines: options.toolPreviewLines ?? 3,
    cwd: '/work',
    releaseInput: () => {},
    onQuit: () => { quits.push(0) },
  })
  app.start(options.history ?? [], options.initialPrompt)
  const session = agent.session
  const attemptId = LlmAttemptId(`${agent.id}:test`)
  let revision = 0
  let index = 0
  let turn = 0
  const emit = (frame: AssistantStreamFrame): void => { agent.ctx.emit('agent/assistant-stream', { agent, frame }) }
  return {
    ctx,
    agent,
    session,
    calls,
    terminal,
    selection,
    app,
    quits,
    setStatus(next) {
      status = next
      agent.ctx.emit('agent/status', { agent, status: next })
    },
    settle: () => new Promise(resolve => setTimeout(resolve, 40)),
    stream: {
      start: () => { emit({ type: 'start', attemptId, revision: ++revision, turn: 1, step: 1 }) },
      chunk: (chunk) => { emit({ type: 'chunk', attemptId, revision: ++revision, index: index++, time: Date.now(), chunk }) },
      end: (outcome) => { emit({ type: 'end', attemptId, revision: ++revision, index: index++, outcome }) },
    },
    appendAssistant(content, extra = {}) {
      turn += 1
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      session.append('assistant/message', {
        stream: [],
        turn,
        step: 1,
        message: createAssistantMessage({ content, source: { provider: 'test-provider', model: 'test-model' } }),
        ...extra.usage === undefined ? {} : { usage: extra.usage },
        ...extra.interrupted === undefined ? {} : { interrupted: extra.interrupted },
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    },
    appendToolCall(callId, name, args) {
      session.append('tool/call', { turn: 1, step: 1, callId: callId as ToolCallId, name, arguments: JSON.stringify(args) })
    },
    appendToolResult(callId, content, isError = false, meta) {
      session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: callId as ToolCallId, content, isError }),
        ...meta === undefined ? {} : { meta: meta as never },
      }, { surfaceOp: 'append' })
    },
  }
}
