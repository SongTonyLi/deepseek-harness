/** The plan-review narrowing shared by every surface that draws an approve/decline card. */

import { describe, expect, it } from 'vitest'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { planReviewOptions, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

const approve = { label: 'Approve' }
const decline = { label: 'Decline', description: 'back to the drawing board' }
const review: AskUserQuestionItem = {
  id: 'q',
  question: 'Proceed with the plan?',
  detail: '# Plan\n1. build',
  options: [approve, decline],
  intent: { kind: 'plan-review', approve: 'Approve' },
}

describe('planReviewOptions', () => {
  it('returns the approve and decline options of a binary plan-review question', () => {
    expect(planReviewOptions(review)).toEqual({ approve, decline })
    expect(planReviewOptions({ ...review, options: [approve] })).toEqual({ approve })
  })

  it('carries the logged call the intent names, so a surface can reopen the plan', () => {
    const callId = 'call-1' as ToolCallId
    expect(planReviewOptions({ ...review, intent: { kind: 'plan-review', approve: 'Approve', callId } }))
      .toEqual({ approve, decline, callId })
  })

  it('leaves every other question to the generic list', () => {
    expect(planReviewOptions({ id: 'q', question: 'Which?', options: [approve, decline] })).toBeUndefined()
    expect(planReviewOptions({ ...review, detail: undefined } as never)).toBeUndefined()
    expect(planReviewOptions({ ...review, multiSelect: true })).toBeUndefined()
    expect(planReviewOptions({ ...review, options: [approve, decline, { label: 'Later' }] })).toBeUndefined()
    expect(planReviewOptions({ ...review, options: [decline] })).toBeUndefined()
    expect(planReviewOptions({ ...review, options: undefined } as never)).toBeUndefined()
  })
})
