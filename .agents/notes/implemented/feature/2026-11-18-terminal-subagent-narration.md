# Agent Note: Subagent progress narration in the terminal profile

Status: implemented

English | [中文](2026-11-18-terminal-subagent-narration.zh.md)

## Problem

The terminal's activity board draws one row per running subagent. Each row shows the last sentence of the child's latest assistant message beside the child's task label, and that sentence exists only when the model writes text before a tool call. The board therefore needs an instruction that reaches each terminal child. Web, headless, and SDK children do not draw the board.

The instruction was first placed in `SUBAGENT_DELEGATION_CONTEXT`, the statement that every in-process child carries. Upstream maintains that statement and extended it with message-authorship sentences, which the sync brought into this branch; the narration sentence is kept out of the shared statement.

## Decision

The narration sentence is a terminal-only runtime-context entry named `tui:subagent-narration`. The `tui-app` listener registers it on each `agent/created` event whose agent has a delegation depth above zero, so every in-process child receives it, whether spawned or forked. Top-level agents and `/btw` side agents have depth zero and receive no entry. The listener removes the entry when its agent is disposed and when the plugin is disposed. The entry is part of the child's runtime-context snapshot, like the delegation statement, so the child's session log records it.

The entry sorts at `SUBAGENT_DELEGATION` + 0.5 (120.5), directly after the `subagent:delegation` statement. `SUBAGENT_DELEGATION` is 120, and the experimental timeline's `timeline:maintenance` context uses the integer 121. The sentence wording is unchanged from [the earlier decision](2026-10-23-subagent-progress-narration.md). The sentence is not part of `SUBAGENT_DELEGATION_CONTEXT`, which states the delegation scope and message authorship only.

## Alternatives considered

**Keep the sentence in `SUBAGENT_DELEGATION_CONTEXT` for every child.** Rejected: this is the superseded decision. Only the terminal draws the board, so Web, headless, and SDK children would write the sentence without a board to draw, and fork-owned text would sit inside the statement upstream maintains.

**A runtime config field in the subagent plugin.** Rejected: a terminal-only switch would place terminal behavior in the shared `@deepseek-ai/dsh-subagent` package and require the child composition to carry the field. The listener keeps the entry in the package that owns the terminal.

**A named placement in `dsh-system-prompt`.** Deferred: a named runtime-context placement would replace the half-step order. Until it exists, the half step is the documented placement, as the [terminal README](../../../../packages/bundle/tui-app/README.md) records.

## Verification

- `packages/bundle/tui-app/tests/subagent-narration.spec.ts` covers placement and recipients: an in-process child receives the entry directly after `subagent:delegation`, a top-level agent and a `/btw` side agent receive none, and disposing a child or the installation removes the entry.
- `packages/bundle/tui-app/tests/subagent-narration-loader.spec.ts` boots the plugin through the Loader from a test-only `cordis.yml` and drives a parent's `subagent` tool call: the child's first model request carries the sentence after its delegation statement, and the same flow without the entry applied carries none.
- `packages/subagent/subagent/tests/activation-policy.spec.ts` checks the delegation statement in the child's runtime context; it does not reference the narration sentence.
- Recorded child sessions under `snapshots/` and expected child logs under `apps/cli/tests/profiles/headless/tests/expected/` carry no narration sentence, so their keyless replays through `pnpm run test:snapshot` and `pnpm run test:expected` do not include it.
- No hands-on TUI run with a real model was possible: the environment has no `DEEPSEEK_API_KEY`.

## Consequences

- Web, headless, and SDK children do not narrate. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.5/child-progress-narration/guide.md) tells hosts that read a child's latest sentence as its progress how to migrate.
- The terminal board keeps one row per running child. A child that skips the sentence draws its label alone.
- Each child started by the terminal profile carries about 30 more tokens in its first runtime-context snapshot, written once and prefix-stable; the parent's requests do not change.
- A child's result is still its last non-empty assistant message, so a narration sentence becomes the result only when it is the final text.
- The half-step order (120.5) is a known limitation; a named `dsh-system-prompt` placement would replace it and is deferred.
