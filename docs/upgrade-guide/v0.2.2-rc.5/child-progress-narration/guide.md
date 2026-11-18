---
kind: upgrade-guide
description: "Web, headless, and SDK subagents stop receiving the progress sentence before each tool call; the terminal profile keeps it."
---

# Web, headless, and SDK subagents no longer narrate tool calls

English | [中文](guide.zh.md)

## Change

Every in-process child agent used to receive a delegation statement that asks it to say one short sentence before each tool call, so a host could show the child's progress. That sentence is now added only by the terminal profile (`dsh --profile tui`), as the runtime-context entry `tui:subagent-narration`. Children started by Web, headless, and SDK hosts no longer receive it, so their assistant messages carry no progress sentence before tool calls. The `subagent:delegation` statement itself is unchanged.

Hosts that read a child's latest assistant sentence as its progress show less text. A child's result is still its last non-empty assistant message.

## Migration

1. If your host shows a child's progress from its latest assistant sentence, derive progress from the child's tool-call events in its session log, or ask the child in its task to report progress.
2. Confirm the migration: the child's runtime-context events in its session log should no longer contain `progress can be followed`, and the host should still show the child's tool calls.
