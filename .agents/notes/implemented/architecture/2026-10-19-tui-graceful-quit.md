# Agent Note: The terminal application owns its quit

Status: implemented

English | [中文](2026-10-19-tui-graceful-quit.zh.md)

## Problem

A quit with work running gave the user no account of what it stopped and no bound on how long it took. The runner released the terminal, printed the resume hint, and only then disposed the session binding, which is the step that stops background jobs and subagents. A command that ignored `SIGTERM` held the exit for its tool's kill grace while the terminal stayed silent, and a hung `whenIdle`, flush, or dispose held it indefinitely, because the launcher's five-second disposal bound in [`process-shutdown.ts`](../../../../apps/cli/src/process-shutdown.ts) starts only once the application requests exit. The second `Ctrl+C` had to arrive within 600 ms while the line inviting it stayed on screen for about two seconds, so a press the screen invited could clear the editor and arm again instead of quitting. Closing the terminal delivered `SIGHUP`, whose default disposition ended the process without disposal: the session was not flushed and the commands it had started were not stopped.

## Decision

**The terminal application owns the quit policy.** No shared service and no launcher change carries it. [`src/quit.ts`](../../../../packages/bundle/tui-app/src/quit.ts) in `dsh-tui-app` counts the work running in the root session tree before anything stops: shell commands (the model's foreground calls and the user's `!` command), other live background jobs, and running descendant Agents. It then runs `agent.cancel({ kind: 'user' })`, `await agent.whenIdle()`, `sessions.flush(session)`, and `await bound.dispose()`, in that order, and each step depends on the one before it. Cancelling first lets every tool call stop through its own cancellation path, which for a shell call is the tool's terminate-then-kill escalation. Waiting for idle before the flush puts the cancelled turn's closing records, including its `turn/end`, into the log the flush persists. Flushing before dispose saves the session even when releasing the binding hangs. Dispose comes last because owner disposal is what stops the jobs and subagents the root owns. Each step is contained: a step that throws is recorded as a typed `QuitFailure` and the next step still runs, so a failed flush never skips the dispose that stops the work. The sequence races `quitGraceMs` (default 10 000 ms, minimum 1000) and the user's force; afterwards the runner requests exit, and the launcher's own five-second tree disposal and synchronous exit-time process kill still follow. The report keeps `timedOut`, `interrupted`, `failures`, and `saved` as independent fields. The exit code is 130 when forced, otherwise 129 for a hangup, otherwise 1 for a timeout or a failed step, and otherwise 0.

**A quit never calls `jobs.kill`.** A settlement with `cause: 'kill'` makes `dsh-tool-jobs` deliver a completion notice to the job's owner Agent, and that notice wakes an idle owner, which would start a turn on the Agent the quit has just stopped. Owner disposal settles each owned job with `cause: 'teardown'`, which delivers no notice because a disposed owner has no reader. Jobs therefore stop only through `bound.dispose()`.

**The TUI runner, not the launcher, handles `SIGHUP`.** A launcher handler would apply to every profile, and adding a Node `SIGHUP` listener replaces the ignored disposition that `nohup` sets, so `nohup dsh web &` would end when its terminal closed. The TUI profile always has a terminal, so its runner registers the listener through `ctx.effect`, whose disposer removes it. A hangup runs the same quit with cause `hangup`: terminal writes and the renderer stop are best-effort, a no-op `error` listener keeps `EIO` and `EPIPE` on stdout and stderr from becoming uncaught exceptions, and the exit code is 129. The `SIGINT` listener that forces a quit exists only while a quit is in flight; the launcher's own `SIGINT` handler keeps running beside it.

**Progress goes to stderr after the terminal is released.** The stop begins after `TuiApp.stop()` has restored the terminal, so `dsh: stopping <work> (Ctrl+C to force)`, a `dsh: still stopping <work> (Ctrl+C to force)` line with the current census every two seconds, and the outcome lines are ordinary stderr writes. They stay in the shell's scrollback after exit beside the resume hint, the cooked terminal turns `Ctrl+C` into the `SIGINT` that forces the quit, and the hangup path uses the same writes best-effort.

**The quit arm lasts exactly as long as the toast.** The first `Ctrl+C` clears the editor, shows `press Ctrl+C again to quit`, followed by `· stops <work>` when the census is not idle, and arms the quit for the lifetime `showToast` returns: the hold plus the fade, or the hold alone where no fade is drawn or the line is printed into the conversation. The `Esc` stop arm follows the same rule, and any other key disarms. A second press the screen invites always quits, and no window remains in which the key means something the screen does not show.

## Alternatives considered

**Handle `SIGHUP` in the launcher for every long-lived profile.** Rejected: installing the listener overrides an inherited ignore, so every non-interactive profile started under `nohup` would end when its terminal closed. Only the TUI is certain to own a terminal.

**Stop jobs with `jobs.kill` before releasing the session.** Rejected: each kill settlement sends a completion notice that can wake the Agent the quit just stopped and start a model request during shutdown. Owner disposal already stops the same jobs with a settlement that sends nothing.

**Request exit first and let the launcher's five-second disposal bound the stop.** Rejected: that bound starts only when exit is requested, disposes the whole application tree without the cancel, idle, flush, and dispose order, and reports nothing about what it waits for. Its fixed five seconds remain as the second bound after `quitGraceMs`.

**Keep the TUI drawing until the stop finishes and show progress inside it.** Rejected: drawing would keep the renderer and its session subscriptions alive while the session they read is being released, and a hangup has no terminal to draw on. Stderr lines remain in the shell's scrollback after exit, and in a cooked terminal the force key arrives as the `SIGINT` the launcher already handles.

**Keep a fixed 600 ms double-press window, or give the window its own setting.** Rejected: a window shorter than the line inviting the press makes the invitation wrong for most of the time it is shown, and a separate setting could disagree with `toastMs`. Tying the arm to the toast's lifetime leaves one value in charge.

## Consequences

- A quit with work running names that work, says every two seconds what still runs, and on every outcome other than a clean stop prints a line naming what may still run and exits with a non-zero code. A clean quit prints only the resume hint, after the jobs and subagents have stopped.
- A quit takes at most `quitGraceMs` plus the launcher's five seconds, whatever a step does; work the budget abandons can run until the launcher's exit-time kill. On macOS, and on Linux without a user-systemd scope, a process that double-forked out of a command's process tree is outside that kill, as the [subprocess-local limitations](../../../../packages/subprocess/subprocess-local/README.md#known-limitations-and-deferred-work) describe.
- Only the TUI profile cleans up when its terminal closes. Other profiles keep the default `SIGHUP` disposition, so `nohup` keeps working for them and a `dsh web` started without it still ends without disposal when its terminal closes.
- Nothing model-visible changes and no Session event is added; the log of a quit holds the cancelled turn's `turn/end` and a `job/settled` record with `cause: 'teardown'` for each job the quit stopped.
- [`tests/quit.spec.ts`](../../../../packages/bundle/tui-app/tests/quit.spec.ts) pins the order, the budget, the force, contained failures, the progress lines, and the outcome mapping, and the built keyless `apps/cli/tests/profiles/tui/tests/quit-while-busy.e2e.ts` drives the shipped profile through quits with work running, `SIGHUP`, and a forced quit. The quit is not exercised under the Apple container sandbox backend, from a real PTY, or on Linux and Windows hosts.

## Related decisions

This note supersedes the 600 ms `Ctrl+C` window that [terminal reader overlay, Esc safety, and the editor as the hub](../feature/2026-09-18-tui-reader-overlay-and-esc-safety.md) kept; that note stays current for everything else. The terminal surface and its profile are owned by [terminal surface as the shipped `tui` profile](2026-09-15-terminal-surface-tui-app.md).
