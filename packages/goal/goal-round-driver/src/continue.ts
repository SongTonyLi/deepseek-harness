/** Human continue-intent rearm and the model-visible continuation notice. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'goal-round-driver': { kind: 'goal-round-driver'; form: 'notice'; summary: string }
  }
}

const CONTINUE_PHRASES = new Set([
  'continue',
  'keep going',
  'resume',
  'go on',
  'continue the work',
  'continue with the work',
])

const MUTATING_TOOLS = new Set(['edit', 'write', 'bash'])

const NO_MUTATION_CLAUSE = 'the previous turn made no file changes; do not repeat its plan'
const MUTATION_CLAUSE = 'the previous turn changed the workspace; continue from the current files'

type ContinueStatus = 'resumed' | 'armed' | 'paused' | 'blocked' | 'complete'

/** Human-readable unexpected values for logs. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Concatenate text blocks from one claimed user message. */
function userMessageText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Trim, drop one optional trailing period, and lowercase a candidate phrase. */
function canonicalizeContinueText(text: string): string {
  const trimmed = text.trim()
  return (trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed).trim().toLowerCase()
}

/** Whether text is exactly one closed continue phrase. */
function isContinuePhrase(text: string): boolean {
  return CONTINUE_PHRASES.has(canonicalizeContinueText(text))
}

/** Whether one claimed message is a human continue-intent. */
function isContinueIntentMessage(message: UserMessage): boolean {
  if (message.source.kind !== 'user') return false
  const text = userMessageText(message)
  if (isContinuePhrase(text)) return true
  const newline = text.indexOf('\n')
  return newline >= 0 && isContinuePhrase(text.slice(0, newline))
}

/** Events from the last `turn/start` through its matching `turn/end`. */
function lastClosedTurn(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const closed = events.findLast((event): event is SessionEvent & { type: 'turn/end' } =>
    event.type === 'turn/end')
  if (closed === undefined) return []
  const start = events.findLastIndex(event =>
    event.type === 'turn/start' && event.data.turn === closed.data.turn)
  return events.slice(Math.max(start, 0), events.lastIndexOf(closed) + 1)
}

/** Whether that closed turn recorded a successful edit, write, or bash result. */
function lastClosedTurnMutatedWorkspace(session: Session): boolean {
  const window = lastClosedTurn(session.snapshotEvents())
  const names = new Map<string, string>()
  for (const event of window) {
    if (event.type === 'tool/call') names.set(event.data.callId, event.data.name)
  }
  for (const event of window) {
    if (event.type !== 'tool/result') continue
    if (event.data.message.isError === true) continue
    const name = names.get(event.data.message.source.callId) ?? ''
    if (MUTATING_TOOLS.has(name)) return true
  }
  return false
}

/** One-line resume outcome for the notice body. */
function continueStatusLine(goal: GoalView, status: ContinueStatus): string {
  switch (status) {
    case 'resumed':
      return 'The active goal was resumed'
    case 'armed':
      return 'The active goal is already armed'
    case 'paused':
      return 'The goal was not resumed because it is paused'
    case 'blocked':
      return `The goal was not resumed because it is blocked: ${goal.blockedReason?.message ?? 'blocked'}`
    case 'complete':
      return 'The goal was not resumed because it is complete'
  }
}

/** Build the plugin notice appended to an accepted continue-intent step. */
function renderContinueNotice(
  goal: GoalView,
  status: ContinueStatus,
  mutated: boolean,
): UserMessage {
  const text = `${continueStatusLine(goal, status)}; ${mutated ? MUTATION_CLAUSE : NO_MUTATION_CLAUSE}.`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'goal-round-driver',
      form: 'notice',
      summary: boundContextSummary(text),
    },
  })
}

/** Human-authorized rearm of an active-disarmed goal that still has capacity. */
function resumeActiveDisarmed(ctx: Context, agent: Agent, goal: GoalView): ContinueStatus | undefined {
  try {
    ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
    return 'resumed'
  } catch (error: unknown) {
    ctx.logger.warn(`goal-round-driver: could not resume goal for agent "${agent.id}": ${renderThrown(error)}`)
    return undefined
  }
}

/** Decide whether continue-intent may rearm, and what the notice should claim. */
function authorizeContinue(ctx: Context, agent: Agent, goal: GoalView): ContinueStatus | undefined {
  switch (goal.phase) {
    case 'active':
      if (goal.activation === 'armed') return 'armed'
      if (goal.roundsStarted >= goal.maxGoalRounds) return undefined
      return resumeActiveDisarmed(ctx, agent, goal)
    case 'paused':
      return 'paused'
    case 'blocked':
      return 'blocked'
    case 'complete':
      return 'complete'
  }
}

/**
 * Rearm an active-disarmed goal from a human continue-intent and build the notice.
 * @param ctx - host context with the goal service.
 * @param agent - live agent whose claimed batch is entering a step.
 * @param messages - claimed pre-step batch.
 * @returns a plugin notice when continue-intent applies to a current goal, otherwise `undefined`.
 */
export function applyContinueIntent(
  ctx: Context,
  agent: Agent,
  messages: readonly UserMessage[],
): UserMessage | undefined {
  if (!messages.some(isContinueIntentMessage)) return undefined
  const goal = ctx.goals.get(agent)
  if (goal === undefined) return undefined
  const status = authorizeContinue(ctx, agent, goal)
  if (status === undefined) return undefined
  return renderContinueNotice(goal, status, lastClosedTurnMutatedWorkspace(agent.session))
}

/**
 * Append a continue notice only to an accepted, non-aborted step.
 * @param decision - downstream pre-step decision.
 * @param notice - notice produced for this claimed batch, if any.
 * @param aborted - whether the step signal aborted while downstream listeners ran.
 * @returns the decision, with the notice appended on an accepted live step.
 */
export function attachContinueNotice(
  decision: PreStepDecision,
  notice: UserMessage | undefined,
  aborted: boolean,
): PreStepDecision {
  if (notice === undefined || decision.kind !== 'enter' || aborted) return decision
  return { ...decision, messages: [...decision.messages, notice] }
}
