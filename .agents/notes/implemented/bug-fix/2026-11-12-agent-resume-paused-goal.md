# Agent Note: Agent resume of a paused goal

Status: implemented

English | [中文](2026-11-12-agent-resume-paused-goal.zh.md)

## Problem

A paused goal could be resumed only from the goal bar or `/goal resume`. `update_goal` action `resume` rejected that phase with `GOAL_TOOL_RESUME_PAUSED` even when the current turn already contained a direct human message. An exact continue phrase left the goal paused and told the model it was not resumed. The person had to use a separate control before the agent could continue the objective.

## Decision

A direct human turn may resume a paused goal through `update_goal` action `resume`, under the same live-agent and direct-human checks as pause and edit. A goal round with no direct human message still cannot resume. Web and `/goal resume` remain able to resume the same goal.

An exact continue-intent — the closed phrases already recognized by `@deepseek-ai/dsh-goal-round-driver` — resumes a paused goal that still has round capacity, arms it, and appends the existing resumed notice. A paused goal with no remaining rounds stays paused and gets no notice, the same as an active-disarmed goal that has exhausted its cap. Blocked and complete goals stay unrearmed by that phrase.

The goal system prompt is unchanged. It still tells the model to rearm a disarmed goal when a human asks to continue, and it does not name paused goals. This decision supersedes only the paused-resume rejection in the [model-facing goal tools decision](../feature/2026-07-19-model-facing-goal-tools.md). Autonomous rounds still cannot edit, pause, or resume a goal.

## Alternatives considered

**Let an automatic goal round resume a paused goal with no new human message.** Rejected because a pause would then undo itself inside the continuation the pause was meant to stop.

**Resume paused goals only for an exact continue phrase, and keep `update_goal` rejected.** Rejected because pause and edit already accept any direct human turn, and the model judges whether the wording asks to continue.

**Name paused goals in the system prompt.** Rejected for this change. The prompt text and its pinned sidecars stay as they are; execution accepts the resume, and the continue-intent notice already says when a phrase resumed the goal.

## Testing

`packages/goal/tool-goal/tests/tool-goal.spec.ts` resumes a paused goal in the same human turn and in a later human turn, and rejects resume in a goal round that has no human message. `packages/goal/goal-round-driver/tests/goal-round-driver.spec.ts` resumes a paused goal with remaining rounds when the user says `continue`, then admits the following goal round. Blocked, complete, and exhausted active-disarmed continue behavior stays covered by the existing driver tests.

## Consequences

A human message lets the model unpause a goal when it judges that the request asks to continue. The runtime does not check the wording of that message. An exact continue phrase resumes a paused goal that still has rounds and can start the next goal round without a separate control. A goal round still cannot resume a paused goal on its own.
