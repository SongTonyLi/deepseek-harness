---
description: "Interactive terminal mode for dsh: talk to the agent in your terminal with streamed replies, tool cards, keyboard navigation over the conversation, a full-screen reader that reads one turn at a time, approvals, questions, slash commands, ! shell lines, @-references, attachments, and session switching."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

English | [中文](README.zh.md)

## Summary

`dsh-tui-app` is the terminal surface of dsh: `dsh tui` starts a multi-turn session in your terminal, with no browser and no server. Replies stream, tool calls become foldable cards, approvals and `ask_user_question` questions appear above the input, `@` completes paths and sessions, and `/`-commands share the Web registry. Arrow keys walk the conversation through a docked inspector; `Ctrl+G` reads it full screen, turns side by side. Persisted sessions reopen through `/resume`, `/sessions`, or startup `--resume`; `/new`, `/clear`, and `/fork` create them, and `/export` writes ZIPs. It runs `dsh web`'s model, tools, and safety defaults, one session at a time. The shipped profile includes experimental Auto review; `/permission auto` selects it for the current session.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Start a session, type, and read the answer in place. `dsh tui` is an alias of `dsh --profile tui`; an optional first prompt on the command line is submitted as soon as the terminal is up.

### Starting and resuming

```sh
dsh tui                                   # new session, wait for input
dsh tui "explain this repository"         # new session with a first prompt
dsh tui --resume <session-id>             # continue an earlier session
dsh tui --no-open                         # print sign-in URLs without opening a browser
```

On quit the app prints `dsh: session <id> saved; resume with: dsh --profile tui --resume <id>` on stderr for the session bound at that moment. A resumed session redraws its persisted history before accepting input; inside the terminal, `/resume` and `/sessions` open the same picker over every persisted root session and resume the selected previous session, `/new` and `/clear` each start a fresh empty one while the previous session stays on disk for `/resume`, and `/fork` copies the current session up to its last completed turn into a new one, the same cut the browser's fork takes. Switching releases the previous Agent and redraws the transcript of the next.

### The screen

The header names the session by its title once one is generated or set, with the id beside it. The transcript grows in the terminal's own scrollback: your prompts start with `❯` on a tinted full-width band while colour is on (attachments listed under them), assistant reasoning is dim italic under a `✻ Thinking` header above the Markdown reply, and each tool call is a card with a `◆` glyph coloured by status — yellow while it runs, green once done, red on failure — the bold tool name, the presenter headline in violet, a loading row while it runs, and a body folded to `toolPreviewLines` rows. The card appears when the model starts the call, its header first and its rows unrolling beneath it over about `toolRevealFrames` frames; the result rows unroll and float out the same way when the tool answers. An `edit` or `write` diff card frames each run of consecutive additions in a green rounded box and each run of removals in a red one, the removed rows above the added ones; once the tool applied the change, the applied hunks replace the diff the call carried and lead every row with its file line number, the new file's for added and unchanged rows and the old file's for removed rows. A `subagent` or `subagent_*` card draws folded as one row behind the same status-coloured `◆`, dim for a child handed to the background: while it runs, the tool name, the task description, and the requested model and `background` when the call names them; once settled, the description dimmed with `[done]`, `[started]` for a child handed to the background, or `[failed]` at the right edge. `Space` on the marked row, or `Ctrl+O`, unfolds the full card. A nonempty system prompt and each injected context — instructions, catalogs, snapshots, notices, relays, and recalls — draw as a dim `⬡` title over the first `contextPreviewLines` rows of their model-facing text, with each snapshot contribution named above its own rows; an empty system prompt and a compaction replacement are omitted. A tool card and a context block that carry more rows than they draw end on one marker: `… <n> more rows · Space expands` while the conversation's focus holds that block, and `… <n> more rows · Ctrl+O expands` otherwise. Fenced code in a reply, the file rows of a `read` card, the changed rows of an `edit` or `write` diff card — with `+` additions marked green, `-` removals red, and source text behind those signs drawn in the language the file's extension names — and the shell command of a `!` / `!!` draft, a `$ command` user-shell row (its `$` in the accent colour), and a terminal tool card, use syntax colours from a theme the terminal's own background picks, light or dark; the grammar of a language loads on the first block that asks for it, so that block draws plain and is repainted in colour a moment later, and a language with no grammar here, a terminal that reports neither 24-bit nor 256 colours, and `codeHighlight: false` each draw every block plain. Headings and list markers use warm orange, links and inline code use violet, and quotes stay dim. Streamed reasoning, reply text, and tool arguments are queued as they arrive and drawn a share per frame, about 60 frames per second by default, so a network burst spreads over `streamPaceFrames` frames instead of landing at once, and the queue never holds the model call back. Streamed reply text fades in and every word keeps its own clock: a word enters near the terminal's background color and brightens to the color it settles in over `streamFadeSteps` ticks of `streamFadeStepMs` each, so a fast stream leaves a longer trail of brightening words rather than a darker one. Streamed reasoning and a tool card float out over the same duration: they appear at a lifted color and recede to the dim italic or palette colors they settle in; a card redrawn from persisted history carries no fade, and text that has settled is never dimmed again.

Below the transcript sit a spinner while the agent works — its label is `thinking` while the model reasons, `writing` while visible text arrives, or `calling <tool>` while a tool is streamed or still running, plus live `↑` send and `↓` receive tokens for the current model call, as compact `k` / `M` / `B` counts, growing as the stream arrives and settling on the provider usage chunk — any open prompt, a boxed follow-ups list while messages wait, an activity board of the open turn's todos and latest descendant line while either has a row — completed todo content scratched out and status glyphs colored green, yellow, or cyan, at most four todo rows then `+<n> more`, not a focus region, gone on `turn/end` and bind — the editor, the subagent panel, and the footer: a status bar that, unfocused, is one line built from both ends inward. The editor's caret is the terminal's own blinking bar: the app asks for that shape at start, gives your default back on quit, and draws no caret at all while the status bar or the panel holds the keyboard. The model and entry keys are colored; live turn, context, and todo facts use yellow, violet, and green. The model is anchored at the left edge and is never dropped — past 20 columns it falls back to the bare model name, and only a label still too wide for that is ellipsized — and the two keys that leave the input are anchored at the right edge as `Shift+↑ read · Shift+↓ status`, or `Shift+↑ select · Shift+↓ status` while follow-ups wait, narrowing to `Shift+↑↓ nav` and dropped below 40 columns. The key facts fill whatever middle is left, in bar order: effort (`effort default` when the selection leaves reasoning to the model), the running turn's elapsed time, the context window percentage, the todo counts, and the workspace path (shortened with `~` and `…/` when long). Every segment that middle cannot hold folds into a trailing `+N`, together with the segments the unfocused line never draws — the permission preset, token usage (session totals plus the in-flight call), the goal and plan-mode markers from the projection seam, and the count of pending attachments. Compaction and model-request retries appear as notices, the same facts the browser's markers carry.

While the keyboard walks the conversation a framed inspector is docked directly above the editor, and the frame is the mode: it is drawn exactly while the conversation holds the keyboard. Its top rule carries an inverse ` ● READ ` chip and the focused section's heading — the section's position among the navigable blocks, the turn it belongs to, and what the section is — as in `╭ ● READ ─ 3/12 · turn 2 · bash git status · result ─╮`. Under it the block's parts draw as a numbered wrapping strip like `← 1 call · [2 result] →` when the block has more than one, the held label bracketed as well as accented so the selection is legible with no color at all; then the section's own source rows, each prefixed with `│ ` and wrapped two columns narrower, folded at `focusPreviewLines` for every section kind — a system prompt and an injected context included — with `… <n> more rows · Ctrl+G reads it` under them. The bottom rule carries the keys the conversation answers, `↑↓ sections · ←→ parts · Space folds · Ctrl+G reader · Esc input`, narrowed to `↑↓ ←→ · Space folds · Esc input` and then to `Esc input` as the terminal loses columns.

The focused block is also marked where it stands, with a two-column gutter that is dim beside the block's other lines and accented beside the focused section's own — or beside the fold marker, when the fold left that section out of the drawn rows entirely — and its content wraps two columns narrower while the mark is drawn. That mark reaches only the lines pi-tui still repaints differentially — the last `rows` lines of the last frame it wrote, a window a taller frame raises and a shorter one never lowers — because changing anything above them would clear the terminal's scrollback. A block that has scrolled past that point keeps no gutter, the inspector heading appends ` · off screen`, and the frame's own rules draw dim instead of accent, so the frame itself reports that the mark cannot be drawn where the block stands. A fade whose rows reach that edge settles them to their final colors in the frame that writes them, so nothing stays dim in the scrollback.

`Ctrl+G` from any region, `Enter` on a conversation section, and `/turns` read the conversation full screen, one turn at a time. The reader takes the terminal rather than drawing over the conversation: it runs on the terminal's alternate screen, the screen a pager runs on, and the conversation's own screen is held off the terminal for as long as it is up. So it costs the conversation no line, leaves the repaint window where it was, fills the screen on every terminal, and cannot leave a row of itself in your scrollback; closing it restores the conversation exactly as you left it, with whatever landed meanwhile drawn underneath. Under a top rule carrying a ` ● READER ` chip and `turn <n> of <total>`, the turn being read takes most of the screen and a narrow turn list sits to its left, every body row closed by a right border. The list has one row per turn — `❯` on the turn being read, the turn number, the first line of its prompt, and right-aligned markers, `⬡<n>` injected context blocks, `✻` any reasoning, `¶` any reply, `◆<n>` tool calls — with the sections of the turn being read listed under it, `▸` on the one the reader holds, so any turn's own context is one step away. The turn panel scrolls that turn end to end in the conversation's own glyphs, a blank row between each two sections: the prompt opens it behind `❯` on a shaded band, then `✻ Thinking` in dim italic, `¶ Reply` rendered as the conversation renders Markdown — headings, emphasis, inline code, and fenced code in syntax colour — except that unordered bullets are drawn as `•`, a call's `◆` — green once its result landed, yellow while it runs — with the tool name in bold and its headline in the link blue, `⎿ Result` indented under its call with a diff's `+ ` rows green and `- ` rows red on shaded bands and a `read` card's file rows in syntax colour, and `⬡` with the label of an injected context. The section the top row belongs to is accented and carries the conversation walk's `┃` gutter on every row, which reads with no color at all. The bands are mixed from the background color the terminal reports, so a terminal that reports none, or draws no color, draws the panel without them. Rows are never folded there: the reader is where the full model-facing text of a system prompt, an injected snapshot, a long reply, or a tool result is read. `Right` opens the selected turn and `Left` goes back to the list; in the list `Up` / `Down` step one section at a time and cross into the turn either side while `PageUp` / `PageDown` step a whole turn, in the turn they scroll one row at a time, and the section the top row belongs to is where the conversation resumes when the reader closes. `/` opens a query line in place of the legend and narrows the list to the turns whose prompt or text matches, with the readout reading `<kept>/<total> turns`; otherwise the legend rule reports `turn 3/12 · row 14/212` at its right, which no width drops. Below `readerMinColumns` the body draws one panel at a time — the list, or the turn `Right` opens from it — and below 24 columns or 8 rows it draws one dim line, `terminal too small for the reader (needs 24×8)`, and answers only `Esc`, `Ctrl+G`, and `Ctrl+C`. It re-reads the conversation on every render, so a streaming reply grows inside it, a landing tool result appears, and a new turn joins the list; a rewrap re-anchors on the section being read rather than on a row number; an approval or a question steps it aside for that prompt's lifetime; and a session switch takes it down with the notice `the transcript changed · reader closed`.

Transient key feedback floats as a dim framed line in the top-right corner of the viewport: `press Esc again to stop turn <n>`, `press Ctrl+C again to quit`, and `nothing in the transcript to read yet`. It holds at full strength for `toastMs`, fades out, costs the conversation no row of its own, and takes no keyboard; where the renderer can no longer repaint the top of the viewport it is printed into the conversation instead, which keeps it. Facts worth keeping are notices in the conversation: `stopping the turn…`, `wait for the session switch to finish`, `above the repaint window · opened in the reader`, and every command result.

Motion reaches past streamed text, and every effect rides the same fade tick. The keyboard landing on the conversation, the subagent panel, or the status bar lifts that surface's frame, its chip, and the mark it holds for twelve ticks of `streamFadeStepMs`; a step of the conversation walk lifts the newly focused gutter for six; and a step along the bar lifts the selected label for eight. A new or status-changed activity-board todo row, and a replaced descendant line, float out on that tick the same way a tool card does; replay and `reducedMotion` draw the settled board. The reader arrives complete on the screen it owns, and what it newly shows floats out on that tick the way a tool card does: opening it and showing another turn float out the whole turn, and stepping the list to another section of the same turn floats out that section, over `streamFadeSteps` ticks; scrolling, live growth, and a rewrap float nothing out. No lift changes how many lines anything draws, and `reducedMotion` — like `NO_COLOR`, a disabled palette, and `TERM=dumb` — turns every one of them off and arms no repaint for them.

The subagent panel is drawn while a subagent session under the bound one is resident, or the listing carries a candidate it could not read. Unfocused it is one summary line with the listed count and the first child's key label; focused, its heading counts what it lists and ends on the keys it answers, `↑↓ children · Enter opens · Tab regions · Esc input`, narrowed to `↑↓ children · Esc input` and then to `Esc input` on a terminal that cannot hold them, and each row gives the child's depth indent, its label or id, its mode (`one-shot` or `continuable`), `resident`, whether its agent is `running` or `idle`, its elapsed time — the open turn's, else the total its settled turns took — and its token usage, as far as this process's own view of that child and the composed projections carry them. Six rows are drawn at most, with `+<n> more · /subagents lists them all` under them; a candidate the listing could not interpret draws as `unreadable: <reason>` and opens nothing, and a failed listing keeps the rows the last good one produced with `listing failed: <reason>` beneath. The panel disappears with its last row. `Enter` or `Right` on a readable row, like `Enter` on a readable `/subagents` row, opens that child as a subagent view: the terminal draws the child session in place of the bound one — its transcript, live stream, conversation walk, inspector, reader, and its own subagent panel — while the session it was entered from stays open. A resident child is read live, and any other is resumed. The entry's detail rows print as notices under `subagent <label> · Ctrl+P or /parent returns to session <id>`, the header ends on `◆ subagent view ›` with one `›` per level entered and `· Ctrl+P returns`, a shaded line directly above the input reads `◆ subagent view · main › <label> · Ctrl+P back to <parent>` for as long as the view is open, whatever the transcript has scrolled to, and `Ctrl+P` or `/parent` goes back one level, redrawing the parent from its log as it stands then. `/new`, `/clear`, `/resume`, `/sessions`, and `/fork` refuse while any session in that chain runs a turn, and otherwise release every view with the session they leave; quitting releases every view and saves the root session.

### Keys and commands

The conversation, input, subagent panel, and status bar form the vertical arrow-key walk: `Down` at the newest section, `Up` on the subagent panel's first row, and `Up` on the status bar with no subagent panel drawn all land at the caret. The follow-ups list sits above the input; `Shift+Up` enters it while it is drawn, and it joins the `Tab` walk. The activity board sits between follow-ups and the input and is not a focus region. While a region other than the editor has the keyboard, `Tab` and `Shift+Tab` walk the regions that are drawn, wrapping at both ends; in the editor, `Tab` takes the offered completion and `Shift+Tab` opens the reasoning-effort picker. A printable key pressed in any of them returns to the input and types there, so a sentence started while reading lands where it was aimed; `Space` in the conversation is the one exception, and folds the marked tool card or context block. `Ctrl+G`, `Ctrl+O`, `Ctrl+T`, `Ctrl+P`, and `Ctrl+L` mean the same thing in every one of those regions, and `Ctrl+C` and `Ctrl+D` return the keyboard to the input before they act. A prompt and the reader own their whole key stream instead, and answer `Ctrl+C` by giving the keyboard back.

While the input has the keyboard:

| Key | Effect |
|---|---|
| `Enter` | Send the editor text; while a turn runs it waits for the next turn in the boxed follow-ups list above the editor until the loop claims it, entering the conversation then |
| `!command` / `!!command` | Run in this terminal; `!` is next-step context the next prompt can read, `!!` stays local |
| `Shift+Enter` | Insert a newline |
| `Ctrl+S` | While a turn runs, steer the editor text into the running turn's next step |
| `Up` / `Down` | Recall earlier prompts |
| `Shift+Left` / `Shift+Right` | Move one word left / right with pi-tui's editor navigation; from the end of `I want to do`, `Shift+Left` lands before `do` |
| `Tab` | Take the completion the editor offers |
| `Shift+Tab` | Open the current model's reasoning-effort picker for the next request, the same picker as empty `/effort` |
| `Shift+Up` | Focus the follow-ups list's first row while prompts wait, otherwise the conversation on the section the walk stopped at; a first entry, and the entry after a session switch, land on the newest section |
| `Shift+Down` | Focus the subagent panel's first row while it is drawn, and the status bar otherwise |
| `Ctrl+G` | Read the conversation full screen, on its newest section |
| `Ctrl+O` | Expand or collapse every tool card and context row |
| `Ctrl+T` | Browse the agent's todo list, the same list `/todos` opens |
| `Ctrl+P` | Return from a subagent view to the session it was entered from, like `/parent` |
| `Ctrl+L` | Redraw the whole screen from scratch |
| `?` | On an empty input, list the commands and keys, like `/help`; inside a draft it is typed |
| `Esc` | Cancel a running `!`; with a leading `!` draft and no turn running, clear the editor; otherwise arm the stop, and a second press while that line is on screen stops the running turn |
| `Ctrl+C` | Clear the editor; a second press within 600 ms quits |
| `Ctrl+D` | Quit when the editor is empty |

An `Esc` that only handed the keyboard back — leaving a region, closing a page, a picker, or the reader — opens a 750 ms window in which an `Esc` reaching the input does nothing at all, so a habitual double press stops no turn. With no turn running, `Esc` closes the completion list while one is open, clears a draft that starts with `!`, and is silent otherwise. A session with nothing to read yet answers `Shift+Up` (when no follow-up waits) and `Ctrl+G` with `nothing in the transcript to read yet` and leaves the keyboard in the input.

While the follow-ups panel has the keyboard:

| Key | Effect |
|---|---|
| `Up` / `Down`, `Home` / `End` | Select a pending follow-up |
| `Enter` | Remove the selected follow-up from its queue and steer it into the nearest step, waking the Agent |
| `S` | The same steer as `Enter` |
| `I` | Move the selected follow-up to next-step injection without waking the Agent |
| `E` | Remove the selected follow-up into the editor; `Enter` sends the revision and `Ctrl+C` restores the original prompt to the next-turn queue |
| `Tab` / `Shift+Tab` | The next / previous region that is drawn |
| `Esc` | Cancel and return to the input |
| Any other printable key | Return to the input and type the character at the caret |

While the conversation has the keyboard:

| Key | Effect |
|---|---|
| `Up` / `Down` | The previous / next section; `Down` at the newest section lands in the input |
| `Shift+Up` / `Shift+Down` | The previous / next block, on that block's first section |
| `PageUp` / `PageDown` | The previous / next turn, on that turn's first section |
| `Home` / `End` | The oldest / newest section |
| `Left` / `Right` | The previous / next part of the held block, stopping at its ends |
| `Shift+Left` / `Shift+Right` | The first / last part of the held block |
| `Space` | Fold or unfold the marked tool card or context block; a block the renderer can no longer rewrite opens in the reader instead, under the notice `above the repaint window · opened in the reader` |
| `Enter` | Read this section full screen |
| `Tab` / `Shift+Tab` | The next / previous region that is drawn |
| `Esc` | Return to the input |
| Any other printable key | Return to the input and type the character at the caret |

The walk covers every section in reading order — a system prompt, injected context (each snapshot contribution as its own part), the reasoning and the reply of a message, the call and the result of a tool, and your prompts, with turn-end notices and printed reports skipped. The rows a part carries are the block's own source text, so a reply reads as the Markdown the model wrote rather than the rendering drawn above. A message that streamed reasoning and then called a tool exposes that reasoning as its only section until visible text arrives, so the walk does not land on a blank reply. A session switch drops the keyboard back into the input and forgets the section the walk stopped at.

While the subagent panel has the keyboard:

| Key | Effect |
|---|---|
| `Up` / `Down` | The previous / next row; `Up` on the first row lands in the input and `Down` on the last row on the status bar |
| `Shift+Up` / `Shift+Down`, `Home` / `End`, `PageUp` / `PageDown` | The first / last row |
| `Enter`, `Right` | Open that child as a subagent view; `Ctrl+P` returns to this session |
| `Tab` / `Shift+Tab` | The next / previous region that is drawn |
| `Esc` | Return to the input |
| Any printable key | Return to the input and type the character at the caret |

The panel also hands the keyboard back to the input when its last row leaves.

While the status bar has the keyboard:

| Key | Effect |
|---|---|
| `Left` / `Right` | The previous / next segment, wrapping at both ends |
| `Shift+Left` / `Shift+Right`, `Home` / `End`, `PageUp` / `PageDown` | The first / last segment |
| `Shift+Up` / `Shift+Down` | The conversation on the section the walk stopped at, and the bar's own first segment |
| `Up` | The subagent panel's last row while it is drawn, and the input otherwise |
| `Enter` | Open the selected segment while the bar keeps the keyboard |
| `Tab` / `Shift+Tab` | The next / previous region that is drawn |
| `Esc` | Return to the input |
| Any printable key | Return to the input and type the character at the caret |

While the reader is open:

| Key | Effect |
|---|---|
| `Up` / `Down`, `k` / `j` | In the turn list, the previous / next section, crossing into the turn either side; in the turn, one row up / down |
| `PageUp` / `PageDown` | The previous / next turn, or a page of rows with one row of overlap |
| `Space` / `b` | In the turn, a page of rows down / up with one row of overlap |
| `[` / `]` | The previous / next turn, from the list or the turn |
| `Home` / `End`, `g` / `G` | The first / last section of the conversation, or the first / last row of the turn |
| `Right`, `Tab`, `Enter` | From the list, read the turn beside it |
| `Left`, `Tab`, `Shift+Tab` | From the turn, return to the list |
| `/` | In the list, open the turn filter: printable keys extend the query, `Backspace` drops one character, `Ctrl+U` clears it, `Enter` keeps the narrowed list and closes the line, and `Esc` clears a non-empty query and then closes the line |
| `Esc`, `q` | Close the reader and return to the conversation on the section last read; with the query line open, `Esc` clears a non-empty query and then closes the line, and `q` extends the query |
| `Ctrl+G`, `Ctrl+C` | Close the reader and return to the input |

Every other key reaching the reader is consumed, and closing it opens the same 750 ms handoff window, so no number of consecutive `Esc` presses reaches the input's stop.

Every focused segment expands its most important facts on the second line. `Enter` prints those facts into the transcript for every segment except `todo`, stating what they are and what changes them: the model segment names `/model`, the effort segment names the picker shared by `Shift+Tab` and `/effort`, and the permission segment names its preset and the `/permission` picker, the `turn` segment — drawn as `turn <elapsed>` between the permission and usage segments, and only while a turn runs — gives the turn number, its start time, its elapsed time, and the queued-message counts, while the usage, context, goal, and plan segments print the matching sections of the `/status` report, the workspace segment the full path, and the attachments segment the pending attachments. The `todo` segment expands the counts by status and the item being worked on, or the next pending item when none is in progress, and `Enter` opens the agent's todo list, the same list `/todos` opens.

Typing `/` at the start of the editor completes the terminal's own commands and the shared registry's; `@` anywhere completes references. A nonempty `!command` or `!!command` line runs through `ctx.shell` in the session cwd at `danger-full-access`; the draft and the transcript `$ command` row use syntax colours, and the transcript shows the output under that row. `!` injects a plugin notice for the next admitted step; `!!` does not. A lone `!` is an ordinary prompt. The editor border turns warning-coloured while the draft starts with `!`.

| Command | Effect |
|---|---|
| `/help` | List the commands, and the keys each focus state answers; `?` on an empty input does the same |
| `/model` | Pick the model (type to filter the rows), then its reasoning effort when the model declares more than one, for the next request; `/model <provider>/<model>` selects directly, `/model save` stores the current selection as the default, and `Ctrl+S` in the model list stores the highlighted model as the default for the next launch without closing the list |
| `/effort [id]` | With no argument, open the current model's reasoning-effort picker for the next request, the same picker as editor `Shift+Tab`; an id selects directly and `/effort default` restores the provider default |
| `/permission [preset]` | With no argument, open the permission-preset picker; a preset selects directly |
| `/resume` | Open the same persisted-session picker as `/sessions` and resume the selected previous session |
| `/sessions` | Open the persisted-session picker and switch to the selected session |
| `/new` | Start a new session |
| `/clear` | Start a new session with empty context; the previous session stays on disk and is resumable with `/resume` |
| `/fork [turn]` | Fork this session at its last completed turn, or after turn `turn` |
| `/title <text>` | Rename this session; alone it shows the current title |
| `/attach <path>` | Attach an image or file to the next prompt; `/attach` lists, `/attach clear` drops them |
| `/queue` | Show the messages queued for the next turn and step; `/queue clear` drops them, and the rows above the editor with them |
| `/skills` | List the skills the agent can load |
| `/signin` | Sign in to a provider through its notices and prompts; `/signin <key>` skips the picker |
| `/login` | Sign in with a provider subscription (hides key-collecting logins); `/login <key>` skips the picker |
| `/export [dir]` | Write this session's log ZIP (sub-sessions and attachments included) into `dir`, default the workspace |
| `/status` | Context window usage and breakdown, token totals with cache hit, session stats, todos, goal, plan mode, and permission |
| `/todos` | Browse the agent's todo list; completed rows are scratched out; `Enter` opens one item in full with its status, position, and turns |
| `/outline` | The turns of this session with their prompt and reply previews |
| `/deliverables` | The files the agent presented, grouped by turn |
| `/changes [turn]` | Browse the files the latest turn changed, or turn `turn`, with their line counts; `Enter` opens one file's turn-start to turn-end comparison |
| `/subagents` | Browse the subagent sessions under this session; `Enter` opens a readable one as a subagent view and an unreadable one's details |
| `/parent` | Return from a subagent view to the session it was entered from, like `Ctrl+P` |
| `/settings [ns [path value]]` | List namespaces, show one, or set one field; `/settings reset <ns>` restores defaults |
| `/plugins` | The composed plugins with enablement and lifecycle phase; `/plugins bundles` lists the profile's bundles, `/plugins enable <id>` and `/plugins disable <id>` switch a plugin entry or a bundle, `/plugins add <spec>` installs a bundle, `/plugins remove <name>` removes one |
| `/tools` | Expand or collapse every tool card and context row, like `Ctrl+O` |
| `/turns` | Read the conversation full screen, turns side by side, like `Ctrl+G` |
| `/quit`, `/exit` | Save the session and exit |

Every other `/name` line goes to the shared command registry, so `/compact`, `/goal`, and plugin commands work as they do in the browser.

Every picker the terminal opens — `/model`'s model and reasoning-effort lists, the current-model effort list shared by empty `/effort` and editor `Shift+Tab`, the permission-preset list empty `/permission` opens, the persisted-session list shared by `/resume` and `/sessions`, the `/subagents` and `/todos` lists, and the rows `/signin` and `/login` raise — filters its rows as you type: the query matches each row's label and description together, its whitespace- and slash-separated tokens must all match, and the rows are ordered best match first, so `dsk chat` and `deepseek/chat` both find `deepseek/deepseek-chat` and `gpt5` finds `gpt-5`. `Backspace` drops the last character, `Ctrl+U` clears the query, `Esc` clears a non-empty query and cancels the picker once the query is empty, `Up` / `Down` move within the matches, and `Enter` picks the highlighted row. The dim line above the rows reads `type to filter · Enter selects · Esc cancels` while the query is empty and `filter: <query> · <kept>/<total>` afterwards; a query nothing matches draws `no row matches "<query>"` in place of the rows, and the `✓` on the row in force — the row a picker opens on — shows only while the query is empty.

`/todos`, the `todo` status-bar segment, and the unreadable rows of `/subagents` share one list-then-details interaction: the picker lists the entries, `Enter` opens the highlighted entry as a read-only page, `Up` / `Down` and `PageUp` / `PageDown` scroll that page, and `Enter`, `Esc`, or `Left` returns to the list on the entry just read, so walking several entries costs no retyped command; `Esc` at the list returns to the editor. An entry whose details cannot be read says so on its page instead of closing the list.

### Subscription sign-in

`/login` stores a subscription credential but does not activate a dormant model route. Configure the catalog route first, then use its full credential key; for example, run `/settings llm-pi-ai providers.openai-codex {}` and then `/login llm-pi-ai/openai-codex`. Cursor is already registered: `/login llm-cursor/cursor`. A marked authorization page opens in the local default browser while its URL remains in the transcript as a fallback. SSH launches, hosts without a desktop, `--no-open`, and opener failures leave the manual URL and device-code paths available instead.

### Prompts from the agent

An approval request draws `Allow <tool>?` with the asker's reason, the logged call the request names (the same rows as its tool card, so a shell command reads before it runs), and two rows, allow once or reject; `Esc` rejects and `Ctrl+C` cancels the request. An `ask_user_question` question renders its `detail` as Markdown above its options plus a free-text row; multi-select toggles rows with `Space` and confirms through `Done`. A plan review (the `plan-review` intent `exit_plan_mode` sets) draws the plan as Markdown with Approve, Decline, and Discuss rows, where Discuss returns the request to the composer as the browser's card does. Prompts queue and show one at a time, and an aborted request withdraws its prompt.

### References and attachments

`@` followed by text lists matching files and directories — workspace-relative, `../` from the workspace, `~/` from the home directory, or absolute — and other sessions, in the same mention grammar the browser composer inserts (`@path`, `@"path with spaces"`, and the opaque `@[label](…)` session token); the base rows resolve those mentions into the prompt exactly as they do for the browser. `/attach <path>` reads a local file relative to the workspace and stores it through the composed attachment store, as an image block for `.png`, `.jpg`, `.jpeg`, `.webp`, and `.gif` and as a file block otherwise; pending attachments travel with the next prompt and are listed under it.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `prompt` | none | A first prompt submitted when the terminal is up |
| `resume` | none | A persisted session id to continue instead of starting a new one |
| `toolPreviewLines` | `8` | Collapsed tool-card body rows before `Space` on the marked card, or `Ctrl+O`, expands them |
| `contextPreviewLines` | `4` | Rows a system prompt or an injected `⬡` context block draws before `Space` on the marked block, or `Ctrl+O`, expands it |
| `focusPreviewLines` | `12` | Rows of the focused section the docked inspector shows before its fold marker sends the rest to the reader, for every section kind |
| `readerMinColumns` | `60` | Columns the reader needs before it draws the selected turn beside the turn list; below it one panel is drawn at a time |
| `codeHighlight` | `true` | Draw fenced code in a reply, the file rows of `read` and diff tool cards, and shell commands in a `!` / `!!` draft, a `$ command` row, and a terminal tool card, in syntax colours, from a theme the terminal's background picks |
| `toastMs` | `2000` | How long a transient key-feedback line holds at full strength before it fades out, which is also the window in which a second `Esc` stops the running turn |
| `liveRefreshMs` | `1000` | Period of the redraw that advances the `turn` segment and the panel's elapsed values and re-reads a stale subagent listing |
| `streamFadeSteps` | `24` | How many ticks a fade lasts: reply text fades in, reasoning and tool cards float out, over `streamFadeSteps × streamFadeStepMs` |
| `streamFadeStepMs` | `16` | One frame: the fade tick, the repaint period while anything is still moving, and the period paced stream text is drawn at; duration is `streamFadeSteps × streamFadeStepMs` |
| `streamPaceFrames` | `8` | Frames a backlog of streamed reply text or tool arguments takes to reach the screen. Thinking still queued when its block ends, or when reply text or a tool call starts, is drawn at once; `0`, like `reducedMotion`, draws each delta as it arrives |
| `toolRevealFrames` | `6` | Frames the rows of a tool card take to unroll when the card appears or its result lands, a share of the hidden rows per frame. Unfolding a card, and a card whose unrolling rows are above the part of the screen the renderer can repaint, draw every row at once; `0`, like `reducedMotion`, draws every row at once |
| `reducedMotion` | `false` | Draw streamed text, streamed reasoning, tool cards, and the chrome in their settled colors, with no fade, no lift, and no repeating repaint |
| `openBrowser` | `true` | Hand marked authorization pages to the local default browser |

`prompt`, `resume`, and `openBrowser` come from the command line through the startup provider; the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tui-app) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The runner is a direct driver over the core API carrier, like `dsh-headless`, that stays alive until the user quits and renders through [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi), the differential terminal renderer of the pi coding agent.

### Run flow

The runner awaits the complete application (`ctx.get('loader')?.await()`) and builds a session host over the core registry with four operations: `create` makes one fresh persisted Agent with the shared [`agentDefaultModel`](../../core/agent-default-model/README.md) selection, `resume` takes the Agent write handle first and then observes the live Session through `ctx.sessionQuery` so bind draws every persisted event including resume closers, and `fork` observes the source through `ctx.sessionQuery`, cuts after the chosen (by default the last) `turn/end` up to the next `turn/start`, and creates a seeded Agent with `parentSession` and `isSeeded` metadata, and `observe` opens a subagent session without releasing the bound one — a resident subagent Agent is read live and its release does nothing, and any other session is resumed. Every operation except a resident `observe` installs a `ModelSelectionRef` in the Agent's scoped setup so `/model` changes the next request. The terminal application starts on the session `--resume` or a fresh `create` yields, subscribes to `session/event`, `agent/assistant-stream`, and `agent/status`, answers the `approval/request` and `user-questions/request` waterfalls for the bound Agent only, and switches sessions by binding the next one and disposing the previous handle; while the host opens the next session the editor refuses input, and a quit during that wait releases the session that arrives afterwards. Quitting cancels any running turn, waits for quiescence, flushes the bound Session, disposes its handle, and requests exit 0; a driver failure writes `dsh: <message>` to stderr and requests exit 1. `/resume` and `/sessions` share the persisted-session chooser. Editor `Shift+Tab` dispatches empty `/effort` to open its current-model picker, and editor `Shift+Left` / `Shift+Right` use pi-tui's word navigation. `/login` starts `authorization.begin` with only subscription methods (every method except a key-collecting `api-key` login). A notice the flow marks with `openInBrowser` is handed to the default browser through `dsh-native-command`'s credential-scrubbed helper while the URL stays printed; the handoff is suppressed when `openBrowser` is false, the launch came through SSH, or the host has no desktop, and an opener failure becomes a notice beside the URL rather than a sign-in failure. A nonempty `!` or `!!` line submitted in the editor runs through `ctx.shell` in this process; `!` injects a next-step notice and `!!` stays local.

### Rendering model

Durable facts come from the session log: `system/message` (a nonempty prompt draws in full; an empty rendering is omitted), `user/message` (own submissions are drawn once and their echo skipped by message id; injected context — instructions, catalogs, snapshots, notices, relays, recalls, and undeclared forms — draws in full as a dim `⬡` row, a snapshot as one named contribution per part; compaction replacements and tool or model sources are omitted), `assistant/message` (which replaces the streamed block with the committed text and folds usage into the footer), `tool/call` and `tool/result` (drawn through the tool's `presentCall` and `presentResult` views when it declares them, with a raw-argument and raw-result fallback), `turn/end` notices, `workspace/changes` (one notice with the turn's file and line counts while the Host still holds the summary), `session/title` (header), `permission/preset` (footer), and `todo/write` under the enclosing `turn/start` (the turns one todo item's page reports; the list carries no per-item identity, so a reworded item counts as a new one; the same write refreshes the activity board from the `todos` projection). A descendant `tool/call`, `tool/result`, or `turn/end`, and a `subagent/start` or `subagent/end` for the bound parent, replace that board's one-line summary — tool title or first result row, never child assistant prose; `turn/end` on the bound session and bind clear the board. Live incrementality comes from `agent/assistant-stream` text, reasoning, tool-call, and usage deltas: a card is mounted when the model names the tool, and the working spinner follows that stream plus durable `tool/call` / `tool/result` so it says `thinking`, `writing`, or `calling <tool>` with live `↑` send and `↓` receive for that call. Session facts outside the log come from the same services the browser reads: `sessionTitle`, `permissionPresets`, `sessionQuery` for the picker, `/deliverables`, and subagent details, `sessionProjections` for the footer, `/status`, `/todos`, and `/outline`, `fileReferences` and `sessionReferenceResolver` for `@` completion, `attachments`, `skills`, `authorization`, `settings`, `subagents`, and the Loader's entries for `/plugins`. Modal prompts are process-local presentation and are never logged.

### Patch surface over base

The patch rides over `dsh-base`: it sets the coding persona prefix and cwd suffix on the base `system-prompt` row, keeps the same temporary process-wide PTC mode opt-in (`DSH_TOOLS_MODE`) as the Web surface, inserts PTC mode's worker, mounts the model-facing `ask_user_question` tool whose questions the terminal answers, mounts the same `@`-reference resolvers (`file-reference-local`, `session-reference`) and the `present` deliverable tool the browser composes, adds the `session-turn-outline` and `session-stats` projection rows behind `/outline` and `/status`, and mounts the startup provider and the runner. The base agent-plane rows (bash, filesystem, skills, goals, compaction, subagents) stay enabled because the terminal composes its Agents process-wide.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `tui-app` plugin: the session host (create, resume, fork, observe), resume observation, quit flow, exit mapping |
| [`src/startup.ts`](src/startup.ts) | The `tui-app-startup` provider: prompt positional, `--resume`, `--no-open`, and `--help` |
| [`src/app.ts`](src/app.ts) | The terminal application: layout, the key router, commands, session binding, seams, log and stream folding, the activity board above the editor, the stop arm, the transient line it mounts, the terminal handover the reader runs on, and prefix-on-submit `!` / `!!` |
| [`src/keys.ts`](src/keys.ts) | The key model: the focus regions, what one press means in each, the legends they degrade through, the entry keys, the `/help` lines, and the handoff window |
| [`src/sessions.ts`](src/sessions.ts) | The persisted-session list and picker rows shared by `/resume` and `/sessions` |
| [`src/effort.ts`](src/effort.ts) | Reasoning-effort names and picker rows shared by `/model`, `/effort`, and editor `Shift+Tab` |
| [`src/permission.ts`](src/permission.ts) | Permission-preset names and picker rows for `/permission` |
| [`src/attach.ts`](src/attach.ts) | `/attach`: local files into image or file blocks through the attachment store |
| [`src/export.ts`](src/export.ts) | `/export`: the session-log ZIP written through the export package's archive helpers |
| [`src/blocks.ts`](src/blocks.ts) | Transcript components: user prompt, user-shell run, assistant reply, tool card, system prompt and injected context, notice; the navigable blocks expose their sections and draw the focus gutter, and the foldable ones carry the marker both fold keys name. Each block keeps the lines it last drew and a reply keeps the coloured fences of its last Markdown parse and re-lexes only the open tail after the last closed fence, so a frame of a settled transcript costs one key comparison per block and a stream delta colours only the fence that changed |
| [`src/context.ts`](src/context.ts) | Project logged system prompts and injected user messages into transcript sections |
| [`src/navigation.ts`](src/navigation.ts) | The transcript as sections, the cursor that walks them along four axes, the turns those sections group into, and the inspector heading |
| [`src/inspector.ts`](src/inspector.ts) | The docked inspector: the framed pane with its mode chip, the section heading, the numbered wrapping parts strip, the folded rows, and its mounted component |
| [`src/frame.ts`](src/frame.ts) | Pure box drawing: the rounded rules, the inverse mode chip, body rows, and the legend step a width holds |
| [`src/reader.ts`](src/reader.ts) | The reader as plain data: its state, the intents keys become, its geometry, and the lines it draws |
| [`src/reader-screen.ts`](src/reader-screen.ts) | The reader pane drawn on the alternate screen: its key map, and where it leaves the keyboard |
| [`src/screen.ts`](src/screen.ts) | The main screen with the settle passes between building a frame and writing it, the repaint window each pass is judged against, the per-block repaint floor, and the suspension that holds the conversation off the terminal |
| [`src/alt-screen.ts`](src/alt-screen.ts) | The terminal's alternate screen: taking it, drawing absolutely addressed rows on it, and giving the conversation's own screen back |
| [`src/fade.ts`](src/fade.ts) | The streamed-text fade: the wall-clock tail tracker, the block-fade clock and registry, the fade-in ramp, the float-out mix, and the recolor of rendered lines |
| [`src/pace.ts`](src/pace.ts) | The stream pacer: the ordered queue between the assistant stream and the transcript, drained a backlog share per frame; and the row reveal that unrolls a tool card the same way |
| [`src/motion.ts`](src/motion.ts) | The chrome motion clock and the three-level lift its call sites draw with: the landing, the section step, and the bar walk |
| [`src/prompts.ts`](src/prompts.ts) | Approval, question, picker, and read-only detail prompts plus the modal queue |
| [`src/toast.ts`](src/toast.ts) | The transient key-feedback line: its overlay, its clock, and the lines it carries |
| [`src/transcript.ts`](src/transcript.ts) | Pure text folding of presentation views, usage, and turn-end reasons, the `$ command` span, and the one fold grammar every marker is written in |
| [`src/diff.ts`](src/diff.ts) | Line diff, hunk selection, and the addition and removal marks diff cards box |
| [`src/style.ts`](src/style.ts) | The palette, including the cool dark-mode heading and link hues a Markdown reply uses, the strikethrough role completed todo content uses, the background band a prompt is drawn on, and the derived pi-tui themes |
| [`src/highlight.ts`](src/highlight.ts) | Syntax colour for fenced code, file rows, and shell commands: the grammars a block may load, the theme the background picks, and the SGR one token is drawn with |
| [`src/completion.ts`](src/completion.ts) | Slash-command and `@`-reference completion for the editor |
| [`src/editor.ts`](src/editor.ts) | The prompt editor's terminal caret, its `Shift+Left` / `Shift+Right` mapping to pi-tui word navigation, and syntax colour on a `!` / `!!` draft |
| [`src/shell-line.ts`](src/shell-line.ts) | Parse a `!` / `!!` line or live draft and format the transcript rows and model-facing notice |
| [`src/status.ts`](src/status.ts) | Projection-seam facts and the sections the `/status` report and the segment details share; compaction and retry notices |
| [`src/footer.ts`](src/footer.ts) | The status bar: the ordered segments, each segment's detail rows, the unfocused line built from both ends, and the focused sliding window |
| [`src/subagent-panel.ts`](src/subagent-panel.ts) | The live subagent panel: one descendant listing plus sampled live facts become its rows, the unfocused summary line, and the focused listing |
| [`src/queue-panel.ts`](src/queue-panel.ts) | The follow-ups list: pending-row glyphs, hanging wrap, and the enter-steer legend |
| [`src/activity-board.ts`](src/activity-board.ts) | The activity board: todo glyphs, the completed scratch-out, the row cap, and the one-line descendant summary |
| [`src/catalog.ts`](src/catalog.ts) | Rows for `/settings`, `/plugins`, `/subagents`, `/deliverables`, `/changes`, and `/outline`, and the `/plugins` management verbs |
| [`src/view-banner.ts`](src/view-banner.ts) | The line above the input that names an open subagent view and the key back |
| [`src/todos.ts`](src/todos.ts) | The todo list: the status glyphs, the picker rows with completed content scratched out, and one item's detail rows |
| [`cordis.patch.yml`](cordis.patch.yml) | The terminal patch over `dsh-base` |
| — | No runtime invariant companion is published; the app registers listeners on one Agent and holds no mutable relation another observer could contradict. |
| [`tests/app.spec.ts`](tests/app.spec.ts) | Rendering, keys, commands, the stop arm, the follow-ups rows above the editor, the activity board, and both seams over a fake terminal |
| [`tests/activity-board.spec.ts`](tests/activity-board.spec.ts) | Activity-board glyphs, the completed scratch-out, the row cap, and the descendant line |
| [`tests/keys.spec.ts`](tests/keys.spec.ts) | What each region claims for a key, the legend steps, and the text one press types |
| [`tests/editor.spec.ts`](tests/editor.spec.ts) | The terminal caret, `Shift+Left` / `Shift+Right` word navigation, and `!` / `!!` draft colour against pi-tui's editor behavior |
| [`tests/frame.spec.ts`](tests/frame.spec.ts) | The rules, the chip, the body rows, and the legend a width holds |
| [`tests/motion.spec.ts`](tests/motion.spec.ts) | The motion clock's levels, its repaint demand, and the lift each level draws |
| [`tests/pace.spec.ts`](tests/pace.spec.ts) | The pacer's per-frame share, grapheme cuts, arrival order, flush, per-channel flush, and clear, and the row reveal's per-frame share, settle, and clamp |
| [`tests/stream-pace.spec.ts`](tests/stream-pace.spec.ts) | Paced reply text and tool arguments in stream order, thinking drawn when its block ends, the flush at stream end and before a logged event, reduced motion, and tool cards unrolling on the frame tick |
| [`tests/view-banner.spec.ts`](tests/view-banner.spec.ts) | The subagent-view line's trail, back target, width, and absence at the main session |
| [`tests/toast.spec.ts`](tests/toast.spec.ts) | The transient line's box, its hold, its fade, and its early settlement |
| [`tests/reader.spec.ts`](tests/reader.spec.ts) | The reader's geometry, its state machine, its filter, and the rows it returns |
| [`tests/reader-screen.spec.ts`](tests/reader-screen.spec.ts) | The reader pane: its key map, the screen it fills, its re-anchoring, and its exit |
| [`tests/alt-screen.spec.ts`](tests/alt-screen.spec.ts) | The alternate screen: its balanced switches, its per-row drawing, and the rows a shorter frame clears |
| [`tests/commands.spec.ts`](tests/commands.spec.ts) | The `/resume` and `/sessions` picker, attachments, queues, skills, sign-in, export, references, the picker shared by `/effort` and `Shift+Tab`, the `/permission` picker, and `Ctrl+S` in the model list over scripted services |
| [`tests/shell.spec.ts`](tests/shell.spec.ts) | Prefix-on-submit `!` / `!!` dispatch, live-draft parse, next-step inject, Esc cancel, and the missing-shell notice |
| [`tests/effort.spec.ts`](tests/effort.spec.ts) | Shared effort names, picker rows, the current-effort hint, and typed argument matching |
| [`tests/permission.spec.ts`](tests/permission.spec.ts) | Shared permission names, picker rows, the current-preset hint, and typed argument matching |
| [`tests/panels.spec.ts`](tests/panels.spec.ts) | Status footer and report, the navigable subagent and todo lists, catalog commands, command hints, and the approval detail |
| [`tests/transcript-focus.spec.ts`](tests/transcript-focus.spec.ts) | Walking the conversation, the region stack, the inspector, the reader over a live session with the terminal it takes and gives back, and the in-place gutter inside the repaint window |
| [`tests/context.spec.ts`](tests/context.spec.ts) | Projection of system prompts and injected context into transcript sections |
| [`tests/index.spec.ts`](tests/index.spec.ts) | Creation, resume paging, fork cut, session switching, quit flow, and failure reporting |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | Command-line parsing over a real Loader tree |
| [`tests/shortcuts.spec.ts`](tests/shortcuts.spec.ts) | `?` on an empty input and inside a draft, `Ctrl+T` from any region, `Ctrl+P` at the root session, and the `Ctrl+L` redraw |
| [`tests/subagents.spec.ts`](tests/subagents.spec.ts) | The live subagent panel's rows, walk, and listing refresh, and the subagent view it and `/subagents` open, left through `/parent` and `Ctrl+P` and released on a session switch and on quit |
| [`../../../apps/cli/tests/profiles/tui/tests/keyless-smoke.e2e.ts`](../../../apps/cli/tests/profiles/tui/tests/keyless-smoke.e2e.ts) | The shipped profile through the real launcher with a keyless mock model |

### Invariant ownership

No invariant companion is published because the app's observable contract (the transcript on stdout, the exit code, the persisted session) is process-level and owned by the launcher e2e; the plugin registers listeners only and holds no mutable relation to audit inside the tree.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you want to go deeper into the shared core, the sibling surfaces, or the seams the terminal answers.

- [Bundle package map](../README.md) — the surfaces built on the same core.
- [dsh-base](../base/README.md) — the shared core the terminal runs on.
- [dsh-headless](../headless/README.md) — the one-shot sibling for scripts and CI.
- [dsh-web-app](../web-app/README.md) — the browser sibling for multi-session work.
- [dsh-user-approval](../../interaction/user-approval/README.md) and [dsh-user-questions](../../interaction/user-questions/README.md) — the two seams the terminal answers.
- [dsh-commands](../../interaction/commands/README.md) — the registry behind `/`-commands.
- [dsh-file-reference](../../context/file-reference/README.md) and [dsh-session-reference](../../context/session-reference/README.md) — the `@` mention grammar and resolvers.
- [dsh-session-log-export](../../session-query/session-log-export/README.md) — the archive `/export` writes.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tui-app) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### User-typed shell command

#### What the model sees

A nonempty `!command` line injects one plugin notice after the command finishes (`source.kind: plugin`, `plugin: tui-app`, `form: notice`). The next admitted step includes this wrapper; `<command>` and the fenced body are data-dependent. An empty run uses the exact line `(no output)` instead of a fence. A cancelled run appends a blank line and `(command cancelled)`. A nonzero exit appends a blank line and `Command exited with code <n>`. `!!command` and a lone `!` add no notice.

##### User shell notice prefix

```markdown
The user ran `<command>` in the terminal.
```

#### Token effect

Conditional and retained: each `!` notice stays in conversation history for later requests; `!!` and a lone `!` add none.

#### KV Cache effect

Append-only conversation growth after the reusable request prefix. The notice does not change the system prompt or tool catalog. A `/model` switch starts a new request series exactly as it does from the browser.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe the terminal surface as shipped; they are not a general CLI comparison or a task backlog.

- **One session at a time** — `/resume`, `/sessions`, `/new`, `/clear`, and `/fork` move the terminal between sessions, but only the bound Agent streams, and a subagent view draws one child in place of the session it was entered from; the browser shows several sessions side by side.
- **Approvals are one-shot** — the prompt offers allow once or reject, matching the approval seam's vocabulary; there is no remembered grant.
- **Browser-only pages stay in the browser** — workspace and directory pickers, open-in-app links, the trajectory ledger, and per-message like/dislike have no terminal counterpart; `/settings`, `/plugins`, `/subagents`, `/outline`, and the shared `/feedback` cover their facts as text, and a subagent transcript is read in a subagent view.
- **Deliverables are named, not opened** — `/deliverables` lists the presented paths and `/changes` shows line comparisons; the browser previews the files.
- **Terminal scrollback owns history** — the keyboard walks every block and part of the conversation, tool cards and context blocks fold, and the reader's `/` filter narrows this session's turns; searching the text of a turn, and the history of other sessions, belong to the browser surface.
- **A focused block that scrolled away is marked only in the inspector** — pi-tui repaints differentially just the last `rows` lines of the last frame it wrote and clears the terminal's scrollback to change anything above them, so a block further back gains no gutter, the inspector heading says `off screen`, its frame goes dim, and `Space` on it opens the reader rather than rewriting it; `Ctrl+O` is the one key that does rewrite those lines, and on a conversation taller than the terminal it makes pi-tui redraw in full.
- **A frame that shrank leaves the top of the viewport out of reach** — the repaint window rises with the tallest frame written so far and never falls, so after read mode closes or the spinner leaves, a transient line is printed into the conversation instead of floating; it recovers as the conversation grows. The reader is unaffected: it draws on the terminal's other screen, where every row is its own.
- **The conversation is not drawn while the reader is up** — its screen is held off the terminal, so a turn that runs, a tool result that lands, and a notice that is printed are all drawn in one frame when the reader closes. The reader itself shows them as they arrive, because it re-reads the conversation on every drawing.
- **The reader shows source text** — an assistant reply reads as the Markdown the model wrote, not the rendering the transcript draws, so tables and headings read as their source; only a list item's leading `-`, `*`, or `+` is drawn as `•`.
- **The panel lists residency, not the tree** — a child joins it while its session record is resident in this process, so a subagent run by an out-of-process provider, which owns no session here, never appears; `/subagents` remains the way to every durable descendant.
- **Residency is not work** — the listing's `activity: 'running'` says the child's record is resident, which is what the row's `resident` reports; whether the child is working is the separate `running` / `idle` word beside it, read from that child's Agent in this process.
- **Rows behind the overflow row are not selectable** — the panel draws at most six rows and `Up` / `Down` leave it at their ends; the children folded into `+<n> more` are reached through `/subagents`, which walks the complete descendant tree.
- **The panel's text is built at the width of its last refresh** — a terminal resized while the panel is drawn keeps the heading legend and the row text that width chose until the next listing update, selection move, or live redraw rebuilds them.
- **The fade needs an answer from the terminal** — its ramp is built from the background color the terminal reports to the query sent at startup, so a terminal that stays silent, or that encodes neither truecolor nor 256 colors, gets the two-level faint mode instead; `NO_COLOR`, a disabled palette, `TERM=dumb`, and `reducedMotion` turn every fade and every chrome lift off entirely, and a transient line then disappears at the end of its hold instead of fading out.
- **The terminal's own caret can flicker** — the editor draws no caret of its own and the app turns the terminal cursor on, which pi-tui then moves across the lines it repaints; a terminal that does not honor the synchronized-output sequences pi-tui wraps a frame in can show that movement.
- **Runs through the `dsh` launcher** — starting the profile another way fails at startup, because only the launcher can request the process exit.
- **`!` is one-shot and not a TTY** — each line is a fresh `ctx.shell.run`; there is no persistent shell or interactive program. The Web composer does not intercept `!`. An optional first prompt on the command line is always a user message.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/bench.ts` owns the fake `Terminal` and a scripted session host; drive keys with its `type()`, read the rendered words with `text()`, which strips CSI, OSC, and APC sequences, and read `hostCalls` and `opened` for what switching did. pi-tui throttles renders to one frame per 16 ms, so tests wait through `settle()` before reading the screen. Services the commands read (`sessionTitle`, `attachments`, `authorization`, …) are provided through the bench's `before` hook as narrow stubs.

</details>
