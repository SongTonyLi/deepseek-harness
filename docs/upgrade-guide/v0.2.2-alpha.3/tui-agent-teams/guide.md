---
kind: upgrade-guide
description: "The TUI replaces experimental Team membership and delegation with standard subagent identities, task tools, and managed saved-child continuation."
---

# Agent Teams in the TUI uses standard subagents

English | [中文](guide.zh.md)

## Change

The shipped TUI enables Team mode through the base composition instead of the retired `@deepseek-ai/dsh-experimental-agent-team-profile` bundle. `/team on` and `/team off` save the root Session's selection; turning Team off keeps children and tasks. These TUI commands remain available independently of the Web conversation menu.

Teammates are continuable entries in the standard subagent catalog. The TUI displays their root-relative names and task descriptions; older unnamed entries use their labels. Team-specific creation and model discovery give way to `subagent`, `subagent_fork`, and `list_subagent_models`. Shared task tools address owners by name, with Session ids accepted as a fallback.

Opening a saved child reads its conversation without resuming an Agent. Continuing it uses the managed subagent prompt operation, which restores saved presets, permissions, and ownership. TUI child-continuation prompts accept text only; attachments remain available in ordinary root conversations. See the [TUI reference](../../../../packages/bundle/tui-app/README.md).

## Migration

1. Remove the retired experimental Team bundle from custom profile selections and overlays. Use the shipped `tui` profile; custom compositions use `@deepseek-ai/dsh-agent-team` and `@deepseek-ai/dsh-tool-agent-team` with the standard subagent plugins.
2. Replace `spawn_teammate` with `subagent` or `subagent_fork`, and save the returned agent name. Replace `list_teammate_models` with `list_subagent_models`; explicit routes use separate `provider`, `model`, and optional `reasoning_effort` fields.
3. Use the name from the start receipt or `list_agents` for message recipients and task owners; existing Session ids remain accepted. Give each child a task description and, optionally, a name. See the [subagent names upgrade guide](../subagent-names/guide.md) for the tool argument changes.
4. Resume the root Session, use `/team` or `/team-play` to inspect a saved child, and submit a text continuation. Confirm its reply appears and the parent retains the child in its catalog. Use `/team off`, then `/team on`, to verify the saved tasks remain.
