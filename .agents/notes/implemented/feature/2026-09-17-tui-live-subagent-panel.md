# Agent Note: Live terminal subagent panel and elapsed counters

Status: implemented

English | [中文](2026-09-17-tui-live-subagent-panel.zh.md)

## Problem

The terminal said nothing about delegated work while it ran. `/subagents` answers over the complete durable descendant tree, so a user who dispatched three children had to type a command and then read a list that also carries every child that finished hours ago; nothing on screen said how many were working right now, or that any were. Time was missing on both sides: the spinner reported that the bound Agent was busy but never for how long, and a child's own turn had no readout at all. The facts already existed — the subagent runtime lists descendants, the `subagentTiming` and `tokenUsage` projections carry each session's turn timing and totals, and `ctx.agents.get` resolves a child's live Agent — so what was missing was a place to draw them and a clock to move them.

## Decision

A subagent panel is docked between the editor and the status bar, the status bar gained a `turn` segment, and one repeating redraw moves both.

The panel is mounted exactly while it has a row, so it appears when delegated work starts and goes away with its last row; when it held the keyboard, the keyboard returns to the editor. Its heading counts the rows it lists. Each row carries the child's depth indent (two spaces per level, as the `/subagents` rows indent), its durable label or its session id, its mode (`one-shot` or `continuable`), `resident`, whether its Agent is `running` or `idle` in this process, its elapsed time, and its token usage; the last two are absent when no `subagentTiming` or `tokenUsage` projection is composed. At most `SUBAGENT_PANEL_MAX_ROWS` (6) rows draw and the rest fold into `+<n> more · /subagents lists them all`, because the panel sits over the conversation and a long list would push it off the screen. A candidate the listing could not interpret draws as `<id> · unreadable: <reason>` and is not enterable; a listing that rejects keeps the rows the last good one produced and adds `listing failed: <reason>` beneath them, while the transcript hears about a reason only when it changes, so a service that keeps failing cannot fill the conversation with notices. `Enter` on a row opens the same read-only session page `/subagents` opens and returns the keyboard to the panel on that row.

`src/subagent-panel.ts` is pure: one function turns the listing plus the sampled live facts into rows, a second renders those rows as the panel's text, and the current time is an input. The panel's rows, its overflow, and its two drawn states are therefore pinned without a terminal or a timer.

The `turn` segment sits between `permission` and `usage` and is drawn only while a turn runs, labelled `turn <elapsed>`; its details give the turn number, the start time, the elapsed time, and the two queued-message counts. The start comes from the durable `turn/start` envelope, so the readout is the logged turn's age rather than the age of a screen state. A panel row's elapsed value is read the same way, from the child's own projection: the time in its open turn (`subagentTiming.active.since` against the app clock) when it has one, else the total its settled turns took (`subagentTiming.settledMs`).

## Membership is residency, not the durable tree

A `child` entry joins the panel only while its `activity` is `running`, which the subagent listing sets from the Session store: the child's logical session record is resident in this process. Residency is what makes the panel a live view — a child that settles out of residency leaves it, and the panel disappears with the last one — while `/subagents` keeps answering over every durable descendant, resident or not. A `diagnostic` entry draws regardless, because a candidate the listing could not interpret is a live problem rather than a settled child, and it is the one way the panel is drawn without a resident child.

What residency does not say is stated where it lands: `activity: 'running'` means the record is resident, not that the child is working, so the row carries the child Agent's own `running` / `idle` status beside it; and a subagent run by an out-of-process provider owns no session record here, so it never appears in the panel at all.

## Membership is reconciled from live signals, not polled

The entries come from one `subagents.listDescendants(session.id)` call per reconcile. A reconcile runs when a session binds — seeding the panel is a listing of its own, not an event handler's read — and afterwards only when a live signal marked the listing stale: `agent/status` for any Agent other than the bound one, `subagent/start` and `subagent/end` (neither edge carries the delegating parent, and both fire for out-of-process children, so they mark rather than add or remove a row), a `session/event` for another session, and a projection change for another session. Marking is not reading: the shared tick performs at most one listing per period, which bounds a burst of child events to one read. Two listings never overlap, and a result that belongs to a session the terminal has left is discarded and marks the listing stale again, so the next tick reads the session actually bound.

## One tick, armed only while something moves

`updateTicker` arms the live-refresh interval while a turn is running, a drawn row is timing an open turn, or the listing is stale, and disarms it as soon as none of those hold, so an idle session runs no timer. One period reconciles a stale listing, redraws the panel, and refreshes the footer while a turn is open — the counters and the staleness reconcile share one tick because they need the same period and the same redraw. Its period is the validated `liveRefreshMs` config field (`z.natural().min(100).default(1000)`), so a deployment that wants a calmer terminal or a finer counter changes it from `cordis.yml` rather than editing a constant.

## Deviation: the tick is `ctx.effect` + `setInterval` + `unref`, not `ctx.interval`

The plugin supplies `TuiAppDeps.tick` as `ctx.effect(() => { const timer = setInterval(callback, delayMs); timer.unref(); return () => { clearInterval(timer) } })`, which is what `ctx.interval` does plus the `unref`. `@deepseek-ai/cordis-plugin-timer` is not a dependency of this package — it is mounted by the `dsh-base` patch this bundle rides over — so calling `ctx.interval` would mean declaring a dependency on a plugin the terminal does not compose in order to get a redraw timer, and the repository's preference for maintained dependencies covers code a dependency deletes, which here is one `setInterval` call. The `unref` is the second reason and the one that changes behavior: `ctx.interval` leaves the interval referenced, and a redraw timer must not hold the process open while the quit flow flushes the session. Disposal is unchanged, because the effect belongs to the plugin fiber and tree teardown clears the interval.

## Alternatives considered

**Poll `listDescendants` on every tick.** Rejected: the listing merges the live session store with the persisted corpus and reads cold candidates, so running it once per period tells a session with no children nothing it did not already know, at the cost of a corpus scan per period. Staleness marking makes the read proportional to child activity instead.

**Read the listing in the handler that noticed the change.** Rejected: one child that starts, runs, and ends produces a burst of status, session, and projection signals; a read per signal would overlap listings and redraw the panel several times per frame. The tick is the single reader, and the stale flag is what the handlers write.

**List every durable descendant in the panel, as `/subagents` does.** Rejected: the panel is docked over the conversation, so a session that has delegated fifty times would push the transcript away with children that finished long ago. Residency answers "what is running now"; the overflow row names the command that answers "what has ever run".

**Track membership from `subagent/start` and `subagent/end` alone and skip the listing.** Rejected: neither edge carries the delegating parent, so a listener cannot tell a run under the bound session from one under a cousin, and a continuable child's residency epochs do not line up with one start/end pair. The listing owns membership; the edges only say it aged.

**Accumulate elapsed time in the terminal from the events it sees.** Rejected: the `subagentTiming` projection already folds each child's open and settled turn time from that child's own log, and a second accumulator would disagree with it after a resume, a session switch, or a missed event. The terminal formats a projection value against its clock and holds no timing state.

**One interval per counter.** Rejected: the panel's rows and the footer's turn segment advance on the same period and are drawn in the same frame, so a second interval would double the redraws to show the same second ticking. The one exception is the fade tick, which has its own period because it repaints at 25 frames per second, and it is armed by a different condition.

**Keep the interval running for the lifetime of the app.** Rejected: an idle terminal would redraw once per period forever, and on a laptop that is a wakeup per period for a screen that has not changed. Arming from the three conditions that can move a value leaves an idle session with no timer at all.

## Consequences

- The terminal has a second region docked under the editor. `Shift+Down` from the editor lands on the panel's first row while the panel is drawn and on the status bar otherwise, `Up` and `Down` walk the panel's rows and leave it at either end for the region above or below, and `Esc` always returns to the editor. [Navigable terminal status bar](2026-09-16-tui-status-bar-navigation.md) owns the bar's own keys and [terminal transcript navigation and the focused-section inspector](2026-09-17-tui-transcript-navigation-and-inspector.md) owns the stack the arrows walk.
- A profile without a subagent runtime, or with no resident child, draws no panel and arms no tick for it; a profile without the timing and usage projections draws rows without those columns rather than blank ones.
- The panel is a live view with a stated blind spot: out-of-process children and settled children are absent, and `/subagents` is the answer for both.
- Six rows is a presentation constant of this surface, not a config field, and the rows behind the overflow row are not selectable.
- `tests/subagent-panel.spec.ts` pins the rows, the elapsed choice, the diagnostic row, and the overflow; `tests/subagents.spec.ts` pins membership, the keys that reach and leave the panel, `Enter`, the single-listing-per-tick bound, the failure line, the arming and disarming of the tick, and the absence cases over the fake terminal.

## Related decisions

The terminal application, its footer facts, and the `/subagents` listing it reads are owned by [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md). The panel's `Enter` opens the page [terminal list-then-details navigation](2026-09-16-tui-list-then-details-navigation.md) defines; the keyboard reaches it through the stack [terminal transcript navigation and the focused-section inspector](2026-09-17-tui-transcript-navigation-and-inspector.md) defines, beside the region [navigable terminal status bar](2026-09-16-tui-status-bar-navigation.md) owns. The caret the editor shows while it holds the keyboard, and the second tick this one shares the terminal with, come from [terminal bar caret and streamed-text fade](2026-09-17-tui-bar-caret-and-stream-fade.md).
