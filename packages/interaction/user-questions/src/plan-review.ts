/**
 * The plan-review narrowing every surface applies before drawing a
 * `plan-review` question as an approve/decline card instead of the generic
 * option list.
 * @module @deepseek-ai/dsh-user-questions/plan-review
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { AskUserQuestionItem, AskUserQuestionOption } from './types.ts'

/** The two verdict options of a plan-review question. */
export interface PlanReviewOptions {
  /** The option that approves the plan. */
  approve: AskUserQuestionOption
  /** The option that declines it; absent when the asker offered no other option. */
  decline?: AskUserQuestionOption
  /** Logged tool invocation used to reopen this plan, when the intent names one. */
  callId?: ToolCallId
}

/**
 * Narrow one question to its plan-review verdicts, or return undefined to
 * leave it to the generic option list. The review is one decision over one
 * plan, so the question must declare the intent, carry the plan as its
 * detail, offer the approve label the intent names, and be a binary single
 * choice: at most one option besides approve, and not multi-select. Anything
 * else has answers two rows cannot express.
 * @param question - the question.
 * @returns the verdict options, or undefined when the generic list owns the question.
 */
export function planReviewOptions(question: AskUserQuestionItem): PlanReviewOptions | undefined {
  const intent = question.intent
  if (intent?.kind !== 'plan-review' || question.detail === undefined) return undefined
  if (question.multiSelect === true) return undefined
  const options = question.options ?? []
  if (options.length > 2) return undefined
  const approve = options.find(option => option.label === intent.approve)
  if (approve === undefined) return undefined
  const decline = options.find(option => option.label !== intent.approve)
  return {
    approve,
    ...(decline === undefined ? {} : { decline }),
    ...(intent.callId === undefined ? {} : { callId: intent.callId }),
  }
}
