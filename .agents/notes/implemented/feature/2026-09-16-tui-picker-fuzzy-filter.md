# Agent Note: Searchable terminal pickers

Status: implemented

English | [中文](2026-09-16-tui-picker-fuzzy-filter.zh.md)

## Problem

Every list the terminal opens — the `/model` catalog, the reasoning-effort chooser, `/sessions`, the provider and method rows of `/signin` and `/login`, and the sign-in flow's own `select` prompt — was a fixed row set walked with `Up` / `Down` through a window of eight rows. A composed catalog runs to dozens of models and a workspace accumulates sessions without bound, so reaching one row cost a count of key presses, and a printable key pressed inside a picker did nothing: `SelectList.handleInput` reads `Up`, `Down`, `Enter`, `Escape`, and `Ctrl+C` and ignores everything else.

## Decision

The query lives in `PickPrompt`, the single `ListPrompt` subclass every picker is built from, so `/model` and its effort chooser, `/sessions`, `/signin`, `/login`, and the authorization flow's `select` prompt became searchable together instead of `/model` gaining a search of its own. `ApprovalPrompt` and the `ask_user_question` prompt carry no query: an approval offers two fixed rows, a question's options are the asker's own, and `Escape` keeps exactly one meaning in each of them.

A printable key extends the query, `Backspace` drops its last character, and `Ctrl+U` clears it; `decodeKittyPrintable` recovers the character from the CSI-u form a terminal in Kitty disambiguate mode sends, so both encodings type the same. `Escape` clears a non-empty query and settles the picker undefined once the query is empty, so a mistyped query costs the query and not the picker — for `/model`, not the effort chooser that follows it either. `Up` / `Down`, `Enter`, and `Ctrl+C` fall through to the list, which keeps movement and selection over whatever rows the query left.

Matching is pi-tui's exported `fuzzyFilter` over each row's label and description joined, so one query spans both: every whitespace- or slash-separated token of the query must match, and the surviving rows come back best score first. `dsk chat` and `deepseek/chat` both reach `deepseek/deepseek-chat`, and `gpt5` reaches `gpt-5`.

A query change rebuilds the list. `SelectList` takes its rows as a constructor argument and publishes no way to replace them, so `ListPrompt.setRows` constructs a fresh `SelectList` over the new rows and wires its `onSelect` and `onCancel` back to the same settlement, and the prompt renders whichever list is current. A fresh list highlights its first row, which under a query is the best match, and `PickPrompt` maps the chosen row back to the item the caller passed by value.

The `✓` on the row in force, and opening the picker on that row, apply only while the query is empty: the mark is part of a row's label and the rows matched against are the unmarked ones, so a query never matches the mark and never holds the highlight on a row it did not rank first. One dim line above the rows reads `type to filter · Enter selects · Esc cancels` while the query is empty and `filter: <query> · <kept>/<total>` afterwards, and a query nothing matches replaces the list with a dim `no row matches "<query>"`.

## Alternatives considered

**Give `/model` a search of its own.** Rejected: the row count that makes `/model` slow to walk is worse in `/sessions`, and every picker is the same class, so a `/model`-local query would have meant a special case inside the shared prompt plus unsearchable lists beside it. One query in `PickPrompt` is less code than that special case and covers every picker the terminal opens.

**Filter with `SelectList.setFilter`.** Rejected: it keeps the rows whose `value` starts with the query compared case-insensitively (`item.value.toLowerCase().startsWith(filter.toLowerCase())`), so `chat` never reaches `deepseek/deepseek-chat` and a row's description is never matched; and its empty result renders the component's hardcoded `  No matching commands` row, which names commands in a list of models, sessions, or providers.

**Hand-roll the matcher.** Rejected under [dependencies over hand-rolling](../process/2026-07-26-dependencies-over-hand-rolling.md): pi-tui exports `fuzzyFilter` and `fuzzyMatch` from the package the prompts already render through, with token splitting, word-boundary and consecutive-run scoring, and the letter/digit swap that lets `gpt5` reach `gpt-5`. Owning that matcher would add code and tests for behavior the dependency ships.

**Replace the mounted list's rows in place.** Rejected: `items` and `filteredItems` are the component's own fields with no setter other than `setFilter`, so writing to them would bind the terminal to the internals of one pinned pi-tui version. Constructing a list per query change uses only the documented constructor, and a picker holds rows in the tens.

**Keep the mark and the opening row while a query is on.** Rejected: once a query is typed the row the user wants is the one the query ranks first, and holding the highlight on the row in force would either move the selection away from that row or point at a row the query dropped. The mark also sits inside the label, so filtering the marked rows would match the query against `✓`.

**Let `Escape` always cancel.** Rejected: the picker is the only place the query exists, so the first job of `Escape` there is to undo typing; always cancelling would let one wrong character close `/model` and the effort chooser behind it. `Escape` still cancels from an empty query, the meaning it has before anything is typed.

## Consequences

- Every picker answers the same keys, and a printable key can no longer become a picker shortcut because it belongs to the query.
- `Escape` reads two ways inside a picker. The picker's own first line states `Esc cancels` while the query is empty, the terminal README states the clearing step, and `/help` keeps its editor keys.
- A query change discards the list's highlight and scroll position by construction, so after each keystroke the highlight is the best match rather than the row the user had walked to.
- `tests/pick-filter.spec.ts` pins the matching examples, the key handling, the filter line, the empty-result row, the mark, and the scrolling window across a rebuilt list, so the call sites need no per-command query tests.

## Related decisions

The terminal surface and its pickers are owned by [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md). The searched lists keep the behavior their own notes state: the `/login` provider rows and the effort chooser from [TUI `/login` and Shift+Tab effort cycling](2026-09-15-tui-login-and-effort-cycle.md), and the model and effort facts the segments of [navigable terminal status bar](2026-09-16-tui-status-bar-navigation.md) explain. `@` completion in the editor matches candidates through its own rules from [file-reference completion outside the session cwd](2026-09-15-file-reference-outside-workspace.md).
