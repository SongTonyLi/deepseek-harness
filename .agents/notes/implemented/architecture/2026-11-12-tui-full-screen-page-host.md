# Agent Note: One host for the TUI's full-screen pages

Status: implemented

English | [中文](2026-11-12-tui-full-screen-page-host.zh.md)

## Problem

The terminal draws two pages that take the whole terminal on the alternate screen besides the reader: the team room behind `/team-play`, which shows how the team divides roles, and the todos page behind `/todos`, which shows how it divides work. The team room arrived first and `src/app.ts` wired it by hand: one field, six methods to open, paint, repaint, route keys to, close, and drop it, and team-room checks in the quit path, the session switch, the key router, the wheel handler, the spinner tick, and the session-event handler. A second page wired the same way would copy all of it, and each copy has its own ordering of `tui.suspend`, `readerScreen.enter`, and `updateSpinTicker` to keep correct, plus its own tests at the per-file coverage gate.

## Decision

[`src/screen-page.ts`](../../../../packages/bundle/tui-app/src/screen-page.ts) defines `ScreenPage`, what a full-screen page implements: `handleInput(data)` returns a `ScreenPageAction` (`close`, or `open` a teammate session as `/team` does) or nothing, `render(width, rows)` returns exactly `rows` lines, and `animates()` reports whether the next spinner tick draws a different frame. The module also owns `PAGE_CLOSE_HINT`, the `Esc q closes` step every page legend ends in. `src/app.ts` holds at most one page in `screenPage` and drives it through `openScreenPage`, `paintScreenPage`, `repaintScreenPage`, `onScreenPageKey`, `closeScreenPage`, and `dropScreenPage`; every former team-room call site calls these instead. `TeamPlay` and `TodosPage` both implement the interface, and `/team-play` and `/todos` differ only in the page they construct and the check that precedes it.

A page owns everything that varies: its state, its legend, its motion, which it measures from a clock the application passes in rather than from timers. The application owns everything that is the same for every page: the alternate screen, suspending and resuming the conversation's renderer, giving the page every key while it is up with `Ctrl+C` always closing it, the wheel doing nothing, repainting on session events, arming the spinner tick exactly while `animates()` is true, and taking the page down on quit and session switch. The todos page's data comes from [`src/work-tree.ts`](../../../../packages/bundle/tui-app/src/work-tree.ts), a pure function the application calls with the Team snapshot, the projections, and the bound log on every key and frame.

## Alternatives considered

**Wire the todos page beside the team room.** Rejected: it copies about 80 lines of `app.ts` and their tests, and the two copies would drift on ordering details that the reader's history shows matter (the repaint boundary and when the renderer resumes).

**Move the work tree into a session projection of the team package.** Deferred: Web and the SDKs could then draw the same tree, but a teammate's todo list lives in its own Session, which a single-session fold cannot read, so the terminal would still assemble part of the tree itself. No second client asks for the tree yet.

## Consequences

A third full-screen page costs one class that implements `ScreenPage` and one command case. The reader stays separate: it is a pi-tui component with its own reveal clock and pinned prompt, not a `ScreenPage`. The `open` action names a teammate session, so a page that wants to open something else extends `ScreenPageAction` and the switch in `onScreenPageKey`, which ends in `assertNever`. The application decides whether a page moves once, from the same fade capability the streamed text uses, so reduced motion, a disabled palette, `NO_COLOR`, and `TERM=dumb` stop every page's motion together.
