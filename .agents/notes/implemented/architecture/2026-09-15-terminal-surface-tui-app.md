# Agent Note: Terminal surface as the shipped `tui` profile

Status: implemented

English | [中文](2026-09-15-terminal-surface-tui-app.zh.md)

## Problem

DeepSeek Harness shipped one interactive surface, the browser application behind `dsh web`; the terminal had only the one-shot `headless` runner, which answers a single task and exits. The [TUI package removal](../../archived/simplification/2026-08-04-remove-tui-package.md) deleted the earlier terminal frontend because nothing composed it, and it set the bar for a return: a named product deployment, an explicit package boundary, a concrete interaction provider, and assembled lifecycle acceptance. Users asking for a terminal workflow like the pi coding agent's had no supported answer.

## Decision

`@deepseek-ai/dsh-tui-app` under `packages/bundle/tui-app` is the terminal surface, and `tui` is a shipped profile (`dsh-base` plus `dsh-tui-app`, startup-only patch reload) with `dsh tui` as the launcher alias beside `dsh web`. The bundle mirrors `dsh-headless`: a `tui-app-startup` command-line provider publishes `tuiStartup` (an optional first prompt and `--resume <session-id>`), and the `tui-app` runner creates or resumes one Agent through the core registry and drives it until the user quits. The profile keeps the base agent-plane rows enabled and adds only PTC mode's worker and the `ask_user_question` tool.

The renderer is [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi), the maintained differential terminal library of the pi coding agent, taken as an ordinary dependency next to the repository's existing `@earendil-works/pi-ai` adapter rather than a vendored or patched copy. The application composes its editor, Markdown, select-list, and loader components over the pi-tui main-screen renderer, so terminal scrollback keeps the transcript.

The terminal reads only the seams other surfaces already use. Durable facts come from `session/event` (`user/message`, `assistant/message`, `tool/call`, `tool/result`, `turn/end`); live text comes from `agent/assistant-stream`; tool cards use each tool's `presentCall` and `presentResult` views; `/`-lines go to `ctx.commands.execute` after four terminal-local commands (`/help`, `/model`, `/tools`, `/quit`); and the app is the in-process answerer on the `approval/request` and `user-questions/request` waterfalls for its Agent only. Prompts are process-local presentation and are never logged. A `--resume` reads the persisted log through a `sessionPersistence` read handle in pages before the Agent resumes, so no new synchronous history read enters production code.

## Verification

Package specs drive the application over a fake `Terminal`, feeding raw key bytes and reading the rendered words, and cover rendering, keys, both interaction seams, local and shared commands, the model picker, and the runner's create, resume, quit, and failure paths at the per-file coverage gate. The startup provider is exercised over a real Loader tree. `apps/cli/tests/profiles/tui/tests/keyless-smoke.e2e.ts` boots the shipped profile through the real `dsh` launcher with the keyless mock model, drives the production shell tool, quits with Ctrl+D, and resumes the persisted session in a second process.

## Alternatives considered

**Restore the deleted TUI package.** Rejected: the removal decision retired that implementation and its patched pi-tui; the current surface is smaller, built on the current seams, and owned by a shipped profile.

**Serve the terminal through the SDK JSON-RPC or ACP server.** Rejected: both are automation transports whose approval and question flows target a remote client, while the terminal needs the same-process presentation the Web client gets through Typert Remote.

**Write a terminal renderer in the repository.** Rejected under the dependencies-over-hand-rolling policy: pi-tui already owns differential rendering, raw-mode input, bracketed paste, the Kitty keyboard protocol, and an editor with history and completion.

**Expose the pi-tui tree to plugins.** Deferred: the removal note records that a plugin-facing overlay API needs a concrete consumer; until one exists the tree stays private to the bundle.

## Consequences

`dsh tui` joins `dsh web`, `headless`, `sdk`, `sdk-minimal`, and `acp` as a shipped application; the launcher, architecture, boot, and bundle documents list it, and the profile tests enumerate its bundle. `tui` is no longer the documentation's placeholder for a custom profile name. The terminal is one session per process and its approvals are one-shot; richer session navigation and remembered grants remain browser-surface features until a terminal consumer justifies them.
