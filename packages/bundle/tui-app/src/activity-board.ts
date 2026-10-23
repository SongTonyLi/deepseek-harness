/**
 * The persistent activity board above the editor: the current todo list and
 * one row per descendant become the rows of one draw, and a second function
 * renders those rows as the board's text.
 *
 * A descendant row says what that child last said it was doing, led by the
 * child's task label, so every running child reads against its own goal.
 *
 * The board is display-only — `/todos` and the subagent panel keep browsing
 * and focus. Membership is the open turn: the caller clears the inputs on
 * `turn/start`, `turn/end`, and bind. An empty board draws nothing so the
 * slot can unmount. Everything here is pure — no Context, no services, no
 * clock: fade ages arrive as inputs.
 * @module @deepseek-ai/dsh-tui-app/activity-board
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
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

/**
 * Descendant rows the board draws before folding the rest into one `+<n> more`
 * row, running children first. The board shares its space above the editor
 * with the todo rows; `/subagents` lists every descendant. A presentation
 * choice of this terminal surface, not a deployment setting.
 */
export const ACTIVITY_BOARD_MAX_SUBAGENTS = 3

/** Narration characters kept per child; the row cuts it to its width again. */
const NARRATION_MAX_CHARS = 240

/** What separates a descendant's label from what it said. */
const NOTE_SEPARATOR = ' › '

/** Share of the row a descendant's label may take when it also draws a note. */
const LABEL_SHARE = 0.4

/** Columns a label keeps however narrow the row is. */
const LABEL_MIN_COLUMNS = 12

/** Fewest columns a note is worth drawing in; a narrower row draws the label alone. */
const NOTE_MIN_COLUMNS = 6

/** Glyph a settled descendant row leads with, by outcome. */
const SUBAGENT_SETTLED_GLYPH = { done: '✓', stopped: '✗' } as const

/** One todo as the board draws it. */
export interface ActivityBoardTodoRow {
  /** The item's content, which the todo tool keeps unique within a write. */
  content: string
  /** The item's status, so the renderer can scratch completed content out. */
  status: TodoItem['status']
  /** Glyph plus content, before completed paint. */
  text: string
}

/** Where one descendant stands in the open turn. */
export type ActivitySubagentState = 'running' | 'done' | 'stopped'

/** One descendant as the board tracks it. */
export interface ActivityBoardSubagent {
  /** The child session id, which keys the row's fade and spinner. */
  id: SessionId
  /** Listing label, or the child session id when the listing has none. */
  label: string
  /** `running` while the child's turn is open; `done` or `stopped` once it settled. */
  state: ActivitySubagentState
  /**
   * What the child last said it was doing while running, or the stop word
   * once it settled; omitted before the child has said anything.
   */
  note?: string
}

/** The plain inputs one board draw is built from. */
export interface ActivityBoardInputs {
  /** Current todos in write order; the same list `/todos` reads. */
  todos: readonly TodoItem[]
  /** The descendants the open turn has seen, in first-seen order; omitted while none has. */
  subagents?: readonly ActivityBoardSubagent[]
}

/** The rows one board draw shows and the todos it left out. */
export interface ActivityBoardView {
  /** Drawn todo rows in write order; at most {@link ACTIVITY_BOARD_MAX_TODOS}. */
  todos: ActivityBoardTodoRow[]
  /** Todos past the drawn rows; 0 when every one of them fits. */
  hidden: number
  /** Drawn descendant rows, running before settled; at most {@link ACTIVITY_BOARD_MAX_SUBAGENTS}. */
  subagents: ActivityBoardSubagent[]
  /** Descendants past the drawn rows; 0 when every one of them fits. */
  hiddenSubagents: number
}

/** How the board is drawn. */
export interface ActivityBoardRender {
  /** The palette completed content and overflow are styled with. */
  palette: Palette
  /** Live fades keyed by todo content; an id with no entry draws settled. */
  todoFades?: ReadonlyMap<string, BlockFade>
  /** Live fades keyed by child session id; a child with no entry draws settled. */
  subagentFades?: ReadonlyMap<SessionId, BlockFade>
  /**
   * The spinner frame each in-progress todo draws in place of its glyph,
   * keyed by content; an in-progress row with no entry draws the glyph.
   */
  spinners?: ReadonlyMap<string, string>
  /** The spinner frame each running descendant draws, keyed by child session id. */
  subagentSpinners?: ReadonlyMap<SessionId, string>
  /** Terminal columns every row is cut to; a longer row would wrap and raise the repaint boundary. */
  width: number
}

/**
 * Build one board draw: todos in write order cut to
 * {@link ACTIVITY_BOARD_MAX_TODOS}, plus the descendants, running before
 * settled and each group in first-seen order, cut to
 * {@link ACTIVITY_BOARD_MAX_SUBAGENTS}.
 * @param inputs - the current list and the descendants the turn has seen.
 * @returns the drawn rows and the count of each kind they left out.
 */
export function activityBoardView(inputs: ActivityBoardInputs): ActivityBoardView {
  const todos = inputs.todos.slice(0, ACTIVITY_BOARD_MAX_TODOS).map(rowOf)
  const children = inputs.subagents ?? []
  const ordered = [
    ...children.filter(child => child.state === 'running'),
    ...children.filter(child => child.state !== 'running'),
  ]
  const subagents = ordered.slice(0, ACTIVITY_BOARD_MAX_SUBAGENTS)
  return {
    todos,
    hidden: inputs.todos.length - todos.length,
    subagents,
    hiddenSubagents: ordered.length - subagents.length,
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
 * What a child said it is doing, from one of its assistant messages: the last
 * sentence of its text, without markdown or code blocks, on one line.
 * Reasoning is not narration, so the caller passes text blocks only.
 * @param text - the message's text blocks joined.
 * @returns the sentence, or undefined when the text holds no prose to show.
 */
export function activityNarration(text: string): string | undefined {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/gu, '\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gmu, '')
    .replace(/\*\*|__|~~|`/gu, '')
  const line = prose.split('\n').map(row => row.trim()).findLast(row => row !== '')
  const sentence = line?.split(/(?<=[.!?])\s+/u).findLast(part => part.trim() !== '')
  const narration = sentence?.replace(/\s+/gu, ' ').trim()
  if (narration === undefined || narration === '') return undefined
  return narration.length > NARRATION_MAX_CHARS ? `${narration.slice(0, NARRATION_MAX_CHARS - 1)}…` : narration
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
 * The rows of one board draw that a spinner animates.
 * @param view - the rows one draw produced.
 * @returns the content of every drawn in-progress todo, in write order.
 */
export function spinningTodos(view: ActivityBoardView): string[] {
  return view.todos.filter(row => row.status === 'in_progress').map(row => row.content)
}

/**
 * The descendant rows of one board draw that a spinner animates.
 * @param view - the rows one draw produced.
 * @returns the session id of every drawn running descendant, in draw order.
 */
export function spinningSubagents(view: ActivityBoardView): SessionId[] {
  return view.subagents.filter(child => child.state === 'running').map(child => child.id)
}

/**
 * Render the board. Todo rows lead with status-colored glyphs, an in-progress
 * one with its spinner frame when one is given; completed content is dim and
 * scratched out. A list past the cap ends on `+<n> more`.
 * The descendant rows are last, each with its own glyph, label, and note, and
 * a descendant list past the cap ends on its own `+<n> more`. An empty view
 * returns the empty string so the slot can unmount.
 * @param view - the rows one draw produced.
 * @param render - the palette, the fades still moving, and the width.
 * @returns the board text, or the empty string when nothing is drawn.
 */
export function renderActivityBoard(view: ActivityBoardView, render: ActivityBoardRender): string {
  const { palette } = render
  const lines: string[] = []
  for (const row of view.todos) {
    const content = paintTodoContent(row.content, row.status, text => palette.dim(palette.strikethrough(text)))
    const paint = row.status === 'completed' ? palette.success : row.status === 'in_progress' ? palette.warning : palette.accent
    const glyph = (row.status === 'in_progress' ? render.spinners?.get(row.content) : undefined) ?? TODO_GLYPH[row.status]
    lines.push(fadedLine(`${paint(glyph)} ${content}`, render.todoFades?.get(row.content)))
  }
  if (view.hidden > 0) lines.push(palette.dim(`+${String(view.hidden)} more`))
  for (const child of view.subagents) {
    lines.push(fadedLine(subagentLine(child, render), render.subagentFades?.get(child.id)))
  }
  if (view.hiddenSubagents > 0) lines.push(palette.dim(`+${String(view.hiddenSubagents)} more subagents`))
  return lines.join('\n')
}

/**
 * One descendant as a row that fits one terminal line: glyph, the label cut
 * to its share of the row, and the note in the room that is left.
 * @param child - the descendant row.
 * @param render - the palette, the running spinner frames, and the width.
 * @returns the styled row.
 */
function subagentLine(child: ActivityBoardSubagent, render: ActivityBoardRender): string {
  const { palette } = render
  const settled = child.state !== 'running'
  const glyph = child.state === 'running'
    ? palette.warning(render.subagentSpinners?.get(child.id) ?? TODO_GLYPH.in_progress)
    : child.state === 'done' ? palette.success(SUBAGENT_SETTLED_GLYPH.done) : palette.error(SUBAGENT_SETTLED_GLYPH.stopped)
  const paintLabel = (text: string): string => settled ? palette.dim(text) : text
  // The glyph and its space.
  const room = Math.max(0, render.width - 2)
  const note = child.note
  const noteless = `${glyph} ${paintLabel(truncateToWidth(child.label, room, '…'))}`
  if (note === undefined || note === '') return noteless
  const label = truncateToWidth(child.label, Math.max(LABEL_MIN_COLUMNS, Math.floor(room * LABEL_SHARE)), '…')
  const noteRoom = room - visibleWidth(label) - visibleWidth(NOTE_SEPARATOR)
  if (noteRoom < NOTE_MIN_COLUMNS) return noteless
  const shown = truncateToWidth(note, noteRoom, '…')
  const paintNote = child.state === 'stopped' ? palette.error : settled ? palette.dim : (text: string) => text
  return `${glyph} ${paintLabel(label)}${palette.dim(NOTE_SEPARATOR)}${paintNote(shown)}`
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
