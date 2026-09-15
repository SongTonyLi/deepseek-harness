---
description: "Interactive terminal mode for dsh: talk to the agent in your terminal with streamed replies, tool cards, approvals, questions, slash commands, @-references, attachments, and session switching."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

English | [中文](README.zh.md)

## Summary

`dsh-tui-app` is the terminal surface of dsh: `dsh tui` starts a multi-turn session in the terminal you are already in, with no browser and no server. Replies stream as you watch, tool calls become foldable cards, approvals and `ask_user_question` questions appear above the input, `@` completes paths and sessions, `/attach` adds images and files, and `/`-commands share the Web registry. Sessions persist: `/sessions`, `/new`, and `/fork` switch between them, `/export` writes the browser's ZIP, and `--resume` continues one later. It runs the same model, tools, and safety defaults as `dsh web`, one session at a time.

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

Start a session, type, and read the answer in place. `dsh tui` is an alias of `dsh --profile tui`; an optional first prompt on the command line is submitted as soon as the terminal is up.

### Starting and resuming

```sh
dsh tui                                   # new session, wait for input
dsh tui "explain this repository"         # new session with a first prompt
dsh tui --resume <session-id>             # continue an earlier session
```

On quit the app prints `dsh: session <id> saved; resume with: dsh --profile tui --resume <id>` on stderr for the session bound at that moment. A resumed session redraws its persisted history before accepting input; inside the terminal, `/sessions` opens a picker over every persisted root session, `/new` starts a fresh one, and `/fork` copies the current session up to its last completed turn into a new one, the same cut the browser's fork takes. Switching releases the previous Agent and redraws the transcript of the next.

### The screen

The header names the session by its title once one is generated or set, with the id beside it. The transcript grows in the terminal's own scrollback: your prompts start with `›` (attachments listed under them), assistant reasoning is dim above the Markdown reply, and each tool call is a card with a status glyph, the tool name, the presenter headline, and a body folded to `toolPreviewLines` rows. Below the transcript sit a spinner while the agent works, any open prompt, the editor, and a two-line footer with the model and reasoning effort, the permission preset, cumulative token usage, the context window percentage, todo and goal and plan-mode markers from the projection seam, the workspace, the count of pending attachments, and the key hints. Compaction and model-request retries appear as notices, the same facts the browser's markers carry.

### Keys and commands

| Key | Effect |
|---|---|
| `Enter` | Send the editor text; while a turn runs it is queued for the next turn |
| `Ctrl+S` | While a turn runs, steer the editor text into the running turn's next step |
| `Shift+Enter` | Insert a newline |
| `Up` / `Down` | Recall earlier prompts |
| `Esc` | Stop the running turn; queued messages stay queued |
| `Ctrl+O` | Expand or collapse every tool card |
| `Ctrl+C` | Clear the editor; a second press within 600 ms quits |
| `Ctrl+D` | Quit when the editor is empty |

Typing `/` at the start of the editor completes the terminal's own commands and the shared registry's; `@` anywhere completes references.

| Command | Effect |
|---|---|
| `/help` | List commands and keys |
| `/model` | Pick the model, then its reasoning effort when the model declares more than one, for the next request; `/model <provider>/<model>` selects directly and `/model save` stores the current selection as the default |
| `/sessions` | Pick another persisted session and switch to it |
| `/new` | Start a new session |
| `/fork [turn]` | Fork this session at its last completed turn, or after turn `turn` |
| `/title <text>` | Rename this session; alone it shows the current title |
| `/attach <path>` | Attach an image or file to the next prompt; `/attach` lists, `/attach clear` drops them |
| `/queue` | Show the messages queued for the next turn and step; `/queue clear` drops them |
| `/skills` | List the skills the agent can load |
| `/signin` | Sign in to a provider through its notices and prompts; `/signin <key>` skips the picker |
| `/export [dir]` | Write this session's log ZIP (sub-sessions and attachments included) into `dir`, default the workspace |
| `/status` | Context window usage and breakdown, token totals with cache hit, session stats, todos, goal, plan mode, and permission |
| `/outline` | The turns of this session with their prompt and reply previews |
| `/deliverables` | The files the agent presented, grouped by turn |
| `/subagents` | The subagent sessions under this session, with activity and ids |
| `/settings [ns [path value]]` | List namespaces, show one, or set one field; `/settings reset <ns>` restores defaults |
| `/plugins` | The composed plugins with enablement and lifecycle phase |
| `/tools` | Expand or collapse every tool card, like `Ctrl+O` |
| `/quit`, `/exit` | Save the session and exit |

Every other `/name` line goes to the shared command registry, so `/compact`, `/permission`, `/goal`, and plugin commands work as they do in the browser.

### Prompts from the agent

An approval request draws `Allow <tool>?` with the asker's reason, the logged call the request names (the same rows as its tool card, so a shell command reads before it runs), and two rows, allow once or reject; `Esc` rejects and `Ctrl+C` cancels the request. An `ask_user_question` question renders its `detail` as Markdown above its options plus a free-text row; multi-select toggles rows with `Space` and confirms through `Done`. A plan review (the `plan-review` intent `exit_plan_mode` sets) draws the plan as Markdown with Approve, Decline, and Discuss rows, where Discuss returns the request to the composer as the browser's card does. Prompts queue and show one at a time, and an aborted request withdraws its prompt.

### References and attachments

`@` followed by text lists matching workspace files and directories and other sessions, in the same mention grammar the browser composer inserts (`@path`, `@"path with spaces"`, and the opaque `@[label](…)` session token); the base rows resolve those mentions into the prompt exactly as they do for the browser. `/attach <path>` reads a local file relative to the workspace and stores it through the composed attachment store, as an image block for `.png`, `.jpg`, `.jpeg`, `.webp`, and `.gif` and as a file block otherwise; pending attachments travel with the next prompt and are listed under it.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `prompt` | none | A first prompt submitted when the terminal is up |
| `resume` | none | A persisted session id to continue instead of starting a new one |
| `toolPreviewLines` | `8` | Collapsed tool-card body rows before `Ctrl+O` expands them |

`prompt` and `resume` come from the command line through the startup provider; the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tui-app) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The runner is a direct driver over the core API carrier, like `dsh-headless`, that stays alive until the user quits and renders through [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi), the differential terminal renderer of the pi coding agent.

### Run flow

The runner awaits the complete application (`ctx.get('loader')?.await()`) and builds a session host over the core registry with three operations: `create` makes one fresh persisted Agent with the shared [`agentDefaultModel`](../../core/agent-default-model/README.md) selection, `resume` reads the persisted log in pages through a read handle of `ctx.sessionPersistence` and resumes the Agent through the registry, and `fork` observes the source through `ctx.sessionQuery`, cuts after the chosen (by default the last) `turn/end` up to the next `turn/start`, and creates a seeded Agent with `parentSession` and `isSeeded` metadata. Every operation installs a `ModelSelectionRef` in the Agent's scoped setup so `/model` changes the next request. The terminal application starts on the session `--resume` or a fresh `create` yields, subscribes to `session/event`, `agent/assistant-stream`, and `agent/status`, answers the `approval/request` and `user-questions/request` waterfalls for the bound Agent only, and switches sessions by binding the next one and disposing the previous handle; while the host opens the next session the editor refuses input, and a quit during that wait releases the session that arrives afterwards. Quitting cancels any running turn, waits for quiescence, flushes the bound Session, disposes its handle, and requests exit 0; a driver failure writes `dsh: <message>` to stderr and requests exit 1.

### Rendering model

Durable facts come from the session log: `user/message` (own submissions are drawn once and their echo skipped by message id; a plugin notice is one dim row and other injected context is not drawn), `assistant/message` (which replaces the streamed block with the committed text and folds usage into the footer), `tool/call` and `tool/result` (drawn through the tool's `presentCall` and `presentResult` views when it declares them, with a raw-argument and raw-result fallback), `turn/end` notices, `session/title` (header), and `permission/preset` (footer). Live incrementality comes from `agent/assistant-stream` text and reasoning deltas. Session facts outside the log come from the same services the browser reads: `sessionTitle`, `permissionPresets`, `sessionQuery` for the picker and `/deliverables`, `sessionProjections` for the footer, `/status`, and `/outline`, `fileReferences` and `sessionReferenceResolver` for `@` completion, `attachments`, `skills`, `authorization`, `settings`, `subagents`, and the Loader's entries for `/plugins`. Modal prompts are process-local presentation and are never logged.

### Patch surface over base

The patch rides over `dsh-base`: it sets the coding persona prefix and cwd suffix on the base `system-prompt` row, keeps the same temporary process-wide PTC mode opt-in (`DSH_TOOLS_MODE`) as the Web surface, inserts PTC mode's worker, mounts the model-facing `ask_user_question` tool whose questions the terminal answers, mounts the same `@`-reference resolvers (`file-reference-local`, `session-reference`) and the `present` deliverable tool the browser composes, adds the `session-turn-outline` and `session-stats` projection rows behind `/outline` and `/status`, and mounts the startup provider and the runner. The base agent-plane rows (bash, filesystem, skills, goals, compaction, subagents) stay enabled because the terminal composes its Agents process-wide.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `tui-app` plugin: the session host (create, resume, fork), history read, quit flow, exit mapping |
| [`src/startup.ts`](src/startup.ts) | The `tui-app-startup` provider: prompt positional, `--resume`, and `--help` |
| [`src/app.ts`](src/app.ts) | The terminal application: layout, keys, commands, session binding, seams, log and stream folding |
| [`src/sessions.ts`](src/sessions.ts) | The `/sessions` list over the query engine and its picker rows |
| [`src/attach.ts`](src/attach.ts) | `/attach`: local files into image or file blocks through the attachment store |
| [`src/export.ts`](src/export.ts) | `/export`: the session-log ZIP written through the export package's archive helpers |
| [`src/blocks.ts`](src/blocks.ts) | Transcript components: user prompt, assistant reply, tool card, notice |
| [`src/prompts.ts`](src/prompts.ts) | Approval, question, and picker prompts plus the modal queue |
| [`src/transcript.ts`](src/transcript.ts) | Pure text folding of presentation views, usage, and turn-end reasons |
| [`src/diff.ts`](src/diff.ts) | Line diff and hunk selection for diff cards |
| [`src/style.ts`](src/style.ts) | The palette and the derived pi-tui themes |
| [`src/completion.ts`](src/completion.ts) | Slash-command and `@`-reference completion for the editor |
| [`src/status.ts`](src/status.ts) | Footer parts and the `/status` report over the projection seam; compaction and retry notices |
| [`src/catalog.ts`](src/catalog.ts) | Rows for `/settings`, `/plugins`, `/subagents`, `/deliverables`, and `/outline` |
| [`cordis.patch.yml`](cordis.patch.yml) | The terminal patch over `dsh-base` |
| — | No runtime invariant companion is published; the app registers listeners on one Agent and holds no mutable relation another observer could contradict. |
| [`tests/app.spec.ts`](tests/app.spec.ts) | Rendering, keys, commands, and both seams over a fake terminal |
| [`tests/commands.spec.ts`](tests/commands.spec.ts) | Session, attachment, queue, skill, sign-in, export, reference, and effort commands over scripted services |
| [`tests/panels.spec.ts`](tests/panels.spec.ts) | Status footer and report, catalog commands, command hints, and the approval detail |
| [`tests/index.spec.ts`](tests/index.spec.ts) | Creation, resume paging, fork cut, session switching, quit flow, and failure reporting |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | Command-line parsing over a real Loader tree |
| [`../../../apps/cli/tests/profiles/tui/tests/keyless-smoke.e2e.ts`](../../../apps/cli/tests/profiles/tui/tests/keyless-smoke.e2e.ts) | The shipped profile through the real launcher with a keyless mock model |

### Invariant ownership

No invariant companion is published because the app's observable contract (the transcript on stdout, the exit code, the persisted session) is process-level and owned by the launcher e2e; the plugin registers listeners only and holds no mutable relation to audit inside the tree.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you want to go deeper into the shared core, the sibling surfaces, or the seams the terminal answers.

- [Bundle package map](../README.md) — the surfaces built on the same core.
- [dsh-base](../base/README.md) — the shared core the terminal runs on.
- [dsh-headless](../headless/README.md) — the one-shot sibling for scripts and CI.
- [dsh-web-app](../web-app/README.md) — the browser sibling for multi-session work.
- [dsh-user-approval](../../interaction/user-approval/README.md) and [dsh-user-questions](../../interaction/user-questions/README.md) — the two seams the terminal answers.
- [dsh-commands](../../interaction/commands/README.md) — the registry behind `/`-commands.
- [dsh-file-reference](../../context/file-reference/README.md) and [dsh-session-reference](../../context/session-reference/README.md) — the `@` mention grammar and resolvers.
- [dsh-session-log-export](../../session-query/session-log-export/README.md) — the archive `/export` writes.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tui-app) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the runner submits typed text as ordinary user messages and the composed base and terminal rows own the prompts and tools.

#### KV Cache effect

The runner adds nothing to the request prefix; a `/model` switch starts a new request series exactly as it does from the browser.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe the terminal surface as shipped; they are not a general CLI comparison or a task backlog.

- **One session at a time** — `/sessions`, `/new`, and `/fork` switch the terminal between sessions, but only the bound Agent streams; the browser shows several sessions side by side.
- **Approvals are one-shot** — the prompt offers allow once or reject, matching the approval seam's vocabulary; there is no remembered grant.
- **Browser-only pages stay in the browser** — workspace and directory pickers, open-in-app links, the trajectory ledger, and per-message like/dislike have no terminal counterpart; `/settings`, `/plugins`, `/subagents`, `/outline`, and the shared `/feedback` cover their facts as text, and subagent transcripts are read by switching to the child session.
- **Deliverables are named, not opened** — `/deliverables` lists the presented paths; the browser previews the files.
- **Terminal scrollback owns history** — the transcript is not searchable or foldable beyond tool cards; the browser surface owns richer navigation.
- **Runs through the `dsh` launcher** — starting the profile another way fails at startup, because only the launcher can request the process exit.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/bench.ts` owns the fake `Terminal` and a scripted session host; drive keys with its `type()`, read the rendered words with `text()`, which strips CSI, OSC, and APC sequences, and read `hostCalls` and `opened` for what switching did. pi-tui throttles renders to one frame per 16 ms, so tests wait through `settle()` before reading the screen. Services the commands read (`sessionTitle`, `attachments`, `authorization`, …) are provided through the bench's `before` hook as narrow stubs.

</details>
