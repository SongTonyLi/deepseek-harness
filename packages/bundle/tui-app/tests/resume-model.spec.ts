/** Resume restores the last logged route, else the launch default. */

import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { resumeModelSelection } from '../src/resume-model.ts'

const fallback = { provider: 'cli-mock', model: 'cli-mock', reasoningEffort: ReasoningEffortId('high') }

describe('resumeModelSelection', () => {
  it('uses the launch default when the log has no request header', () => {
    expect(resumeModelSelection(undefined, fallback)).toBe(fallback)
  })

  it('restores the logged provider and model without an effort', () => {
    expect(resumeModelSelection(
      { config: { provider: 'logged', model: 'logged-model' } },
      fallback,
    )).toEqual({ provider: 'logged', model: 'logged-model' })
  })

  it('keeps an effort the conversation chose', () => {
    expect(resumeModelSelection(
      { config: { provider: 'logged', model: 'logged-model', reasoningEffort: ReasoningEffortId('off') } },
      fallback,
    )).toEqual({
      provider: 'logged',
      model: 'logged-model',
      reasoningEffort: ReasoningEffortId('off'),
    })
  })

  it('omits an effort the adapter defaulted', () => {
    expect(resumeModelSelection(
      {
        config: { provider: 'logged', model: 'logged-model', reasoningEffort: ReasoningEffortId('high') },
        adapterDefaults: { reasoningEffort: true },
      },
      fallback,
    )).toEqual({ provider: 'logged', model: 'logged-model' })
  })
})
