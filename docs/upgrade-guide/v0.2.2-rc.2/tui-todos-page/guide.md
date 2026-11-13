---
kind: upgrade-guide
description: "The TUI `/todos` picker becomes a full-screen todos page that shows shared tasks, their owners and subtasks, and this agent's todo list."
---

# `/todos` in the TUI opens a full-screen todos page

English | [中文](guide.zh.md)

## Change

`/todos`, `Ctrl+T`, and `Enter` on the status bar's `todo` segment used to open a picker over the agent's own todo list, where `Enter` showed one item's status, position, list counts, and turns. They now open the todos page on the alternate screen. The page lists each shared task with its owner and the owner's live todo list as subtasks, then the agent's own todo list as one branch, and marks every row delivered, in progress, stuck, deferred, or pending. The right pane details the selected row; for one of the agent's own todos it still reports the turn the item was first written in and the turn its status last changed in. The picker's type-to-filter and its item position and list counts are gone. `Ctrl+T` on the page closes it. Users of the shipped `tui` profile observe the change; no configuration, Session data, or SDK surface changes. See the [TUI reference](../../../../packages/bundle/tui-app/README.md).

## Migration

1. Use `↑` `↓` on the page in place of the picker's filter, `←` `→` to fold and unfold a task, and `Esc`, `q`, or `Ctrl+T` to return to the conversation.
2. Read item counts from the page's first line, `todos · <delivered>/<total> delivered`, or from `/status`.
3. To confirm, run a turn that writes todos, type `/todos`, and check that the first line starts with `todos · ` and that `Esc` returns to the conversation.
