# Post-mortem 0005: resuming old subagents after a parent model switch

English | [中文](0005-subagent-resume-after-model-switch.zh.md)

Status: operational workaround applied; individual child failures not fully diagnosed

## Executive summary

During the upstream-sync session, attempts to resume two existing Anthropic-backed subagents failed after the parent switched to an OpenAI Codex model. New subagents created under the current route completed their assignments. Current model discovery explicitly denies the old provider, and the checkout preserves a child's recorded model route across cold resume. A retained-route/current-availability mismatch is a plausible, unconfirmed hypothesis: the failed-child notifications supplied no underlying exception, so the cause of each failed turn is not established. The operational lesson is to recheck routes after a switch and hand unfinished work to a newly authorized agent rather than repeatedly waking an old one without diagnostics.

## Observed behavior

| Operation | Result in this session | What it establishes |
|---|---|---|
| Create the original workers | Requests explicitly selected `anthropic` / `claude-haiku-5-5` | Their requested route differed from the parent's later route |
| Switch the parent model | Runtime context changed to `openai-codex` / `gpt-6.1-sol` | The parent route changed; no child-route migration was reported |
| Send follow-up work to `ctrl-fixer` and `masker-refactor` | Delivery was acknowledged, then each worker failed before finishing with no closing message | Delivery acknowledgement did not establish a successful child turn |
| Query `list_subagent_models` | Only `openai-codex` was listed | Current discovery exposed no Anthropic route |
| Query `list_subagent_models({ provider: 'anthropic' })` | `LLM provider "anthropic" is not allowed for this Session` | The old provider was explicitly denied by current discovery policy |
| Create `controller-doc-review` and `masker-review` without the old route override | Both completed their assigned reviews | Fresh delegation on the current default route worked |
| Interrupt `cache-refactor` and `docs-controller` during the earlier user-requested pause | Both stopped without a closing message | Intentional interruption is not evidence of model-switch failure |

The discovery denial concerns authorization, not proof of missing credentials or a provider outage. An `inactive` row from `list_agents` does not certify completion; consult the completion notification and the actual files or task results. A failed or stopped worker may leave partial edits, so inspect its write scope before reassigning it.

## Mechanism and evidence limits

The checkout's [subagent descriptor](../../packages/subagent/subagent/src/descriptor.ts) stores `agentProvider`, `agentModel`, and `agentReasoningEffort`. [Cold restoration](../../packages/subagent/subagent/src/manager.ts) supplies those recorded fields to child materialization rather than replacing them with the parent's current selection. The [continuation test](../../packages/subagent/subagent/tests/continuation.spec.ts), “reapplies the descriptor model route and reasoning effort on cold resume”, passes in a focused run. This verifies the repository mechanism, not the unavailable exception from the running session's failed workers.

[Model discovery](../../packages/subagent/tool-subagent/src/list-models.ts) filters providers through the Session's authorized routes. Without a recorded model-selection policy, it restricts discovery to the current parent route. [Explicit child selection](../../packages/subagent/tool-subagent/src/model-selection.ts) performs a separate authorization check. A parent model switch therefore does not imply that every old child route remains selectable or that an existing child has changed models.

Repeatedly sending another message does not itself replace a recorded route. However, a discovery denial alone does not demonstrate which check or provider request failed during an existing child's wake-up. This incident lacks the failed turns' structured error, nested cause, and runtime route-resolution trace. It does not establish credential revocation, token exhaustion, incompatible reasoning effort, or a failure of every model switch. No automatic-fallback behavior or runtime fix is claimed here.

## Why the investigation repeated work

The orchestrator reused old agents before refreshing model discovery after the switch. The tool acknowledged message delivery, but the later failure notification contained neither a provider error nor a closing report. The orchestrator then had to reconstruct unfinished scope and create new workers. The actionable error from model discovery arrived only after the failed resumes. Discovery could have been queried before attempting the resumes.

## Operational mitigation

1. After a parent model switch, query `list_subagent_models` before choosing a child route or reusing a worker whose route differs.
2. After one unexplained resume failure, inspect the completion notice, task ownership, and worker write scope. Do not assume a delivery receipt means work completed, or retry repeatedly without new evidence.
3. When the old route is unavailable for fresh delegation, create a replacement on an authorized route and hand over the exact responsibility, acceptance criteria, existing evidence, and remaining work. Check for partial edits before the replacement writes.
4. Reassign the shared task explicitly when its owner changes. Task readiness does not start an idle agent; send the new owner its assignment.
5. If the original child's identity and history must be retained, preserve them and obtain its error and route-availability evidence before choosing a runtime repair. Creating a replacement is not migration of the old child.

These are operational recommendations derived from this session, not newly implemented runtime guarantees.

## Remaining diagnostic work

A complete runtime diagnosis needs a controlled switch-and-resume reproduction with the child's route before and after the switch, the current authorization policy, the actual provider resolution result, and the structured turn failure. Compare an old child with a newly created child under the same policy. Also test switching while the old route remains authorized, to distinguish model switching itself from loss of route access. Surface the failing route and actionable cause in the parent notification without exposing credentials; that behavior is proposed work, not part of this sync.
