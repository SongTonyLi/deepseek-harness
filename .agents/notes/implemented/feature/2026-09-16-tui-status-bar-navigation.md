# Agent Note: Navigable terminal status bar

Status: implemented

English | [中文](2026-09-16-tui-status-bar-navigation.zh.md)

## Problem

The terminal footer printed its facts as one dim line: the model, the reasoning effort, the permission preset, cumulative token usage, the context percentage, the todo, goal, and plan markers, the workspace, and the pending-attachment count. A user reading `ctx 82%`, `goal blocked`, or `todo 2/7` had no way to ask what the number covered or which command moves it; the only answer was `/status`, which prints every section at once and says nothing about the model, the workspace, or the attachments. The facts were already read from `sessionProjections` for `/status`, so what was missing was selection and per-fact detail, not another data source.

## Decision

The footer line under the editor is a status bar of segments in a fixed order: the model (`provider/model`), the reasoning effort, the permission preset, token usage, `ctx NN%`, `todo done/total`, `goal <phase>`, `plan`, the workspace path (shortened with `~` and `…/` when long), and `<n> attached`. A segment is present exactly when its fact exists, the rule the footer parts already followed, so an unregistered projection key or an empty attachment list removes its segment rather than showing a placeholder.

`Shift+Down` moves focus into the bar and selects the first segment: from the editor while no subagent panel is drawn, and from any other region whatever is drawn. While the bar has focus, `Left` / `Right` and `Tab` / `Shift+Tab` move between segments and wrap at both ends, `Up` leaves the bar for the region drawn above it, `Enter` opens the selected segment while the bar keeps focus, and `Esc` returns focus to the editor. No other key reaches the editor while the bar has focus, so a stray character cannot land in a prompt the user cannot see the caret for; `Ctrl+C` and `Ctrl+D` keep their usual meaning and return focus to the editor, which keeps the quit path reachable from every focus state. `Shift+Tab` still cycles the bound model's reasoning effort while the editor has focus — the binding is read against the focused component, not globally.

Opening a segment states its current facts and names what changes them: the model segment names `/model`, the effort segment `Shift+Tab`, and the permission segment its preset; the usage, context, goal, and plan segments print the matching sections of the `/status` report; the workspace segment prints the full path the bar shortens; and the attachments segment lists the pending attachments. Those details are printed into the transcript. A segment whose fact the application has its own navigable page for declares that instead of carrying rows, and the bar opens the page: the `todo` segment is that kind, and it opens the same list `/todos` opens. `src/status.ts` owns one set of section builders, and both `/status` and the printed segment details call them, so a section cannot read one way in the report and another way under `Enter`. `src/footer.ts` stays pure: it turns the same facts into the ordered segment list and the selected index into rendered text, with no terminal, palette, or agent access, which is what lets the segment list and its wrapping be tested without a terminal.

## Key bindings over the pi-tui editor

The editor component from `@earendil-works/pi-tui` claims `ctrl+a`, `ctrl+b`, `ctrl+e`, `ctrl+f`, `ctrl+d`, `ctrl+k`, `ctrl+u`, `ctrl+w`, `ctrl+y`, `alt+b`, `alt+d`, `alt+f`, `alt+y`, `tab`, `enter`, `shift+enter`, and the bare arrows for editing, completion, submission, and history. `shift+up` and `shift+down` are the pair it does not claim, so the application reads them without taking a key away from text editing, and both directions of the focus move stay symmetric and memorable. Inside the bar the application owns the whole key stream, which is why `Tab`, `Enter`, and the arrows can mean navigation there while the editor keeps them when it has focus.

## Alternatives considered

**Make the footer a hover or mouse target.** Rejected: the terminal surface runs without mouse reporting in the general case, and a keyboard agent workflow over SSH must reach every fact from the keyboard.

**Bind `Ctrl+Up` or a function key.** Rejected: `Ctrl`-arrow combinations are rewritten or swallowed by common terminal emulators and multiplexers, and function keys collide with the host terminal's own bindings more often than `Shift`-arrow does.

**Print the details as a modal prompt instead of transcript lines.** Rejected for the facts that fit in a few rows: a page closes and leaves nothing behind, while printed details stay in the scrollback beside the turn that raised the question. The modal queue is not reserved for approvals and questions — it also carries the read-only pages of [terminal list-then-details navigation](2026-09-16-tui-list-then-details-navigation.md) — and the `todo` segment opens one of those, because a list to walk is not a few rows to read.

**Expand `/status` with the model, workspace, and attachment facts and skip the bar.** Rejected: it answers "what is everything" and not "what is this number", and it keeps the cost of reading one fact at a full report.

**Give the segment details their own formatters.** Rejected: two renderings of the same projection facts drift. The shared section builders in `src/status.ts` make the report and the details one definition.

## Consequences

- Every footer fact is explainable in place, and the terminal gains a focus state the app tracks: the editor, the bar, or another region one of the editor's two entry keys reaches.
- `Shift+Tab` is overloaded by focus — effort cycling in the editor, previous segment in the bar. The `/help` keys and the package README state both readings.
- Adding a footer fact means adding a segment together with what `Enter` does for it: the rows it prints, or the navigable page the application owns.
- The terminal keeps one transcript per session, so details printed by `Enter` interleave with the conversation instead of living in a side panel as the browser's cards do.

## Related decisions

The terminal surface, its footer facts, and the `/status` report over `sessionProjections` are owned by [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md); `Shift+Tab` effort cycling comes from [TUI `/login` and Shift+Tab effort cycling](2026-09-15-tui-login-and-effort-cycle.md). The `todo` segment's page is [terminal list-then-details navigation](2026-09-16-tui-list-then-details-navigation.md); the `turn` segment, the second region docked under the editor, and the redraw that advances the bar's elapsed value belong to [live terminal subagent panel and elapsed counters](2026-09-17-tui-live-subagent-panel.md). The entry keys that reach the bar, and the `Up` and `Down` that leave it for the regions above, are owned by [terminal transcript navigation and the focused-section inspector](2026-09-17-tui-transcript-navigation-and-inspector.md).
