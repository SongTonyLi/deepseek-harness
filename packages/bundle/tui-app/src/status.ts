/**
 * Persistent session status for the terminal: one read of the session
 * projections becomes plain facts, and pure formatters turn those facts into
 * footer parts, the `/status` report, and the one-line notices for
 * compaction and model-request retries. Nothing here touches the terminal,
 * the palette, or the agent.
 * @module @deepseek-ai/dsh-tui-app/status
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { GoalPhase } from '@deepseek-ai/dsh-goal/types'
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry/types'
import type { PermissionSelection } from '@deepseek-ai/dsh-permission-presets'
import type { PlanProjection } from '@deepseek-ai/dsh-plan-mode/types'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/types'
import type { ContextBreakdownProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
// Type-only: merges the `compaction/summary` event into `SessionEventMap`.
import type {} from '@deepseek-ai/dsh-compaction/types'
import { formatTokens } from './transcript.ts'

/** Context occupancy of the next request, present once a provider reported usage and a route capacity. */
export interface ContextFacts {
  /** Tokens the next request's prompt would cost: the provider sample plus the surface delta since it. */
  used: number
  /** Newest recorded route capacity. */
  window: number
  /** `used / window`, rounded and capped at 100. */
  percent: number
}

/** Todo counts by status over the agent's current list. */
export interface TodoFacts {
  /** The current whole list, in write order. */
  items: readonly TodoItem[]
  done: number
  active: number
  pending: number
}

/** The session's current durable goal. */
export interface GoalFacts {
  phase: GoalPhase
  objective: string
  /** Highest admitted round number. */
  round: number
  /** Total admitted round cap. */
  maxRounds: number
  /** Present exactly while `phase` is `blocked`. */
  blockedReason?: string
}

/**
 * Everything the terminal shows about a session that is not the transcript.
 * Every field is optional: a projection key that is not registered in the
 * running profile, or that has no value yet, leaves its fact absent.
 */
export interface StatusFacts {
  context?: ContextFacts
  /** Heuristic system/tools/messages composition of the next request. */
  breakdown?: ContextBreakdownProjection
  /** Cumulative provider-reported usage over the complete log. */
  tokenUsage?: TokenUsageProjection
  /** Whole-log turn/step counts and wall times. */
  stats?: SessionStatsProjection
  todos?: TodoFacts
  goal?: GoalFacts
  plan?: PlanProjection
  permissions?: PermissionSelection
}

/** The read face of `ctx.sessionProjections` this module needs. */
export type StatusProjections = Pick<SessionProjectionRegistry, 'snapshot'>

/** The client-visible keys one status read selects. */
const STATUS_KEYS = [
  'contextPressure',
  'contextBreakdown',
  'tokenUsage',
  'sessionStats',
  'todos',
  'goal',
  'plan',
  'permissions',
] as const

/**
 * Read one consistent cut of the status projections for `session`.
 * @param projections - the session-projection registry (`ctx.get('sessionProjections')`).
 * @param session - the session whose status is read.
 * @returns the facts every registered key yields; unregistered keys leave their fact absent.
 */
export function readStatusFacts(projections: StatusProjections, session: Session): StatusFacts {
  const { values } = projections.snapshot(session, STATUS_KEYS)
  const facts: StatusFacts = {}
  const pressure = values.contextPressure
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (used !== undefined && pressure?.contextWindow !== undefined) {
    facts.context = {
      used,
      window: pressure.contextWindow,
      percent: Math.min(100, Math.round(used / pressure.contextWindow * 100)),
    }
  }
  if (values.contextBreakdown !== undefined) facts.breakdown = values.contextBreakdown
  if (values.tokenUsage !== undefined) facts.tokenUsage = values.tokenUsage
  if (values.sessionStats !== undefined) facts.stats = values.sessionStats
  if (values.todos !== undefined && values.todos !== null) {
    const items = values.todos
    facts.todos = {
      items,
      done: items.filter(item => item.status === 'completed').length,
      active: items.filter(item => item.status === 'in_progress').length,
      pending: items.filter(item => item.status === 'pending').length,
    }
  }
  if (values.goal !== undefined && values.goal !== null) {
    const { goal, roundsStarted } = values.goal
    facts.goal = {
      phase: goal.phase,
      objective: goal.objective,
      round: roundsStarted,
      maxRounds: goal.maxGoalRounds,
      ...goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason.message },
    }
  }
  if (values.plan !== undefined) facts.plan = values.plan
  if (values.permissions !== undefined) facts.permissions = values.permissions
  return facts
}

/**
 * The short footer parts: `ctx 42%`, `todo 2/5` (done over total),
 * `goal active`, and `plan` (`plan…` while a mode switch is pending).
 * @param facts - the facts one status read produced.
 * @returns one part per present fact, in footer order; empty when nothing is known.
 */
export function footerStatus(facts: StatusFacts): string[] {
  const parts: string[] = []
  if (facts.context !== undefined) parts.push(`ctx ${String(facts.context.percent)}%`)
  if (facts.todos !== undefined) parts.push(`todo ${String(facts.todos.done)}/${String(facts.todos.items.length)}`)
  if (facts.goal !== undefined) parts.push(`goal ${facts.goal.phase}`)
  if (facts.plan?.pending === true) parts.push('plan…')
  else if (facts.plan?.active === true) parts.push('plan')
  return parts
}

/** Glyph per todo status, matching the browser's list markers. */
const TODO_GLYPH: Record<TodoItem['status'], string> = {
  completed: '✓',
  in_progress: '▸',
  pending: '○',
}

/**
 * The multi-line `/status` report: context occupancy and composition, token
 * usage with the cache-hit share, session stats, the todo list, the goal,
 * plan mode, and the permission preset — one section per present fact.
 * @param facts - the facts one status read produced.
 * @returns the report lines; a single explanatory line when nothing is known.
 */
export function statusReport(facts: StatusFacts): string[] {
  const lines: string[] = []
  if (facts.context !== undefined) {
    const { used, window, percent } = facts.context
    lines.push(`context: ~${formatTokens(used)} / ${formatTokens(window)} (${String(percent)}%)`)
  }
  if (facts.breakdown !== undefined) {
    const { systemTokens, toolsTokens, messageTokens } = facts.breakdown
    lines.push(`  system ~${formatTokens(systemTokens)} · tools ~${formatTokens(toolsTokens)} · messages ~${formatTokens(messageTokens)}`)
  }
  if (facts.tokenUsage !== undefined) {
    const usage = facts.tokenUsage
    const parts = [
      `↑${formatTokens(usage.uncachedInputTokens)} uncached`,
      `cache read ${formatTokens(usage.cacheReadTokens)}`,
      `cache write ${formatTokens(usage.cacheWriteTokens)}`,
      `↓${formatTokens(usage.outputTokens)}`,
    ]
    const hit = cacheHitPercent(usage)
    if (hit !== null) parts.push(`cache hit ${hit}%`)
    lines.push(`tokens: ${parts.join(' · ')}`)
  }
  if (facts.stats !== undefined) {
    const stats = facts.stats
    const parts = [
      `${String(stats.turns)} ${plural(stats.turns, 'turn')}`,
      `${String(stats.steps)} ${plural(stats.steps, 'step')}`,
      `model ${formatDuration(stats.llmMs)}`,
      `tools ${formatDuration(stats.toolMs)}`,
    ]
    if (stats.ttftSteps > 0) parts.push(`first token ${formatDuration(stats.ttftMs / stats.ttftSteps)} avg`)
    if (stats.decodeMs > 0) parts.push(`${String(Math.round(stats.decodeTokens / stats.decodeMs * 1000))} tok/s`)
    lines.push(`session: ${parts.join(' · ')}`)
  }
  if (facts.todos !== undefined) {
    const { items, done, active, pending } = facts.todos
    lines.push(`todos: ${String(done)} done · ${String(active)} active · ${String(pending)} pending`)
    for (const item of items) lines.push(`  ${TODO_GLYPH[item.status]} ${item.content}`)
  }
  if (facts.goal !== undefined) {
    const goal = facts.goal
    lines.push(`goal: ${goal.phase} · round ${String(goal.round)}/${String(goal.maxRounds)} · ${goal.objective}`)
    if (goal.blockedReason !== undefined) lines.push(`  blocked: ${goal.blockedReason}`)
  }
  if (facts.plan !== undefined) {
    lines.push(`plan: ${facts.plan.active ? 'on' : 'off'}${facts.plan.pending ? ' (switching)' : ''}`)
  }
  if (facts.permissions !== undefined) {
    // The projection carries the current value only; the selectable options
    // moved to the process-level catalog Remote.
    lines.push(`permission: ${facts.permissions.currentValue}`)
  }
  return lines.length === 0 ? ['no session status yet'] : lines
}

/**
 * The share of prompt-side input served from cache over the complete log.
 * @param usage - cumulative provider-reported usage.
 * @returns the percentage text; a partial hit never rounds up to `100`, and
 * no billed input returns null.
 */
export function cacheHitPercent(usage: TokenUsageProjection): string | null {
  const promptTokens = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  if (promptTokens === 0) return null
  if (promptTokens === usage.cacheReadTokens) return '100'
  const percent = usage.cacheReadTokens / promptTokens * 100
  const rounded = Math.round(percent)
  return rounded < 100 ? String(rounded) : String(Math.floor(percent * 10) / 10)
}

/**
 * Compact duration: `45.2s` under a minute, `2m42s` from there on.
 * @param ms - duration in milliseconds.
 * @returns the formatted duration.
 */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${String(Math.round(seconds * 10) / 10)}s`
  const whole = Math.round(seconds)
  return `${String(Math.floor(whole / 60))}m${String(whole % 60)}s`
}

/**
 * The notice a completed compaction earns.
 * @param data - the `compaction/summary` event data.
 * @returns e.g. `compacted 12 items (~3.4k tokens)`.
 */
export function compactionNotice(data: Pick<SessionEventMap['compaction/summary'], 'shadowedSeqs' | 'shadowedTokenCount'>): string {
  const count = data.shadowedSeqs.length
  return `compacted ${String(count)} ${plural(count, 'item')} (~${formatTokens(data.shadowedTokenCount)} tokens)`
}

/**
 * The notice a scheduled model-request retry earns.
 * @param data - the `llm/retry` event data.
 * @returns e.g. `retrying (2/5) in 4s · RATE_LIMIT: provider busy`; an
 * `always` policy has no cap, so its attempt reads `(2)`.
 */
export function retryMessage(data: LlmRetryEventData): string {
  const attempt = data.mode === 'normal' ? `${String(data.retry)}/${String(data.maxRetries)}` : String(data.retry)
  return `retrying (${attempt}) in ${formatDuration(data.delayMs)} · ${data.failure.code}: ${data.failure.message}`
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}
