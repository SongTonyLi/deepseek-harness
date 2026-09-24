# Agent Note: Ship Auto review on the TUI profile

Status: implemented

English | [中文](2026-09-24-tui-auto-review.zh.md)

## Problem

[Auto review](2026-08-28-auto-review.md) is an optional Web bundle. The terminal has the same permission picker and approval prompt, but a stock TUI profile never mounts the layer, and a prompt typed there has `source.kind === 'user'` with no `rpcId`, so the reviewer does not treat it as a human instruction.

## Decision

The shipped `tui` template selects `@deepseek-ai/dsh-experimental-auto-review` after `dsh-base` and `dsh-tui-app`. A profile whose bundle list is still exactly those two names is rewritten to the template on the next load; any other list is left as it is. Web, Headless, General settings, and new-session defaults stay without the layer. Default-product isolation allows this optional bundle only when the TUI template is its sole shipped selection.

Each prompt the person submits from the terminal stores `{ kind: 'user', rpcId }` with a new id. Auto review's existing check treats that id as a human instruction. A revised draft keeps a non-user source. Child creation prompts stay without `rpcId`.

## Alternatives considered

**Leave Auto review opt-in through `/plugins enable`.** The terminal can already switch the bundle on, but a stock profile after install never has the mode, and typed instructions still would not authorize medium-risk calls.

**Treat every `{ kind: 'user' }` source as a human instruction.** Headless and child-creation prompts use that source and must stay facts or direct-parent instructions.

## Consequences

- `/permission` on a stock TUI profile lists Auto review. Selecting it is the current-session switch; future-session defaults still omit it.
- A stock profile that had added another bundle does not gain Auto review until its bundle list includes the package.
- A terminal prompt can authorize a medium-risk call. A prompt recorded before this id does not.

## Related decisions

- [Auto review](2026-08-28-auto-review.md) — authority, lifecycle, and the `rpcId` check.
- [Optional bundles](../architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md) — Web still switches the layer on from the Plugins page.
