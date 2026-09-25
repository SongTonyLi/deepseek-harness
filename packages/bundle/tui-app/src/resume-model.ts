/**
 * Resume-time model selection: the last logged route, else the launch default.
 * @module @deepseek-ai/dsh-tui-app/resume-model
 */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { EpochHeader } from '@deepseek-ai/dsh-session'

/**
 * The model the next resumed request should assemble with.
 *
 * A logged header supplies the conversation's last provider, model, and any
 * effort the adapter did not default. An adapter-defaulted effort is omitted
 * so an unchanged default does not read as a request change. A log with no
 * header uses `fallback`, the same launch default a fresh session starts from.
 *
 * @param logged - the Session's last request header, or undefined before one exists.
 * @param fallback - the composed default-model selection.
 * @returns the selection installed for prompt assembly and request routing.
 */
export function resumeModelSelection(
  logged: EpochHeader | undefined,
  fallback: ModelSelection,
): ModelSelection {
  if (logged === undefined) return fallback
  return {
    provider: logged.config.provider,
    model: logged.config.model,
    ...logged.config.reasoningEffort === undefined || logged.adapterDefaults?.reasoningEffort === true
      ? {}
      : { reasoningEffort: logged.config.reasoningEffort },
  }
}
