---
description: "Interactive terminal mode for dsh: talk to the agent in your terminal with streamed replies, tool cards, approvals, questions, and slash commands."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

English | [中文](README.zh.md)

## Summary

`dsh-tui-app` is the terminal surface of dsh: `dsh tui` starts a multi-turn session in the terminal you are already in, with no browser and no server. Replies stream as you watch, every tool call becomes a foldable card, permission prompts and `ask_user_question` questions appear above the input, and `/`-commands share the same registry as the Web surface. The session persists like every other surface, so `--resume` continues it later. It runs the same model, tools, and safety defaults as `dsh web`; the boundary is one session per terminal.

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

On quit the app prints `dsh: session <id> saved; resume with: dsh --profile tui --resume <id>` on stderr. A resumed session redraws its persisted history before accepting input.

### The screen

The transcript grows in the terminal's own scrollback: your prompts start with `›`, assistant reasoning is dim above the Markdown reply, and each tool call is a card with a status glyph, the tool name, the presenter headline, and a body folded to `toolPreviewLines` rows. Below the transcript sit a spinner while the agent works, any open prompt, the editor, and a two-line footer with the model, cumulative token usage, the workspace, and the key hints.

### Keys and commands

| Key | Effect |
|---|---|
| `Enter` | Send the editor text; while a turn runs it is steered into the next step |
| `Shift+Enter` | Insert a newline |
| `Up` / `Down` | Recall earlier prompts |
| `Esc` | Stop the running turn |
| `Ctrl+O` | Expand or collapse every tool card |
| `Ctrl+C` | Clear the editor; a second press within 600 ms quits |
| `Ctrl+D` | Quit when the editor is empty |

`/help` lists commands and keys, `/model` opens a picker over the composed providers (or `/model <provider>/<model>` selects directly) for the next request, `/tools` toggles the cards like `Ctrl+O`, and `/quit` saves and exits. Every other `/name` line goes to the shared command registry, so `/compact`, `/permission`, `/goal`, and plugin commands work as they do in the browser.

### Prompts from the agent

An approval request draws `Allow <tool>?` with the asker's reason and two rows, allow once or reject; `Esc` rejects and `Ctrl+C` cancels the request. An `ask_user_question` question draws its options plus a free-text row; multi-select toggles rows with `Space` and confirms through `Done`. Prompts queue and show one at a time, and an aborted request withdraws its prompt.

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

The runner awaits the complete application (`ctx.get('loader')?.await()`), reads the shared [`agentDefaultModel`](../../core/agent-default-model/README.md) selection, and either creates one fresh persisted Agent with that provider and model or, for `--resume`, reads the persisted log in pages through a read handle of `ctx.sessionPersistence` and resumes the Agent through the registry. Both paths install a `ModelSelectionRef` in the Agent's scoped setup so `/model` changes the next request. The terminal application then subscribes to `session/event`, `agent/assistant-stream`, and `agent/status` for that Agent, registers the `approval/request` and `user-questions/request` answerers, and takes over the terminal. Quitting cancels any running turn, waits for quiescence, flushes the Session, disposes the Agent handle, and requests exit 0; a driver failure writes `dsh: <message>` to stderr and requests exit 1.

### Rendering model

Durable facts come from the session log: `user/message` (own submissions are drawn once and their echo skipped by message id; a plugin notice is one dim row and other injected context is not drawn), `assistant/message` (which replaces the streamed block with the committed text and folds usage into the footer), `tool/call` and `tool/result` (drawn through the tool's `presentCall` and `presentResult` views when it declares them, with a raw-argument and raw-result fallback), and `turn/end` notices. Live incrementality comes from `agent/assistant-stream` text and reasoning deltas. Modal prompts are process-local presentation and are never logged.

### Patch surface over base

The patch rides over `dsh-base`: it sets the coding persona prefix and cwd suffix on the base `system-prompt` row, keeps the same temporary process-wide PTC mode opt-in (`DSH_TOOLS_MODE`) as the Web surface, inserts PTC mode's worker, mounts the model-facing `ask_user_question` tool whose questions the terminal answers, and mounts the startup provider and the runner. The base agent-plane rows (bash, filesystem, skills, goals, compaction, subagents) stay enabled because the terminal is single-session and composes its Agent process-wide.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `tui-app` plugin: Agent creation or resume, history read, quit flow, exit mapping |
| [`src/startup.ts`](src/startup.ts) | The `tui-app-startup` provider: prompt positional, `--resume`, and `--help` |
| [`src/app.ts`](src/app.ts) | The terminal application: layout, keys, commands, seams, log and stream folding |
| [`src/blocks.ts`](src/blocks.ts) | Transcript components: user prompt, assistant reply, tool card, notice |
| [`src/prompts.ts`](src/prompts.ts) | Approval, question, and picker prompts plus the modal queue |
| [`src/transcript.ts`](src/transcript.ts) | Pure text folding of presentation views, usage, and turn-end reasons |
| [`src/diff.ts`](src/diff.ts) | Line diff and hunk selection for diff cards |
| [`src/style.ts`](src/style.ts) | The palette and the derived pi-tui themes |
| [`src/completion.ts`](src/completion.ts) | Slash-command completion for the editor |
| [`cordis.patch.yml`](cordis.patch.yml) | The terminal patch over `dsh-base` |
| — | No runtime invariant companion is published; the app registers listeners on one Agent and holds no mutable relation another observer could contradict. |
| [`tests/app.spec.ts`](tests/app.spec.ts) | Rendering, keys, commands, and both seams over a fake terminal |
| [`tests/index.spec.ts`](tests/index.spec.ts) | Creation, resume paging, quit flow, and failure reporting |
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

- **One session per process** — there is no session list or switcher; start another `dsh tui` or use `--resume` for an earlier session.
- **Approvals are one-shot** — the prompt offers allow once or reject, matching the approval seam's vocabulary; there is no remembered grant.
- **Attachments are text only** — the editor sends text; images and file receipts reach commands only from the browser.
- **Terminal scrollback owns history** — the transcript is not searchable or foldable beyond tool cards; the browser surface owns richer navigation.
- **Runs through the `dsh` launcher** — starting the profile another way fails at startup, because only the launcher can request the process exit.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/bench.ts` owns the fake `Terminal`; drive keys with its `type()` and read the rendered words with `text()`, which strips CSI, OSC, and APC sequences. pi-tui throttles renders to one frame per 16 ms, so tests wait through `settle()` before reading the screen.

</details>
