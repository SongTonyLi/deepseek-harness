/**
 * The agent's todo list as terminal text: the status glyphs every todo surface
 * of this terminal draws, the paint completed content takes, and the turn
 * facts the application keeps per item. Pure: no Context, no services.
 * @module @deepseek-ai/dsh-tui-app/todos
 */

// Named type import: also carries the `todos` projection-key declaration merge.
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'

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
