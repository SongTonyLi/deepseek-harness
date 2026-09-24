/**
 * Test bench: the real registries around a scripted Agent, a captured fake
 * terminal, and helpers that type keys and read the rendered screen.
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, AssistantStreamFrame, CreateAgentOptions, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAttemptId, createAssistantMessage, createToolResultMessage, createUserMessage, type StreamChunk, type ContentBlock, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionEventType, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { Terminal } from '@earendil-works/pi-tui'
import { TuiApp, type BoundSession, type SessionHost } from '../src/app.ts'
import { CONTEXT_PREVIEW_LINES } from '../src/blocks.ts'
import { FADE_STEPS, FADE_TICK_MS } from '../src/fade.ts'
import { FOCUS_PREVIEW_LINES } from '../src/inspector.ts'
import { READER_MIN_COLUMNS } from '../src/reader.ts'
import { createPalette } from '../src/style.ts'
import { TOAST_MS } from '../src/toast.ts'

/**
 * The clock every bench starts at, a fixed instant so an elapsed readout is
 * the same on every run. Specs move it with `advance` or `tick`.
 */
export const BENCH_NOW = Date.UTC(2026, 1, 3, 14, 25, 0)

/** Let the throttled renderer draw everything pending. */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 60))
}

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

/** The OSC 11 background-color query pi-tui writes, `ESC ] 11 ; ? BEL`. */
const OSC11_BACKGROUND_QUERY = '\u001b]11;?\u0007'

/** A terminal that records what the tree writes and lets tests type into it. */
export class FakeTerminal implements Terminal {
  output = ''
  /**
   * Everything the tree ever wrote, which nothing clears. `output` is the
   * window a test reads and resets; an invariant that must hold over a whole
   * scenario reads this instead.
   */
  written = ''
  title = ''
  columns = 100
  rows = 40
  kittyProtocolActive = false
  started = false
  stopped = false
  /**
   * Body this terminal answers an OSC 11 background-color query with, e.g.
   * `rgb:0000/0000/0000`. Undefined answers nothing, which is the terminal
   * that lets the query time out.
   */
  backgroundReply: string | undefined
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
    this.written += data
    // pi-tui registers the pending query before it writes it, so answering
    // from inside the write is what a terminal that replies at once does.
    if (this.backgroundReply !== undefined && data.includes(OSC11_BACKGROUND_QUERY)) {
      this.type(`\u001b]11;${this.backgroundReply}\u0007`)
    }
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

  /**
   * Simulate a terminal resize.
   * @param columns - the new width.
   * @param rows - the new height; the current height when omitted.
   */
  resize(columns: number, rows: number = this.rows): void {
    this.columns = columns
    this.rows = rows
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
  left: '\u001b[D',
  right: '\u001b[C',
  shiftUp: '\u001b[1;2A',
  shiftDown: '\u001b[1;2B',
  shiftLeft: '\u001b[1;2D',
  shiftRight: '\u001b[1;2C',
  tab: '\t',
  shiftTab: '\u001b[Z',
  space: ' ',
  pageUp: '\u001b[5~',
  pageDown: '\u001b[6~',
  home: '\u001b[H',
  end: '\u001b[F',
  ctrlG: '\u0007',
  ctrlU: '\u0015',
  backspace: '\u007f',
  slash: '/',
  digit1: '1',
} as const

/** What the scripted Agent observed. */
export interface AgentCalls {
  followups: UserMessage[]
  steers: UserMessage[]
  injections: UserMessage[]
  cancels: number
  /** The options of the last cancel, e.g. `{ keepInbox: true }`. */
  cancelOptions: unknown
}

/** One Agent the bench created under the bound session, for the subagent surfaces. */
export interface BenchChild {
  agent: Agent
  session: Session
  id: SessionId
  /** Set this child's status and publish the transition, as the bound Agent's `setStatus` does. */
  setStatus(status: 'idle' | 'running'): void
  /**
   * Append one log-only event to the child's own session, which reaches the
   * app as a non-bound `session/event`.
   * @param type - the event type; surface events, which take intent options, are out of scope.
   * @param data - the event payload.
   */
  append(type: SessionEventType, data: unknown): void
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
  /**
   * Create one Agent and Session under the bound session, as a subagent
   * provider would: the durable header carries the parent, `origin`, and the
   * delegation depth the listing reads.
   * @param options - the child's label-free identity: its id and depth.
   * @returns the child and the handles a spec drives it with.
   */
  createChild(options?: { id?: string; depth?: number; parent?: SessionId }): Promise<BenchChild>
  /**
   * Run one period of every tick the app armed at `delayMs`, moving the bench
   * clock forward first. Nothing happens while no tick of that period is
   * armed. The app arms at most one tick per purpose, each at its own
   * configured period, so a period names the tick a spec drives.
   * @param delayMs - the period to run, e.g. the live-refresh or the fade period.
   * @param advanceMs - milliseconds to move the clock by; `delayMs` by default.
   */
  runTick(delayMs: number, advanceMs?: number): void
  /**
   * Run one period of the app's live-refresh interval, moving the bench clock
   * forward first. Nothing happens while the app has the interval disarmed.
   * @param advanceMs - milliseconds to move the clock by; one period by default.
   */
  tick(advanceMs?: number): void
  /**
   * Put the bench clock at one instant without running a period, for an
   * elapsed readout measured against a time the session log recorded.
   * @param ms - the Unix time in milliseconds the app now reads.
   */
  setNow(ms: number): void
  /**
   * Whether the app has a tick of one period armed right now.
   * @param delayMs - the period; the live-refresh period by default.
   * @returns true while that tick is armed.
   */
  tickArmed(delayMs?: number): boolean
  /** The periods the app has armed right now, in the order it armed them. */
  tickDelaysMs(): number[]
  /** Wait for the throttled renderer to draw pending changes. */
  settle(): Promise<void>
  /**
   * The text of one complete repaint. `terminal.text()` accumulates every
   * frame ever written, so it can show that something was drawn but never
   * that it stopped being drawn; this resizes the terminal, which redraws the
   * whole screen, and returns only that frame.
   * @returns the complete current frame.
   */
  screen(): Promise<string>
  /** Emit assistant stream frames for the Agent. */
  stream: {
    start(): void
    chunk(chunk: StreamChunk): void
    end(outcome: Extract<AssistantStreamFrame, { type: 'end' }>['outcome']): void
  }
  /**
   * Append one durable user prompt, as the loop logs a prompt it has claimed
   * from the inbox; a running bench's typed prompts wait in the queue instead.
   */
  appendPrompt(text: string): void
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
  /** Collapsed body rows of a system prompt or an injected context block. */
  contextPreviewLines?: number
  /** Rows of the focused section the docked inspector shows. */
  focusPreviewLines?: number
  /** Columns the reader needs before it draws two sections side by side. */
  readerMinColumns?: number
  /** Whether fenced code draws in syntax colours; on by default, as it ships. */
  codeHighlight?: boolean
  /** How long a transient key-feedback line holds before it fades out. */
  toastMs?: number
  color?: boolean
  /** Start with the Agent already running. */
  running?: boolean
  /** Omit the model selection and the Agent's model options. */
  unselected?: boolean
  /** Make every host operation fail with this message. */
  hostFailure?: string
  /** Hold every host operation until the returned release is called. */
  hostGate?: { release: () => void }
  /** Make releasing a session the host opened fail with this message; read at each release. */
  disposeFailure?: string
  /** Replace the real projection registry: `none` mounts nothing, an object is provided as the service. */
  projections?: 'none' | { snapshot(session: Session, keys: readonly string[]): unknown; onChanged(listener: (session: Session) => void): () => void }
  /**
   * Provide a subagent runtime whose `listDescendants` this callback answers.
   * The app re-reads the listing on every reconcile, so a callback that
   * returns different entries — or rejects — models a tree that changed or a
   * service that failed. Absent leaves the service unmounted.
   */
  subagents?: (sessionId: SessionId) => Promise<readonly SubagentDescendantListEntry[]>
  /** The live-refresh period the app is configured with. */
  liveRefreshMs?: number
  /** Brightness levels the fade is configured with. */
  fadeSteps?: number
  /** The fade period the app is configured with. */
  fadeStepMs?: number
  /** Frames a streamed backlog drains over; `0`, the default, draws each delta as it arrives. */
  streamPaceFrames?: number
  /** Frames a tool card's rows unroll over; `0`, the default, draws every row at once. */
  toolRevealFrames?: number
  /** Ask for streamed text drawn with no ramp. */
  reducedMotion?: boolean
  /** The environment the fade capability is decided from; empty by default, which yields the two-level mode. */
  env?: NodeJS.ProcessEnv
  /**
   * The body the fake terminal answers the app's OSC 11 background-color
   * query with, e.g. `rgb:0000/0000/0000`. The default body does not parse as
   * a color, which is how a terminal that cannot report its background
   * behaves; `false` answers nothing at all, so the query runs to its timeout.
   */
  background?: string | false
  /** History the host attaches to a resumed or forked session. */
  openedHistory?: readonly SessionEvent[]
  /** Authorization-page handoff; omitted to model a remote or headless terminal. */
  openUrl?: (url: string) => Promise<void>
  /**
   * Record each saved default-model selection instead of mounting the real
   * default-model plugin, whose own write goes through a Loader entry no
   * hand-built Context has.
   */
  saveDefaultModel?: (selection: { provider: string; model: string }) => Promise<void>
  before?(ctx: Context): Promise<void> | void
} = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (options.projections === undefined) await ctx.plugin(SessionProjectionRegistry)
  else if (options.projections !== 'none') ctx.provide('sessionProjections', options.projections as never)
  await ctx.plugin(AgentRegistry)
  if (options.saveDefaultModel === undefined) {
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  } else {
    const saveSelection = options.saveDefaultModel
    ctx.provide('agentDefaultModel', {
      selection: { provider: 'test-provider', model: 'test-model' },
      saveSelection,
    } as never)
  }
  if (options.subagents !== undefined) {
    const listDescendants = options.subagents
    ctx.provide('subagents', { listDescendants: (sessionId: SessionId) => listDescendants(sessionId) } as never)
  }
  await options.before?.(ctx)
  const calls: AgentCalls = { followups: [], steers: [], injections: [], cancels: 0, cancelOptions: undefined }
  // Every Agent the host binds shares the status `setStatus` moves, so a spec
  // that switches sessions keeps driving one scripted Agent; a child created
  // with `createChild` carries its own.
  let hostStatus: 'idle' | 'running' = options.running === true ? 'running' : 'idle'
  const childStatuses = new Map<SessionId, 'idle' | 'running'>()
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
        get status() { return childStatuses.get(session.id) ?? hostStatus },
        ctx: ownerCtx,
        cancel: (_reason, options) => { calls.cancels += 1; calls.cancelOptions = options },
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (message) => { calls.followups.push(message) },
        steer: (message) => { calls.steers.push(message) },
        inject: (message) => { calls.injections.push(message) },
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
  if (options.background !== false) terminal.backgroundReply = options.background ?? 'not-a-color'
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
        dispose: () => {
          entry.disposed += 1
          return options.disposeFailure === undefined ? Promise.resolve() : Promise.reject(new Error(options.disposeFailure))
        },
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
    observe: async (id) => {
      const resident = ctx.agents.get(id)
      if (resident === undefined) return open(`observe:${id}`, id)
      hostCalls.push(`observe-resident:${id}`)
      if (options.hostFailure !== undefined) throw new Error(options.hostFailure)
      return {
        agent: resident,
        selection: { current: undefined, assembled: undefined },
        history: resident.session.ownEvents(),
        dispose: () => Promise.resolve(),
      }
    },
  }
  let disposed = 0
  const initial: BoundSession = {
    agent,
    selection,
    history: options.history ?? [],
    dispose: () => { disposed += 1; return Promise.resolve() },
  }
  opened.push({ bound: initial, get disposed() { return disposed } })
  const liveRefreshMs = options.liveRefreshMs ?? 1000
  const fadeStepMs = options.fadeStepMs ?? FADE_TICK_MS
  let now = BENCH_NOW
  // The bench holds every armed tick instead of a real timer, so a spec
  // decides exactly when a period runs and for which tick.
  const armed: { callback: () => void; delayMs: number }[] = []
  const runTick = (delayMs: number, advanceMs: number = delayMs): void => {
    now += advanceMs
    // A callback can disarm itself or another tick, so the run walks a copy.
    for (const entry of [...armed]) {
      if (entry.delayMs === delayMs) entry.callback()
    }
  }
  const app = new TuiApp({
    ctx,
    host,
    initial,
    terminal,
    palette: createPalette(options.color ?? false),
    toolPreviewLines: options.toolPreviewLines ?? 3,
    contextPreviewLines: options.contextPreviewLines ?? CONTEXT_PREVIEW_LINES,
    focusPreviewLines: options.focusPreviewLines ?? FOCUS_PREVIEW_LINES,
    readerMinColumns: options.readerMinColumns ?? READER_MIN_COLUMNS,
    codeHighlight: options.codeHighlight ?? true,
    toastMs: options.toastMs ?? TOAST_MS,
    liveRefreshMs,
    fadeSteps: options.fadeSteps ?? FADE_STEPS,
    fadeStepMs,
    streamPaceFrames: options.streamPaceFrames ?? 0,
    toolRevealFrames: options.toolRevealFrames ?? 0,
    reducedMotion: options.reducedMotion ?? false,
    env: options.env ?? {},
    now: () => now,
    tick: (callback, delayMs) => {
      const entry = { callback, delayMs }
      armed.push(entry)
      return () => {
        const at = armed.indexOf(entry)
        if (at !== -1) armed.splice(at, 1)
      }
    },
    cwd: '/work',
    ...options.openUrl === undefined ? {} : { openUrl: options.openUrl },
    releaseInput: () => {},
    onQuit: (bound) => { quits.push(bound) },
  })
  app.start(options.initialPrompt)
  const session = agent.session
  const attemptId = LlmAttemptId(`${agent.id}:test`)
  let revision = 0
  let index = 0
  let turn = 0
  let childCount = 0
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
      hostStatus = next
      agent.ctx.emit('agent/status', { agent, status: next })
    },
    async createChild(childOptions = {}) {
      const id = (childOptions.id ?? `session-child-${String(++childCount)}`) as SessionId
      childStatuses.set(id, 'idle')
      const handle = await ctx.agents.create({
        sessionId: id,
        meta: {
          cwd: '/work',
          parentSession: childOptions.parent ?? agent.session.id,
          origin: 'subagent',
          delegationDepth: childOptions.depth ?? 1,
        },
      })
      const child = handle.agent
      return {
        agent: child,
        session: child.session,
        id,
        setStatus(next) {
          childStatuses.set(id, next)
          child.ctx.emit('agent/status', { agent: child, status: next })
        },
        append(type, data) {
          // `append` takes surface intent options for surface event types;
          // this helper carries the log-only lifecycle events instead.
          const log = child.session as unknown as { append(type: string, data: unknown): void }
          log.append(type, data)
        },
      }
    },
    runTick,
    tick(advanceMs = liveRefreshMs) {
      runTick(liveRefreshMs, advanceMs)
    },
    setNow(ms) {
      now = ms
    },
    tickArmed: (delayMs = liveRefreshMs) => armed.some(entry => entry.delayMs === delayMs),
    tickDelaysMs: () => armed.map(entry => entry.delayMs),
    settle: () => settle(),
    async screen() {
      terminal.output = ''
      // A width change redraws every line; a plain render only rewrites the
      // lines that changed, which would keep a removed panel out of sight.
      terminal.resize(terminal.columns === 100 ? 96 : 100)
      await settle()
      return terminal.text()
    },
    stream: {
      start: () => { emit({ type: 'start', attemptId, revision: ++revision, turn: 1, step: 1 }) },
      chunk: (chunk) => { emit({ type: 'chunk', attemptId, revision: ++revision, index: index++, time: Date.now(), chunk }) },
      end: (outcome) => { emit({ type: 'end', attemptId, revision: ++revision, index: index++, outcome }) },
    },
    appendPrompt(text) {
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
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
