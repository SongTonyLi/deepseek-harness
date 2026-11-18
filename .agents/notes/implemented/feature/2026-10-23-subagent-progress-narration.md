# Agent Note: Subagent progress narration in the delegation context

Status: implemented

Partially superseded: the every-child scope is replaced by [terminal-only narration](2026-11-18-terminal-subagent-narration.md); the wording and the board rationale remain.

English | [中文](2026-10-23-subagent-progress-narration.zh.md)

## Problem

The terminal's activity board draws one row per running subagent. Built from the child's tool calls and results, a row read `calling read · 1| /** … */`: which tool ran, not what the child was doing for its task. A child's assistant messages carry that information only when the model writes text before a tool call, and nothing asked it to.

## Decision

`SUBAGENT_DELEGATION_CONTEXT` ends with one more sentence: `Before each tool call, say in one short sentence what you are doing and why it serves the task, so your progress can be followed.` It rides the existing `subagent:delegation` runtime-context contribution, so every in-process child, spawn and fork alike, carries it in its own logged context and the deployment's system prompt stays uniform across parents and children.

The sentence names no interface. It asks for task-relevant narration, and any host that follows children reads it from the same assistant messages. The terminal draws the last sentence of a child's latest assistant message beside the child's task label ([terminal README](../../../../packages/bundle/tui-app/README.md)). A child's result is unchanged: the parent still receives the last non-empty assistant message.

## Alternatives considered

**Apply the sentence in the terminal profile only.** Rejected: it needs a new subagent runtime config field and plumbing from the runtime into the child composition so that headless, web, ACP, and SDK children keep their text. The sentence is about 30 tokens in a context every child already carries, and narration is not terminal-specific.

**An explicit progress tool.** Rejected for now: its notes are always task-relevant, but it adds a tool to every child's schema, one call per update, and a prompt instruction to use it.

**A side model that summarizes the child's recent activity.** Rejected: it adds model cost, latency, and a provider and configuration dependency for status text.

**Draw the child's reasoning when it writes no text.** Rejected: reasoning is a scratchpad, often long and not a statement of what the child did.

## Verification

- `packages/subagent/subagent/tests/activation-policy.spec.ts` asserts that the child's runtime context carries the delegation statement and its system prompt does not; the narration sentence is covered by the [TUI listener tests](2026-11-18-terminal-subagent-narration.md) instead.
- Recorded child sessions under `snapshots/` and expected child logs under `apps/cli/tests/profiles/headless/tests/expected/` carry no narration sentence, so their replays through `test:snapshot` and `test:expected` do not include it.
- No controlled probe measured how often the models follow the sentence, unlike the [end-turn guidance](../bug-fix/2026-10-21-subagent-end-turn-guidance.md). A child that skips it draws its label alone.

## Consequences

- Each child started by the terminal profile carries about 30 more tokens in its first runtime-context snapshot, written once and prefix-stable; the parent's requests do not change.
- Terminal children write one sentence of text before tool calls. It appears in the child's transcript and session view, and it can become the child's result only if it is the last non-empty assistant message.
- A model that ignores the sentence leaves its terminal row at the label and spinner.
