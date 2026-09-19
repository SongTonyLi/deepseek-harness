# Agent Note: Terminal reader overlay, Esc safety, and the editor as the hub

Status: implemented

English | [中文](2026-09-18-tui-reader-overlay-and-esc-safety.zh.md)

## Problem

The terminal's keyboard model reached every region but told the user almost nothing, and one of its keys was dangerous.

Entering read mode changed the screen by a thin gutter beside one block and a one-line heading above the editor, so a user who pressed the entry key could not see that the mode had changed. Walking a long session cost one press per section — a thirty-turn session needed about a hundred to reach its start — with no key for a block, a turn, or an end, and the one-line heading was the only report of where the walk had got to. `Enter` opened the focused section as an inline page that drew what the inspector already drew, and, because that page made the frame taller than the terminal, pi-tui's `previousViewportTop` rose for good and the block the page was opened from could read `off screen` forever afterwards. A system prompt or an injected context block drew every model-facing row in the transcript and again in full in the docked inspector, so one injection could be longer than the visible conversation. A printable key pressed while a region held the keyboard was swallowed without a mark on screen.

`Esc` was the hazard. It returned to the editor from every region, page, and picker, and in the editor it stopped the running turn on one press with no confirmation — so the habitual second press of a double press stopped the turn the user was still reading.

## Decision

Six decisions, one screen. The conversation stays the terminal's own scrollback; everything the application owns is either docked chrome under it, which is framed and never animates its row count, or a full-screen overlay over it, which costs the frame no rows at all.

**A turn is never stopped as a side effect.** Every `Esc` that only hands the keyboard back — leaving the transcript, the panel, or the bar, settling any modal, closing the reader — starts a handoff window of `ESCAPE_HANDOFF_MS` (750 ms, a human double press, in `src/keys.ts`). An `Esc` that reaches the editor inside that window is consumed and does nothing at all: it does not arm the stop, show the line, or clear anything. Outside it, with a turn running and the autocomplete closed, the first press shows the transient line `press Esc again to stop turn <n>` and arms the stop for exactly as long as any part of that line is on screen — the hold plus the fade, and the hold alone where the terminal draws no ramp — and only a second press inside that window cancels. Any other key the editor takes disarms and takes the line down, so a stale arm cannot survive a sentence of typing. `Ctrl+C` keeps its own 600 ms window, because its first press already does something useful.

**The editor is the middle of the region stack, not its edge.** The regions are walked in the order the screen draws them: the transcript above the editor, the editor, the subagent panel, the status bar. `Down` at the newest section, `Up` on the panel's first row, and `Up` on the bar with no panel drawn all land in the editor, where the caret is. `Shift+↑` re-enters the transcript on the remembered cursor, settled against the blocks drawn now, so returning to type does not cost the walk back. Coarse keys were added where one press per section was the only step: `Shift+↑↓` jump a block, `PgUp` / `PgDn` a turn, `Home` / `End` the ends, `Shift+←→` the held block's ends, and `Tab` / `Shift+Tab` cycle the regions that are drawn. A printable key pressed in a docked region hands the keyboard back to the editor and types at the caret; `Space` in the transcript is the one exception, because folding the marked block is that region's primary verb and a leading space is trimmed off a prompt anyway.

**The reader is an overlay, and it replaces the inline section page.** `Ctrl+G` from any docked state, `Enter` in the transcript, and `/turns` open a full-screen pane composited into the viewport: a list of turns with `⬡ ✻ ¶ ⚒` markers, the selected turn scrolling beside it under its own section headers, `/` filtering the list, and `Esc` closing back to the transcript on the section last read — [the reader is two panels](../simplification/2026-09-18-tui-reader-two-panels.md) supersedes the sections walk and the compare pane this note shipped. It holds no copy of the conversation — it re-derives its turn groups from the transcript's own blocks on every render — so a streaming reply grows inside it and a landing tool result appears. `DetailPrompt` stays for the lists `browse` drives — `/todos`, `/subagents`, `/changes`, and the `todo` status-bar segment — and for a subagent panel row, where a bounded page in the modal slot is the right size.

**One fold grammar, with a budget for injected context.** A folded block's last row reads `… <n> more row(s) · <key>`, where the key is the one that works from where the keyboard is: `Space expands` while the transcript marks that block, `Ctrl+O expands` otherwise, and `Ctrl+G reads it` under the docked inspector, whose remaining rows the reader draws. `src/transcript.ts` owns those three phrases and the grammar around them. `ContextBlock` folds at the new `contextPreviewLines` (default 4) as `ToolBlock` folds at `toolPreviewLines`, and the docked inspector folds every section kind at `focusPreviewLines`; `parts()` stays complete, so the walk, the inspector, and the reader still reach every model-facing row. `Ctrl+O` and `/tools` fold both kinds through one `Foldable` marker.

**Motion rides the tick that already exists.** The fade registry the streamed text uses also carries the chrome motions: the keyboard landing on a region lifts that region's frame, chip, and mark for six ticks, a section step lifts the new mark for three, a bar selection for four, and the reader grows and shrinks over six and four. `src/motion.ts` is a clock plus one `pulse(palette, text, level)` that returns the surface's own settled drawing at level 0, so a settled motion is byte-identical to what the surface drew before. No motion changes a docked row count, `reducedMotion` and a colorless terminal turn every one of them off, and an idle session arms no timer.

**One owner per legend.** `src/keys.ts` holds the legend of every docked region in declared degradation steps, the entry keys the unfocused bar reserves, and the lines `/help` lists per focus state; `src/reader.ts` holds the reader's two legends the same way. Every surface reads those steps through `fitLegend`, and `/help` prints one row per focus state built from the same table, so a key cannot be named one way on screen and another way in `/help`.

## Why the overlay is anchored at the bottom of the viewport

pi-tui's `TuiMainScreen` repaints differentially only lines at or after `previousViewportTop`, a high-water mark a taller frame raises for good; a change above it takes the full-redraw branch, which writes `ESC[2J ESC[H ESC[3J` and discards the terminal's scrollback. `compositeOverlays` runs inside `doRender` before the differential compare and composites into the **last `terminal.rows` lines of the frame**, which is why an overlay costs the frame no rows and why the inline page it replaces cost the repaint boundary permanently.

A top-anchored overlay composites at the frame's own viewport top. Whenever the tree frame has shrunk since the renderer's high-water mark — which every `Esc` out of read mode does — that line lies above the boundary and the renderer redraws in full. The reader is therefore anchored `bottom-left` and told it may draw `terminal.rows - viewportFloor` lines, which puts its first line exactly on the last repaintable one; at the dominant `viewportFloor === 0` that is the whole screen, and after a shrink the padding rows of `ViewportPad` give the shortfall back before the reader draws, so it covers the screen there too. The reveal grows from the bottom rule upward for the same reason: the overlay's row is `termHeight - height`, so growing downward would slide every drawn line up one row per tick. The transient line is placed the same way and falls back to a transcript notice when the viewport's top is out of reach, because a line that says which key stops a turn is worth more than its own disappearance.

## Alternatives considered

**Keep one-press `Esc` and confirm with a prompt.** Rejected: a modal over a running turn is heavier than the risk, and the prompt's own `Esc` would inherit the same ambiguity. A second press inside a visible window is the confirmation.

**Give the cooldown a configurable duration.** Rejected: it debounces one human double press, not a deployment difference. It stays a constant beside the `Ctrl+C` window.

**Show transient key feedback as a docked line or a transcript notice.** Rejected: a docked row raises `previousViewportTop` for good, and guidance the next key press makes obsolete should not become permanent scrollback. The notice remains the fallback for the one case where the overlay cannot be drawn.

**Keep the section page inline in the modal slot, where the other pages are.** Rejected: an inline page is frame rows, and the boundary the renderer judges a frame against only rises, so a page taller than the terminal puts the block it was opened from out of marking reach for the rest of the session — the `off screen` that outlives the page. An overlay is composited after the tree has rendered and costs the frame no rows, which is also what leaves room for the turn list and the turn beside it that a docked page has no height for.

**Move the terminal to the alternate screen so any line can be repainted.** Rejected again, as in [terminal transcript navigation and the focused-section inspector](2026-09-17-tui-transcript-navigation-and-inspector.md): the conversation is the terminal's own scrollback, wheel, and selection, and the overlay buys full-screen reading without giving that up.

**Draw the reader as columns of turns, or as two text panes with no rail.** Rejected as the default: columns stop being readable at 80 columns and neither answers "where am I in the session". The rail is the navigation spine; the compare pane it shipped beside was dropped by [the reader is two panels](../simplification/2026-09-18-tui-reader-two-panels.md).

**Bind the reader to `Ctrl+P`.** Rejected: `Ctrl+O` already folds every block, and two adjacent keys opening two different surfaces makes a mistype expensive. `Ctrl+G` is claimed by neither pi-tui's editor nor this application.

**Let digits select a part in the docked regions.** Rejected: a printable key must type where an editor is visible, and a user writing "1. first" from read mode must not jump instead. The reader, where nothing can be typed, was the one surface they were bound in, until [the reader is two panels](../simplification/2026-09-18-tui-reader-two-panels.md) dropped them.

**Fold or unfold with `Left` / `Right` at a block's edges.** Rejected: it overloads the part walk with a destructive-looking verb, and `Space` already folds in one press.

**Animate the fold and unfold.** Rejected: it animates transcript row counts, which is exactly what the renderer's repaint window makes expensive, and it buys no navigational information.

**Give the chrome motions a clock of their own.** Rejected: a second clock is a second reason to repaint, and the two would have to agree about when nothing is moving — the agreement an idle session's "no timer at all" rests on. Every motion registers with the fade registry the streamed text already ticks, so one armed period draws all of them and the last one to settle disarms it.

**Lower the `focusPreviewLines` default now that every section kind folds.** Rejected: the harm was the unbounded context draw, which `contextPreviewLines` and the inspector's fold fix; changing a shipped default is a user-visible change with no new reason behind it.

**Open a panel row's details as an overlay too.** Rejected: a sixteen-row page in the modal slot is the right size for one list entry, and the overlay would buy nothing a bounded page does not already give.

## Consequences

- `Esc` can no longer stop a turn from outside the editor, and inside it only on a second press while the line that offered it is on screen. The cost is one extra press for a deliberate stop.
- The walk crosses through the editor, so `Up` and `Down` no longer jump over the caret; a user who wanted the old edge-to-edge jump uses `Tab`.
- `Ctrl+O` remains the one key that rewrites lines above the repaint window, so on a long transcript it makes pi-tui redraw in full. `Space` refuses that on a block the renderer can no longer mark and opens the reader instead.
- The reader re-derives everything per render, so it never shows a stale conversation, and a session switch takes it down with the notice `the transcript changed · reader closed`.
- Three new validated config fields — `contextPreviewLines`, `toastMs`, `readerMinColumns` — join `toolPreviewLines` and `focusPreviewLines`, whose meanings are now "before `Space` or `Ctrl+O`" and "before the reader".
- Every legend lives in one module, so adding a key means editing the key model and nothing else; `/help`, the surfaces, and both READMEs state the same words.

## Related decisions

The reader's own interaction model is superseded in turn by [the reader is two panels](../simplification/2026-09-18-tui-reader-two-panels.md), which keeps everything else here current.

This note supersedes parts of two earlier ones, which stay current for everything else. From [terminal transcript navigation and the focused-section inspector](2026-09-17-tui-transcript-navigation-and-inspector.md): the `Esc` semantics, the region stack's ends, the "every other key is consumed" rule, `Shift+Up` / `Shift+Down` walking one section rather than a whole block, `Enter` opening an inline `DetailPrompt` page, and the system prompt and injected context drawn in full in the transcript and the inspector alike; what its blocks carry as sections, its in-place gutter, and its repaint-window analysis are unchanged and are what the reader and the fold rely on. From [navigable terminal status bar](2026-09-16-tui-status-bar-navigation.md): `Tab` / `Shift+Tab` moving the bar's selection, which now cycle regions, the unfocused line's trailing `Shift+↓`, which is now the anchored model at one end and a pair of entry hints reserved at the other, and the bar consuming every printable key, which now returns the keyboard to the editor and types there; its segment order, its details, and the shared `src/status.ts` sections are unchanged.

The terminal surface and its profile are owned by [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md). The panel this stack walks through is [live terminal subagent panel and elapsed counters](2026-09-17-tui-live-subagent-panel.md), the pages the modal slot still carries are [terminal list-then-details navigation](2026-09-16-tui-list-then-details-navigation.md), and the tick every motion here rides is [continuous terminal stream fade](2026-09-17-tui-continuous-fade.md).
