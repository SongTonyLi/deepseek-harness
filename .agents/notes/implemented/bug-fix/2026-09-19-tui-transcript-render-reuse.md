# Agent Note: Reuse each transcript block's last drawing in the terminal

Status: implemented

English | [中文](2026-09-19-tui-transcript-render-reuse.zh.md)

## Problem

pi-tui's main-screen renderer asks every mounted component for its lines on every frame and diffs the whole frame against the last one. The terminal transcript is never pruned, so the work one frame does grows with the session. Three block kinds in `packages/bundle/tui-app/src/blocks.ts` rebuilt their lines from scratch on every frame, and the tool card ran the shiki tokeniser over the code rows of every `read`, `edit`, and `write` card each time, folded or not. Frames are requested at up to 60 Hz while a reply streams, at 12.5 Hz by the spinner while the agent runs, and at 30 Hz while any fade moves, so a frame that outgrows its period pins the process at full CPU for the rest of the turn and every key press waits behind it. Measured over the package bench with one folded TypeScript `read` card and one code-fenced reply per turn under a 1500-row system prompt: at 80 turns an idle frame took 455 ms and, with the fade and focus guard in `src/app.ts` rendering the conversation a second time, 910 ms; the guarded frame took about 240 ms at 20 turns and 3.9 s at 320; with code colour off the 80-turn idle frame took 31 ms, so the tokeniser was about 93% of the cost.

## Decision

Each block keeps the lines it last drew together with the key they were built for - the width, whether the focus gutter narrowed it, its fold state, and for a card its status and result - and hands them back until the key changes. `invalidate()` drops them, which the application already calls on every block when a grammar lands; a new terminal width misses every key on its own. What changes every frame is drawn over the kept lines rather than into them: a card fade recolours the kept groups, the focus mark prepends its gutter, and a streaming reply, whose tail recolours words by their age, is composed each frame as before. A reply also keeps the coloured fences of its last Markdown parse in a memo keyed by language and source, because pi-tui's `Markdown` re-parses the whole message on every text change and asks the theme to colour every fence again; the memo answers a fence it has seen and drops, when the next parse closes, whatever that parse did not ask for, so it never holds more than the reply shows. A fence the highlighter left plain is not kept, so the grammar that lands is asked for it.

One entry per block and one parse's worth of fences per reply bound the memory to what the transcript already retains, so no cache size, eviction policy, or configuration is introduced. Focusing a card rebuilds that one card, because the gutter narrows it and renames its fold key; one card per key press is accepted.

## Alternatives considered

**One process-wide highlighter cache keyed by source and language, bounded by an LRU.** Rejected: the bound is a tunable with no deployment meaning, and a memo that lives with the block it serves is freed with the block on a session switch without a policy.

**Cache the painted rows apart from the wrapped rows, so a focus change or a width change re-wraps without recolouring.** Rejected for now: a resize changes every block's width key regardless, and a focus change rebuilds one card, so the second level would save one tokenisation per key press.

**Prune old blocks from the transcript container.** Rejected: the terminal's scrollback owns history, the keyboard walk and the reader address every block, and pi-tui repaints only the lines that changed, so a settled block that costs one key comparison is cheaper than deciding what to drop.

**Let the settle guard reuse the frame it was handed instead of rendering the conversation again.** Not needed once blocks reuse their lines: the guard's second walk now returns kept arrays, and the measured focused frame equals the idle one.

## Consequences

- The same bench after the change: the idle frame takes 1.2 ms at 20 turns, 4.4 ms at 80, and 18 ms at 320; the fade- or focus-guarded frame 1.6 ms, 4.5 ms, and 21 ms; every card expanded at 80 turns 0.7 ms against 3.4 s before. What remains is pi-tui's own pass over every line of the frame, which grows with the frame's text and is outside this package.
- `tests/blocks.spec.ts` pins the contract with a counting highlighter: a card colours once across repeated frames, again when it folds or unfolds, and again after `invalidate()`; a reply colours an unchanged fence once across stream deltas and the commit; an answer left plain is asked for again; a settled block returns the same lines until something changes.
- The measurements come from the package bench over a fake terminal and exclude the terminal emulator and model latency. A streaming reply still re-parses its Markdown on every delta, and the fence still open at the end of the message is coloured again per delta until it closes.

## Related decisions

The colour this keeps is [syntax colour for fenced code in the terminal](../feature/2026-09-19-tui-syntax-colour.md); the settle guard and repaint window it stays inside are [terminal reader overlay, Esc safety, and the editor as the hub](../feature/2026-09-18-tui-reader-overlay-and-esc-safety.md); the surface is [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md).
