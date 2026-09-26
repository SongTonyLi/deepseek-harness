/**
 * The persistent activity board above the editor: the current todo list and
 * one latest-descendant line become the rows of one draw, and a second
 * function renders those rows as the board's text.
 *
 * The board is display-only — `/todos` and the subagent panel keep browsing
 * and focus. Membership is the open turn: the caller clears the inputs on
 * `turn/start`, `turn/end`, and bind. An empty board draws nothing so the
 * slot can unmount. Everything here is pure — no Context, no services, no
 * clock: fade ages arrive as inputs.
 * @module @deepseek-ai/dsh-tui-app/activity-board
 */

import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import type { BlockFade } from './blocks.ts'
import { recolorLines } from './fade.ts'
import type { Palette } from './style.ts'
import { paintTodoContent, TODO_GLYPH } from './todos.ts'
import { turnEndNotice } from './transcript.ts'

/**
 * Todo rows the board draws before folding the rest into one `+<n> more` row.
 * The board sits between follow-ups and the editor, so it stays short enough
 * to leave the prompt readable; `/todos` lists every item without a cap. A
 * presentation choice of this terminal surface, not a deployment setting.
 */
export const ACTIVITY_BOARD_MAX_TODOS = 4

/** What separates two facts on the descendant line. */
const SEPARATOR = ' · '

/** One todo as the board draws it. */
export interface ActivityBoardTodoRow {
  /** The item's content, which the todo tool keeps unique within a write. */
  content: string
  /** The item's status, so the renderer can scratch completed content out. */
  status: TodoItem['status']
  /** Glyph plus content, before completed paint. */
  text: string
}

/** The latest descendant fact the board shows as one line. */
export interface ActivityBoardSubagent {
  /** Listing label, or the child session id when the listing has none. */
  label: string
  /** The status word: `calling <name>`, a turn-end notice, `done`, or a stop reason. */
  status: string
  /** Presenter title or first result row; omitted when the event carries none. */
  summary?: string
}

/** The plain inputs one board draw is built from. */
export interface ActivityBoardInputs {
  /** Current todos in write order; the same list `/todos` reads. */
  todos: readonly TodoItem[]
  /** The latest descendant line; omitted while no descendant event has landed. */
  subagent?: ActivityBoardSubagent
}

/** The rows one board draw shows and the todos it left out. */
export interface ActivityBoardView {
  /** Drawn todo rows in write order; at most {@link ACTIVITY_BOARD_MAX_TODOS}. */
  todos: ActivityBoardTodoRow[]
  /** Todos past the drawn rows; 0 when every one of them fits. */
  hidden: number
  /** The formatted descendant line; absent while the inputs carry none. */
  subagent?: string
}

/** How the board is drawn. */
export interface ActivityBoardRender {
  /** The palette completed content and overflow are styled with. */
  palette: Palette
  /** Live fades keyed by todo content; an id with no entry draws settled. */
  todoFades?: ReadonlyMap<string, BlockFade>
  /** Live fade of the descendant line; omitted draws it settled. */
  subagentFade?: BlockFade
  /** The spinner frame an in-progress todo draws in place of its glyph; omitted draws the glyph. */
  spinner?: string
}

/**
 * Build one board draw: todos in write order cut to
 * {@link ACTIVITY_BOARD_MAX_TODOS}, plus the formatted descendant line.
 * @param inputs - the current list and the optional descendant fact.
 * @returns the drawn rows, the count they left out, and the descendant line.
 */
export function activityBoardView(inputs: ActivityBoardInputs): ActivityBoardView {
  const todos = inputs.todos.slice(0, ACTIVITY_BOARD_MAX_TODOS).map(rowOf)
  return {
    todos,
    hidden: inputs.todos.length - todos.length,
    ...inputs.subagent === undefined ? {} : { subagent: formatActivitySubagentLine(inputs.subagent) },
  }
}

/**
 * One todo as a board row.
 * @param item - the current list item.
 * @returns the row.
 */
function rowOf(item: TodoItem): ActivityBoardTodoRow {
  return {
    content: item.content,
    status: item.status,
    text: `${TODO_GLYPH[item.status]} ${item.content}`,
  }
}

/**
 * Join the descendant line's parts, dropping an empty summary.
 * @param line - the label, status word, and optional summary.
 * @returns `{label} · {status}` or `{label} · {status} · {summary}`.
 */
export function formatActivitySubagentLine(line: ActivityBoardSubagent): string {
  const parts = [line.label, line.status]
  if (line.summary !== undefined && line.summary !== '') parts.push(line.summary)
  return parts.join(SEPARATOR)
}

/**
 * The status and summary one tool result draws on the descendant line.
 * @param firstRow - the first presented result row, when the result had one.
 * @param isError - whether the result is an error.
 * @returns `error` plus the row, the row alone, or `done` when the result had no row.
 */
export function activityResultParts(
  firstRow: string | undefined,
  isError: boolean,
): Pick<ActivityBoardSubagent, 'status' | 'summary'> {
  if (isError) {
    return firstRow === undefined || firstRow === '' ? { status: 'error' } : { status: 'error', summary: firstRow }
  }
  return { status: firstRow === undefined || firstRow === '' ? 'done' : firstRow }
}

/**
 * The status word a child `turn/end` draws: the existing notice, or `done`.
 * @param reason - the durable turn-end reason.
 * @returns the notice text, or `done` for an ordinary completion.
 */
export function activityTurnEndStatus(reason: TurnEndReason): string {
  return turnEndNotice(reason) ?? 'done'
}

/**
 * Whether one board draw holds a row the spinner animates.
 * @param view - the rows one draw produced.
 * @returns true while an in-progress todo is drawn.
 */
export function activityBoardSpins(view: ActivityBoardView): boolean {
  return view.todos.some(row => row.status === 'in_progress')
}

/**
 * Render the board. Todo rows lead with status-colored glyphs, an in-progress
 * one with the spinner frame when one is given; completed content is dim and
 * scratched out. A list past the cap ends on `+<n> more`.
 * The descendant line is last. An empty view returns the empty string so the
 * slot can unmount.
 * @param view - the rows one draw produced.
 * @param render - the palette and the fades still moving.
 * @returns the board text, or the empty string when nothing is drawn.
 */
export function renderActivityBoard(view: ActivityBoardView, render: ActivityBoardRender): string {
  const { palette } = render
  const lines: string[] = []
  for (const row of view.todos) {
    const content = paintTodoContent(row.content, row.status, text => palette.dim(palette.strikethrough(text)))
    const paint = row.status === 'completed' ? palette.success : row.status === 'in_progress' ? palette.warning : palette.accent
    const glyph = row.status === 'in_progress' && render.spinner !== undefined ? render.spinner : TODO_GLYPH[row.status]
    lines.push(fadedLine(`${paint(glyph)} ${content}`, render.todoFades?.get(row.content)))
  }
  if (view.hidden > 0) lines.push(palette.dim(`+${String(view.hidden)} more`))
  if (view.subagent !== undefined) lines.push(fadedLine(palette.dim(view.subagent), render.subagentFade))
  return lines.join('\n')
}

/**
 * Draw one row at the mix its fade reports.
 * @param text - the settled row.
 * @param fade - the row's fade; absent for a row that never faded.
 * @returns the row at that mix, or `text` once the fade settled or was never attached.
 */
function fadedLine(text: string, fade: BlockFade | undefined): string {
  if (fade === undefined) return text
  const age = fade.age()
  if (age === undefined) return text
  return recolorLines([text], age, fade.style(), 0).join('\n')
}
