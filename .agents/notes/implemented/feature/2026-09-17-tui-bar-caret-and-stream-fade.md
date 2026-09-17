# Agent Note: Terminal bar caret and streamed-text fade

Status: implemented

English | [中文](2026-09-17-tui-bar-caret-and-stream-fade.zh.md)

## Problem

The caret was a reverse-video block cell: pi-tui's `Editor` paints the character under the caret in reverse video, `EditorOptions` carries no switch for it, and the block is drawn whether or not the editor is focused — so a full-cell caret sat in the input while the status bar owned the keyboard, and the terminal's own caret preference never applied. Streamed text arrived at full brightness: a reply the model was still writing looked exactly like one it had finished, so nothing on screen separated the words arriving right now from the text that was already final.

## Decision

The editor leaves the caret to the terminal, and the newest streamed words are drawn dimmer and brighten to the normal foreground as they age.

**The caret.** `BarCursorEditor` extends pi-tui's `Editor` and removes the drawn block from the lines `render` returns. The removal is anchored at `CURSOR_MARKER`, the hidden marker pi-tui emits immediately before the cell the terminal cursor is placed at: only the `\x1b[7m` / `\x1b[0m` pair that follows the marker is deleted, so reverse video the user typed or pasted survives, and the cell's own character — or the space pi-tui drew past the last character — stays, so the line keeps its visible width and the marker keeps its column. Everything else is pi-tui's: text, autocomplete, padding, borders, scrolling, submission, and history are untouched. The application constructs `TuiMainScreen(terminal, true)` so pi-tui shows the hardware cursor at that marker, writes DECSCUSR `\x1b[5 q` (blinking bar) once the terminal is taken over, and writes `\x1b[0 q` on stop, which restores the shape the user's terminal is configured with — the shell that regains the terminal keeps whatever caret it was left with, so giving the default back is part of releasing the terminal.

pi-tui emits the marker only while the editor is focused but draws the block either way, so `render` turns the marker on for the `super.render` call to anchor the removal and then drops the marker again when the editor is not focused. The unfocused editor therefore shows no caret at all: the terminal cursor stays with the region that owns the keyboard, and the input does not advertise a caret no keystroke answers to.

**The fade.** `FadeTracker` holds the tail of one region streaming right now. It splits deltas at word boundaries rather than at token edges, which reads more smoothly, and a delta that ends mid-word leaves that word open so the next delta extends it and the word keeps the moment it first became visible. A chunk brightens one level per `streamFadeStepMs` from the moment it became visible and leaves the tail after `streamFadeSteps` of them. `buildFadeRamp` interpolates from the terminal background to the foreground, `fadeSgr` encodes one level as `ESC[38;2;R;G;Bm` under truecolor or the nearest xterm grayscale index under 256 colors, and `recolorTail` walks the rendered lines backwards over visible columns — stepping over escape sequences, wide characters, and grapheme clusters as units — to paint each chunk's columns under its level.

`resolveFadeCapability` decides once per run: reduced motion, a disabled palette, a non-empty `NO_COLOR`, and `TERM=dumb` each mean no fade at all; `COLORTERM` of `truecolor` or `24bit` gives the 24-bit ramp, a `TERM` naming `256color` gives the grayscale ramp, and everything else falls back to a two-level mode that draws the two youngest ages faint (`ESC[2m`) and needs no colors. The ramp itself needs the terminal's background, which the application asks for once with pi-tui's `queryTerminalBackgroundColor` bounded at 200 ms; a terminal that answers nothing usable also lands in the two-level mode. `streamFadeSteps` (minimum 2) and `streamFadeStepMs` (minimum 16) are validated config fields whose defaults [continuous terminal fade for streamed text and tool cards](2026-09-17-tui-continuous-fade.md) sets, and `reducedMotion` turns the effect off for users who do not want text that changes after it is drawn.

## The fade is a transform over rendered lines, not a redraw

`recolorTail` takes the lines the streaming block already produced and returns them with the tail's trailing visible columns recolored; lines the tail does not cover come back byte-identical. pi-tui's `TuiMainScreen` compares a component's returned lines against the previous frame and repaints only the lines that changed, so a fade tick reaches the terminal as the tail's lines and nothing else, however long the message above them is. Nothing in `src/fade.ts` writes to a terminal, emits a cursor movement, or tracks a screen row.

Settled text is never redrawn, in two senses. `AssistantBlock.commit` drops the block's `FadeRender` when the durable `assistant/message` replaces the streamed content, and the application clears the tracker at stream start, stream end, `turn/end`, and session rebinding, so a committed message and a block rebuilt from history carry no tail at all. Within a running stream, a chunk leaves the tail by ageing out and then renders exactly as the Markdown component drew it. A width change flushes the tail as well, because the columns it was matched against do not describe the rewrapped lines.

## The oldest tail level is the terminal's own foreground

pi-tui reports the terminal background but never its foreground, so the top of the ramp is an assumption: a light foreground over a dark background and a dark one over a light background. That assumption is never drawn. The streaming block hands `recolorTail` only the chunks younger than `steps - 1`, so the oldest visible level — the one the assumed foreground would colour — is left to draw in whatever foreground the terminal is actually using, which is also what the chunk draws in once it settles. No chunk jumps color as it leaves the tail, and a terminal whose foreground is not the assumed one still ends the ramp on its own color.

Two further degradations are deliberate. Markdown rewrites text, so a chunk may not appear in the rendered output at all; matching then stops and that chunk plus every older one draws at the foreground, which is the least visible failure available because older chunks are already the brightest levels. And a recolored run reasserts the sequences in force at its start, so enclosing bold or italic continues across it while an enclosing foreground color wins over the ramp and that run simply does not fade.

## Alternatives considered

**Keep pi-tui's block caret.** Rejected: it is a full cell in reverse video, which reads as a selection rather than an insertion point, it cannot follow the user's terminal cursor preference, and it stays drawn while another region owns the keyboard. `EditorOptions` has no switch, so the choice was the subclass or the block.

**Fork or patch pi-tui to stop drawing the block.** Rejected: pi-tui is an upstream dependency, and a fork would take on its editor, autocomplete, and rendering for one cell. The subclass overrides one method and keeps every upstream fix.

**Strip reverse video from the editor's lines wherever it appears.** Rejected: reverse video is legitimate content — a user can paste it, and a theme can emit it — so a blanket strip would eat it. The `CURSOR_MARKER` anchor names the one pair pi-tui drew.

**Hide the caret by not focusing the editor, rather than dropping the marker.** Rejected: the application does set pi-tui's focus to `null` while a docked region owns the keyboard, but pi-tui draws its block regardless of focus, so the unfocused editor would still show a block. Dropping the marker is what makes "no caret" true on screen.

**Fade by re-rendering the streaming block at a dimmer palette.** Rejected: the block's whole text would change bytes on every tick, so the differential renderer would repaint every line of a long reply 25 times per second. A transform over the rendered lines changes only the lines the tail covers.

**Track the tail in screen coordinates.** Rejected: the Markdown component owns wrapping, styling, and rewriting, so a row/column model in the application would have to reproduce them and would break on every resize. Matching the chunk text backwards through the rendered output keeps the block as the only thing that knows where text landed.

**Let the ramp end at the assumed foreground.** Rejected: a terminal whose foreground is not white on black or black on white would show a visible jump when a chunk settles. Withholding the oldest level costs one brightness step and removes the jump for every terminal.

**Fade the reasoning text and tool cards too.** Rejected: the effect marks where the model is writing right now; reasoning is already dim and a tool card's body arrives as one result, so there is nothing to follow. `recolorTail` is handed the Markdown lines alone, which is also what keeps the tail at the end of what it matches against. [Continuous terminal fade for streamed text and tool cards](2026-09-17-tui-continuous-fade.md) supersedes this alternative: reasoning streams on a tail of its own, and a card fades as a whole through a line transform that needs no match against the end of anything.

**Keep fading during a fast stream.** Rejected: at one chunk per repaint the ramp is invisible and the tail becomes a permanent dark band behind the stream head, which is the opposite of the effect's purpose. Detecting the sustained case and stopping is recoverable; slowing the stream is not this surface's choice. [Continuous terminal fade for streamed text and tool cards](2026-09-17-tui-continuous-fade.md) supersedes this alternative: ages read from the wall clock bound the tail at `streamFadeSteps * streamFadeStepMs` of elapsed time whatever the arrival rate, so the band this argument answered cannot last and no cutoff exists.

## Consequences

- The caret is the terminal's own, so its blink, color, and shape come from the user's terminal, and the application must restore the default on every exit path it owns. Quitting writes `\x1b[0 q` before the tree stops.
- A terminal that does not honor the synchronized-output sequences pi-tui wraps a frame in can show the hardware cursor moving across a repaint. The package README states this.
- The fade costs nothing where it cannot be drawn: a terminal resolved to `none` tracks no tail and arms no tick, so streaming there behaves exactly as it did before the effect existed.
- Two brightness levels is the shortest ramp that shows, so `streamFadeSteps` is validated at a minimum of 2 and `streamFadeStepMs` at 16, which is pi-tui's own frame period.
- `tests/fade.spec.ts` pins the ramp, the SGR encodings, the tracker's word splitting and wall-clock ages, and the recolor's ANSI and grapheme handling; `tests/stream-fade.spec.ts` pins the running terminal — the level per elapsed period, the settle at the terminal foreground, the arming and disarming of the fade tick, the two-level and no-fade modes, and that committed or replayed text never fades; `tests/editor.spec.ts` pins the block removal against the stock editor, the unfocused case, and the two DECSCUSR sequences.

## Related decisions

The terminal application and its pi-tui rendering are owned by [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md). The regions that take the keyboard from the editor — and so leave it without a caret — come from [navigable terminal status bar](2026-09-16-tui-status-bar-navigation.md) and [live terminal subagent panel and elapsed counters](2026-09-17-tui-live-subagent-panel.md), whose own tick runs beside this one at its own period. The clock the tail ages on, the ramp's easing, and the reasoning and tool-card fades built over this transform are owned by [continuous terminal fade for streamed text and tool cards](2026-09-17-tui-continuous-fade.md).
