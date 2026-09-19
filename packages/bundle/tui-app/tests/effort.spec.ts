/** Reasoning-effort rows, labels, and argument matching. */

import { describe, expect, it } from 'vitest'
import { ReasoningEffortId, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { PROVIDER_DEFAULT, effortHint, effortItems, effortName, matchEffort } from '../src/effort.ts'

const reasoning: LlmModelReasoningInfo = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High', description: 'slow' },
  ],
}

describe('reasoning effort rows', () => {
  it('lists the provider default above the declared efforts', () => {
    expect(effortItems(reasoning)).toEqual([
      { value: PROVIDER_DEFAULT, label: 'Provider default' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High', description: 'slow' },
    ])
    expect(effortItems({ ...reasoning, defaultEffort: ReasoningEffortId('high') })[0])
      .toEqual({ value: PROVIDER_DEFAULT, label: 'Provider default', description: 'resolves to High' })
    expect(effortItems({ efforts: [], defaultEffort: ReasoningEffortId('gone') })[0]?.description).toBe('resolves to gone')
  })

  it('names the effort in force, falling back to its raw id', () => {
    expect(effortName(reasoning, ReasoningEffortId('high'))).toBe('High')
    expect(effortName(reasoning, ReasoningEffortId('stale'))).toBe('stale')
    expect(effortName(reasoning, undefined)).toBe('Provider default')
    expect(effortHint(reasoning, ReasoningEffortId('low'))).toBe('current: Low · Esc keeps it')
  })

  it('matches an argument against the declared ids before the default keyword', () => {
    expect(matchEffort(reasoning, 'HIGH')).toBe('high')
    expect(matchEffort(reasoning, 'default')).toBeUndefined()
    expect(matchEffort(reasoning, 'turbo')).toBeNull()
    const owned: LlmModelReasoningInfo = { efforts: [{ id: ReasoningEffortId('default'), name: 'Default' }, ...reasoning.efforts] }
    expect(matchEffort(owned, 'Default')).toBe('default')
  })
})
