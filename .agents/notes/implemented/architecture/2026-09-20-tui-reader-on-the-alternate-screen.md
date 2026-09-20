# Agent Note: The terminal reader runs on the alternate screen

Status: implemented

English | [中文](2026-09-20-tui-reader-on-the-alternate-screen.zh.md)

## Problem

The terminal's full-screen reader drew on the same screen as the conversation, and a user reported the result: after `Esc`, rows of the reader were left in the terminal's scrollback, spliced into the middle of a tool card.

The reader was an overlay. pi-tui composites an overlay into the last `terminal.rows` lines of the frame it is about to write, so the reader's rows were the conversation's own rows, written into the terminal's main screen and its scrollback. Three things follow from that, and only the first was designed for:

- Nothing the overlay drew could be taken back except by the renderer's differential repaint, which reaches only lines at or after `previousViewportTop` — a high-water mark a taller frame raises and a shorter one never lowers. Any change above it takes the full-redraw branch, which writes `ESC[2J ESC[H ESC[3J`, discarding the conversation the user is reading.
- Covering the screen was conditional. A frame that had since shrunk left the viewport's top out of the renderer's reach, so the reader was drawn short of full screen until `ViewportPad` appended blank rows to push the frame back to the mark. The pad worked, at the cost of a frame length that fed on the reader's own presence and a second settle pass whenever it changed.
- Every frame while the reader was up diffed the whole conversation, however long it was, to draw a screen that had nothing to do with it.

A reader is a pager. Terminals already have a screen for pagers.

## Decision

`Ctrl+G`, `Enter` on a section, and `/turns` switch the terminal to its **alternate screen** (`ESC[?1049h`) and hold the conversation's screen off the terminal until the reader closes.

`src/alt-screen.ts` owns the switch and the drawing. It addresses every row absolutely (`ESC[<row>;1H`), clears and rewrites only the rows whose text changed since the last drawing, wraps each frame in one synchronized-output pair, and disables autowrap so a row that fills the last line cannot scroll. Entering and leaving are balanced and idempotent: a caller cannot leave the terminal one switch deep.

`GuardedMainScreen.suspend(onRender)` is the other half. It stops every write to the terminal while leaving the renderer's record of the main screen untouched — `previousLines`, `previousViewportTop`, and the cursor row all stay as they were — and answers every render request by drawing the suspending surface instead. `ESC[?1049l` restores exactly the screen that record describes, so the first frame after `resume()` writes only what the session changed meanwhile. The application therefore needs no new clock and no new render path: the render requests it already makes for a landing tool result, a streamed word, a fade tick, and a terminal resize all reach the reader while it is up.

Keys follow the same rule. While the reader holds the terminal, `TuiApp.onKey` hands every key to the pane and consumes it, so nothing reaches the editor behind it and pi-tui is never asked for a frame of a conversation the terminal is not showing. `Ctrl+C` alone withdraws the reader.

Four consequences of drawing on the conversation's screen are gone with it: `ViewportPad` and the frame-length feedback it needed, the reveal the reader grew and shrank through (six ticks and four, meaningless when the screen switches), the overlay's focus-restore dance, and `viewportFloor`'s role in deciding how tall the reader could draw. `viewportFloor` remains, for the one surface still composited into the conversation: the transient key-feedback line.

The line that explains why a fold key opened the reader — `above the repaint window · opened in the reader` — became a conversation notice. It is written before the reader takes the terminal, and it is read when the terminal comes back; as a floating line it would have been drawn on a screen the user was about to leave.

## What the alternate screen guarantees

The two properties the overlay could only approach:

- **The reader cannot interfere with the conversation.** Its rows are never written to the main screen, so no full redraw, foreign write, scroll, resize, or multiplexer scrollback can put them in the user's history. Closing restores the conversation byte for byte.
- **The reader is full screen on every terminal.** It is told `terminal.rows` and returns exactly that many lines. What the conversation's frame did, and what the renderer can still repaint there, decide nothing.

The conversation is not drawn while the reader is up. A turn that runs, a tool result that lands, and a notice that is printed are all drawn in one frame when it closes — while the reader itself shows them as they arrive, because it re-reads the blocks on every drawing.

## Alternatives considered

**Keep the overlay and harden the repaint path.** Rejected: the guarantee the user asked for is unconditional, and every version of this one is conditional on pi-tui's repaint window, on no other writer touching the terminal, and on the terminal honouring `ESC[3J`. The overlay's rows are the conversation's rows; that is the property to remove, not to defend.

**Move the whole terminal surface to the alternate screen.** Rejected again, as in [terminal transcript navigation and the focused-section inspector](../feature/2026-09-17-tui-transcript-navigation-and-inspector.md) and [the reader overlay](../feature/2026-09-18-tui-reader-overlay-and-esc-safety.md): the conversation is the terminal's own scrollback, wheel, and selection, and giving that up costs far more than the reader buys. Switching for the reader alone gives up nothing — the user is not scrolling the conversation while reading it, and the reader has its own scroll keys.

**Run pi-tui's `TuiAltScreen` for the reader.** Rejected: it owns raw mode through `terminal.start` / `terminal.stop`, which would cycle the terminal's input state on every `Ctrl+G` and risk dropping buffered keys, and it brings a scroll view, mouse capture, selection, and search around a pane that already returns exactly the rows the screen has and answers its own keys. The thin writer here is one file with no state beyond the rows it last drew.

**Keep the reveal as a fade of the reader's own rows.** Rejected: the terminal switches screens in one step, so there is no frame in which a partial reader and the conversation are both on screen. An animation would be drawn on a screen the user has already been given in full.

**Leave the fold line floating.** Rejected: it explains why the reader opened, and it would be drawn on the screen the switch immediately replaces. As a notice the conversation keeps it, which is what a fact worth keeping does here.

## Consequences

- The reader costs the conversation nothing: no line, no repaint-window movement, and no scrollback risk. The class of defect the user reported cannot recur, whatever the terminal or multiplexer does.
- The reader fills the screen unconditionally, including right after read mode closes or the spinner leaves, where the overlay previously depended on `ViewportPad`.
- A frame drawn while the reader is up costs the reader's own rows, not a diff of the whole conversation, so reading a long session no longer pays for the session's length.
- `reducedMotion` has one less effect to switch off, and `src/motion.ts` two fewer constants: the reader has no motion to reduce.
- A terminal that does not support the alternate screen would draw the reader over the conversation's screen and restore nothing; every terminal this application supports implements `ESC[?1049h`, as every pager on them relies on it.
- The conversation stops updating on screen while the reader is up. It catches up in one frame when the reader closes, and the reader shows everything that lands meanwhile.

## Related decisions

This supersedes the "Why the overlay is anchored at the bottom of the viewport" reasoning in [terminal reader overlay, Esc safety, and the editor as the hub](../feature/2026-09-18-tui-reader-overlay-and-esc-safety.md); everything else in that note — the `Esc` handoff window, the region stack, the fold grammar, the legend ownership — is unchanged, as is the reader's own two-panel interaction model in [the reader is two panels](../simplification/2026-09-18-tui-reader-two-panels.md). The repaint-window analysis those notes rest on still governs the conversation's own screen and the transient line composited into it, and is owned by [terminal transcript navigation and the focused-section inspector](../feature/2026-09-17-tui-transcript-navigation-and-inspector.md).

The terminal surface and its profile are owned by [terminal surface as the shipped `tui` profile](2026-09-15-terminal-surface-tui-app.md). The per-block drawing memo that makes a settled frame cheap is [reusing each transcript block's last drawing](../bug-fix/2026-09-19-tui-transcript-render-reuse.md).
