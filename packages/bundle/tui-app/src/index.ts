/**
 * @deepseek-ai/dsh-tui-app — the interactive terminal runner. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates or resumes one Agent through the core registry, hands it to the
 * terminal application, and on quit flushes its Session and requests exit.
 *
 * @module @deepseek-ai/dsh-tui-app
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { ProcessTerminal, type Terminal } from '@earendil-works/pi-tui'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { TuiApp } from './app.ts'
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

/** Events persisted for `--resume`, read through the storage handle before the Agent takes the log over. */
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
  if (persistence === undefined) throw new Error('tui-app: --resume needs a composed session persistence provider')
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

/** Report an unexpected runner failure and request a failing exit. */
function fail(host: TuiHost, error: unknown): void {
  host.stderr.write(`dsh: ${describeFailure(error)}\n`)
  host.exit(1)
}

/**
 * Create or resume the Agent, start the terminal application, and request
 * process exit when the user quits.
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
  const { agents, defaultModel, sessions } = core

  const cwd = process.cwd()
  const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
  const setup = (agentCtx: Context): void => { installModelSelection(agentCtx, selection) }
  let handle: AgentHandle
  let history: SessionEvent[] = []
  if (config.resume === undefined) {
    const model = defaultModel.currentSelection()
    selection.current = model
    handle = await agents.create({
      sessionId: brandString<SessionId>(`session-${randomUUID()}`),
      meta: { cwd },
      agentOptions: { provider: model.provider, model: model.model },
      setup,
    })
  } else {
    const id = brandString<SessionId>(config.resume)
    history = await readHistory(ctx, id)
    handle = await agents.resume({ resumeSessionId: id, setup })
  }
  const agent = handle.agent
  await agent.whenIdle()

  const app = new TuiApp({
    ctx,
    agent,
    selection,
    terminal: host.createTerminal(),
    palette: createPalette(host.color),
    toolPreviewLines: config.toolPreviewLines,
    cwd,
    releaseInput: () => { host.releaseInput() },
    onQuit: () => {
      void (async () => {
        agent.cancel({ kind: 'user' })
        await agent.whenIdle()
        await sessions.flush(agent.session)
        host.stderr.write(`dsh: session ${agent.session.id} saved; resume with: dsh --profile tui --resume ${agent.session.id}\n`)
        await handle.dispose()
        host.exit(0)
      })().catch((error: unknown) => { fail(host, error) })
    },
  })
  app.start(history, config.prompt)
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
