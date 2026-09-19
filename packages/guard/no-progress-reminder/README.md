---
description: "Advisory loop-hygiene guard that nudges the model after idle goal turns with no file mutation, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-no-progress-reminder

English | [中文](README.zh.md)

## Summary

Use this package to nudge a model that spends whole turns on recap, skills, or todos while a goal is active and no file changes. After a configured number of idle turns, the next step receives a notice naming the count and asking for a read, edit, write, or bash call, or a blocker explanation. The notice is advisory and never blocks a tool. Continue does not clear the count; only a successful mutating tool or a cleared or completed goal does. The dsh base bundle enables it at five idle turns on the Cursor subscription route (`provider: cursor`).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a long goal-driven session on a Cursor subscription model should catch itself looping on recap, skills, or todos without changing a file. The `dsh` base bundle already runs it for the `cursor` route; tune the idle-turn count, mutating-tool patterns, goal requirement, or `providers` list below when you want the nudge on other routes, sooner, later, or without a current goal.

### When to choose it

Choose it when the model works toward a standing goal for many turns and the failure you want to break is bookkeeping without tree mutations. Avoid it when idle analysis is legitimate and must run undisturbed, and when mutation happens through tool names outside the default `edit` / `write` / `bash` list — those names are configurable, but a missed pattern will keep counting.

### Setting the idle count and mutating tools

When you want to change when the notice fires or which successful tools clear it, mount the plugin with configuration:

```yaml
- name: '@deepseek-ai/dsh-no-progress-reminder'
  config:
    idleTurns: 5
    mutatingTools: [edit, write, bash]
    requireGoal: true
    providers: [cursor]
```

| Field | Default | Meaning |
|---|---|---|
| `idleTurns` | `5` | Whole turns without a successful mutating tool that trigger a notice |
| `mutatingTools` | `['edit', 'write', 'bash']` | Tool-name `*`-wildcard patterns whose successful calls reset the count |
| `requireGoal` | `true` | Count and inject only while a goals service is present and the agent's goal is `active` |
| `providers` | `['cursor']` | Provider routes that participate; empty matches none. Default is the Cursor subscription route |

Invalid `idleTurns` fails at startup with a clear error — a non-integer or a value below 1 — never a silent change of behavior. A missing goals service or a non-live agent with `requireGoal: true` is a no-op at call time, not a throw. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-no-progress-reminder) documents every accepted value.

### What you get

With the defaults, a Cursor subscription model that finishes five whole turns on an active goal without a successful `edit`, `write`, or `bash` call receives a notice on the next step naming that idle count and asking it to read, edit, write, or bash, or to explain what blocks it. A DeepSeek or pi-ai catalog route does not receive the notice. A later idle turn without a mutation receives the notice again (once per turn). A user continue does not clear the debt. A successful mutating tool, or a cleared or completed goal, resets the count. Notices appear as additional user messages attributed to the plugin.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard counts idle turns and delivers notices, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on four commitments:

- **Advisory, not veto.** The guard appends a sourced user message on `agent/pre-step`; it never blocks or rewrites a tool call.
- **Count whole turns.** Detection increments on `turn/end`, so several bookkeeping tools in one turn still count as one idle turn.
- **Reset only on mutation or goal end.** A successful `tools/post-execute` whose name matches `mutatingTools`, or a `goal/change` whose operation is `clear` or `complete`, zeros the count. A user-kind message does not.
- **Fail loud at load.** `idleTurns` validates in `apply` and throws, never falling back to a hidden default inside the listeners.

### Detection: the idle-turn counter

Each agent's counter lives in a `WeakMap<Agent, IdleState>`.

- **Goal gating.** When `requireGoal` is true, a turn is counted only if `ctx.get('goals')` exists, the agent is the registry's live instance, and `goals.get(agent)` has phase `active`. A missing goals service or a non-live agent does nothing. When `requireGoal` is false, every turn is eligible.
- **Mutation resets the current turn.** A matching successful call marks the open turn so its later `turn/end` does not increment.
- **Unmatched tools are transparent.** `todo_write`, `skill`, `get_goal`, and any name outside `mutatingTools` neither reset nor block counting.
- **Failed mutating calls do not reset.** Only `isError === false` clears the debt.
- **Per-agent keying.** One agent's idle run never trips another's notice.
- **In-memory only.** A session resumed from persistence starts with a fresh counter.

### Notice delivery

Notices ride `agent/pre-step` as additional user messages (source `{kind: 'plugin', plugin: 'no-progress-reminder', form: 'notice', summary: 'no progress'}`). After `idleTurns` consecutive counted turns, the first pre-step of the next turn receives the notice; later steps of that same turn do not. A further idle turn injects again with the updated count. The guard always delegates via `next()` and appends its notice only onto an `enter` decision.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, idle-turn listeners |
| — | No runtime invariant companion is published; the idle-turn chain is private to one listener set and exposes no package-owned event or snapshot that an independent companion can observe. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tools waterfall and goal service to the guard group map.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/post-execute` waterfall and `agent/pre-step` decision this guard consumes.
- [Goal service](../../goal/goal/README.md) — the optional `ctx.goals` lookup this guard reads when `requireGoal` is true.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-no-progress-reminder) — accepted config fields collected from plugin schemas.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### Idle-progress context message

#### What the model sees

After `idleTurns` consecutive counted turns with no successful mutating tool, that agent receives the notice below on the next step. No tool schema or normal-call text is added.

##### Idle-progress notice

```markdown
No file has changed in <N> turns. Your next tool call must be read, edit, write, or bash, or explain what blocks you.
```

#### Token effect

Zero tokens before the threshold. Each notice is retained history for that agent; `<N>` is the counted idle-turn total at injection.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **In-memory only** — a resumed session starts with a fresh counter, so idle debt does not survive process restart.
- **Advisory only** — the notice never blocks a tool call or forces a mutating tool.
- **Read does not reset** — a successful `read` is not in the default `mutatingTools` list, so inspection alone keeps the debt.
- **User continue does not reset** — a new user-kind message leaves the count unchanged.
- **Compaction does not reset** — a counter spanning a compaction checkpoint keeps counting.
- **No cross-agent sharing** — a parent and its subagent keep separate counters.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above and the package code.

None.

</details>
