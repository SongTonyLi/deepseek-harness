---
description: "Advisory loop-hygiene guard that nudges the model out of identical tool-call loops, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-repeat-tool-reminder

English | [中文](README.zh.md)

## Summary

This package helps a model escape loops in which it calls the same tool with identical arguments without making progress. At configured repeat counts, it asks the model to inspect the previous result and change approach or finish. Reminders are advisory and never delay a call; an optional `blockThreshold` denies a further identical tracked call so the tool body does not run. Repeats are tracked separately for each agent and cleared by a new user message. The `dsh` base bundle enables the package with reminders at 3, 5, and 8 repeats.

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

Mount this plugin when the model should catch itself looping on identical tool calls. There is nothing to learn or wire: the `dsh` base bundle already runs it, and the defaults work for most sessions — tune the thresholds and tool scope below when you want the nudge sooner, later, or on fewer tools.

### When to choose it

Choose it when the model works autonomously for long stretches and a stuck loop is the failure you want to break with advice, or with a deny once `blockThreshold` is set. Leave `blockThreshold` unset when identical repeats are legitimate and must run — a reminder is only a small extra message after the repeated call — and avoid the package when near-identical variants must be caught, because only exact repeats (same tool, same arguments regardless of property order) are detected.

### Setting the thresholds and scope

When you want to change when reminders fire or which tools they cover, mount the plugin with configuration:

```yaml
- name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # remind at 3, 5, and 8 consecutive repeats
    include: []                  # track every tool; list patterns to track only some
    exclude: [todo_write]        # never track these tools
    argumentsPreviewChars: 500   # cap on arguments shown in the detailed reminder
    blockThreshold: 12           # deny at this consecutive count; omit to stay advisory-only
    blockProviders: [cursor]     # routes that honor blockThreshold; default is the Cursor subscription route
```

| Field | Default | Meaning |
|---|---|---|
| `thresholds` | `[3, 5, 8]` | Repeat counts that trigger a reminder |
| `include` | `[]` | Only these tools are tracked; empty means every tool |
| `exclude` | `[]` | These tools are never tracked; calls to them neither count nor reset |
| `argumentsPreviewChars` | `500` | How many characters of the repeated arguments the detailed reminder shows |
| `blockThreshold` | unset | Consecutive-repeat count at which an identical tracked call is denied before execute; omit to stay advisory-only |
| `blockProviders` | `['cursor']` | Provider routes that honor `blockThreshold`; empty denies no route. Reminders still run for every provider |

Invalid configuration fails at startup with a clear error — an empty `thresholds` list, a repeat count below 2, a duplicate, or an invalid `blockThreshold` — never a silent change of behavior. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) documents every accepted value.

### What you get

With the defaults, a model that repeats the same call with identical arguments receives a short reminder on the third repeat — to analyze the previous result before calling again — and detailed reminders on the fifth and eighth, naming the tool and the repeated arguments so it can decide whether to change approach, gather more evidence, or finish. When `blockThreshold` is set, the call that would reach that count is denied before the tool body runs if the agent's current or selected provider is in `blockProviders` (default the Cursor subscription route `cursor`); the model sees the deny reason and the chain still counts the denied attempt. A DeepSeek or pi-ai catalog route is not denied. A new user message clears the count, so a fresh instruction is never treated as a loop. Reminders appear in the conversation after the repeated call's result, attributed to the plugin, so the model reads them like any other message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard detects repeats and delivers reminders, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on four commitments:

- **Advisory by default; optional deny.** Reminders enrich post-execute decisions with model context and never rewrite a call. When `blockThreshold` is set, `tools/pre-execute` denies an identical tracked call; `PostToolDecision` blocking stays a later listener's job.
- **Count in post-execute.** Detection still runs on `tools/post-execute`, which also fires for denied calls; pre-execute only peeks at the last key and count so a deny does not double-increment.
- **Exact-match canonicalization.** Arguments reach the guard as the loop's `JSON.parse` output (or its raw-string fallback), so JSON's value domain is the whole input domain and a deep key-sort plus `JSON.stringify` is a complete, deterministic identity — no bigint, cycle, or `undefined` handling exists because no input path can produce them.
- **Fail loud at load.** `thresholds`, `argumentsPreviewChars`, and `blockThreshold` validate in `apply` and throw, never falling back to defaults.

### Detection: the repeat chain

Each agent's chain is keyed by `(tool name, canonical arguments)` — two calls with the same tool and canonically identical arguments (property order ignored) count as consecutive, and a different tracked call resets the count to 1. The chain lives in a `WeakMap<Agent, Chain>`.

- **Untracked calls are transparent to the chain.** A call excluded by `include`/`exclude` neither increments nor resets the counter, so `grep X → todo_write → grep X` still counts as two consecutive `grep X` when `todo_write` is excluded — bookkeeping tools interleaved into a loop do not launder it.
- **Denied calls count.** Detection sits on `tools/post-execute`, which also runs for calls a `tools/pre-execute` listener denied — including this guard's own `blockThreshold` deny; a model hammering a denied call is exactly the loop worth breaking.
- **Blocking peeks, then post-execute counts.** When `blockThreshold` is set, `tools/pre-execute` denies if a matching chain's `count + 1` would reach that value; it does not increment. The denied attempt still flows through post-execute, which advances the count and may also attach a reminder.
- **Calls without an agent are ignored.** A direct `ctx.tools.execute()` caller has no model to remind and no live agent object to key on.
- **Per-agent keying, reset on user prompts.** One agent's repetition never trips another's reminder; a user prompt (`agent/pre-step`) deletes the submitting agent's chain, and object lifetime bounds the weak entry without a disposal listener.
- **In-memory only.** A session resumed from persistence starts with a fresh chain — the guard is a heuristic nudge, not a logged invariant, so reminders after a resume are the accepted cost.

### Reminder delivery

Reminders ride the post-execute decision's `additionalContexts` (source `{kind: 'plugin', plugin: 'repeat-tool-reminder', form: 'notice', summary: '<tool> × <count>'}`), never a `content` replacement: the `tool/result` event stays the tool's own output for audit. The loop buffers the context and appends it as an injected `user/message` after the step's tool results, which the session renders as a plain synthetic user message — model-visible, source-attributed, and reconstructable from the session log with no new session event. The guard always delegates via `next()` and prepends its reminder to the downstream decision's context array, so both decision variants (a blocked call included) still get the nudge while every entry retains its own source and metadata.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, chain listeners |
| — | No runtime invariant companion is published; the repeat chain is private to this plugin's listeners and exposes no package-owned event or snapshot that an independent companion can observe. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tools waterfall to exhaustive configuration and the guard group map.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/execute` waterfall, `additionalContexts`, and decision shapes this guard consumes.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted config field and its source declaration.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### First-threshold context message

#### What the model sees

At the first configured consecutive-repeat threshold, that agent receives the reminder below. No tool schema or normal-call text is added.

##### First-threshold reminder

```markdown
You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.
```

#### Token effect

Zero tokens before the threshold. The reminder is retained history for that agent.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Later-threshold context message

#### What the model sees

A later threshold receives the detailed reminder template below. A capped argument preview ends exactly `… (+<omitted> more chars)`.

##### Later-threshold reminder

```markdown
Repeated tool call detected:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.
```

#### Token effect

Each reminder is retained history; `argumentsPreviewChars` bounds its data-dependent argument text, while agents keep independent counters.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Blocked identical-call result

#### What the model sees

When `blockThreshold` is set and the next identical tracked call would reach that count, the call is denied before the tool body runs. The deny reason starts with the sentence below; a second line names the tool.

##### Identical-call deny reason

```markdown
identical to your previous call; no state changed
```

#### Token effect

The denied call still produces a tool-result error in history. Zero extra tokens when `blockThreshold` is unset or not yet reached.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Exact-match detection only** — canonicalization is a deep key-sort, so near-identical variants (a tweaked path, extra whitespace inside a value) evade the chain; fuzzy matching is rejected pending evidence of need.
- **Compaction does not reset chains** — a chain spanning a compaction checkpoint keeps counting.
- **Polling tools** — identical repeats that must run (status polls) should stay in `exclude` or leave `blockThreshold` unset; a set threshold denies those repeats once the count is reached.
- **No subagent chain-sharing** — chains stay isolated per agent; a parent and its subagent repeating the same call never combine.
- **Legitimate idempotent polling still draws nudges** past the reminder thresholds — `thresholds`/`exclude` remain the reminder valves; `blockThreshold` is the deny valve.
- **Past the highest threshold a chain goes silent** — reminders fire only at exact configured counts, never beyond them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The [repeat-tool-guard feature note](../../../.agents/notes/archived/feature/2026-07-08-repeat-tool-guard.md) records the original design and alternatives under the former package name; the [naming ledger](../../../.agents/notes/archived/architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md) records the rename to `repeat-tool-reminder` and its reason.

</details>
