/**
 * The docked Agent Teams summary between the editor and the status bar.
 * Member and task rows plus a hidden flag become one draw, and a second
 * function renders that draw as text.
 *
 * The summary is one line while a teammate or a shared task that is not
 * deleted exists. The app never gives this panel the keyboard; a selected
 * index is only for a test that reads the capped rows. Everything here is
 * pure — no Context, no services, no clock.
 * @module @deepseek-ai/dsh-tui-app/team-panel
 */

import { visibleWidth } from '@earendil-works/pi-tui'
import { fitLegend } from './frame.ts'
import { paintKeys } from './key-chips.ts'
import { HINTS } from './keys.ts'
import type { Palette } from './style.ts'

/**
 * Rows a focused draw keeps before folding the rest into one `+<n> more`
 * row. The summary the app mounts is one line; the cap applies only when a
 * caller passes a selected index. A presentation choice of this terminal
 * surface, not a deployment setting.
 */
export const TEAM_PANEL_MAX_ROWS = 6

/** Drawn when the user forces the panel on and the roster has nothing to list. */
export const TEAM_PANEL_EMPTY = 'team · no teammates or shared tasks yet'

/** What separates two facts inside one row. */
const SEPARATOR = ' · '

/** One roster row the panel counts and, when focused, may draw. */
export interface TeamMemberRow {
  /** Session id of the member. */
  id: string
  /** Model-facing name. */
  name: string
  /** Lead or teammate. The lead counts in the summary and is not a session the panel opens. */
  role: 'lead' | 'teammate'
  /** Runtime status of the member. */
  status: 'running' | 'inactive' | 'provisioning' | 'failed'
  /** Optional longer description. */
  description?: string
  /** Model id when the roster recorded one. */
  model?: string
  /** Reader diagnostics, one line each when a detail page prints them. */
  diagnostics: string[]
}

/** One shared task the panel counts unless its status is `deleted`. */
export interface TeamTaskRow {
  /** Team-local task id. */
  id: string
  /** Revision of this task value. */
  revision: number
  /** Short subject. */
  subject: string
  /** Task body. */
  description: string
  /** Lifecycle status. `deleted` tasks are omitted from the summary and the rows. */
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  /** Task ids that still block this one. */
  blockedBy: string[]
  /** Advisory write scopes. */
  writeScopes: string[]
  /** Member name that owns the task; absent when nobody does. */
  ownerName?: string
  /** Whether the task can be claimed now. */
  ready: boolean
  /** Warnings about the write scopes. */
  writeScopeWarnings: string[]
}

/** The plain inputs one panel draw is built from. */
export interface TeamPanelInputs {
  /** Roster rows, lead included. */
  members: readonly TeamMemberRow[]
  /** Shared tasks, deleted rows included; the draw drops those. */
  tasks: readonly TeamTaskRow[]
  /** Whether the user hid the panel. A hidden draw is empty even when rows exist. */
  hidden: boolean
}

/** The rows one panel draw shows and the ones it left out. */
export interface TeamPanelView {
  /**
   * Focused row texts, members then non-deleted tasks, at most
   * {@link TEAM_PANEL_MAX_ROWS}. Empty when the summary draws nothing.
   */
  rows: string[]
  /** Rows past {@link TEAM_PANEL_MAX_ROWS}; 0 when every one of them fits or the summary is empty. */
  hidden: number
  /** Every member, the lead included. */
  memberCount: number
  /** Members whose status is `running`. */
  running: number
  /** Tasks whose status is not `deleted`. */
  taskCount: number
  /** Whether the unfocused summary has a line to draw. */
  shown: boolean
}

/** How the panel is drawn. */
export interface TeamPanelRender {
  /** The palette the summary and any focused rows are styled with. */
  palette: Palette
  /**
   * Terminal columns a focused heading fits its legend into. The app draws
   * the unfocused summary, which does not use the width.
   */
  width: number
  /**
   * Index of the selected focused row. Absent for the summary the app
   * mounts, which never takes the keyboard.
   */
  selected?: number
  /**
   * Line drawn when {@link TeamPanelView.shown} is false because the roster
   * has no teammate and no live task. The app passes {@link TEAM_PANEL_EMPTY}
   * only while the user forced the panel on.
   */
  forcedEmpty?: string
}

/**
 * Tasks the summary and the focused rows count.
 * @param tasks - the roster's tasks, deleted rows included.
 * @returns the tasks whose status is not `deleted`, in input order.
 */
function liveTasks(tasks: readonly TeamTaskRow[]): TeamTaskRow[] {
  return tasks.filter(task => task.status !== 'deleted')
}

/**
 * Whether the roster has anything the summary lists.
 * @param members - the roster rows.
 * @param tasks - the non-deleted tasks.
 * @returns true when a teammate or a live task exists.
 */
function hasContent(members: readonly TeamMemberRow[], tasks: readonly TeamTaskRow[]): boolean {
  return members.some(member => member.role === 'teammate') || tasks.length > 0
}

/**
 * One member as a focused row.
 * @param member - the roster row.
 * @returns `name · role · status`, plus ` · model` when a model is present.
 */
function memberLine(member: TeamMemberRow): string {
  const parts = [member.name, member.role, member.status]
  if (member.model !== undefined) parts.push(member.model)
  return parts.join(SEPARATOR)
}

/**
 * One task as a focused row.
 * @param task - a non-deleted task.
 * @returns `subject · status · owner|unowned · ready|blocked`.
 */
function taskLine(task: TeamTaskRow): string {
  const owner = task.ownerName ?? 'unowned'
  return [task.subject, task.status, owner, task.ready ? 'ready' : 'blocked'].join(SEPARATOR)
}

/**
 * The unfocused summary.
 * @param view - the draw.
 * @returns `team · <n> members · <running> running · <tasks> tasks`.
 */
function summaryLine(view: TeamPanelView): string {
  return `team · ${String(view.memberCount)} members · ${String(view.running)} running · ${String(view.taskCount)} tasks`
}

/**
 * Build one panel draw. A hidden flag, or a roster with no teammate and no
 * task that is not deleted, yields an empty draw. Otherwise the counts
 * include every member and every non-deleted task, and the focused rows are
 * those members then those tasks, cut to {@link TEAM_PANEL_MAX_ROWS}.
 * @param inputs - the roster, the tasks, and whether the user hid the panel.
 * @returns the counts, the drawn rows, and how many rows the cap left out.
 */
export function teamPanelView(inputs: TeamPanelInputs): TeamPanelView {
  const tasks = liveTasks(inputs.tasks)
  const memberCount = inputs.members.length
  const running = inputs.members.filter(member => member.status === 'running').length
  const taskCount = tasks.length
  if (inputs.hidden || !hasContent(inputs.members, tasks)) {
    return { rows: [], hidden: 0, memberCount, running, taskCount, shown: false }
  }
  const listed = [...inputs.members.map(memberLine), ...tasks.map(taskLine)]
  const rows = listed.slice(0, TEAM_PANEL_MAX_ROWS)
  return { rows, hidden: listed.length - rows.length, memberCount, running, taskCount, shown: true }
}

/**
 * The one-line summary the app mounts. `hidden` draws nothing. `forced`
 * draws {@link TEAM_PANEL_EMPTY} when the roster has no teammate and no task
 * that is not deleted. Otherwise the line counts every member, the running
 * ones, and the tasks that are not deleted.
 * @param inputs - the roster, the tasks, and whether the line is hidden or forced.
 * @param palette - the palette the line is dimmed with.
 * @returns the summary line, or `''` when the slot should stay empty.
 */
export function teamPanelLine(
  inputs: Pick<TeamPanelInputs, 'members' | 'tasks'> & { readonly hidden?: boolean; readonly forced?: boolean },
  palette: Palette,
): string {
  if (inputs.hidden === true) return ''
  const view = teamPanelView({ members: inputs.members, tasks: inputs.tasks, hidden: false })
  if (!view.shown) return inputs.forced === true ? palette.dim(TEAM_PANEL_EMPTY) : ''
  return palette.dim(summaryLine(view))
}

/**
 * Render the panel. The app omits `selected`, so the result is the one dim
 * summary line, or empty when the draw has nothing to show. A selected index
 * draws the heading, the capped rows, and `+<hidden> more · /team lists them all`.
 * @param view - the rows one draw produced.
 * @param render - the palette, the width, the optional selected row, and the forced-empty line.
 * @returns the panel text, empty when the summary stays unmounted.
 */
export function renderTeamPanel(view: TeamPanelView, render: TeamPanelRender): string {
  if (!view.shown) return render.forcedEmpty === undefined ? '' : render.palette.dim(render.forcedEmpty)
  const { palette, selected } = render
  if (selected === undefined) return palette.dim(summaryLine(view))
  const counts = `team · ${String(view.memberCount)} members · ${String(view.taskCount)} tasks`
  const hints = fitLegend(HINTS.panel, render.width - visibleWidth(counts) - visibleWidth(SEPARATOR))
  const lines = [`${palette.dim(`${counts}${SEPARATOR}`)}${paintKeys(palette, hints)}`]
  for (const [index, row] of view.rows.entries()) {
    lines.push(index === selected ? palette.accent(row) : palette.dim(row))
  }
  if (view.hidden > 0) lines.push(palette.dim(`+${String(view.hidden)} more${SEPARATOR}/team lists them all`))
  return lines.join('\n')
}
