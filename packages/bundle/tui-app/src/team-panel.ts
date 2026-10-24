/**
 * The docked Agent Teams summary between the editor and the status bar: the
 * roster and the shared tasks become one dim line.
 *
 * The line is the only team summary on the main page. The subagent panel does
 * not list or count teammates, and the activity board labels a teammate by name
 * and role. The line names the teammates whose turn is running, so it is also
 * the live indicator. It is drawn while a teammate or a shared task that is not
 * deleted exists, and the app never gives it the keyboard. Everything here is
 * pure — no Context, no services, no clock.
 * @module @deepseek-ai/dsh-tui-app/team-panel
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { Palette } from './style.ts'

/** Drawn when the user forces the panel on and the roster has nothing to list. */
export const TEAM_PANEL_EMPTY = 'team · no teammates or shared tasks yet'

/** What separates two facts inside the line. */
const SEPARATOR = ' · '

/** The command the line points at; it plays the exchanges between the lead and its teammates. */
const TEAM_PLAY_HINT = '/team-play'

/** One roster row the summary counts and the app labels sessions with. */
export interface TeamMemberRow {
  /** Session id of the member. */
  id: string
  /** Model-facing name. */
  name: string
  /** Lead or teammate. The summary counts teammates only, and the lead is not a session the app opens. */
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

/** One shared task the summary counts unless its status is `deleted`. */
export interface TeamTaskRow {
  /** Team-local task id. */
  id: string
  /** Revision of this task value. */
  revision: number
  /** Short subject. */
  subject: string
  /** Task body. */
  description: string
  /** Lifecycle status. `deleted` tasks are omitted from the summary. */
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

/** The plain inputs one summary line is built from. */
export interface TeamLineInputs {
  /** Roster rows, lead included. */
  members: readonly TeamMemberRow[]
  /** Shared tasks, deleted rows included; the line drops those. */
  tasks: readonly TeamTaskRow[]
  /** Terminal columns the line is fitted to. */
  width: number
  /** Whether the user hid the line. A hidden line is empty even when rows exist. */
  hidden?: boolean
  /** Whether the user forced the line on, which draws {@link TEAM_PANEL_EMPTY} for a roster with nothing to list. */
  forced?: boolean
}

/**
 * Tasks the summary counts.
 * @param tasks - the roster's tasks, deleted rows included.
 * @returns the tasks whose status is not `deleted`, in input order.
 */
function liveTasks(tasks: readonly TeamTaskRow[]): TeamTaskRow[] {
  return tasks.filter(task => task.status !== 'deleted')
}

/**
 * The ways the running teammates can be named, longest first: every name, then
 * fewer names ended by `+<n>` for the ones left out, then only their number.
 * @param names - the names of the teammates whose status is `running`, in roster order.
 * @returns one candidate per step, or `undefined` alone when no teammate is running, which leaves the segment out.
 */
function workingSegments(names: readonly string[]): (string | undefined)[] {
  if (names.length === 0) return [undefined]
  const segments: string[] = []
  for (let shown = names.length; shown >= 1; shown--) {
    const rest = names.length - shown
    segments.push(`working: ${names.slice(0, shown).join(', ')}${rest === 0 ? '' : ` +${String(rest)}`}`)
  }
  segments.push(`${String(names.length)} working`)
  return segments
}

/**
 * The summary text.
 * @param teammates - the roster rows whose role is `teammate`.
 * @param tasks - the tasks that are not deleted.
 * @param width - columns the text should fit.
 * @returns `team · <n> teammates · working: <names> · tasks <completed>/<total> done · /team-play`
 * with the `working` segment left out while nobody runs. The first segment step that fits
 * `width` is used, and the shortest one when none does.
 */
function summaryText(teammates: readonly TeamMemberRow[], tasks: readonly TeamTaskRow[], width: number): string {
  const completed = tasks.filter(task => task.status === 'completed').length
  const count = `${String(teammates.length)} ${teammates.length === 1 ? 'teammate' : 'teammates'}`
  const running = teammates.filter(member => member.status === 'running').map(member => member.name)
  let text = ''
  for (const segment of workingSegments(running)) {
    text = [
      'team',
      count,
      ...segment === undefined ? [] : [segment],
      `tasks ${String(completed)}/${String(tasks.length)} done`,
      TEAM_PLAY_HINT,
    ].join(SEPARATOR)
    if (visibleWidth(text) <= width) break
  }
  return text
}

/**
 * The one-line summary the app mounts. `hidden` draws nothing. `forced`
 * draws {@link TEAM_PANEL_EMPTY} when the roster has no teammate and no task
 * that is not deleted. Otherwise the line counts the teammates (the lead is
 * not one), names the running ones, and counts the completed tasks among the
 * tasks that are not deleted. A line wider than `width` drops names from the
 * running list first, then ends with `…`.
 * @param inputs - the roster, the tasks, the width, and whether the line is hidden or forced.
 * @param palette - the palette the line is dimmed with.
 * @returns the summary line, or `''` when the slot should stay empty.
 */
export function teamPanelLine(inputs: TeamLineInputs, palette: Palette): string {
  if (inputs.hidden === true) return ''
  const teammates = inputs.members.filter(member => member.role === 'teammate')
  const tasks = liveTasks(inputs.tasks)
  const text = teammates.length === 0 && tasks.length === 0
    ? inputs.forced === true ? TEAM_PANEL_EMPTY : ''
    : summaryText(teammates, tasks, inputs.width)
  return text === '' ? '' : palette.dim(truncateToWidth(text, inputs.width, '…'))
}
