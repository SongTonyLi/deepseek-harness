# Agent Note: Continuous terminal fade for streamed text and tool cards

Status: implemented

English | [中文](2026-09-17-tui-continuous-fade.zh.md)

## Problem

The streamed-text fade counted ticks: every tracked chunk aged one level per fade period, so the words that arrived between two periods shared one level and the trailing edge moved as a band of five brightness steps rather than as a continuous edge. The ramp itself mixed the background and foreground channels as sRGB bytes at even positions, which bunches the visible change into the dark end and starts and stops abruptly. Above both, a sustained fast stream switched the effect off mid-reply and flushed the tail, so the reader lost the marker exactly where text was arriving fastest and got it back when the stream slowed. And the fade covered the visible text of one message only: streamed reasoning and a tool card — the other two things that appear while a turn runs — arrived at full brightness, so nothing on screen said which of them had just landed.

## Decision

A chunk's brightness is a function of elapsed time, the ramp is perceptual, and everything that arrives during a turn fades in: the visible text, the reasoning, and each half of a tool card.

**Ages are read from the clock.** `FadeTracker` takes `{ steps, stepMs, now }` and records `bornAt` for each chunk; an age is `Math.floor((now() - bornAt) / stepMs)`, computed at the moment a render asks for it. `spans()` therefore carries the age each word holds at that instant, `needsRepaint()` is true while some chunk is below `steps - 1`, and `tick()` drops the chunks whose age reached `steps` instead of counting anything. A render triggered by a delta that arrives between two fade periods draws every word at its own level, which is what makes the trailing edge continuous. Deltas are cut at word boundaries, and a delta that ends mid-word leaves that word open for the next one to extend, so the word keeps the moment it first became visible.

**The ramp is eased and mixed in linear light.** `buildFadeRamp` places level `k` at `t = (k + 1) / steps`, eases it with the smoothstep `t * t * (3 - 2 * t)`, and interpolates each channel after decoding sRGB to linear light and encoding the result back. The last level stays a copy of `fg`, so settled text and the last faded frame carry identical bytes. The defaults are `FADE_STEPS = 8` levels of `FADE_TICK_MS = 33` ms, about thirty frames per second over a fade of a quarter second; `streamFadeSteps` (minimum 2) and `streamFadeStepMs` (minimum 16) stay the validated config fields that set them.

**Every streaming region has its own tail, and cards fade as a unit.** The application keeps a `textTail` and a `reasoningTail`, each created with its own clock, so reasoning and visible text age from the moment their own words appeared rather than together; the reasoning tail settles at the dim foreground, because the faint and italic sequences the block wraps its reasoning in stay in force across a recolored run. A tool card arrives complete rather than word by word, so it fades through `recolorLines`, which opens a level at the start of a line and reasserts it after every SGR the line already carries — overriding the status glyph, the bold tool name, and the dim body rule while the card fades and handing them back when it settles. A `BlockFadeClock` gives each group its level: one for the header and the call rows when the call is logged, another for the result rows when the tool answers. `FadeRegistry` holds the clocks that are still moving, drops each one as it settles, and is cleared when the terminal binds another session.

**Replay and the switched-off terminal fade nothing.** `bind` replays a session's history through the same handlers, so it sets a `replaying` flag around that loop and attaches no card fade while it is set: a replayed card describes what the session already did, however long ago it was logged. A terminal that resolves to the `none` capability, and a user who asked for reduced motion, track no tail, attach no card fade, and arm no tick.

## The tail is bounded by wall time, not by arrival rate

A chunk reaches the terminal's own foreground `steps * stepMs` after it appeared, whatever arrives in between. A fast stream therefore leaves a longer trail of brightening words and never a darker one, and never a lasting one: the trail ends a fixed time after the stream does. That bound is why no arrival-rate cutoff exists. The cost the bound admits is that a stream fast enough to fill the screen in a quarter second draws most of a screen in the ramp's colors; the ramp ends at the terminal's own foreground, so what that costs is contrast on the newest text, not legibility.

## A fade stops where the renderer stops repainting

Both transforms take a first repaintable line and return every line above it byte-identical. The application computes it per block in the frame guard — `repaintFloor(start, viewportTop)` in `src/screen.ts`, against the repaint window the screen hands the guard — and hands it to the block, which subtracts its own region offsets and passes the rest to `recolorTail` or `recolorLines`. The rule those numbers come from, and the guard that applies them, belong to [terminal transcript navigation and the focused-section inspector](2026-09-17-tui-transcript-navigation-and-inspector.md): pi-tui repaints differentially only the lines at or after the top of the last written frame's viewport, a boundary a taller frame raises and a shorter one never lowers, and falls back to a redraw that clears the terminal's scrollback for anything above it. A floor only rises, so a row that left the window is drawn in the colors the component produced and is never rewritten. The consequence is visible in two shipped cases a test pins: a card taller than the terminal fades only the part of it the renderer can still reach, and a card that later content pushed above the window settles in the frame that pushed it.

## Alternatives considered

**Keep the sustained-fast-stream cutoff.** Rejected, and it supersedes the alternative [terminal bar caret and streamed-text fade](2026-09-17-tui-bar-caret-and-stream-fade.md) settled the other way: the cutoff answered tick-counted ages, where a chunk replaced every period never visibly brightened and the tail became a lasting dark band. Wall-clock ages remove the premise — the band is bounded at `steps * stepMs` of elapsed time at any rate — so the effect stays on and the surface keeps one behavior instead of two.

**Leave reasoning and tool cards unfaded.** Rejected, and it supersedes the other alternative that note settled the other way: the effect marks what arrived just now, and during a turn that is as often a reasoning delta or a landing tool result as it is a word of the reply. A card's own fade needs no tail to follow because it has a level of its own, and the whole-line transform gives it one without a second palette.

**Ease with an ease-out curve instead of smoothstep.** Rejected: ease-out brightens fastest at the start, which puts the largest visible step exactly where the word first appears and reads as a flash. Smoothstep spends the ramp's extremes slowly and its middle quickly, so a word enters and settles without an edge at either end.

**Count ticks but interpolate between them.** Rejected: it keeps a counter the render then has to correct against the clock, which is the same computation with a second source of truth. Reading `now()` per render makes the tick a cleanup pass — it drops settled chunks and requests a render — and lets a late, early, or skipped period draw exactly what the elapsed time asks for.

**Rebuild a tool card from a dimmed palette instead of recoloring its rendered lines.** Rejected: the card's rows carry the palette's own colors, so a dimmed rendering means a second palette per level and a card that re-renders on every period. Reasserting one level after each SGR overrides the same colors in a transform over lines the card already produced, which is what keeps the differential renderer repainting only the card.

**Stream tool arguments into a provisional card.** Deferred, not rejected: `tool-call-delta` carries the name early and the arguments in pieces, so a card could appear as the model writes the call. It needs a provisional card the durable `tool/call` then replaces, which is a transcript decision rather than a fade one.

## Consequences

- The default fade lasts 264 ms over 8 levels rather than 200 ms over 5, so the effect is longer and smoother and repaints about thirty times a second while anything is below the last level; a deployment that wants the previous feel sets the two config fields.
- Three regions fade where one did, and each has its own clock, but the tick stays single: one period ages every tail and every card clock and requests one render.
- A fade never lengthens a frame or moves a line, so the cost stays what the differential renderer repaints — the lines the tail covers, or the card's own rows.
- A process that was suspended mid-stream draws settled text when it resumes rather than replaying the ramp, because an age is elapsed time and not a count of periods the process ran.
- Fades are held to the same repaint window as the focus mark, so rows that scrolled out of the renderer's reach keep the colors they were drawn in and the terminal's scrollback is never cleared to fix them.
- `tests/fade.spec.ts` pins the eased linear-light ramp against hand-computed bytes, the SGR encodings, word splitting, wall-clock ageing, the block clock, the registry, and both recolor transforms; `tests/stream-fade.spec.ts` pins the running terminal — levels per elapsed period, the settle at the terminal's own foreground, the reasoning tail's dim settle, a card fading in on its call and again on its result, replayed history and reduced motion fading nothing, the width flush, the repaint floor, and the arming and disarming of the tick.

## Related decisions

The fade's tail, its capability resolution, its SGR encodings, and the rendering rule it holds to come from [terminal bar caret and streamed-text fade](2026-09-17-tui-bar-caret-and-stream-fade.md), whose two alternatives above this note supersedes. The repaint window both fades and the focus mark observe belongs to [terminal transcript navigation and the focused-section inspector](2026-09-17-tui-transcript-navigation-and-inspector.md). The terminal application and its pi-tui rendering are owned by [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md); the second tick the fade tick runs beside belongs to [live terminal subagent panel and elapsed counters](2026-09-17-tui-live-subagent-panel.md).
