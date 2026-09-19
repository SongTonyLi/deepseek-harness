/**
 * Reasoning-effort rows and labels shared by `/effort`, the effort step of
 * `/model`, and the Shift+Tab picker.
 * @module @deepseek-ai/dsh-tui-app/effort
 */

import type { LlmModelReasoningInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { PickItem } from './prompts.ts'

/** Row value standing for the provider's own default; no adapter owns the empty id. */
export const PROVIDER_DEFAULT = ''

/** What the provider-default row is called. */
const PROVIDER_DEFAULT_LABEL = 'Provider default'

/** The `/effort` argument that restores the provider default. */
const DEFAULT_ARGUMENT = 'default'

/**
 * The display name of one effort.
 * @param reasoning - what the model declares.
 * @param effort - the selected effort, or undefined for the provider default.
 * @returns the declared name, the raw id when the model no longer declares it, or the provider-default label.
 */
export function effortName(reasoning: LlmModelReasoningInfo, effort: ReasoningEffortId | undefined): string {
  if (effort === undefined) return PROVIDER_DEFAULT_LABEL
  return reasoning.efforts.find(candidate => candidate.id === effort)?.name ?? effort
}

/**
 * Picker rows for one model: the provider default above the adapter's own order.
 * @param reasoning - what the model declares.
 * @returns the rows, provider default first.
 */
export function effortItems(reasoning: LlmModelReasoningInfo): PickItem[] {
  const resolved = reasoning.defaultEffort === undefined
    ? undefined
    : `resolves to ${effortName(reasoning, reasoning.defaultEffort)}`
  return [
    { value: PROVIDER_DEFAULT, label: PROVIDER_DEFAULT_LABEL, ...resolved === undefined ? {} : { description: resolved } },
    ...reasoning.efforts.map(effort => ({
      value: effort.id,
      label: effort.name,
      ...effort.description === undefined ? {} : { description: effort.description },
    })),
  ]
}

/**
 * The dim row under the picker heading.
 * @param reasoning - what the model declares.
 * @param effort - the effort in force, or undefined for the provider default.
 * @returns one row naming the effort in force and how to dismiss the picker.
 */
export function effortHint(reasoning: LlmModelReasoningInfo, effort: ReasoningEffortId | undefined): string {
  return `current: ${effortName(reasoning, effort)} · Esc keeps it`
}

/**
 * The effort a typed `/effort` argument names. A declared id wins over the
 * `default` keyword, so an adapter may own that id.
 * @param reasoning - what the model declares.
 * @param typed - the argument, matched against declared ids without case.
 * @returns the declared effort, undefined for the provider default, or null when the model declares no such effort.
 */
export function matchEffort(reasoning: LlmModelReasoningInfo, typed: string): ReasoningEffortId | undefined | null {
  const wanted = typed.toLowerCase()
  const declared = reasoning.efforts.find(effort => effort.id.toLowerCase() === wanted)
  if (declared !== undefined) return declared.id
  return wanted === DEFAULT_ARGUMENT ? undefined : null
}
