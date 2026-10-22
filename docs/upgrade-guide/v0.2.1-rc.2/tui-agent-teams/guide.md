---
kind: upgrade-guide
description: "The stock tui profile mounts Agent Teams, and the two previous bundle lists rewrite to that template."
---

# Stock tui profiles mount Agent Teams

English | [中文](guide.zh.md)

## Change

A stock `tui` profile did not mount Agent Teams. The shipped template now appends `@deepseek-ai/dsh-experimental-agent-team-profile` after `@deepseek-ai/dsh-experimental-auto-review`. On the next launch, a profile whose `dsh.profile.bundles` is exactly `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui-app']`, or that list plus `@deepseek-ai/dsh-experimental-auto-review`, is rewritten to the template. Any other list is unchanged. Web, headless, SDK, and ACP templates do not gain the bundle.

The bundle disables `subagent`, `subagent_fork`, and the overlapping global child controls, and adds `spawn_teammate` plus the Team task tools.

## Migration

1. To keep the previous tools, remove `@deepseek-ai/dsh-experimental-agent-team-profile` from `dsh.profile.bundles` in `$DSH_HOME/profiles/tui/package.json`.
2. Confirm with `dsh tui`. An empty session's start card reads `Agent Teams is on by default` and names `/plugins disable @deepseek-ai/dsh-experimental-agent-team-profile`. `/team-play` plays an example until the session has teammate messages; `Esc` closes it. A profile that removed the bundle has no start card, and `/team-play` reports `Agent Teams are not enabled in this composition`.
