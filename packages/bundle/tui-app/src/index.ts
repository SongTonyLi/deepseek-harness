/**
 * @deepseek-ai/dsh-tui-app — the interactive terminal runner. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates, resumes, and forks Agents through the core registry as the
 * terminal application's session host, and on quit flushes the bound Session
 * and requests exit.
 *
 * @module @deepseek-ai/dsh-tui-app
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { ProcessTerminal, type Terminal } from '@earendil-works/pi-tui'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentSetup, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { resumeModelSelection } from './resume-model.ts'
import { BTW_SANDBOXED_TOOLS, BTW_TOOLS, btwSeed, restrictBtwAgent } from './btw.ts'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { launchedThroughSsh, launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { canOpenNativePath, openNativeUrl } from '@deepseek-ai/dsh-native-command'
import { SessionLogOffset, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { TuiApp, type BoundSession, type SessionHost } from './app.ts'
import { CONTEXT_PREVIEW_LINES } from './blocks.ts'
import { FADE_STEPS, FADE_TICK_MS } from './fade.ts'
import { STREAM_PACE_FRAMES, TOOL_REVEAL_FRAMES } from './pace.ts'
import { FOCUS_PREVIEW_LINES } from './inspector.ts'
import { READER_MIN_COLUMNS } from './reader.ts'
import { colorEnabled, createPalette } from './style.ts'
import { TOAST_MS } from './toast.ts'
import { describeFailure } from './transcript.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-app'

/** Core services required before the terminal can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the invocation resolved from this app's injected provider service, plus presentation tunables. */
export interface Config {
  /** A first prompt submitted as soon as the terminal is up. */
  prompt?: string
  /** A persisted session id to resume instead of starting a new session. */
  resume?: string
  /** Collapsed tool-card body rows before `Space` on the focused card, or `Ctrl+O`, expands them. */
  toolPreviewLines: number
  /**
   * Rows a system prompt or an injected context block draws in the transcript
   * before `Space` on the focused block, or `Ctrl+O`, expands it. One
   * injection can carry more rows than the conversation around it, so the
   * transcript shows this many and names the key that draws the rest. The
   * model-facing text is never cut from what the keyboard reads: the docked
   * inspector folds the focused section at `focusPreviewLines` and the walk
   * itself addresses every row. A taller budget reads more of each injection
   * at once and leaves less of the conversation on screen.
   */
  contextPreviewLines: number
  /**
   * Rows of the focused transcript section the docked inspector shows before
   * its fold marker names what is left. `Shift+Up` puts the keyboard on the
   * newest block and the inspector draws the section it holds, folded at this
   * budget whatever kind of section it is - a system prompt and an injected
   * context block included, so one injection cannot fill the screen above the
   * editor. The model-facing text itself is never cut: the rest of the
   * section is one key away. A taller budget reads more of a long reply or
   * tool result at once and leaves less of the conversation on screen.
   */
  focusPreviewLines: number
  /**
   * Columns the full-screen reader needs before it draws the held turn beside
   * the turn list. `Ctrl+G` reads the conversation full screen in two panels:
   * every turn listed on the left, the turn the list holds scrolling on the
   * right. Below this width one panel is drawn at a time — the list, or the
   * turn `Right` opens from it — so a narrow terminal keeps readable text
   * instead of two cramped columns. A lower value splits a narrower terminal.
   */
  readerMinColumns: number
  /**
   * Draw fenced code, `read` and diff file rows, and shell commands — a `!` /
   * `!!` draft, a `$ command` user-shell row, and a terminal tool card — in
   * syntax colours, from a theme picked by the terminal's own background. The
   * grammars load on the first block that asks for one, so a session with no
   * code in it loads none; a language with no grammar here, and a terminal that
   * reports neither 24-bit nor 256 colours, draw the block plain. Turn it off
   * to read every block in one colour.
   */
  codeHighlight: boolean
  /**
   * How long a transient key-feedback line - `press Esc again to stop turn
   * <n>`, `press Ctrl+C again to quit` - holds at full strength before it
   * fades out, in milliseconds. It is also the window in which a second `Esc`
   * stops the running turn: the arm lasts exactly as long as any part of the
   * line is on screen, so there is no invisible window in which the key means
   * something else. The line floats over the conversation and is never
   * written into it; facts worth keeping stay transcript notices.
   */
  toastMs: number
  /**
   * Period in milliseconds of the terminal's one repeating redraw: it
   * advances the running-turn counter in the status bar and the per-child
   * counters in the subagent panel, and re-reads the subagent listing a live
   * signal marked stale. The terminal arms the interval only while a turn is
   * running, a listed child is timing an open turn, or the listing is stale,
   * and disarms it as soon as none of those hold, so an idle session runs no
   * timer. A shorter period redraws more often; a longer one lets a counter
   * lag behind by up to one period.
   */
  liveRefreshMs: number
  /**
   * How long one streamed fade lasts, in `streamFadeStepMs` ticks: reply text
   * fades in from near the terminal background toward the terminal foreground,
   * while reasoning and tool cards appear at a lifted color and recede to the
   * colors they settle in, over `streamFadeSteps * streamFadeStepMs`. Each
   * reply word carries the moment it appeared, so a fast stream leaves a
   * longer trail of brightening words and never a darker one. Two is the
   * shortest step count that still shows a ramp; more steps spread the same
   * duration over a softer trailing edge. Text that has settled is never
   * dimmed again.
   */
  streamFadeSteps: number
  /**
   * How long one frame lasts, in milliseconds: the fade tick, the repaint
   * period while anything is still moving, and the period at which paced
   * stream text is drawn. The default of 16 draws about 60 frames per
   * second. Duration of each fade is `streamFadeSteps * streamFadeStepMs`,
   * and the app's own chrome motions - the keyboard landing on a region and
   * a step of a walk - run for their own step counts at this same tick. The
   * terminal arms this repaint only while something still differs from its
   * settled drawing and disarms it as soon as the last one settles, so an
   * idle session runs no timer. A shorter period draws a smoother fade at the
   * cost of more redraws.
   */
  streamFadeStepMs: number
  /**
   * How many `streamFadeStepMs` frames a backlog of streamed reply text or
   * tool arguments takes to reach the screen. Thinking stays on that queue
   * only while its block is open; a finished thinking block, or the first
   * reply or tool-call delta after it, is drawn at once. The live stream is
   * queued as it arrives and never waits on a redraw; each frame draws a
   * share of the queue proportional to its length, so a network burst
   * spreads over several frames instead of landing at once, and drawn text
   * trails the stream by at most about this many frames. `0` draws every
   * delta as it arrives, and so does `reducedMotion`.
   */
  streamPaceFrames: number
  /**
   * How many `streamFadeStepMs` frames the rows of a tool card take to
   * unroll when the card appears or grows. Each frame draws a share of the
   * rows still hidden proportional to their number, at least one, so a card
   * slides in under the text that preceded it rather than landing whole. A
   * card whose unrolling rows have scrolled above the part of the screen the
   * renderer can repaint draws them at once, and unfolding a card draws its
   * rows at once. `0` draws every row at once, and so does `reducedMotion`.
   */
  toolRevealFrames: number
  /**
   * Draw streamed assistant text, streamed reasoning, tool cards, and the
   * app's own chrome at the colors they settle in, for users who do not want
   * what is on screen to change after it is drawn: no brightness ramp on
   * arriving text, no lift where the keyboard lands or steps, and no repeating
   * repaint for any of them. A transient key-feedback line still holds for
   * `toastMs` and then disappears, because the window it names has to end.
   */
  reducedMotion: boolean
  /** Permit local default-browser handoff for authorization pages. */
  openBrowser: boolean
  /**
   * Global tools a `/btw` side agent may call. Every other global tool is
   * hidden from it and refused if called. Name only tools that read: the side
   * agent shares the workspace with the working agent it was opened beside.
   * Names this composition does not register are skipped.
   */
  btwTools: string[]
  /**
   * Command tools a `/btw` side agent may call only when the composed command
   * executor confines commands to a sandbox. The side agent's session runs in
   * the `read-only` sandbox mode with the `never` approval policy, so writes
   * are refused and cannot be approved. Without a confining executor these
   * tools stay hidden.
   */
  btwSandboxedTools: string[]
}

export const Config: z<Config> = z.object({
  prompt: z.string(),
  resume: z.string(),
  toolPreviewLines: z.natural().min(1).default(8),
  contextPreviewLines: z.natural().min(1).default(CONTEXT_PREVIEW_LINES),
  focusPreviewLines: z.natural().min(1).default(FOCUS_PREVIEW_LINES),
  readerMinColumns: z.natural().min(40).default(READER_MIN_COLUMNS),
  codeHighlight: z.boolean().default(true),
  toastMs: z.natural().min(500).default(TOAST_MS),
  liveRefreshMs: z.natural().min(100).default(1000),
  streamFadeSteps: z.natural().min(2).default(FADE_STEPS),
  streamFadeStepMs: z.natural().min(16).default(FADE_TICK_MS),
  streamPaceFrames: z.natural().default(STREAM_PACE_FRAMES),
  toolRevealFrames: z.natural().default(TOOL_REVEAL_FRAMES),
  reducedMotion: z.boolean().default(false),
  openBrowser: z.boolean().default(true),
  btwTools: z.array(z.string()).default([...BTW_TOOLS]),
  btwSandboxedTools: z.array(z.string()).default([...BTW_SANDBOXED_TOOLS]),
})

/** Process-facing effects of one run: the terminal, the error stream, and the launcher's bounded exit request. */
interface TuiHost {
  /** Create the terminal the tree renders into. */
  createTerminal(): Terminal
  /** Drop the process's reference to terminal input once the terminal has stopped. */
  releaseInput(): void
  stderr: { write(chunk: string): unknown }
  /** Whether SGR styling is emitted. */
  color: boolean
  /** Whether this Host can hand a URL to a local desktop. */
  canOpenUrl(): boolean
  /** Hand an authorization page to the local default browser. */
  openUrl(url: string): Promise<void>
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process-bound pieces of the host; tests substitute a fake terminal and captured streams. */
export const internals: Pick<TuiHost, 'createTerminal' | 'releaseInput' | 'stderr' | 'color' | 'canOpenUrl' | 'openUrl'> = {
  /* v8 ignore next -- the process terminal owns raw stdin; tests substitute a fake */
  createTerminal: () => new ProcessTerminal(),
  /* v8 ignore next -- process stdin is the host's; tests substitute a recorder */
  releaseInput: () => { process.stdin.unref() },
  stderr: process.stderr,
  color: colorEnabled(process.env, process.stdout.isTTY),
  canOpenUrl: () => canOpenNativePath(),
  openUrl: openNativeUrl,
}

/**
 * Events the terminal binds after the Agent has taken the write handle.
 * The live Session already includes interrupted-turn closers resume appended.
 * @param ctx - plugin context carrying the session query engine.
 * @param id - the session the Agent just resumed.
 * @returns the persisted events in log order, closers included.
 * @throws when no query engine is composed.
 */
async function observeBoundHistory(ctx: Context, id: SessionId): Promise<readonly SessionEvent[]> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) throw new Error('tui-app: resuming a session needs a composed session query engine')
  using observation = await query.observeSession(id, { projectionMode: 'none' })
  return observation.events
}

/** The injected core services, read together after settlement. */
interface CoreServices {
  agents: NonNullable<Context['agents']>
  defaultModel: NonNullable<Context['agentDefaultModel']>
  sessions: NonNullable<Context['sessions']>
}

/**
 * Read the three injected services from the global store.
 * @param ctx - plugin context.
 * @returns the services, or undefined when the tree already lost one of them.
 */
function coreServices(ctx: Context): CoreServices | undefined {
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return undefined
  return { agents, defaultModel, sessions }
}

/**
 * The fork prefix of a session: its events through a completed turn, up to
 * the next turn's start, the same cut the browser's fork command takes.
 * @param ctx - plugin context carrying the session query engine.
 * @param id - the session to fork.
 * @param turn - the completed turn to cut after; the last one when omitted.
 * @returns the seed events.
 * @throws when no query engine is composed or the session has no such completed turn.
 */
async function forkSeed(ctx: Context, id: SessionId, turn: number | undefined): Promise<SessionEvent[]> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) throw new Error('forking a session needs a composed session query engine')
  using source = await query.observeSession(id)
  const boundary = source.events.findLast(event => event.type === 'turn/end' && (turn === undefined || event.data.turn === turn))
  if (boundary === undefined) {
    throw new Error(turn === undefined
      ? `session ${id} has no completed turn to fork from`
      : `session ${id} has no completed turn ${String(turn)} to fork from`)
  }
  let cut = boundary.seq + 1
  while (cut < source.events.length && source.events[cut]?.type !== 'turn/start') cut += 1
  return source.events.slice(0, cut)
}

/**
 * The terminal's session host over the core Agent registry. Every Agent gets
 * the model selection installed so `/model` applies from the next request.
 * Resume passes the launch default as AgentOptions so assemble has a
 * `{{model}}` value, then overlays the log's last request header onto the
 * selection when one exists, else keeps that default.
 * @param ctx - plugin context.
 * @param core - the injected services.
 * @param cwd - the workspace root recorded on new sessions.
 * @param btw - the tools a `/btw` side agent may call.
 * @returns the host.
 */
function sessionHost(ctx: Context, core: CoreServices, cwd: string, btw: Pick<Config, 'btwTools' | 'btwSandboxedTools'>): SessionHost {
  const { agents, defaultModel } = core
  const bind = async (
    open: (selection: ModelSelectionRef, setup: AgentSetup) => ReturnType<typeof agents.create>,
    history: readonly SessionEvent[],
  ): Promise<BoundSession> => {
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    const handle = await open(selection, (agentCtx) => { installModelSelection(agentCtx, selection) })
    await handle.agent.whenIdle()
    return { agent: handle.agent, selection, history, dispose: () => handle.dispose() }
  }
  const create = (seed: SessionEvent[] | undefined, parent: SessionId | undefined): Promise<BoundSession> => bind((selection, setup) => {
    const model = defaultModel.currentSelection()
    selection.current = model
    return agents.create({
      sessionId: brandString<SessionId>(`session-${randomUUID()}`),
      ...seed === undefined ? {} : { seed, inheritedEventCount: SessionLogOffset(seed.length) },
      meta: { cwd, ...parent === undefined ? {} : { parentSession: parent, isSeeded: true } },
      agentOptions: { provider: model.provider, model: model.model },
      setup,
    })
  }, seed ?? [])
  const resume = async (id: SessionId): Promise<BoundSession> => {
    const fallback = defaultModel.currentSelection()
    const selection: ModelSelectionRef = { current: fallback, assembled: undefined }
    const handle = await agents.resume({
      resumeSessionId: id,
      agentOptions: { provider: fallback.provider, model: fallback.model },
      setup: (agentCtx, agent) => {
        selection.current = resumeModelSelection(agent.session.requestHeader(), fallback)
        installModelSelection(agentCtx, selection)
      },
    })
    await handle.agent.whenIdle()
    return {
      agent: handle.agent,
      selection,
      history: await observeBoundHistory(ctx, id),
      dispose: () => handle.dispose(),
    }
  }
  return {
    create: () => create(undefined, undefined),
    resume,
    fork: async (id, turn) => create(await forkSeed(ctx, id, turn), id),
    aside: async (parent) => {
      const session = parent.agent.session
      const query = ctx.get('sessionQuery')
      if (query === undefined) throw new Error('btw needs a composed session query engine')
      let events: readonly SessionEvent[]
      {
        using observed = await query.observeSession(session.id, { projectionMode: 'none' })
        events = observed.events
      }
      const { seed, inheritedEventCount } = btwSeed(events)
      const model = resumeModelSelection(session.requestHeader(), parent.selection.current ?? defaultModel.currentSelection())
      return bind((selection, installSelection) => {
        selection.current = model
        // No parent Agent and no subagent catalog entry: the working Agent
        // neither owns nor lists the side agent, and the side agent is not
        // its continuable child, so it cannot message it.
        /* v8 ignore next -- TUI sessions record cwd on create; process cwd is the fallback when a header omitted it */
        const workdir = session.header.cwd ?? cwd
        return agents.create({
          sessionId: brandString<SessionId>(`session-${randomUUID()}`),
          ...seed.length === 0 ? {} : { seed, inheritedEventCount },
          meta: { cwd: workdir, parentSession: session.id, isSeeded: true, origin: 'subagent' },
          agentOptions: {
            provider: model.provider,
            model: model.model,
            ...model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort },
          },
          setup: async (agentCtx, agent) => {
            await installSelection(agentCtx, agent)
            restrictBtwAgent(agentCtx, agent, btw)
          },
        })
      }, [])
    },
    observe: async (id) => {
      const resident = agents.get(id)
      if (resident === undefined) return resume(id)
      // A resident subagent is owned by the run that started it; the view
      // reads it live and releases nothing.
      return {
        agent: resident,
        selection: { current: undefined, assembled: undefined },
        history: await observeBoundHistory(ctx, id),
        dispose: () => Promise.resolve(),
      }
    },
  }
}

/** Report an unexpected runner failure and request a failing exit. */
function fail(host: TuiHost, error: unknown): void {
  host.stderr.write(`dsh: ${describeFailure(error)}\n`)
  host.exit(1)
}

/**
 * Create or resume the first Agent, start the terminal application over the
 * session host, and request process exit when the user quits.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher services.
 * @param config - the validated invocation and tunables.
 * @param host - process-facing effects.
 */
async function run(ctx: Context, config: Config, host: TuiHost): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const core = coreServices(ctx)
  // Early process shutdown can dispose the tree while settlement is pending.
  if (core === undefined) return
  const cwd = process.cwd()
  const sessions = sessionHost(ctx, core, cwd, config)
  const initial = config.resume === undefined
    ? await sessions.create()
    : await sessions.resume(brandString<SessionId>(config.resume))
  const openUrl = config.openBrowser
    && host.canOpenUrl()
    && !launchedThroughSsh(launchEnvironmentOf(ctx))
    ? (url: string): Promise<void> => host.openUrl(url)
    : undefined

  const app = new TuiApp({
    ctx,
    host: sessions,
    initial,
    terminal: host.createTerminal(),
    palette: createPalette(host.color),
    toolPreviewLines: config.toolPreviewLines,
    contextPreviewLines: config.contextPreviewLines,
    focusPreviewLines: config.focusPreviewLines,
    readerMinColumns: config.readerMinColumns,
    codeHighlight: config.codeHighlight,
    toastMs: config.toastMs,
    liveRefreshMs: config.liveRefreshMs,
    fadeSteps: config.streamFadeSteps,
    fadeStepMs: config.streamFadeStepMs,
    streamPaceFrames: config.streamPaceFrames,
    toolRevealFrames: config.toolRevealFrames,
    reducedMotion: config.reducedMotion,
    env: process.env,
    now: () => Date.now(),
    tick: (callback, delayMs) => {
      const dispose = ctx.effect(() => {
        const timer = setInterval(callback, delayMs)
        // A redraw timer must not hold the process open once the user quits.
        timer.unref()
        return () => { clearInterval(timer) }
      }, 'tui-app: repeating redraw')
      return () => void dispose()
    },
    cwd,
    ...openUrl === undefined ? {} : { openUrl },
    releaseInput: () => { host.releaseInput() },
    onQuit: (bound) => {
      void (async () => {
        const { agent } = bound
        agent.cancel({ kind: 'user' })
        await agent.whenIdle()
        await core.sessions.flush(agent.session)
        host.stderr.write(`dsh: session ${agent.session.id} saved; resume with: dsh --profile tui --resume ${agent.session.id}\n`)
        await bound.dispose()
        host.exit(0)
      })().catch((error: unknown) => { fail(host, error) })
    },
  })
  app.start(config.prompt)
}

/**
 * Mount the terminal runner.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated invocation config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-app: the launcher must provide ctx.appExit before the tree mounts')
  }
  const host: TuiHost = {
    createTerminal: internals.createTerminal,
    releaseInput: internals.releaseInput,
    stderr: internals.stderr,
    color: internals.color,
    canOpenUrl: internals.canOpenUrl,
    openUrl: internals.openUrl,
    exit,
  }
  void run(ctx, config, host).catch((error: unknown) => { fail(host, error) })
}
