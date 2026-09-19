# Agent Note: The terminal reader is two panels

Status: implemented

English | [中文](2026-09-18-tui-reader-two-panels.zh.md)

## Problem

The reader opened with four things to learn at once. A rail selected a turn; a second cursor walked that turn's sections; `Enter` pinned a section into a second pane beside the walking one; and the rows between two section headers — the text the reader exists to show — moved only under `Shift+↑↓`, `PgUp` / `PgDn`, or the digits `1`…`9`. `↑↓` in the sections jumped whole sections, so reading one long reply meant learning that the obvious key was not the reading key.

The two cursors could also disagree. The held section and the panel's first visible row were separate state: pinning rewrapped the walking pane and moved every row number under it, `Esc` meant unpin, then step back to the rail, then close, depending on what was on, and the legend rule spent its width on `turn 3/12 · section 2/9 · row 14/212`. Below `readerMinColumns` the pin was recorded but not drawn, which bought a fourth legend line, `compare needs <n> columns`, to explain a mode that was not on screen.

## Decision

The reader is two panels and one selection across them. The left panel lists the turns — each one's number, the first line of its prompt, and the `⬡ ✻ ¶ ⚒` markers — and opens the turn being read into its own sections, `▸` on the one the cursor holds. The right panel is that turn, scrolled row by row, its sections stacked under their own headers. Nothing else is drawn, and nothing is pinned.

One key means one thing per panel. In the list `↑↓` step one section and cross into the turn either side, `PgUp` / `PgDn` step a whole turn, and `Home` / `End` reach the conversation's own ends; in the turn they scroll rows, page rows, and reach the turn's ends. `Right`, `Tab`, and `Enter` cross into the turn; `Left`, `Tab`, and `Shift+Tab` come back to the list; `/` opens the turn filter over the list. `Esc` closes the reader from either panel, so the only Escape chain left inside it is the query line's: clear a non-empty query, then close the line.

**Only the turn being read opens.** A full outline of a long session would be hundreds of rows to page through, and a manual expand key would be the fourth thing to learn. The list stays a timeline whose current entry is open, so another turn's own context is one step away in the same walk rather than behind a key of its own.

**The section being read is the row the panel starts at.** `ReaderState` keeps one `cursor`, and a scroll re-reads it from the header at or above the top row. That cursor is what the accented header marks, and it is what the conversation resumes on when the reader closes — reading and resuming are the same act instead of two selections that can drift apart. Selecting a turn in the list opens it at its first section.

**The frame is padded so the reader covers the screen.** pi-tui repaints a line only at or after its own high-water mark, so a frame that has shrunk since the tallest one written — closing the docked inspector does it — leaves the top of the viewport out of reach, and the overlay, which may not draw there, stopped short of the screen by exactly that shortfall. While the reader is mounted the application draws that many blank rows at the foot of the frame (`ViewportPad`, `src/screen.ts`): the terminal scrolls by the shortfall, the whole viewport becomes repaintable, and the overlay covers every row of it. The rows are never seen — the reader is drawn over them — and they are gone before it is.

**`readerMinColumns` is the one-panel threshold.** It defaults to 60 — the width the body could already split at — and below it the reader draws one panel at a time: the list, or the turn `Right` opens from it. There is nothing left to refuse, so the legend keeps its keys at every width.

## Alternatives considered

**Keep the pinned compare pane.** Rejected: it was a second mode layered on the one the reader exists for. It cost a second cursor, a rewrap of the walking pane on every pin, a width class where the pin was recorded but invisible, and a legend line to explain that class — all to serve reading two sections at once, which is rarer than reading one turn end to end. Two passes of `Ctrl+G`, or two terminals, still compare two turns; the reader no longer carries the mode.

**Let the reader clear the screen and draw over it, like a pager.** Rejected for the reason the overlay exists at all: the conversation is the terminal's own scrollback, and `ESC[2J ESC[3J` discards it. Padding the frame buys the same full screen while every line above stays where the terminal put it, which the no-scrollback-clear tests hold the reader to.

**Keep the section cursor and give the rows their own keys.** Rejected: two pieces of state in one panel — which section is held, which row is on top — can disagree after any rewrap, and the disagreement is what the old re-anchor code existed to repair. Deriving the section from the scroll deletes the class of defect rather than fixing an instance of it.

**Let `Esc` step from the turn back to the list before closing.** Rejected: it gives one key two meanings in two panels and makes leaving cost two presses from where the reader opens. `Left` is the way back to the list, and the handoff window from [terminal reader overlay, Esc safety, and the editor as the hub](../feature/2026-09-18-tui-reader-overlay-and-esc-safety.md) still swallows an `Esc` that follows the closing one, so leaving in one press stops no turn.

**Drop the turn filter with the rest.** Rejected: `/` draws no panel and nothing at all until it is pressed, and it is the only way to reach one turn of a long session without paging. What made the reader hard to use was the number of things on screen at once, not the number of keys it answers.

**Drop the per-section headers and show the turn as one text.** Rejected: the headers are how a reader tells a system prompt from a reply from a tool result inside one turn, and they are the rows the scroll anchors on. They are structure, not chrome.

## Consequences

- The list and the panel share one cursor: a step in the list scrolls the panel to that section, and a scroll in the panel moves the list's mark to the section the top row belongs to. Neither can report a place the other is not at.
- `ReaderIntent` has nine cases where it had thirteen, `ReaderGeometry` reports one list width and one panel width where it reported a list and a list of panes, and the `ReaderState` fields `pinned` and the pane's section index are gone. The `compare needs <n> columns` refusal is gone with them.
- The legend rule reports `turn 3/12 · row 14/212`, and the reader's two legends name the keys of the panel that has the keyboard.
- `readerMinColumns` keeps its name and changes both its default (80 → 60) and its meaning; a deployment that set it keeps a valid value with a new effect, which the pre-stable config policy allows and [docs/config-catalog.md](../../../../docs/config-catalog.md) states.
- Reading two sections side by side is given up. Nothing else the reader did was removed: every turn is still listed, every row of a turn is still reachable, and the reader still re-reads the conversation per render.

## Related decisions

This note supersedes the reader's interaction model in [terminal reader overlay, Esc safety, and the editor as the hub](../feature/2026-09-18-tui-reader-overlay-and-esc-safety.md) — the rail-plus-sections walk, the pin, and the digit keys. Everything else in that note stands and is what this one is built on: the overlay's bottom anchor and the repaint-window analysis behind it, the `Esc` handoff window, the fold grammar and its budgets, the motions riding the fade tick, and one owner per legend.

The terminal surface and its profile are owned by [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md).
