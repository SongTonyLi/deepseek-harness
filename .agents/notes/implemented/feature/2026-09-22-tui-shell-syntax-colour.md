# Agent Note: Syntax colour for shell-mode drafts and `$ command` rows

Status: implemented

English | [中文](2026-09-22-tui-shell-syntax-colour.zh.md)

## Problem

The terminal already colours fenced code and the file rows of a `read` or `diff` card from one shiki core. A `!` / `!!` draft — the other place a person writes a command — stayed in one colour: the bang, a flag, a string, and a path were the same foreground as an ordinary prompt. After submit, the transcript `$ command` row and the command on a terminal tool card were the same grey. The shellscript grammar was already in the map; nothing asked for it on those lines.

## Decision

The same highlighter colours a shell draft and a `$ command` row. Nothing new loads at start. The first `!` that reaches a render asks for `shellscript`; that frame draws the bang in the warning role and the command plain, and the grammar's arrival invalidates the conversation and requests the frame again.

**The editor overlay is a transform over rendered lines.** pi-tui's `Editor` has no highlight hook, and the editor state is the text the user will submit. `BarCursorEditor.render` still strips the block caret, then `paintShellEditorLines` paints over the content lines: indent stays plain, `!` / `!!` uses `palette.warning` (the same role as the shell-mode border), and the command uses `highlight.lines(..., 'shellscript')`. `CURSOR_MARKER`, padding, the top and bottom rules, and an autocomplete list stay as rendered. A chunk whose painted visible width differs from its plain width, or that cannot be matched after a scroll, is left plain. ANSI never enters `setText`.

**The transcript `$ command` row is a `CodeSpan`.** `UserShellBlock` draws the finished run through `paintCodeRows` so a grammar that lands after submit recolours the command. Output rows stay uncoloured. A terminal tool card puts `$ ${title}` in the call body with the same span, so the command the model is about to run uses the same colours as a user-typed one; the dim title on the header stays the headline.

## Alternatives considered

**Fork or patch pi-tui for an editor highlight hook.** Rejected: the caret subclass already refused a fork for one cell, and a highlight hook would take on wrapping, paste markers, and autocomplete for the same reason.

**Write ANSI into the editor text.** Rejected: the caret, word movement, submit, and history all read that text. Coloured bytes would shift columns and leak into `ctx.shell`.

**Map shell tokens onto palette roles.** Rejected for the same reason [syntax colour for fenced code](2026-09-19-tui-syntax-colour.md) rejected it: the palette is semantic and syntax is not.

**Wait for the grammar before the first paint.** Rejected: a draft the user is watching would sit plain until an unrelated key. The highlighter already asks for the frame.

**Colour the terminal-card title instead of adding a body row.** Rejected: the header already wraps the title in `palette.dim`, which would wash out theme colours, and the card body is the path `paintCodeRows` already owns.

**Replace the title with a body-only command.** Rejected: the header would lose the command the fold and the inspector already name.

## Consequences

- The first `!` of a session starts the shellscript import. A session that never types `!` and never renders a `shell` / `bash` fence still loads none of it.
- A nonempty terminal-card title adds one `$ command` body row, so a folded card's "more rows" count grows by one and an approval detail that reads `call.lines` shows the command.
- A wrap that lands mid-token, or a paste marker the overlay does not treat as atomic, can leave that chunk plain. The command stays readable.
- `tests/editor.spec.ts` pins the overlay against pi-tui's own lines; `tests/blocks.spec.ts` pins `UserShellBlock` invalidate; `tests/transcript.spec.ts` pins the terminal span; `tests/stream-fade.spec.ts` pins the real grammar on a truecolor bench.

## Related decisions

The highlighter, the lazy load, and the redraw are [syntax colour for fenced code](2026-09-19-tui-syntax-colour.md). The render-then-transform is the same move [terminal bar caret and streamed-text fade](2026-09-17-tui-bar-caret-and-stream-fade.md) uses for the block caret. The surface is [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md).
