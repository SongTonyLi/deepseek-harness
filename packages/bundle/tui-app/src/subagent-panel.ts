/**
 * The live subagent panel between the editor and the status bar: one
 * descendant listing plus the live facts the app sampled for it become the
 * panel's rows, and a second function renders those rows as the panel's text.
 *
 * Membership is residency, not completion: a `child` entry joins the panel
 * while its session record is resident in this process (`activity: 'running'`)
 * and leaves once it is not, so the panel tracks the children running right
 * now while `/subagents` browses the complete durable tree. A `diagnostic`
 * entry always draws, because a candidate the listing could not interpret is
 * a live problem rather than a settled child.
 *
 * Unfocused the panel is one summary line; focused it is the heading, the
 * drawn rows, overflow, and hints. Everything here is pure — no Context, no
 * services, no clock: the current time arrives as an input.
 * @module @deepseek-ai/dsh-tui-app/subagent-panel
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { Palette } from './style.ts'
import { formatElapsed, formatTokens } from './transcript.ts'

/**
 * Rows the panel draws before folding the rest into one `+<n> more` row. The
 * panel sits between the transcript and the editor, so it stays short enough
 * to leave the conversation readable; `/subagents` lists every descendant
 * without a cap. The selection moves among the drawn rows only. A
 * presentation choice of this terminal surface, not a deployment setting.
 */
export const SUBAGENT_PANEL_MAX_ROWS = 6

/** Two-space indentation per nesting level, as the `/subagents` rows indent. */
const DEPTH_INDENT = '  '

/** What separates two facts inside one row, and two parts of the heading. */
const SEPARATOR = ' · '

/** The keys the focused panel answers, appended to its heading. */
const FOCUS_HINTS = `↑ ↓ select${SEPARATOR}Enter details${SEPARATOR}Esc back`

/** The live facts one panel draw sampled for one listed child. */
export interface SubagentLiveFacts {
  /** Whether the child's Agent is running a turn in this process right now. */
  running: boolean
  /** Start of the child's open turn, from `subagentTiming.active.since`; absent between turns. */
  activeSince?: number
  /** Milliseconds the child's settled turns took, from `subagentTiming.settledMs`. */
  settledMs?: number
  /** Tokens the child billed; absent when no `tokenUsage` projection is registered. */
  usage?: {
    /** Prompt-side tokens, cached and uncached together. */
    inputTokens: number
    outputTokens: number
  }
}

/** The plain inputs one panel draw is built from. */
export interface SubagentPanelInputs {
  /** The descendant listing, in pre-order. */
  entries: readonly SubagentDescendantListEntry[]
  /** Live facts by child session id; an id with no entry draws without them. */
  facts: ReadonlyMap<SessionId, SubagentLiveFacts>
  /** The wall clock a running child's elapsed time is measured against. */
  now: number
}

/** One panel row. */
export interface SubagentPanelRow {
  /** The child session id: the panel's selection key and the detail target. */
  id: SessionId
  /** Whether `Enter` opens this row's session details; false for a diagnostic row. */
  enterable: boolean
  /** The row text, led by its depth indent. */
  text: string
  /** Whether this row's elapsed value advances with the clock. */
  ticking: boolean
}

/** The rows one panel draw shows and the children it left out. */
export interface SubagentPanelView {
  /** The drawn rows in listing order; at most {@link SUBAGENT_PANEL_MAX_ROWS}. */
  rows: SubagentPanelRow[]
  /** Children past the drawn rows; 0 when every one of them fits. */
  hidden: number
  /** Whether any drawn row's elapsed value advances with the clock. */
  ticking: boolean
}

/** How the panel is drawn. */
export interface SubagentPanelRender {
  /** The palette the heading, rows, and hints are styled with. */
  palette: Palette
  /** Index of the selected row; absent while the panel does not hold the keyboard. */
  selected?: number
  /** Why the last listing failed, drawn as one line under the rows. */
  failure?: string
}

/**
 * The elapsed part of a row: the open turn's running time, else the total the
 * child's settled turns took. Absent when no timing projection is registered.
 * @param facts - the live facts sampled for the child, when it has any.
 * @param now - the wall clock the running time is measured against.
 * @returns the formatted elapsed time, or undefined when the child has none.
 */
function elapsedOf(facts: SubagentLiveFacts | undefined, now: number): string | undefined {
  if (facts?.activeSince !== undefined) return formatElapsed(now - facts.activeSince)
  if (facts?.settledMs !== undefined) return formatElapsed(facts.settledMs)
  return undefined
}

/**
 * One listing entry as a row.
 * @param entry - the listing entry.
 * @param facts - the live facts sampled for it, when it has any.
 * @param now - the wall clock the running time is measured against.
 * @returns the row.
 */
function rowOf(entry: SubagentDescendantListEntry, facts: SubagentLiveFacts | undefined, now: number): SubagentPanelRow {
  const indent = DEPTH_INDENT.repeat(entry.depth - 1)
  if (entry.kind === 'diagnostic') {
    return { id: entry.id, enterable: false, ticking: false, text: `${indent}${entry.id}${SEPARATOR}unreadable: ${entry.reason}` }
  }
  const parts = [entry.mode, 'resident', facts?.running === true ? 'running' : 'idle']
  const elapsed = elapsedOf(facts, now)
  if (elapsed !== undefined) parts.push(elapsed)
  if (facts?.usage !== undefined) {
    parts.push(`↑${formatTokens(facts.usage.inputTokens)} ↓${formatTokens(facts.usage.outputTokens)}`)
  }
  return {
    id: entry.id,
    enterable: true,
    ticking: facts?.activeSince !== undefined,
    text: `${indent}${entry.label ?? entry.id}${SEPARATOR}${parts.join(SEPARATOR)}`,
  }
}

/**
 * Build one panel draw: every resident child and every diagnostic candidate
 * of the listing, in listing order, cut to {@link SUBAGENT_PANEL_MAX_ROWS}.
 * @param inputs - the listing, the live facts, and the current time.
 * @returns the drawn rows, the count they left out, and whether any of them advances with the clock.
 */
export function subagentPanelView(inputs: SubagentPanelInputs): SubagentPanelView {
  const listed = inputs.entries.filter(entry => entry.kind === 'diagnostic' || entry.activity === 'running')
  const rows = listed
    .slice(0, SUBAGENT_PANEL_MAX_ROWS)
    .map(entry => rowOf(entry, inputs.facts.get(entry.id), inputs.now))
  return { rows, hidden: listed.length - rows.length, ticking: rows.some(row => row.ticking) }
}

/**
 * Render the panel. Unfocused it is one dim summary line — the listed count
 * and the first child's key label. Focused it is the heading with navigation
 * keys, one line per drawn row, the overflow count, and the last listing
 * failure. The selected row is accented while the panel holds the keyboard.
 * @param view - the rows one draw produced.
 * @param render - the palette, the selected row, and the listing failure.
 * @returns the panel text, one line when unfocused and one line per row when focused.
 */
export function renderSubagentPanel(view: SubagentPanelView, render: SubagentPanelRender): string {
  const { palette, selected } = render
  const total = view.rows.length + view.hidden
  if (selected === undefined) {
    const first = view.rows[0]?.text.trimStart().split(SEPARATOR)[0]
    const parts = [`subagents${SEPARATOR}${String(total)} listed`]
    if (first) parts.push(first)
    if (render.failure !== undefined) parts.push(`listing failed: ${render.failure}`)
    return palette.dim(parts.join(SEPARATOR))
  }
  const heading = `subagents${SEPARATOR}${String(total)} listed${SEPARATOR}${FOCUS_HINTS}`
  const lines = [palette.dim(heading)]
  for (const [index, row] of view.rows.entries()) {
    lines.push(index === selected ? palette.bold(palette.accent(row.text)) : palette.dim(row.text))
  }
  if (view.hidden > 0) lines.push(palette.dim(`+${String(view.hidden)} more${SEPARATOR}/subagents lists them all`))
  if (render.failure !== undefined) lines.push(palette.dim(`listing failed: ${render.failure}`))
  return lines.join('\n')
}
