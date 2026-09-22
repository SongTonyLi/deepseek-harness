/**
 * Model-switch work-state notice admitted after a model-selection notice
 * whose incoming route is the Cursor subscription (`cursor`).
 *
 * @module @deepseek-ai/dsh-compaction-basic/work-state
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Work-state attribution; readers preserve the notice without this producer.
     * Its admission uses the kind to avoid repeated injection.
     * @persistenceAttribution
     */
    'compaction-basic': { kind: 'compaction-basic'; form: 'notice'; summary: string }
  }
}

const WORK_STATE_PLUGIN = 'compaction-basic'
const WORK_STATE_SUMMARY = 'work state'
const COMPACTED_SUMMARY_TAG = '<compacted-summary>'
const CONTINUES_WITH = /the session continues with ([^\]]+)/
const CURSOR_PROVIDER = 'cursor'
const FILE_CHANGING_TOOLS = new Set(['edit', 'write', 'bash'])
const NO_FILE_CHANGES = 'the previous turn made no file changes; do not repeat its plan'
const WITH_CHECKPOINT = 'treat the latest <compacted-summary> and durable session/workspace state as authority; '
  + 'do not re-inspect completed work or re-derive a plan already recorded; '
  + 'the next action is the checkpoint\'s Next Step, or a state-changing tool (read only if a named file is missing)'
const WITHOUT_CHECKPOINT = 'do not re-inspect completed work or re-derive a plan already recorded; '
  + 'the next action is a state-changing tool (read only if a named file is missing)'

/**
 * Listen for model-selection notices whose incoming route is `cursor`,
 * including `auto: false` backends.
 * @param ctx - plugin context that owns the listeners.
 * @returns nothing; listeners dispose with the context fiber.
 */
export function installWorkStateNotice(ctx: Context): void {
  ctx.on('agent/pre-step', onWorkStatePreStep)
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.on('agent/pre-step', onWorkStatePreStep, { prepend: true })
  })
}

async function onWorkStatePreStep(
  { agent }: { agent: Agent },
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  return appendWorkStateNotice(agent.session, await next())
}

function appendWorkStateNotice(session: Session, decision: PreStepDecision): PreStepDecision {
  if (decision.kind !== 'enter') return decision
  if (!decision.messages.some(isModelSelectionNotice)) return decision
  if (!incomingCursorRoute(session, decision.messages)) return decision
  if (decision.messages.some(isWorkStateNotice)) return decision
  return {
    ...decision,
    messages: [...decision.messages, createWorkStateNotice(session, decision.messages)],
  }
}

/**
 * Whether the incoming model-selection route is the Cursor subscription.
 * The durable request header is still the previous route, so a
 * cursor→other switch must not inject. A `provider/model` label is
 * cross-provider; a bare model id is same-provider and uses that header.
 */
function incomingCursorRoute(session: Session, admitted: readonly UserMessage[]): boolean {
  const to = incomingRouteLabel(admitted)
  if (to === undefined) return false
  if (to.startsWith(`${CURSOR_PROVIDER}/`)) return true
  if (to.includes('/')) return false
  return session.requestHeader()?.config.provider === CURSOR_PROVIDER
}

function incomingRouteLabel(admitted: readonly UserMessage[]): string | undefined {
  for (const message of admitted) {
    if (!isModelSelectionNotice(message)) continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      const match = CONTINUES_WITH.exec(block.text)
      if (match !== null) return match[1]
    }
  }
  return undefined
}

function createWorkStateNotice(session: Session, admitted: readonly UserMessage[]) {
  return createUserMessage({
    content: [{
      type: 'text',
      text: workStateNoticeText(
        historyHasCompactedSummary(session, admitted),
        previousTurnChangedFiles(session),
      ),
    }],
    source: {
      kind: WORK_STATE_PLUGIN,
      form: 'notice',
      summary: boundContextSummary(WORK_STATE_SUMMARY),
    },
  })
}

function workStateNoticeText(hasCheckpoint: boolean, previousTurnChangedFiles: boolean): string {
  const body = hasCheckpoint ? WITH_CHECKPOINT : WITHOUT_CHECKPOINT
  return previousTurnChangedFiles
    ? `[work state: ${body}]`
    : `[work state: ${body}; ${NO_FILE_CHANGES}]`
}

function isModelSelectionNotice(message: UserMessage): boolean {
  return message.source.kind === 'model-selection'
}

function isWorkStateNotice(message: UserMessage): boolean {
  return message.source.kind === WORK_STATE_PLUGIN
}

function historyHasCompactedSummary(
  session: Session,
  admitted: readonly UserMessage[],
): boolean {
  return [...session.deriveMessages(), ...admitted].some(messageHasCompactedSummary)
}

function messageHasCompactedSummary(message: Message): boolean {
  return message.content.some(block =>
    block.type === 'text' && block.text.includes(COMPACTED_SUMMARY_TAG))
}

function previousTurnChangedFiles(session: Session): boolean {
  const state = { names: new Map<string, string>(), last: false, current: false }
  for (const event of session.snapshotEvents()) applyTurnFileChange(state, event)
  return state.last
}

/** Fold one log event into whether the last completed turn changed files. */
function applyTurnFileChange(
  state: { names: Map<string, string>; last: boolean; current: boolean },
  event: SessionEvent,
): void {
  switch (event.type) {
    case 'turn/start':
      state.names.clear()
      state.current = false
      return
    case 'tool/call':
      state.names.set(event.data.callId, event.data.name)
      return
    case 'tool/result':
      if (fileChangingSuccess(event, state.names)) state.current = true
      return
    case 'turn/end':
      state.last = state.current
      return
    default:
      // Other event types do not affect previous-turn file-change detection.
      return
  }
}

function fileChangingSuccess(
  event: Extract<SessionEvent, { type: 'tool/result' }>,
  names: ReadonlyMap<string, string>,
): boolean {
  const name = names.get(event.data.message.source.callId)
  /* v8 ignore next -- a valid log pairs every tool/result with a same-turn tool/call. */
  if (name === undefined) return false
  return FILE_CHANGING_TOOLS.has(name) && event.data.message.isError !== true
}
