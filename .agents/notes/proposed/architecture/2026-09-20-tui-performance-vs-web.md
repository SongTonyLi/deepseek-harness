# Agent Note: Measure TUI endpoints separately before copying Web optimizations

Status: proposed

English | [中文](2026-09-20-tui-performance-vs-web.zh.md)

## Problem

A `dsh tui` run and a `dsh web` run can feel different even though both profiles share `dsh-base` and the same `agent loop`. A single “TUI is slower” number cannot name the work that differs. Cold profile boot, `--resume` of a long log, live token paint, key echo while a turn runs, and model or tool time that both surfaces already share are five different clocks.

Web already has required lanes for session open, Client fold, active reconnect, and a long-session browser workflow ([session-open gate](../../implemented/testing/2026-09-04-session-open-performance-gate.md), [frontend budgets](../../implemented/testing/2026-09-06-frontend-performance-budgets.md)). Session-open excludes model and Gateway. The browser workflow includes the test Host, transport, Playwright, and paint; it is not `dsh web` process spawn. `benchmarks/` has no TUI user path. `packages/bundle/tui-app/tests/bench.ts` is a functional fake-`Terminal` harness, not a timing gate.

Without separated clocks, a tempting copy of Web paging, conversation fold, or `requestAnimationFrame` batching can fight shipped terminal rules: the transcript is never pruned, scrollback owns history, and a line change above `previousViewportTop` writes `ESC[3J` and wipes that history ([repaint window](../../implemented/feature/2026-09-17-tui-transcript-navigation-and-inspector.md)). Settled-block line reuse already shipped; it rejected pruning, not that sequence ([render reuse](../../implemented/bug-fix/2026-09-19-tui-transcript-render-reuse.md)).

## Proposal

Treat TUI performance as five endpoints. Measure each on the production entry path before changing product code. Copy a Web mechanism only when it does not break those terminal rules and a named card shows the cost it claims to remove.

### Endpoints the complaint mixes

| Id | User operation | What a faster Web tab does not prove |
|---|---|---|
| A | Cold start: process spawn until the editor echoes a key | Web chrome can appear after Host boot, before any Session exists |
| B | Resume: `--resume` until history is on screen and the editor accepts input | Web opens a 50-message page and may leave the Agent unactivated |
| C | Live stream: token to visible reply text | Web paints on the browser thread; TUI paints on the Node loop that also runs the loop |
| D | Input during a turn: key to editor echo while tokens or the spinner run | Web input is a different process from Host tool and LLM I/O |
| E | Shared loop work: prompt assembly, tools, model I/O | Not a TUI versus Web product gap once a Session is running |

tsx source-launch (`pnpm dsh`) taxes both Hosts. Compare built `dsh --profile tui` to a built Web Host plus built Client. PTC mode is a `dsh-base` row, not a TUI insert. Shiki does not load on an empty new session; the first fenced block that asks for a grammar does ([syntax colour](../../implemented/feature/2026-09-19-tui-syntax-colour.md)).

### What source already shows

- Both profiles mount `@deepseek-ai/dsh-agent-loop` through `dsh-base`. After a Session is running, host-plane rows versus `agent-presets` remounts do not change the class of per-turn work.
- TUI `TuiApp.onStreamFrame` calls `this.tui.requestRender()` on every `chunk` and `end` frame (`start` returns without one). On the main screen, pi-tui `TuiBase.requestRender` already coalesces to `MIN_RENDER_INTERVAL_MS = 16`; a later call in the same window returns while `renderRequested` is true. The suspended reader paints immediately ([alternate-screen reader](../../implemented/architecture/2026-09-20-tui-reader-on-the-alternate-screen.md)).
- A streaming `AssistantBlock` calls `compose()` on every `render()` while a fade is attached. pi-tui `Markdown.render` re-lexes only after `setText` or a width change. Fade ticks therefore recolor; they do not re-parse.
- `presentCall` and `presentResult` run on `tool/call` and `tool/result` only. A `tool-call-delta` updates the loader message.
- `--resume` pages the log at `HISTORY_PAGE = 256` in `readHistory` (one full-log pass on a read handle, then that handle closes), then `agents.resume()` opens a write handle and calls `handle.read(0, undefined)` (a second full-log pass, which may append interrupted-turn closers). `TuiApp.bind` then replays the `readHistory` snapshot through `onSessionEvent`, so it omits those closers. Web Client `Session.doOpen` requests `PAGE_MESSAGES = 50`.
- Web conversation assembly publishes live chunks as `'animation-frame'` and waits for three `requestAnimationFrame` callbacks. That is a looser cap than TUI’s 16 ms scheduler, not a capability TUI lacks.
- Settled blocks already return `LastDrawn` lines. The reuse note’s fake-terminal bench reports idle frames of 1.2 ms at 20 turns, 4.4 ms at 80, and 18 ms at 320. Remaining idle cost is pi-tui’s walk and line comparison over the growing frame.
- The 80 ms loader calls `requestRender` while the Agent is `running`. That is about 12.5 frames per second of whole-frame diffs during think gaps, not a transcript rebuild.

Same-process contention is a topology fact (`tui-app` runner and `AgentLoop` share one Node loop). The reuse note’s settled fake-terminal idle frames are a few milliseconds at 80 turns; they do not measure tool or key delay under a live `doRender`. A long streaming `doRender` that re-lexes a large reply can still delay the next tool or key on that loop.

### Measurement cards

Build these before product edits. Use compiled JavaScript under plain Node, a private `mkdtemp` Harness home, and synthetic JSONL from reviewed constants. Exclude model and network latency. Package-local `.perf.ts` may own the fake-`Terminal` stream card; a required `benchmarks/` lane waits on calibration per [benchmarks/AGENTS.md](../../../../benchmarks/AGENTS.md) and the [performance skill](../../implemented/process/2026-09-06-evidence-driven-performance-skill.md).

| Card | Completion | Workload | Entry path | Clock | Memory |
|---|---|---|---|---|---|
| A cold first key | Printable key appears in the editor | New empty Session | Built `dsh --profile tui` child | Process start → echoed key | RSS after first frame |
| B resume ready | Editor accepts input and history line count matches the log | 80-turn and 320-turn fixtures in the reuse-bench shape (1500-row system prompt, folded `read` card, and one fenced reply per turn) | Same child; after `loader.await`, time `readHistory`, `agents.resume`, `bind`, and first frame separately | Persistence I/O and UI replay separately | Retained Session + mounted blocks |
| C stream frame | One `doRender` after a burst | 20k-character live reply, closed fences, 50 deltas inside one 16 ms window, then a paced 16 ms stream | Production `TuiApp` + fake `Terminal` on the main screen | Share of lexer, `compose`, fade recolor, `Container` concat, line diff | Transient peak during the burst |
| D think-gap frames | One second of loader-only ticks on a settled 80-turn transcript | Agent `running`, no deltas, fade disarmed | Same | `doRender` count and duration | Unchanged retained blocks |
| C+D input overlap | Key bytes to editor line change while C or D runs | Same 80-turn tree plus live deltas or the loader | Same | Event-loop delay and key-to-echo | — |

Card C must count `Markdown` lexer calls versus `requestRender` versus `doRender` in one 16 ms window on the main screen. The expected production behavior is one parse and one `doRender` for a burst that only changes the live reply’s text; that `doRender` may still walk the tree up to three times (`SETTLE_PASSES = 2` after the first `super.render`). The reader’s immediate paints stay off this card.

Do not set a required CI time budget until three reference samples and a hosted repeat exist. A threshold-free diagnostic is enough to rank the interventions below.

### Ranked interventions

| Rank | Change | Verdict | Smallest falsifier | Behavior that must stay |
|---|---|---|---|---|
| 1 | Incremental Markdown for the live reply: cache closed tokens and compose only the open tail | Keep after card C | Lexer plus wrap below about one fifth of `doRender` on the 20k-character reply | Wrap, lists, tables, unclosed fences, `recolorTail` matching from the end, first-fence grammar load |
| 2 | Resume from the Agent’s loaded Session instead of a second `readHistory` pass | Keep for card B | The paged read-handle pass plus the write-handle `read(0, undefined)` become one full-log pass; 80-turn and 320-turn resume wall times fall | `bind` draws every persisted event including resume closers; write-handle repair still runs |
| 3 | Stop or slow the loader only in think gaps | Demote until card D | `doRender` count in a one-second think gap | Spinner still means the Agent is working |
| 4 | Eager editor before history finishes painting | Demote | Card A without a visible transcript | Editor still refuses submit while a session switch is in flight; printable keys still echo |
| 5 | Remount TUI tools behind `agent-presets` as Web does | Demote as boot-only | Card A plugin-settlement time | Process-wide composition the terminal profile documents |
| 6 | App-level 16 ms stream coalesce | Reject | `TuiBase.requestRender` already coalesces the main screen; a 50-delta burst in one window must stay one scheduled `doRender` | Stream and fade cadence on the main screen; the suspended reader stays immediate |
| 7 | Web `PAGE_MESSAGES` window or “load earlier” | Reject | `Home`, `/turns`, and `Ctrl+G` must still name every turn | Scrollback owns history; prepend above the viewport writes `ESC[3J` |
| 8 | Skip sibling `render()` when only the live block changed | Reject | Time inside `AssistantBlock.render` versus `Container` concat versus line diff at 320 turns | pi-tui calls every child every frame; `LastDrawn` is the legal skip |
| 9 | Import Client `ConversationNodeAssembler` | Reject | No TUI bug the `session/event` switch cannot express | Parity from shared services, not the Client node graph |
| 10 | Drop off-screen blocks | Reject | `transcript-focus` scrollback-clear invariant | Heights stay in the tree; off-screen rows are scrollback |
| 11 | Disable fade while tokens arrive | Reject | Card C with `reducedMotion` already exists as the off switch | Wall-clock ages; no arrival-rate cutoff ([continuous fade](../../implemented/feature/2026-09-17-tui-continuous-fade.md)) |
| 12 | `setImmediate` between stream handler and paint | Demote | Event-loop delay ≈ `doRender` duration | One frame is one consistent line array |
| 13 | Paint on a worker thread | Reject | No small measurement can make this legal | Process TTY, raw stdin, in-process approval and question waterfalls |
| 14 | Cache footer `sessionProjections.snapshot` | Reject as first work | Snapshot time versus one loader `doRender` | Footer numbers stay current on the 1 s live tick and on turn, usage, permission, and projection updates |

### Implementation layers

Later work lands as separate PRs, each mergeable:

1. Cards A–D as package-local diagnostics or a `benchmarks/` path, with this note as the measurement-card owner. No product behavior change.
2. Rank 1 only if card C shows the lexer share. Own tests in `tests/blocks.spec.ts` keep fence memo and wrap contracts.
3. Rank 2 only if card B shows the second full read. `bind` reads the resumed Session’s events; `readHistory` goes away or becomes a test-only helper.
4. Rank 3 only if card D shows loader frames dominating think-gap CPU.

A later required TUI lane reuses the same cards and adds budgets the way the Web browser workflow did: reference-machine samples first, hosted repeat second, source constants last.

## Alternatives considered

**Treat one TUI-versus-Web wall-clock as the acceptance test.** Rejected: Web “open” is session-open in an already-scaffolded Host; TUI first paint includes profile boot and an eager Agent. Mixing them would pass or fail for the wrong endpoint.

**Copy Web paging, inactive-view deferral, and the Client assembler first.** Rejected: those mechanisms assume a DOM window and a Client node graph. The reuse note already rejected pruning old blocks. The terminal surface reads the same services the browser reads and does not import Client conversation types ([terminal surface](../../implemented/architecture/2026-09-15-terminal-surface-tui-app.md)).

**Add an application 16 ms coalesce before measuring.** Rejected: pi-tui already owns that interval. An extra timer cannot cut Markdown re-parse and can only make stream and fade stepwise.

**Treat same-loop contention as the first product fix.** Rejected until cards C and D show `doRender` delaying tools or keys. The reuse note’s settled idle frames are a few milliseconds at 80 turns on the fake terminal; a worker renderer would split the TTY and the in-process waterfalls the surface requires.

**Ship incremental Markdown without card C.** Rejected: Markdown is non-local. A prefix wrap change must invalidate the cache, and `recolorTail` matches from the end. If card C attributes the leftover cost to pi-tui’s line walk, this package cannot skip that walk without forking the renderer.

## Acceptance criteria

- This note is the owner for TUI-versus-Web performance work: five endpoints, the measurement cards, and the keep / demote / reject table.
- A change that claims a TUI speedup names one endpoint, runs that card before and after, and keeps the behavior column.
- Cards A–D exist as executable diagnostics on built artifacts, even if they are not yet required CI budgets.
- No PR copies Web paging, Client fold, sibling-`render` skipping, off-screen virtualization, stream fade cutoff, or a render worker while this note is proposed or implemented.
- Rank 2 does not move, overwrite, or delete a committed persistence generation; it only stops the terminal from performing a second full-log pass for the same log the Agent is about to load.

## Risks

A first-keystroke editor that appears before history paints can accept a prompt against a Session that is still binding. Keep the existing rule that submit waits while the host opens another session, unless card A is the agreed product change. Printable keys already echo during that wait.

Incremental Markdown that misses a prefix restyle will show a layout jump when the closer arrives. The owning tests must include an unclosed fence, a list that tightens on a later marker, and a width change.

Feeding `bind` from the resumed Session must not skip write-handle repair in `agents.resume()`. The Agent still takes the write handle first and appends interrupted-turn closers before publication.

A required TUI CI budget adopted from one laptop sample will flake on hosted runners. Follow the Web frontend note: threshold-free diagnostics first, then reference and hosted calibration.

Fake-`Terminal` cards exclude emulator latency and synchronized-output cost. State that exclusion on every report; they do not prove Kitty or iTerm paint time.

## Related decisions

The terminal application and its unpatched pi-tui dependency are [the shipped `tui` profile](../../implemented/architecture/2026-09-15-terminal-surface-tui-app.md); Rank 2 would amend that note’s sentence that `--resume` pages a read handle before the Agent resumes, and would not archive it. Settled-block line reuse, fence memo, and the leftover full-frame walk are [transcript render reuse](../../implemented/bug-fix/2026-09-19-tui-transcript-render-reuse.md). Fade ages, the 33 ms tick, and the rejected arrival-rate cutoff are [continuous fade](../../implemented/feature/2026-09-17-tui-continuous-fade.md). The high-water repaint window and scrollback-clear rule are [transcript navigation and the inspector](../../implemented/feature/2026-09-17-tui-transcript-navigation-and-inspector.md). `Ctrl+G` and `/turns` leave the conversation off the terminal and bypass the 16 ms scheduler ([alternate-screen reader](../../implemented/architecture/2026-09-20-tui-reader-on-the-alternate-screen.md)). Lazy grammar load is [syntax colour](../../implemented/feature/2026-09-19-tui-syntax-colour.md). Measurement procedure is the [evidence-driven performance skill](../../implemented/process/2026-09-06-evidence-driven-performance-skill.md). Web numbers this note must not be compared to blindly are the [frontend budgets](../../implemented/testing/2026-09-06-frontend-performance-budgets.md) and the [session-open gate](../../implemented/testing/2026-09-04-session-open-performance-gate.md).
