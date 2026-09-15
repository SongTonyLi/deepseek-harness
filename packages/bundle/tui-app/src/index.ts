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
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { SessionLogOffset, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { TuiApp, type BoundSession, type SessionHost } from './app.ts'
import { colorEnabled, createPalette } from './style.ts'
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
  /** Collapsed tool-card body rows before `Ctrl+O` expands them. */
  toolPreviewLines: number
}

export const Config: z<Config> = z.object({
  prompt: z.string(),
  resume: z.string(),
  toolPreviewLines: z.natural().min(1).default(8),
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
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process-bound pieces of the host; tests substitute a fake terminal and captured streams. */
export const internals: Pick<TuiHost, 'createTerminal' | 'releaseInput' | 'stderr' | 'color'> = {
  /* v8 ignore next -- the process terminal owns raw stdin; tests substitute a fake */
  createTerminal: () => new ProcessTerminal(),
  /* v8 ignore next -- process stdin is the host's; tests substitute a recorder */
  releaseInput: () => { process.stdin.unref() },
  stderr: process.stderr,
  color: colorEnabled(process.env, process.stdout.isTTY),
}

/** Events read per page when a persisted session is resumed, through the storage handle before the Agent takes the log over. */
const HISTORY_PAGE = 256

/**
 * Read a persisted session's complete event log in pages, so the terminal
 * can draw the earlier conversation before resuming it.
 * @param ctx - plugin context carrying the persistence service.
 * @param id - the session to read.
 * @returns the persisted events in log order.
 */
async function readHistory(ctx: Context, id: SessionId): Promise<SessionEvent[]> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('tui-app: resuming a session needs a composed session persistence provider')
  const handle = await persistence.open(id, 'read')
  try {
    const events: SessionEvent[] = []
    for (;;) {
      const page = await handle.read(events.length, HISTORY_PAGE)
      events.push(...page.events)
      if (page.events.length < HISTORY_PAGE) return events
    }
  } finally {
    await handle[Symbol.asyncDispose]()
  }
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
 * The fork prefix of a session: its events through the last completed turn,
 * up to the next turn's start, the same cut the browser's fork command takes.
 * @param ctx - plugin context carrying the session query engine.
 * @param id - the session to fork.
 * @returns the seed events.
 * @throws when no query engine is composed or the session has no completed turn.
 */
async function forkSeed(ctx: Context, id: SessionId): Promise<SessionEvent[]> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) throw new Error('forking a session needs a composed session query engine')
  using source = await query.observeSession(id)
  const boundary = source.events.findLast(event => event.type === 'turn/end')
  if (boundary === undefined) throw new Error(`session ${id} has no completed turn to fork from`)
  let cut = boundary.seq + 1
  while (cut < source.events.length && source.events[cut]?.type !== 'turn/start') cut += 1
  return source.events.slice(0, cut)
}

/**
 * The terminal's session host over the core Agent registry. Every Agent gets
 * the model selection installed so `/model` applies from the next request.
 * @param ctx - plugin context.
 * @param core - the injected services.
 * @param cwd - the workspace root recorded on new sessions.
 * @returns the host.
 */
function sessionHost(ctx: Context, core: CoreServices, cwd: string): SessionHost {
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
  return {
    create: () => create(undefined, undefined),
    resume: async id => bind((_selection, setup) => agents.resume({ resumeSessionId: id, setup }), await readHistory(ctx, id)),
    fork: async id => create(await forkSeed(ctx, id), id),
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
  const sessions = sessionHost(ctx, core, cwd)
  const initial = config.resume === undefined
    ? await sessions.create()
    : await sessions.resume(brandString<SessionId>(config.resume))

  const app = new TuiApp({
    ctx,
    host: sessions,
    initial,
    terminal: host.createTerminal(),
    palette: createPalette(host.color),
    toolPreviewLines: config.toolPreviewLines,
    cwd,
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
    exit,
  }
  void run(ctx, config, host).catch((error: unknown) => { fail(host, error) })
}
