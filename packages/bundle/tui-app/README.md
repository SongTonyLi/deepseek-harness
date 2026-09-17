---
description: "Interactive terminal mode for dsh: talk to the agent in your terminal with streamed replies, tool cards, approvals, questions, slash commands, @-references, attachments, and session switching."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

English | [中文](README.zh.md)

## Summary

`dsh-tui-app` is the terminal surface of dsh: `dsh tui` starts a multi-turn session in the terminal you are already in, with no browser-hosted application and no server. Replies stream as you watch, tool calls become foldable cards, approvals and `ask_user_question` questions appear above the input, `@` completes paths and sessions, `/attach` adds images and files, and `/`-commands share the Web registry. Sessions persist: `/sessions`, `/new`, and `/fork` switch between them, `/export` writes the browser's ZIP, and `--resume` continues one later. It runs the same model, tools, and safety defaults as `dsh web`, one session at a time.

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
dsh tui --no-open                         # print sign-in URLs without opening a browser
```

On quit the app prints `dsh: session <id> saved; resume with: dsh --profile tui --resume <id>` on stderr for the session bound at that moment. A resumed session redraws its persisted history before accepting input; inside the terminal, `/sessions` opens a picker over every persisted root session, `/new` starts a fresh one, and `/fork` copies the current session up to its last completed turn into a new one, the same cut the browser's fork takes. Switching releases the previous Agent and redraws the transcript of the next.

### The screen

The header names the session by its title once one is generated or set, with the id beside it. The transcript grows in the terminal's own scrollback: your prompts start with `›` (attachments listed under them), assistant reasoning is dim above the Markdown reply, and each tool call is a card with a status glyph, the tool name, the presenter headline, and a body folded to `toolPreviewLines` rows. Streamed reply text fades in: the newest words arrive near the terminal's background color and brighten to the normal foreground over `streamFadeSteps` levels of `streamFadeStepMs` each, so a soft edge trails the stream head, and text that has settled is never dimmed again. Below the transcript sit a spinner while the agent works, any open prompt, the editor, the subagent panel, and the footer: a status bar of segments over a line of key hints. The editor's caret is the terminal's own blinking bar: the app asks for that shape at start, gives your default back on quit, and draws no caret at all while the status bar or the panel holds the keyboard. Each segment appears only when its fact exists — the model and reasoning effort, the permission preset, the running turn's elapsed time, cumulative token usage, the context window percentage, todo and goal and plan-mode markers from the projection seam, the workspace path (shortened with `~` and `…/` when long), and the count of pending attachments — and `Shift+Up` moves focus into the bar to read a segment's details. Compaction and model-request retries appear as notices, the same facts the browser's markers carry.

The subagent panel is drawn while a subagent session under the bound one is resident, or the listing carries a candidate it could not read. Its heading counts what it lists, and each row gives the child's depth indent, its label or id, its mode (`one-shot` or `continuable`), `resident`, whether its agent is `running` or `idle`, its elapsed time — the open turn's, else the total its settled turns took — and its token usage, as far as this process's own view of that child and the composed projections carry them. Six rows are drawn at most, with `+<n> more · /subagents lists them all` under them; a candidate the listing could not interpret draws as `unreadable: <reason>` and opens nothing, and a failed listing keeps the rows the last good one produced with `listing failed: <reason>` beneath. The panel disappears with its last row.

### Keys and commands

| Key | Effect |
|---|---|
| `Enter` | Send the editor text; while a turn runs it is queued for the next turn |
| `Ctrl+S` | While a turn runs, steer the editor text into the running turn's next step |
| `Shift+Enter` | Insert a newline |
| `Shift+Tab` | While the editor has focus, cycle the current model's reasoning effort for the next request |
| `Up` / `Down` | Recall earlier prompts |
| `Shift+Up` | Move focus on through the docked regions: editor → status bar → subagent panel → editor |
| `Shift+Down` | Move focus back through that cycle; in the editor with no panel drawn it stays the editor's own key |
| `Esc` | Stop the running turn; queued messages stay queued |
| `Ctrl+O` | Expand or collapse every tool card |
| `Ctrl+C` | Clear the editor; a second press within 600 ms quits |
| `Ctrl+D` | Quit when the editor is empty |

While the status bar has focus, `Left` / `Right` and `Tab` / `Shift+Tab` move between segments and wrap at both ends, `Enter` opens the selected segment while the bar keeps focus, `Shift+Up` moves on to the subagent panel while it is drawn, and `Esc` or `Shift+Down` returns focus to the editor. No other key reaches the editor while the bar has focus; `Ctrl+C` and `Ctrl+D` keep their usual meaning and return focus to the editor.

While the subagent panel has focus, `Up` / `Down` move the selection and wrap at both ends, `Enter` opens that child's session details as a read-only page and comes back to the panel on the same row, `Shift+Down` moves on to the status bar, and `Esc` or `Shift+Up` returns focus to the editor. Every other key is consumed there as well, apart from `Ctrl+C` and `Ctrl+D`; the panel also hands the keyboard back to the editor when its last row leaves.

Every segment except `todo` prints its details into the transcript, stating its current facts and naming what changes them: the model segment names `/model`, the effort segment `Shift+Tab`, and the permission segment its preset, the `turn` segment — drawn as `turn <elapsed>` between the permission and usage segments, and only while a turn runs — gives the turn number, its start time, its elapsed time, and the queued-message counts, while the usage, context, goal, and plan segments print the matching sections of the `/status` report, the workspace segment the full path, and the attachments segment the pending attachments. The `todo` segment opens the agent's todo list instead, the same list `/todos` opens.

Typing `/` at the start of the editor completes the terminal's own commands and the shared registry's; `@` anywhere completes references.

| Command | Effect |
|---|---|
| `/help` | List commands and keys |
| `/model` | Pick the model (type to filter the rows), then its reasoning effort when the model declares more than one, for the next request; `/model <provider>/<model>` selects directly and `/model save` stores the current selection as the default |
| `/sessions` | Pick another persisted session and switch to it |
| `/new` | Start a new session |
| `/fork [turn]` | Fork this session at its last completed turn, or after turn `turn` |
| `/title <text>` | Rename this session; alone it shows the current title |
| `/attach <path>` | Attach an image or file to the next prompt; `/attach` lists, `/attach clear` drops them |
| `/queue` | Show the messages queued for the next turn and step; `/queue clear` drops them |
| `/skills` | List the skills the agent can load |
| `/signin` | Sign in to a provider through its notices and prompts; `/signin <key>` skips the picker |
| `/login` | Sign in with a provider subscription (hides key-collecting logins); `/login <key>` skips the picker |
| `/export [dir]` | Write this session's log ZIP (sub-sessions and attachments included) into `dir`, default the workspace |
| `/status` | Context window usage and breakdown, token totals with cache hit, session stats, todos, goal, plan mode, and permission |
| `/todos` | Browse the agent's todo list; `Enter` opens one item in full with its status, position, and turns |
| `/outline` | The turns of this session with their prompt and reply previews |
| `/deliverables` | The files the agent presented, grouped by turn |
| `/subagents` | Browse the subagent sessions under this session; `Enter` opens one session's details |
| `/settings [ns [path value]]` | List namespaces, show one, or set one field; `/settings reset <ns>` restores defaults |
| `/plugins` | The composed plugins with enablement and lifecycle phase |
| `/tools` | Expand or collapse every tool card, like `Ctrl+O` |
| `/quit`, `/exit` | Save the session and exit |

Every other `/name` line goes to the shared command registry, so `/compact`, `/permission`, `/goal`, and plugin commands work as they do in the browser.

Every picker the terminal opens — the model and reasoning-effort lists of `/model`, `/sessions`, the `/subagents` and `/todos` lists, and the rows `/signin` and `/login` raise — filters its rows as you type: the query matches each row's label and description together, its whitespace- and slash-separated tokens must all match, and the rows are ordered best match first, so `dsk chat` and `deepseek/chat` both find `deepseek/deepseek-chat` and `gpt5` finds `gpt-5`. `Backspace` drops the last character, `Ctrl+U` clears the query, `Esc` clears a non-empty query and cancels the picker once the query is empty, `Up` / `Down` move within the matches, and `Enter` picks the highlighted row. The dim line above the rows reads `type to filter · Enter selects · Esc cancels` while the query is empty and `filter: <query> · <kept>/<total>` afterwards; a query nothing matches draws `no row matches "<query>"` in place of the rows, and the `✓` on the row in force — the row a picker opens on — shows only while the query is empty.

`/subagents`, `/todos`, and the `todo` status-bar segment share one list-then-details interaction: the picker lists the entries, `Enter` opens the highlighted entry as a read-only page, `Up` / `Down` and `PageUp` / `PageDown` scroll that page, and `Enter`, `Esc`, or `Left` returns to the list on the entry just read, so walking several entries costs no retyped command; `Esc` at the list returns to the editor. An entry whose details cannot be read says so on its page instead of closing the list.

### Subscription sign-in

`/login` stores a subscription credential but does not activate a dormant model route. Configure the catalog route first, then use its full credential key; for example, run `/settings llm-pi-ai providers.openai-codex {}` and then `/login llm-pi-ai/openai-codex`. A marked authorization page opens in the local default browser while its URL remains in the transcript as a fallback. SSH launches, hosts without a desktop, `--no-open`, and opener failures leave the manual URL and device-code paths available instead.

### Prompts from the agent

An approval request draws `Allow <tool>?` with the asker's reason, the logged call the request names (the same rows as its tool card, so a shell command reads before it runs), and two rows, allow once or reject; `Esc` rejects and `Ctrl+C` cancels the request. An `ask_user_question` question renders its `detail` as Markdown above its options plus a free-text row; multi-select toggles rows with `Space` and confirms through `Done`. A plan review (the `plan-review` intent `exit_plan_mode` sets) draws the plan as Markdown with Approve, Decline, and Discuss rows, where Discuss returns the request to the composer as the browser's card does. Prompts queue and show one at a time, and an aborted request withdraws its prompt.

### References and attachments

`@` followed by text lists matching files and directories — workspace-relative, `../` from the workspace, `~/` from the home directory, or absolute — and other sessions, in the same mention grammar the browser composer inserts (`@path`, `@"path with spaces"`, and the opaque `@[label](…)` session token); the base rows resolve those mentions into the prompt exactly as they do for the browser. `/attach <path>` reads a local file relative to the workspace and stores it through the composed attachment store, as an image block for `.png`, `.jpg`, `.jpeg`, `.webp`, and `.gif` and as a file block otherwise; pending attachments travel with the next prompt and are listed under it.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `prompt` | none | A first prompt submitted when the terminal is up |
| `resume` | none | A persisted session id to continue instead of starting a new one |
| `toolPreviewLines` | `8` | Collapsed tool-card body rows before `Ctrl+O` expands them |
| `liveRefreshMs` | `1000` | Period of the redraw that advances the `turn` segment and the panel's elapsed values and re-reads a stale subagent listing |
| `streamFadeSteps` | `5` | Brightness levels streamed assistant text climbs before it draws in the normal foreground |
| `streamFadeStepMs` | `40` | How long one brightness level lasts, which is also the repaint period of the fading text |
| `reducedMotion` | `false` | Draw streamed text at the normal foreground, with no fade and no repeating repaint |
| `openBrowser` | `true` | Hand marked authorization pages to the local default browser |

`prompt`, `resume`, and `openBrowser` come from the command line through the startup provider; the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tui-app) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The runner is a direct driver over the core API carrier, like `dsh-headless`, that stays alive until the user quits and renders through [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi), the differential terminal renderer of the pi coding agent.

### Run flow

The runner awaits the complete application (`ctx.get('loader')?.await()`) and builds a session host over the core registry with three operations: `create` makes one fresh persisted Agent with the shared [`agentDefaultModel`](../../core/agent-default-model/README.md) selection, `resume` reads the persisted log in pages through a read handle of `ctx.sessionPersistence` and resumes the Agent through the registry, and `fork` observes the source through `ctx.sessionQuery`, cuts after the chosen (by default the last) `turn/end` up to the next `turn/start`, and creates a seeded Agent with `parentSession` and `isSeeded` metadata. Every operation installs a `ModelSelectionRef` in the Agent's scoped setup so `/model` changes the next request. The terminal application starts on the session `--resume` or a fresh `create` yields, subscribes to `session/event`, `agent/assistant-stream`, and `agent/status`, answers the `approval/request` and `user-questions/request` waterfalls for the bound Agent only, and switches sessions by binding the next one and disposing the previous handle; while the host opens the next session the editor refuses input, and a quit during that wait releases the session that arrives afterwards. Quitting cancels any running turn, waits for quiescence, flushes the bound Session, disposes its handle, and requests exit 0; a driver failure writes `dsh: <message>` to stderr and requests exit 1. Shift+Tab cycles the bound model's adapter-owned reasoning efforts, wrapping through the provider default, and `/login` starts `authorization.begin` with only subscription methods (every method except a key-collecting `api-key` login). A notice the flow marks with `openInBrowser` is handed to the default browser through `dsh-native-command`'s credential-scrubbed helper while the URL stays printed; the handoff is suppressed when `openBrowser` is false, the launch came through SSH, or the host has no desktop, and an opener failure becomes a notice beside the URL rather than a sign-in failure.

### Rendering model

Durable facts come from the session log: `user/message` (own submissions are drawn once and their echo skipped by message id; a plugin notice is one dim row and other injected context is not drawn), `assistant/message` (which replaces the streamed block with the committed text and folds usage into the footer), `tool/call` and `tool/result` (drawn through the tool's `presentCall` and `presentResult` views when it declares them, with a raw-argument and raw-result fallback), `turn/end` notices, `session/title` (header), `permission/preset` (footer), and `todo/write` under the enclosing `turn/start` (the turns one todo item's page reports; the list carries no per-item identity, so a reworded item counts as a new one). Live incrementality comes from `agent/assistant-stream` text and reasoning deltas. Session facts outside the log come from the same services the browser reads: `sessionTitle`, `permissionPresets`, `sessionQuery` for the picker, `/deliverables`, and subagent details, `sessionProjections` for the footer, `/status`, `/todos`, and `/outline`, `fileReferences` and `sessionReferenceResolver` for `@` completion, `attachments`, `skills`, `authorization`, `settings`, `subagents`, and the Loader's entries for `/plugins`. Modal prompts are process-local presentation and are never logged.

### Patch surface over base

The patch rides over `dsh-base`: it sets the coding persona prefix and cwd suffix on the base `system-prompt` row, keeps the same temporary process-wide PTC mode opt-in (`DSH_TOOLS_MODE`) as the Web surface, inserts PTC mode's worker, mounts the model-facing `ask_user_question` tool whose questions the terminal answers, mounts the same `@`-reference resolvers (`file-reference-local`, `session-reference`) and the `present` deliverable tool the browser composes, adds the `session-turn-outline` and `session-stats` projection rows behind `/outline` and `/status`, and mounts the startup provider and the runner. The base agent-plane rows (bash, filesystem, skills, goals, compaction, subagents) stay enabled because the terminal composes its Agents process-wide.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `tui-app` plugin: the session host (create, resume, fork), history read, quit flow, exit mapping |
| [`src/startup.ts`](src/startup.ts) | The `tui-app-startup` provider: prompt positional, `--resume`, `--no-open`, and `--help` |
| [`src/app.ts`](src/app.ts) | The terminal application: layout, keys, commands, session binding, seams, log and stream folding |
| [`src/sessions.ts`](src/sessions.ts) | The `/sessions` list over the query engine and its picker rows |
| [`src/attach.ts`](src/attach.ts) | `/attach`: local files into image or file blocks through the attachment store |
| [`src/export.ts`](src/export.ts) | `/export`: the session-log ZIP written through the export package's archive helpers |
| [`src/blocks.ts`](src/blocks.ts) | Transcript components: user prompt, assistant reply, tool card, notice |
| [`src/fade.ts`](src/fade.ts) | The streamed-text fade: the tail tracker, the background-to-foreground ramp, and the recolor of rendered lines |
| [`src/prompts.ts`](src/prompts.ts) | Approval, question, picker, and read-only detail prompts plus the modal queue |
| [`src/transcript.ts`](src/transcript.ts) | Pure text folding of presentation views, usage, and turn-end reasons |
| [`src/diff.ts`](src/diff.ts) | Line diff and hunk selection for diff cards |
| [`src/style.ts`](src/style.ts) | The palette and the derived pi-tui themes |
| [`src/completion.ts`](src/completion.ts) | Slash-command and `@`-reference completion for the editor |
| [`src/editor.ts`](src/editor.ts) | The prompt editor without pi-tui's drawn block cursor, and the DECSCUSR sequences for the terminal's own caret |
| [`src/status.ts`](src/status.ts) | Projection-seam facts and the sections the `/status` report and the segment details share; compaction and retry notices |
| [`src/footer.ts`](src/footer.ts) | The status bar: the ordered segments, each segment's detail rows, and the footer's two rendered lines |
| [`src/subagent-panel.ts`](src/subagent-panel.ts) | The live subagent panel: one descendant listing plus sampled live facts become its rows, and the rows its text |
| [`src/catalog.ts`](src/catalog.ts) | Rows for `/settings`, `/plugins`, `/subagents`, `/deliverables`, and `/outline` |
| [`src/todos.ts`](src/todos.ts) | The todo list: the status glyphs, the picker rows, and one item's detail rows |
| [`cordis.patch.yml`](cordis.patch.yml) | The terminal patch over `dsh-base` |
| — | No runtime invariant companion is published; the app registers listeners on one Agent and holds no mutable relation another observer could contradict. |
| [`tests/app.spec.ts`](tests/app.spec.ts) | Rendering, keys, commands, and both seams over a fake terminal |
| [`tests/commands.spec.ts`](tests/commands.spec.ts) | Session, attachment, queue, skill, sign-in, `/login`, Shift+Tab effort cycling, export, reference, and effort commands over scripted services |
| [`tests/panels.spec.ts`](tests/panels.spec.ts) | Status footer and report, the navigable subagent and todo lists, catalog commands, command hints, and the approval detail |
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
- **The panel lists residency, not the tree** — a child joins it while its session record is resident in this process, so a subagent run by an out-of-process provider, which owns no session here, never appears; `/subagents` remains the way to every durable descendant.
- **Residency is not work** — the listing's `activity: 'running'` says the child's record is resident, which is what the row's `resident` reports; whether the child is working is the separate `running` / `idle` word beside it, read from that child's Agent in this process.
- **Rows behind the overflow row are not selectable** — the panel draws at most six rows and `Up` / `Down` wrap inside them; the children folded into `+<n> more` are reached through `/subagents`, which walks the complete descendant tree.
- **The fade needs an answer from the terminal** — its ramp is built from the background color the terminal reports to the query sent at startup, so a terminal that stays silent, or that encodes neither truecolor nor 256 colors, gets the two-level faint mode instead; `NO_COLOR`, a disabled palette, `TERM=dumb`, and `reducedMotion` turn the effect off entirely.
- **The terminal's own caret can flicker** — the editor draws no caret of its own and the app turns the terminal cursor on, which pi-tui then moves across the lines it repaints; a terminal that does not honor the synchronized-output sequences pi-tui wraps a frame in can show that movement.
- **Runs through the `dsh` launcher** — starting the profile another way fails at startup, because only the launcher can request the process exit.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/bench.ts` owns the fake `Terminal` and a scripted session host; drive keys with its `type()`, read the rendered words with `text()`, which strips CSI, OSC, and APC sequences, and read `hostCalls` and `opened` for what switching did. pi-tui throttles renders to one frame per 16 ms, so tests wait through `settle()` before reading the screen. Services the commands read (`sessionTitle`, `attachments`, `authorization`, …) are provided through the bench's `before` hook as narrow stubs.

</details>
