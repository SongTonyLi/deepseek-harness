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
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Terminal } from '@earendil-works/pi-tui'
import { TuiApp, type BoundSession, type SessionHost } from '../src/app.ts'
import { createPalette } from '../src/style.ts'

/**
 * Provide the export services over one stored session: a read handle with a
 * bare header and one event, a lineage without descendants, and an empty
 * attachment store.
 * @param ctx - the context to provide into.
 * @param id - the stored session.
 * @param missing - make the persistence handle report the session as absent.
 */
export function exportStubs(ctx: Context, id: SessionId, missing = false): void {
  ctx.provide('sessionPersistence', {
    open: () => missing ? Promise.reject(new SessionPersistenceNotFoundError(id)) : Promise.resolve({
      header: { version: 2, id, createdAt: 1, cwd: '/work', isSeeded: false },
      read: () => Promise.resolve({ eventState: 'complete', events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }] }),
      close: () => Promise.resolve(),
    }),
  } as never)
  ctx.provide('sessionQuery', {
    traceSession: () => Promise.resolve({ target: { header: { id } }, ancestors: [], descendants: [] }),
  } as never)
  ctx.provide('attachments', {} as never)
}

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
  ctrlS: '\u0013',
  up: '\u001b[A',
  down: '\u001b[B',
  shiftTab: '\u001b[Z',
  space: ' ',
} as const

/** What the scripted Agent observed. */
export interface AgentCalls {
  followups: UserMessage[]
  steers: UserMessage[]
  cancels: number
  /** The options of the last cancel, e.g. `{ keepInbox: true }`. */
  cancelOptions: unknown
}

export interface Bench {
  ctx: Context
  agent: Agent
  session: Session
  calls: AgentCalls
  terminal: FakeTerminal
  selection: ModelSelectionRef
  app: TuiApp
  /** The sessions handed to `onQuit`. */
  quits: BoundSession[]
  /** What the scripted host was asked for, e.g. `create`, `resume:session-x`, `fork:session-x`. */
  hostCalls: string[]
  /** Sessions the host bound after the initial one, with their disposal counts. */
  opened: { bound: BoundSession; disposed: number }[]
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
  /** Make every host operation fail with this message. */
  hostFailure?: string
  /** Hold every host operation until the returned release is called. */
  hostGate?: { release: () => void }
  /** Replace the real projection registry: `none` mounts nothing, an object is provided as the service. */
  projections?: 'none' | { snapshot(session: Session, keys: readonly string[]): unknown; onChanged(listener: (session: Session) => void): () => void }
  /** History the host attaches to a resumed or forked session. */
  openedHistory?: readonly SessionEvent[]
  before?(ctx: Context): Promise<void> | void
} = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (options.projections === undefined) await ctx.plugin(SessionProjectionRegistry)
  else if (options.projections !== 'none') ctx.provide('sessionProjections', options.projections as never)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  await options.before?.(ctx)
  const calls: AgentCalls = { followups: [], steers: [], cancels: 0, cancelOptions: undefined }
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
        cancel: (_reason, options) => { calls.cancels += 1; calls.cancelOptions = options },
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
  const quits: BoundSession[] = []
  const hostCalls: string[] = []
  const opened: { bound: BoundSession; disposed: number }[] = []
  let openedCount = 0
  const open = async (call: string, id: SessionId): Promise<BoundSession> => {
    hostCalls.push(call)
    if (options.hostFailure !== undefined) throw new Error(options.hostFailure)
    if (options.hostGate !== undefined) await new Promise<void>((resolve) => { options.hostGate!.release = resolve })
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: '/work' } })
    const entry = {
      bound: {
        agent: handle.agent,
        selection: { current: { provider: 'test-provider', model: 'opened-model' }, assembled: undefined },
        history: options.openedHistory ?? [],
        dispose: () => { entry.disposed += 1; return Promise.resolve() },
      },
      disposed: 0,
    }
    opened.push(entry)
    return entry.bound
  }
  const host: SessionHost = {
    create: () => open('create', `session-opened-${String(++openedCount)}` as SessionId),
    resume: id => open(`resume:${id}`, id),
    fork: (id, turn) => open(`fork:${id}${turn === undefined ? '' : `@${String(turn)}`}`, `session-fork-of-${id}` as SessionId),
  }
  let disposed = 0
  const initial: BoundSession = {
    agent,
    selection,
    history: options.history ?? [],
    dispose: () => { disposed += 1; return Promise.resolve() },
  }
  opened.push({ bound: initial, get disposed() { return disposed } })
  const app = new TuiApp({
    ctx,
    host,
    initial,
    terminal,
    palette: createPalette(options.color ?? false),
    toolPreviewLines: options.toolPreviewLines ?? 3,
    cwd: '/work',
    releaseInput: () => {},
    onQuit: (bound) => { quits.push(bound) },
  })
  app.start(options.initialPrompt)
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
    hostCalls,
    opened,
    setStatus(next) {
      status = next
      agent.ctx.emit('agent/status', { agent, status: next })
    },
    settle: () => new Promise(resolve => setTimeout(resolve, 60)),
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
