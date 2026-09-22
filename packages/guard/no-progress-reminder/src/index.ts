/**
 * Advisory per-agent idle-progress reminder. It counts whole turns while a
 * goal is active (or always when `requireGoal` is false) and injects a notice
 * after a configured run of turns with no successful mutating tool. The
 * reminder never vetoes a call. Configuration lives in the package README.
 * @module @deepseek-ai/dsh-no-progress-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { GoalChangeMeta } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'no-progress-reminder': { kind: 'no-progress-reminder'; form: 'notice'; summary: string }
  }
}
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'no-progress-reminder'

/** Tool and agent registries this plugin observes; goals are optional via `ctx.get`. */
export const inject = ['tools', 'agents']

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time check in `apply` (`idleTurns` must be an integer >= 1; a
 * non-integer or a value below 1 throws at plugin load). `mutatingTools`
 * entries are `*`-wildcard predicates over tool names at call time, not
 * references to registry entries.
 */
export interface Config {
  /** Consecutive counted turns that trigger a notice (default `5`). */
  idleTurns?: number
  /** Tool-name patterns whose successful calls reset the idle count. */
  mutatingTools?: string[]
  /**
   * When true (default), only count and inject while `ctx.get('goals')` is
   * present, the agent is live in that registry, and `goals.get(agent)` has
   * phase `active`. A missing goals service or a non-live agent is a no-op,
   * not a throw.
   */
  requireGoal?: boolean
  /**
   * Provider routes that participate. Default `['cursor']` — the Cursor
   * subscription adapter. An empty list matches no route.
   */
  providers?: string[]
}

export const Config: z<Config> = z.object({
  idleTurns: z.number().default(5),
  mutatingTools: z.array(z.string()).default(['edit', 'write', 'bash']),
  requireGoal: z.boolean().default(true),
  providers: z.array(z.string()).default(['cursor']),
})

/**
 * Source stamped on every notice this guard injects.
 */
const PLUGIN_SOURCE: MessageSource = {
  kind: 'no-progress-reminder',
  form: 'notice',
  summary: 'no progress',
}

/** One agent's in-memory idle-progress debt. */
interface IdleState {
  idleTurns: number
  mutatedThisTurn: boolean
  lastNotifiedTurn?: number
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Validate `idleTurns` per the fail-loud contract.
 * @param value - candidate from the validated config object.
 * @returns the same integer when it is >= 1.
 */
function validateIdleTurns(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`no-progress-reminder: invalid idleTurns ${value} — must be an integer >= 1`)
  }
  return value
}

/** Model-visible notice naming the counted idle turns. */
function noProgressText(idleCount: number): string {
  return `No file has changed in ${idleCount} turns. Your next tool call must be read, edit, write, or bash, or explain what blocks you.`
}

function createNotice(idleCount: number) {
  return createUserMessage({
    content: [{ type: 'text', text: noProgressText(idleCount) }],
    source: PLUGIN_SOURCE,
  })
}

function goalChangeEnded(event: SessionEvent): boolean {
  if (event.type !== 'goal/change') return false
  const change: GoalChangeMeta = event.data
  return change.operation === 'clear' || change.operation === 'complete'
}

function hasActiveGoal(ctx: Context, agent: Agent): boolean {
  const goals = ctx.get('goals')
  if (goals === undefined || ctx.agents.get(agent.id) !== agent) return false
  return goals.get(agent)?.phase === 'active'
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; `idleTurns` is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const idleTurns = validateIdleTurns(config.idleTurns as number)
  const mutatingPatterns = (config.mutatingTools as string[]).map(wildcardToRegExp)
  const requireGoal = config.requireGoal as boolean
  const providers = validateProviders(config.providers as string[])
  const states = new WeakMap<Agent, IdleState>()
  install(ctx, { idleTurns, mutatingPatterns, requireGoal, providers, states })
}

function validateProviders(values: string[]): string[] {
  for (const value of values) {
    if (value.length === 0) {
      throw new Error('no-progress-reminder: providers entries must be non-empty')
    }
  }
  return values
}

interface Resolved {
  idleTurns: number
  mutatingPatterns: RegExp[]
  requireGoal: boolean
  providers: readonly string[]
  states: WeakMap<Agent, IdleState>
}

function reset(states: WeakMap<Agent, IdleState>, agent: Agent): void {
  states.set(agent, { idleTurns: 0, mutatedThisTurn: true })
}

function tracking(
  ctx: Context,
  requireGoal: boolean,
  providers: readonly string[],
  agent: Agent,
): boolean {
  if (requireGoal && !hasActiveGoal(ctx, agent)) return false
  const provider = agent.session.requestHeader()?.config.provider ?? agent.options.provider
  return provider !== undefined && providers.includes(provider)
}

function liveAgent(ctx: Context, session: Session): Agent | undefined {
  return ctx.agents.get(session.id)
}

function install(ctx: Context, resolved: Resolved): void {
  const { idleTurns, mutatingPatterns, requireGoal, providers, states } = resolved
  ctx.on('tools/post-execute', async (
    exec: ToolExecution,
    result: ToolExecutionResult,
    next,
  ): Promise<PostToolDecision> => {
    if (exec.agent !== undefined && !result.isError
      && mutatingPatterns.some(pattern => pattern.test(exec.name))) {
      reset(states, exec.agent)
    }
    return next()
  })
  ctx.on('session/event', (session, event) => {
    onSessionEvent(ctx, session, event, requireGoal, providers, states)
  })
  ctx.on('agent/pre-step', async ({ agent, turn }, next): Promise<PreStepDecision> => {
    return onPreStep(ctx, agent, turn, next, idleTurns, requireGoal, providers, states)
  })
}

function onSessionEvent(
  ctx: Context,
  session: Session,
  event: SessionEvent,
  requireGoal: boolean,
  providers: readonly string[],
  states: WeakMap<Agent, IdleState>,
): void {
  const agent = liveAgent(ctx, session)
  if (agent === undefined) return
  if (goalChangeEnded(event)) {
    reset(states, agent)
    return
  }
  if (event.type !== 'turn/end') return
  const current = states.get(agent) ?? { idleTurns: 0, mutatedThisTurn: false }
  if (current.mutatedThisTurn) {
    states.set(agent, { idleTurns: 0, mutatedThisTurn: false })
    return
  }
  if (!tracking(ctx, requireGoal, providers, agent)) return
  states.set(agent, { ...current, idleTurns: current.idleTurns + 1 })
}

async function onPreStep(
  ctx: Context,
  agent: Agent,
  turn: number,
  next: () => Promise<PreStepDecision>,
  idleTurns: number,
  requireGoal: boolean,
  providers: readonly string[],
  states: WeakMap<Agent, IdleState>,
): Promise<PreStepDecision> {
  const downstream = await next()
  if (downstream.kind !== 'enter' || !tracking(ctx, requireGoal, providers, agent)) return downstream
  const current = states.get(agent)
  if (current === undefined || current.idleTurns < idleTurns) return downstream
  if (current.lastNotifiedTurn === turn) return downstream
  states.set(agent, { ...current, lastNotifiedTurn: turn })
  return { ...downstream, messages: [...downstream.messages, createNotice(current.idleTurns)] }
}
