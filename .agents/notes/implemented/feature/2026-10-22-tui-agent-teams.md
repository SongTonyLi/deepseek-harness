# Agent Note: Select Agent Teams on the TUI template

Status: implemented

English | [中文](2026-10-22-tui-agent-teams.zh.md)

## Problem

Terminal work needs Team delegation — a durable roster, shared tasks, and `spawn_teammate` — from the profile `dsh tui` creates. Web, headless, SDK, and ACP templates keep ordinary subagent tools. `@deepseek-ai/dsh-experimental-agent-team-profile` is experimental, so a release package cannot depend on it.

## Decision

The shipped `tui` template selects `@deepseek-ai/dsh-experimental-agent-team-profile` after `@deepseek-ai/dsh-experimental-auto-review`. Default-product isolation allows that optional bundle because the TUI template is its only shipped selection, and TUI predecessor tuples may repeat the same bundle. A profile whose bundle list is exactly `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui-app']`, or that list plus `@deepseek-ai/dsh-experimental-auto-review`, is rewritten to the template on the next load. Any other list stays unchanged. Web, headless, SDK, and ACP templates do not select the bundle.

The bundle disables `subagent`, `subagent_fork`, and the overlapping global child controls, and adds `spawn_teammate` plus the Team task tools.

## Alternatives considered

**Leave it opt-in through `/plugins enable`.** The terminal can switch the bundle on, and a fresh profile then keeps `subagent` and `subagent_fork` without `spawn_teammate` or the Team task tools.

**Mount the service inside `dsh-tui-app`.** A release package must not depend on the experimental package.

## Consequences

- A stock TUI session can delegate with `spawn_teammate`.
- A profile that already added another bundle does not gain the layer.
- An empty root session draws a start card that says Agent Teams is on and names `/plugins disable @deepseek-ai/dsh-experimental-agent-team-profile`.
- `/team-play` plays how teammates message each other. `/subagents` still opens one teammate's transcript.

## Related decisions

- [Agent Teams](2026-08-05-agent-teams.md) — roster, tasks, mailbox, and the composition outside this template.
- [Auto review on the TUI profile](2026-09-24-tui-auto-review.md) — the preceding optional bundle on the same template, and the same predecessor lists.
- [Shipped optional bundles](../process/2026-09-15-shipped-optional-bundles.md) — the installation list and the TUI selection exception.
