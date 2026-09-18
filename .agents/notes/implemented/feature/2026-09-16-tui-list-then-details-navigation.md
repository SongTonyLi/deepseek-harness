# Agent Note: Terminal list-then-details navigation

Status: implemented

English | [中文](2026-09-16-tui-list-then-details-navigation.zh.md)

## Problem

`/subagents` printed one row per descendant session into the transcript, and the agent's todo list was one printed section of the `/status` report. Both answers were a block of text the user could only scroll with the whole terminal: a subagent's own facts — workspace, title, turn outline, presented files — were unreachable without switching to the child session, reading a second child meant retyping `/subagents`, and the todo section printed every item at once with nothing about one item's position in the list or the turns it was written and changed in. The terminal already had a list component with a query, `PickPrompt`, behind `/model`, `/sessions`, `/signin`, and `/login`, so what was missing was a way to enter a row and come back to it, not another printer.

## Decision

The terminal has one list-then-details interaction, `TuiApp.browse`, and commands are its consumers. `browse` takes a title and `BrowseRow` values — a `PickItem` for the picker, a page heading, and a `detail()` that resolves the page rows — and loops: `PickPrompt` opens over the rows, `Enter` resolves the picked row's details into a `DetailPrompt`, leaving that page reopens the picker with `current` set to the row just read, and `Esc` at the picker ends the loop and returns the keyboard to the editor. A rejected `detail()` becomes the page's rows, so a failed read costs the page and not the list. A consumer may widen the picker's label column, which the todo list does so a 64-column item is not cut again at the list component's 30-column default.

`DetailPrompt` is a read-only page: an accented heading, the caller's rows wrapped to the terminal width, and a dim hint line. `Up` and `Down` scroll one row, `PageUp` and `PageDown` a full page, the hint carries `(<first>/<total>)` once the rows pass the 16 drawn at once, and `Enter`, `Esc`, or `Left` returns to the list. Every other key is ignored, because the page has nothing else to answer.

**Extended.** [Terminal reader overlay, Esc safety, and the editor as the hub](2026-09-18-tui-reader-overlay-and-esc-safety.md) keeps these pages and every key they answer, and adds one rule to the way out of them: leaving a page and cancelling a picker both start the handoff window that note defines, so an `Esc` arriving in the editor just behind the one that closed a page does nothing at all instead of reaching the running turn. What opens one of these pages is the whole of this list — `/subagents`, `/todos`, `/changes`, the `todo` status-bar segment, and a subagent panel row — because a transcript section is read in that note's full-screen reader instead.

`/subagents` is the first consumer. `listSubagentChoices` maps the subagent runtime's descendant listing to picker rows — the durable label or the id, indented by depth, with activity, mode, and the id behind it — and `subagentDetail` reads one child through `sessionQuery` for that row's label and description, the creation time, the workspace, the title, the turn outline, and the presented files, folding the outline and the file list at eight entries each. A descendant the listing reported as a `diagnostic` candidate still opens; its page carries the id and the reason the durable record could not be interpreted.

The agent's todo list is the second consumer, opened by `/todos` and by `Enter` on the `todo` status-bar segment. `listTodoChoices` turns the `todos` projection into one row per item — the status glyph, the content cut to 64 columns, and the status word — and `todoDetail` prints one item's full content wrapped to 72 columns, its status, `item 3 of 7`, the list counted by status (`2 completed · 1 in progress · 4 pending`), and the item's turn facts. A list that is empty, unwritten, or unavailable in this profile draws the `no todos yet` notice instead of an empty picker.

## Todo turn facts are keyed by item content

`todo/write` carries the whole list and no per-item identity: a `TodoItem` is `{ content, status }`. The turn an item was first written in and the turn its status last changed in are therefore held by the application, not read back per item: `onSessionEvent` remembers the turn each `turn/start` opened, and each `todo/write` folds the new list into a `Map` keyed by item content, which the `todo_write` tool rejects duplicates of within one write. A content the bound session has not carried starts at the current turn, a known content whose status moved records that turn, and a content the write dropped is forgotten. A reworded item is therefore a new item that starts over, and the item it replaced is gone. Binding another session clears the map and rebuilds it from that session's replayed history, so a resumed session keeps its turn facts and a fresh one has none until it writes a list.

## Alternatives considered

**Keep printing detail blocks into the transcript, as the status-bar segments do.** Rejected: a transcript block cannot be scrolled on its own — the user scrolls the whole terminal, and a long turn outline pushes the conversation away — and printing closes the list, so walking a subagent tree costs one `/subagents` per child. A modal page scrolls by itself and hands the list back on the row just read.

**Give each command its own output format.** Rejected: `/subagents` and the todo list would each have owned a row layout, a key table, and an empty-list case, and the second consumer would have copied the first. One `browse` over the existing `PickPrompt` plus one `DetailPrompt` is the whole mechanism, and a third consumer adds a `BrowseRow` list and nothing else.

**Draw the details as a one-row `PickPrompt`.** Rejected: a picker draws a filter line, a row list, and a selection highlight over content that offers nothing to pick or filter, and its `Escape` would first clear a query the page has no use for. `DetailPrompt` draws the heading, the rows, and the keys it answers.

**Log a per-item todo identity so the turn facts need no in-memory map.** Rejected: `todo/write` is the `todo_write` tool's whole-list snapshot, read by the Web surface and both SDKs; adding an id to satisfy one terminal page would change a logged event for every reader. Content is unique within a write, which carries the page, and the cost is stated: a reworded item counts as new.

**Derive the turn facts from the log when a page opens, as the subagent page derives its details.** Rejected: `todo/write` carries no turn of its own, so an item's turns exist only relative to the enclosing `turn/start`, and deriving them on demand folds the whole log per page open. The terminal already sees every event of the bound session, live and on replay, so the same fold runs once as the events arrive.

**Leave the `todo` status-bar segment printing its `/status` section.** Rejected: the segment names the fact the list holds, and two ways to read one list — a printed section under `Enter` and a picker under `/todos` — drift apart. `/status` still prints the todo section as part of the whole report.

## Consequences

- `Enter` on the status bar reads two ways: the `todo` segment opens the list, every other segment prints its details into the transcript. The package README and the root README state the split.
- A details page is not in the scrollback. What a page showed is gone once it closes; the transcript keeps only what a command printed.
- Todo turn facts are process-local and content-keyed, so a reworded item restarts them and a profile without the `todos` projection has no list to open at all.
- A third list costs a `BrowseRow` list and its detail rows; the keys, the returning-to-the-visited-row behavior, and the failure text come with `browse`.
- `tests/panels.spec.ts` pins both consumers end to end — walking, entering, returning to the visited row, the unreadable child, the empty list, and the turn rows — `tests/prompts.spec.ts` pins `DetailPrompt`'s wrapping, scrolling, position line, and settle keys, and `tests/todos.spec.ts` with `tests/catalog.spec.ts` pin the row and page text.

## Related decisions

The terminal application that hosts these lists is owned by [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md). The picker they open is the one [searchable terminal pickers](2026-09-16-tui-picker-fuzzy-filter.md) gave a query, so the subagent and todo lists filter as every other picker does. The `todo` segment and the `Enter` binding that reaches it come from [navigable terminal status bar](2026-09-16-tui-status-bar-navigation.md), whose other segments keep their printed details.
