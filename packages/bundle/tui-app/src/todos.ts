/**
 * The agent's todo list as terminal rows: the status glyphs every todo surface
 * of this terminal draws, the picker choices the list offers, and the detail
 * rows one entered item prints. Completed picker content can take a paint
 * function so the list scratches it out. Everything here is pure text work
 * over plain values; the single service touch is one optional read of the
 * `todos` session projection.
 * @module @deepseek-ai/dsh-tui-app/todos
 */

import type { Context } from '@deepseek-ai/cordis'
import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { Session } from '@deepseek-ai/dsh-session'
// Empty type import: carries the `ctx.sessionProjections` service declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
// Named type import: also carries the `todos` projection-key declaration merge.
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'

/**
 * Terminal columns a picker row spends on content. The list draws one row per
 * todo, so content past this cap ends in `…` instead of wrapping onto a second
 * row; 64 columns plus the status glyph and the list's own row marker fit an
 * 80-column terminal. Columns, not characters: one wide character fills two of
 * them. A presentation choice of this terminal surface, not a deployment
 * setting.
 */
const TODO_LABEL_COLUMNS = 64

/**
 * Columns the detail rows wrap one item's full content to. Fixed rather than
 * read from the terminal so these rows stay plain values; 72 columns fit an
 * 80-column terminal, and a narrower terminal wraps them again when it draws
 * them. A presentation choice of this terminal surface, not a deployment
 * setting.
 */
const TODO_DETAIL_COLUMNS = 72

/**
 * Glyph per todo status: the marker a todo row leads with. This module is the
 * one home of the markers — every module of this terminal surface that prints
 * a todo row imports them from here rather than keeping its own table.
 */
export const TODO_GLYPH: Record<TodoItem['status'], string> = {
  completed: '✓',
  in_progress: '▸',
  pending: '○',
}

/** The word each status is spelled out as. */
const TODO_WORD: Record<TodoItem['status'], string> = {
  completed: 'completed',
  in_progress: 'in progress',
  pending: 'pending',
}

/** Every status, in the order a counts row lists them. */
const TODO_STATUSES: readonly TodoItem['status'][] = ['completed', 'in_progress', 'pending']

/** Paint applied to completed todo content; omitted leaves the text unmarked. */
export type TodoContentPaint = (content: string) => string

/**
 * The content a todo row shows: completed items take `paint` so the list can
 * scratch them out; every other status is the content unchanged.
 * @param content - the text after any row-length cut.
 * @param status - the item's status.
 * @param paint - how completed content is marked.
 * @returns the painted content, or `content` when the item is not completed or no paint was given.
 */
export function paintTodoContent(content: string, status: TodoItem['status'], paint?: TodoContentPaint): string {
  return status === 'completed' && paint !== undefined ? paint(content) : content
}

/** One todo of the current list as the picker shows it. */
export interface TodoChoice {
  /** Zero-based position in the current list; the picker row value once the caller stringifies it. */
  index: number
  /** Row label: the status glyph, then the content cut to {@link TODO_LABEL_COLUMNS}. */
  label: string
  /** Row description: the status word, plus for `in_progress` that the item is being worked on now. */
  description: string
  /** The item's status, so the caller can style or group the row without re-reading the list. */
  status: TodoItem['status']
}

/**
 * The agent's current todo list as picker rows, in write order.
 * @param ctx - plugin context carrying the optional session-projection registry.
 * @param session - the session whose todo list is read.
 * @param paint - how completed content is marked; omitted leaves it unmarked.
 * @returns one choice per item. Empty in three cases: no projection registry
 * is composed in this profile, the registry has no `todos` unit registered, or
 * the value is `null` — which it is before the first `todo_write` of the
 * current turn, since every `turn/start` clears the list.
 */
export function listTodoChoices(ctx: Context, session: Session, paint?: TodoContentPaint): TodoChoice[] {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) return []
  const items = projections.snapshot(session, ['todos']).values.todos
  if (items === undefined || items === null) return []
  return items.map((item, index) => ({
    index,
    label: `${TODO_GLYPH[item.status]} ${paintTodoContent(labelContent(item.content), item.status, paint)}`,
    description: describeStatus(item.status),
    status: item.status,
  }))
}

/**
 * One content line cut to a single picker row.
 * @param content - the item's content.
 * @returns the content unchanged, or its leading columns followed by `…`,
 * together never wider than {@link TODO_LABEL_COLUMNS}. A wide character that
 * would straddle the cut is dropped rather than halved.
 */
function labelContent(content: string): string {
  if (visibleWidth(content) <= TODO_LABEL_COLUMNS) return content
  return `${sliceByColumn(content, 0, TODO_LABEL_COLUMNS - 1, true)}…`
}

/**
 * The picker description for one status.
 * @param status - the item's status.
 * @returns the status word, and for `in_progress` that the item is being worked on now.
 */
function describeStatus(status: TodoItem['status']): string {
  return status === 'in_progress' ? `${TODO_WORD[status]} · being worked on now` : TODO_WORD[status]
}

/**
 * The turn facts a caller may keep for one todo. The todo list carries no
 * identity — every `todo/write` replaces the whole list — so a caller matches
 * these to an item by its `content`, which the todo tool keeps unique within a
 * write. An item whose wording changes is therefore a new item that starts
 * over at the turn it was reworded in, and the item it replaced is gone.
 */
export interface TodoTransition {
  /** The turn whose `todo/write` first carried this content. */
  firstTurn: number
  /** The turn whose `todo/write` last changed this content's status. */
  statusTurn: number
}

/**
 * The rows one entered todo prints: its full content wrapped to
 * {@link TODO_DETAIL_COLUMNS}, its status, its position in the list, the
 * list's counts by status, and — when the caller tracked them — the turn the
 * item first appeared in and the turn its status last changed in. Equal turns
 * print the appearance row alone: an item still holding the status it was
 * written with has no later change to report.
 * @param items - the list the entered row was drawn from.
 * @param index - zero-based position of the entered row.
 * @param transition - the turn facts the caller tracked for this item, when it has them.
 * @returns the detail rows; one row naming the missing item when `index` is
 * outside the list, which it is once a later `todo/write` shortened it.
 */
export function todoDetail(items: readonly TodoItem[], index: number, transition?: TodoTransition): string[] {
  const item = items[index]
  if (item === undefined) return [`no todo item ${String(index + 1)} of ${String(items.length)}`]
  const rows = [
    ...wrapTextWithAnsi(item.content, TODO_DETAIL_COLUMNS),
    `status: ${TODO_WORD[item.status]}`,
    `item ${String(index + 1)} of ${String(items.length)}`,
    countsRow(items),
  ]
  if (transition !== undefined) {
    rows.push(`first written in turn ${String(transition.firstTurn)}`)
    if (transition.statusTurn !== transition.firstTurn) {
      rows.push(`status last changed in turn ${String(transition.statusTurn)}`)
    }
  }
  return rows
}

/**
 * The whole list counted by status.
 * @param items - the current list.
 * @returns one count per status in {@link TODO_STATUSES} order, including the
 * zeroes, e.g. `2 completed · 1 in progress · 4 pending`.
 */
function countsRow(items: readonly TodoItem[]): string {
  return TODO_STATUSES
    .map(status => `${String(items.filter(item => item.status === status).length)} ${TODO_WORD[status]}`)
    .join(' · ')
}
