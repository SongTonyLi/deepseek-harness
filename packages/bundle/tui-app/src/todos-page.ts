/**
 * The todos page: one alternate-screen page that shows how the work is
 * divided, the counterpart of the team room, which shows who plays which
 * role. The left pane lists the shared tasks with each owner's todos beneath
 * them, then the bound session's own todo list as one more branch; the right
 * pane details the selected node. Below {@link TODOS_PAGE_STACK_BELOW}
 * columns the panes stack, the tree above the detail.
 *
 * The application rebuilds the tree on every key and frame. `Enter` hands the
 * selected owner's session back to the application, which opens it the way
 * `/team` does. Motion is a function of the clock and of the instants
 * {@link TodosPage} records, so no timer runs here: tree rows reveal top to
 * bottom when the page opens, the children of an unfolded node reveal one
 * after another, and a node whose state changed draws lifted for a few steps.
 * Every motion keeps the number of lines, moves each line only forward from
 * blank to lifted to settled, and ends on exactly the frame the page draws
 * without motion. Pure aside from the key state of {@link TodosPage}.
 * @module @deepseek-ai/dsh-tui-app/todos-page
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { fitLegend } from './frame.ts'
import { paintKeys } from './key-chips.ts'
import { Motion, pulse, type MotionLevel } from './motion.ts'
import { PAGE_CLOSE_HINT, type ScreenPage, type ScreenPageAction } from './screen-page.ts'
import type { Palette, Style } from './style.ts'
import { teamBrowseRows } from './team.ts'
import { unopenable } from './team-play.ts'
import type { TeamMemberRow } from './team-panel.ts'
import { TODO_GLYPH, type TodoTransition } from './todos.ts'
import type { WorkNode, WorkOwner, WorkReason, WorkState, WorkTree } from './work-tree.ts'

/**
 * The page's legend in declared degradation steps, widest first. The page is
 * not a focus region, so it names its keys here the way the team room does.
 */
export const TODOS_PAGE_HINTS: readonly [string, ...string[]] = [
  '↑↓ move · ←→ fold · Enter opens owner · PgUp PgDn scroll detail · Ctrl+T Esc q closes',
  '↑↓ move · ←→ fold · Enter opens owner · PgUp PgDn scroll · Esc q closes',
  '↑↓ move · ←→ fold · Enter opens · Esc closes',
  '↑↓ · ←→ · Enter · Esc closes',
  PAGE_CLOSE_HINT,
]

/** Drawn under the legend while the tree has no node. */
export const TODOS_PAGE_EMPTY = 'No todos or shared tasks yet — the list fills in when the agent plans its work.'

/**
 * The glyph each state leads a row with. Delivered and pending share the todo
 * list's markers; `in_progress` does not, because the todo list's `▸` is the
 * folded marker of this tree.
 */
export const WORK_GLYPH: Record<WorkState, string> = {
  delivered: TODO_GLYPH.completed,
  in_progress: '◐',
  stuck: '⊘',
  deferred: '◌',
  pending: TODO_GLYPH.pending,
}

/**
 * Columns below which the panes stack: under 72 columns the detail pane
 * beside a tree of at least 34 columns would keep fewer than 35 columns,
 * which cuts most subjects and descriptions short. A presentation choice of
 * this terminal surface, not a deployment setting.
 */
export const TODOS_PAGE_STACK_BELOW = 72

/**
 * Steps an opening reveal or an unfold reveal spreads its rows over at most;
 * a longer list reveals several rows per step, and a row past the count the
 * reveal started with arrives at the last step. A presentation choice of
 * this terminal surface, not a deployment setting.
 */
export const TODOS_PAGE_REVEAL_STEPS = 8

/**
 * Spinner periods a revealed row's lift lasts: the first third at the peak,
 * the second lifted, the last settled ({@link Motion}), so the row settles two
 * steps after it appears.
 */
export const TODOS_PAGE_REVEAL_LIFT_TICKS = 3

/**
 * Spinner periods the lift of a row whose state changed lasts, split in
 * thirds the same way, so the row settles four steps after the change.
 */
export const TODOS_PAGE_CHANGE_LIFT_TICKS = 6

/**
 * Steps the detail pane draws dim when the page opens, before it settles. It
 * appears with the first tree line, which holds the selected row when a page
 * opens.
 */
export const TODOS_PAGE_DETAIL_FADE_STEPS = 1

/** Rows above the panes: the heading, then the legend or a notice. */
const HEADER_ROWS = 2

/** Share of the width the tree pane takes beside the detail pane. */
const TREE_SHARE = 0.45

/** Columns the tree pane keeps at least beside the detail pane: a todo row's lead and a 26-column title. */
const TREE_MIN_COLUMNS = 34

/** Columns the tree pane takes at most, so a wide terminal gives the rest to the detail. */
const TREE_MAX_COLUMNS = 60

/** Columns between the panes: a space, the dim rule, and a space. */
const SEPARATOR_COLUMNS = 3

/** The rule between the stacked panes. */
const STACKED_RULE_ROWS = 1

/** Share of the stacked rows the tree takes at most. */
const STACKED_TREE_SHARE = 0.6

/** Rows the stacked detail keeps while the tree takes what it needs. */
const STACKED_MIN_DETAIL_ROWS = 4

/** Columns a tree row's title keeps, or all of it when shorter, before its `<done>/<n>` count gives way. */
const MIN_TITLE_COLUMNS = 12

/** Columns each tree level indents its rows by. */
const INDENT_COLUMNS = 2

/** The selection marker and its space; an unselected row draws spaces instead. */
const SELECTED_MARK = '❯ '

/** The fold marker of an open node with children. */
const OPEN_MARK = '▾ '

/** The fold marker of a folded node with children. */
const FOLDED_MARK = '▸ '

/** What a row draws in each of the two-column cells it leaves empty. */
const BLANK_CELL = '  '

/** What ends a line the width cut short. */
const ELLIPSIS = '…'

/** What a node without an owner names as its owner. */
const UNOWNED = 'unowned'

/** The word each state is spelled out as. */
const STATE_WORD: Record<WorkState, string> = {
  delivered: 'delivered',
  in_progress: 'in progress',
  stuck: 'stuck',
  deferred: 'deferred',
  pending: 'pending',
}

/** The palette role each state's glyph and word take. */
const STATE_ROLE: Record<WorkState, 'success' | 'warning' | 'error' | 'dim'> = {
  delivered: 'success',
  in_progress: 'warning',
  stuck: 'error',
  deferred: 'dim',
  pending: 'dim',
}

/** Each reason spelled out; `blocked` names the tasks it waits on when the node lists them. */
const REASON_TEXT: Record<WorkReason, string> = {
  blocked: 'waits on another task',
  owner_failed: 'owner failed to start',
  owner_idle: 'owner idle',
  released: 'released by its owner',
  reopened: 'reopened',
  left_open: 'left open when the turn ended',
}

/** What the page reads from the application, re-read on every key and frame. */
export interface TodosPageSource {
  /** The tree to draw, rebuilt by the application on every key and frame. */
  readonly tree: WorkTree
  /**
   * The spinner frame of one worked row.
   * @param slot - the row's position in the tree, so the application can stagger phases.
   * @returns the glyph, or undefined where motion is reduced and the row draws a static glyph.
   */
  spinner(slot: number): string | undefined
  /**
   * The roster row of one member.
   * @param id - the member's session id.
   * @returns the row, or undefined when the roster does not list the id.
   */
  member(id: string): TeamMemberRow | undefined
}

/** One unfold whose children reveal one after another. */
export interface TodosPageUnfold {
  /** When the node was unfolded, in milliseconds. */
  at: number
  /** How many children the node had then; the reveal spreads over this many. */
  children: number
}

/** The instants one frame's motion is measured from. */
export interface TodosPageMotion {
  /** The wall-clock instant drawn, in milliseconds. */
  now: number
  /** How long one step lasts, in milliseconds: the spinner period the application ticks at. */
  stepMs: number
  /** When the page first rendered; the opening reveal and the detail fade start here. */
  openedAt: number
  /**
   * How many tree lines the opening reveal spreads over: the
   * {@link TodosPageFrame.treeLines} of the first frame that drew the tree.
   * Undefined until then, when the frame's own count is used. Fixed once
   * known, so a fold or a resize during the reveal never takes back a line.
   */
  openingLines: number | undefined
  /** The unfolds by node key; a node's children reveal from its unfold. */
  unfolded: ReadonlyMap<string, TodosPageUnfold>
  /** When each node's state last changed, by node key; its row lifts from that instant. */
  changed: ReadonlyMap<string, number>
}

/** How one frame of the page is drawn. */
export interface TodosPageDraw {
  /** The palette the frame is styled with. */
  palette: Palette
  /** The tree and the spinner frames to draw. */
  source: TodosPageSource
  /** The selected node's key; the first visible row when absent or not visible. */
  selected: string | undefined
  /** Keys of the nodes whose children are hidden. */
  folded: ReadonlySet<string>
  /** How many detail lines the detail pane is scrolled down. */
  top: number
  /** One line that replaces the legend, such as why `Enter` opened nothing. */
  notice: string | undefined
  /** Columns the frame fits. */
  width: number
  /** Rows the frame fills. */
  rows: number
  /** The instants to draw the motion at; absent draws every line settled with static glyphs. */
  motion: TodosPageMotion | undefined
}

/** One drawn frame and what the next key needs to know about it. */
export interface TodosPageFrame {
  /** Exactly `rows` lines, each fitting the width. */
  lines: string[]
  /** The detail scroll offset after clamping to the lines the detail has. */
  top: number
  /** Detail lines a page key scrolls. */
  page: number
  /** How many lines the tree pane drew, count rows included; 0 when the frame drew no tree pane. */
  treeLines: number
  /** Whether the frame drew a spinner frame or an unsettled motion, so the next tick draws a different frame. */
  animated: boolean
}

/** What a {@link TodosPage} is built with. */
export interface TodosPageOptions {
  /** The palette the page is styled with. */
  palette: Palette
  /**
   * The reads the page draws, called on every key and frame.
   * @returns the tree, the spinner frames, and the roster rows.
   */
  source: () => TodosPageSource
  /**
   * The wall clock the motion is measured against.
   * @returns the current time in milliseconds.
   */
  now: () => number
  /** The spinner period the application renders at while the page animates, in milliseconds. */
  stepMs: number
  /** Whether the page moves; false for reduced motion, a disabled palette, or a dumb terminal. */
  motion: boolean
}

/** One visible row of the tree. */
interface TreeRow {
  /** The node the row draws. */
  readonly node: WorkNode
  /** Its position among the visible rows. */
  readonly index: number
  /** How many levels below the top it sits. */
  readonly depth: number
  /** Its position among its parent's children. */
  readonly sibling: number
  /** The row of its parent; undefined for a top-level node. */
  readonly parent: TreeRow | undefined
}

/** One run of a drawn line: its text and the style it settles in. */
interface Run {
  /** The characters, unstyled. */
  readonly text: string
  /** The style the run settles in. */
  readonly style: Style
}

/** One drawn line as runs, so a motion can draw the whole line in one style of its own. */
type Line = readonly Run[]

/** The first item a pane shows and how many. */
interface Slice {
  /** Index of the first item shown. */
  readonly start: number
  /** How many items are shown. */
  readonly count: number
}

/** One line of a pane: an item, or how many items the pane leaves out above or below. */
type PaneLine<T> =
  | { readonly kind: 'item'; readonly item: T }
  | { readonly kind: 'more'; readonly hidden: number; readonly above: boolean }

/** One pane's lines and whether any of them is still moving. */
interface Pane {
  /** The drawn lines, each fitting the pane's width. */
  readonly lines: string[]
  /** Whether a line drew a spinner frame or an unsettled motion. */
  readonly animated: boolean
}

/**
 * Leave text unstyled.
 * @param text - the text.
 * @returns `text`.
 */
const unstyled: Style = text => text

/**
 * Draw the page.
 *
 * Rows go to the heading and the legend first. From
 * {@link TODOS_PAGE_STACK_BELOW} columns up, the tree takes about 45% of the
 * width and every remaining row, and the detail takes the rest beside it.
 * Below that the tree takes the rows its visible nodes need, up to 60% of
 * the rows, while the detail under the rule keeps at least four. A pane cut
 * short draws `+<n> more above` and `+<n> more` where it leaves items out; the
 * tree scrolls to keep the selected row in view, and the detail scrolls by
 * {@link TodosPageDraw.top}.
 * @param draw - the reads, the key state, the screen size, and the motion instants.
 * @returns the lines, the clamped detail offset, the page size, and whether the frame moves.
 */
export function todosPageFrame(draw: TodosPageDraw): TodosPageFrame {
  const width = Math.max(draw.width, 1)
  const rows = Math.max(draw.rows, 1)
  const { palette, source } = draw
  const fit = (line: string): string => truncateToWidth(line, width, ELLIPSIS)
  const lines = [
    fit(heading(palette, source.tree)),
    fit(draw.notice === undefined ? paintKeys(palette, fitLegend(TODOS_PAGE_HINTS, width)) : palette.warning(draw.notice)),
  ]
  const body = Math.max(rows - HEADER_ROWS, 0)
  const visible = visibleRows(source.tree.nodes, draw.folded)
  const focus = Math.max(visible.findIndex(row => row.node.key === draw.selected), 0)
  const selected = visible[focus]
  let top = 0
  let page = 1
  let treeLines = 0
  let animated = false
  if (selected === undefined) {
    for (const line of wrapTextWithAnsi(TODOS_PAGE_EMPTY, Math.max(width - 2, 1))) lines.push(fit(palette.dim(`  ${line}`)))
  } else if (body > 0) {
    const stacked = width < TODOS_PAGE_STACK_BELOW
    const treeWidth = stacked ? width : clamp(Math.round(width * TREE_SHARE), TREE_MIN_COLUMNS, TREE_MAX_COLUMNS)
    const detailWidth = stacked ? width : width - treeWidth - SEPARATOR_COLUMNS
    const room = stacked ? Math.max(body - STACKED_RULE_ROWS, 0) : body
    const treeRows = stacked
      ? clamp(room - STACKED_MIN_DETAIL_ROWS, 1, Math.min(visible.length, Math.max(Math.floor(room * STACKED_TREE_SHARE), 1)))
      : body
    const tree = treePane(draw, visible, focus, treeWidth, treeRows)
    const detail = detailPane(draw, selected, detailWidth, stacked ? Math.max(room - treeRows, 0) : body)
    top = detail.top
    page = detail.page
    treeLines = tree.lines.length
    animated = tree.animated || detail.animated
    if (stacked) {
      lines.push(...tree.lines, palette.dim('─'.repeat(width)), ...detail.lines)
    } else {
      for (let row = 0; row < body; row += 1) {
        const left = tree.lines[row] ?? ''
        const right = detail.lines[row] ?? ''
        lines.push(`${left}${' '.repeat(treeWidth - visibleWidth(left))} ${palette.dim('│')}${right === '' ? '' : ` ${right}`}`)
      }
    }
  }
  while (lines.length < rows) lines.push('')
  return { lines: lines.slice(0, rows), top, page, treeLines, animated }
}

/**
 * The page that shows the division of work on the alternate screen.
 */
export class TodosPage implements ScreenPage {
  private selected: string | undefined
  private index = 0
  private readonly folded = new Set<string>()
  private readonly placed = new Set<string>()
  private states = new Map<string, WorkState>()
  private readonly unfolded = new Map<string, TodosPageUnfold>()
  private readonly changed = new Map<string, number>()
  private openedAt: number | undefined
  private openingLines: number | undefined
  private top = 0
  private page = 1
  private animated = false
  private notice: string | undefined

  /**
   * @param options - the palette, the reads, the clock, the step, and whether the page moves.
   */
  constructor(private readonly options: TodosPageOptions) {}

  /**
   * Whether the last frame drew a spinner frame or an unsettled motion, so
   * the application keeps its tick running only while the page moves.
   * @returns true while the next tick draws a different frame; always false without motion.
   */
  animates(): boolean {
    return this.animated
  }

  /**
   * Answer one key. Any key takes down the notice the previous key raised.
   * @param data - the raw key bytes.
   * @returns what the application should do, or undefined when the page handled the key itself.
   */
  handleInput(data: string): ScreenPageAction | undefined {
    this.notice = undefined
    if (matchesKey(data, 'escape') || matchesKey(data, 'q') || matchesKey(data, 'ctrl+t')) return { kind: 'close' }
    if (matchesKey(data, 'pageUp')) {
      this.top = Math.max(this.top - this.page, 0)
      return undefined
    }
    if (matchesKey(data, 'pageDown')) {
      this.top += this.page
      return undefined
    }
    const source = this.options.source()
    this.observe(source.tree, this.options.now())
    const rows = visibleRows(source.tree.nodes, this.folded)
    this.select(rows)
    const row = rows[this.index]
    if (row === undefined) return undefined
    if (matchesKey(data, 'enter')) return this.open(source, row)
    const target = this.target(data, rows, row)
    if (target !== undefined) {
      this.index = clamp(target, 0, rows.length - 1)
      this.selected = (rows[this.index] as TreeRow).node.key
      this.top = 0
    }
    return undefined
  }

  /**
   * Draw the page. The first call starts the opening reveal.
   * @param width - the terminal columns.
   * @param rows - the terminal rows; the page returns this many lines.
   * @returns the frame.
   */
  render(width: number, rows: number): string[] {
    const source = this.options.source()
    const now = this.options.now()
    this.observe(source.tree, now)
    this.select(visibleRows(source.tree.nodes, this.folded))
    if (this.options.motion) this.openedAt ??= now
    const frame = todosPageFrame({
      palette: this.options.palette,
      source,
      selected: this.selected,
      folded: this.folded,
      top: this.top,
      notice: this.notice,
      width,
      rows,
      motion: this.openedAt === undefined ? undefined : {
        now,
        stepMs: this.options.stepMs,
        openedAt: this.openedAt,
        openingLines: this.openingLines,
        unfolded: this.unfolded,
        changed: this.changed,
      },
    })
    if (this.openingLines === undefined && frame.treeLines > 0) this.openingLines = frame.treeLines
    this.top = frame.top
    this.page = frame.page
    this.animated = frame.animated
    return frame.lines
  }

  /**
   * Record what the tree holds now: fold a node the first time it has
   * children, by the opening rule, note each state change, and forget the
   * keys the tree no longer has.
   * @param tree - the tree this key or frame reads.
   * @param now - the wall-clock instant a state change is recorded at.
   */
  private observe(tree: WorkTree, now: number): void {
    const states = new Map<string, WorkState>()
    const visit = (nodes: readonly WorkNode[]): void => {
      for (const node of nodes) {
        const last = this.states.get(node.key)
        if (this.options.motion && last !== undefined && last !== node.state) this.changed.set(node.key, now)
        if (node.children.length > 0 && !this.placed.has(node.key)) {
          this.placed.add(node.key)
          if (startsFolded(node)) this.folded.add(node.key)
        }
        states.set(node.key, node.state)
        visit(node.children)
      }
    }
    visit(tree.nodes)
    this.states = states
    for (const keys of [this.folded, this.placed]) {
      for (const key of keys) {
        if (!states.has(key)) keys.delete(key)
      }
    }
    for (const instants of [this.unfolded, this.changed]) {
      for (const key of instants.keys()) {
        if (!states.has(key)) instants.delete(key)
      }
    }
  }

  /**
   * Keep the selection on its node, or on the row now at its old position
   * when the node is no longer visible.
   * @param rows - the visible rows; an empty tree keeps the selection as it was.
   */
  private select(rows: readonly TreeRow[]): void {
    if (rows.length === 0) return
    const found = rows.findIndex(row => row.node.key === this.selected)
    this.index = found === -1 ? clamp(this.index, 0, rows.length - 1) : found
    this.selected = (rows[this.index] as TreeRow).node.key
  }

  /**
   * The row a movement key selects, folding or unfolding on the way.
   * @param data - the raw key bytes.
   * @param rows - the visible rows.
   * @param row - the selected row.
   * @returns the row index to select, which may lie past either end; undefined when the selection stays.
   */
  private target(data: string, rows: readonly TreeRow[], row: TreeRow): number | undefined {
    if (matchesKey(data, 'up') || matchesKey(data, 'k')) return row.index - 1
    if (matchesKey(data, 'down') || matchesKey(data, 'j')) return row.index + 1
    if (matchesKey(data, 'g')) return 0
    if (matchesKey(data, 'shift+g')) return rows.length - 1
    if (matchesKey(data, 'right')) return this.unfold(row)
    return matchesKey(data, 'left') ? this.fold(row) : undefined
  }

  /**
   * Unfold the selected node, or step into it when it is open.
   * @param row - the selected row.
   * @returns the first child's row when the node was already open; undefined otherwise.
   */
  private unfold(row: TreeRow): number | undefined {
    if (row.node.children.length === 0) return undefined
    if (!this.folded.has(row.node.key)) return row.index + 1
    this.folded.delete(row.node.key)
    if (this.options.motion) this.unfolded.set(row.node.key, { at: this.options.now(), children: row.node.children.length })
    return undefined
  }

  /**
   * Fold the selected node, or step out to its parent when it is folded or a leaf.
   * @param row - the selected row.
   * @returns the parent's row when the selection steps out; undefined otherwise.
   */
  private fold(row: TreeRow): number | undefined {
    if (row.node.children.length > 0 && !this.folded.has(row.node.key)) {
      this.folded.add(row.node.key)
      this.unfolded.delete(row.node.key)
      return undefined
    }
    return row.parent?.index
  }

  /**
   * Open the selected node's owner as `/team` does, or say why nothing opens.
   * @param source - the reads of this key.
   * @param row - the selected row.
   * @returns the open action for a running or inactive teammate, otherwise undefined with the notice raised.
   */
  private open(source: TodosPageSource, row: TreeRow): ScreenPageAction | undefined {
    const { node } = row
    const owner = node.owner
    if (owner === undefined) {
      this.notice = `${node.taskId === undefined ? 'this item' : `#${node.taskId}`} has no owner yet`
      return undefined
    }
    const bound = source.tree.nodes.find(candidate => candidate.kind === 'own')?.owner?.id
    if (node.kind === 'own' || row.parent?.node.kind === 'own' || (bound !== undefined && owner.id === bound)) {
      this.notice = `${owner.name} is the session you are in`
      return undefined
    }
    const member = owner.id === undefined ? undefined : source.member(owner.id)
    if (member === undefined) {
      this.notice = `${owner.name} is not on the team roster`
      return undefined
    }
    const entry = teamBrowseRows([member], [])[0]
    if (entry?.choice !== undefined) return { kind: 'open', entry, choice: entry.choice }
    this.notice = unopenable(member)
    return undefined
  }
}

/**
 * Whether a node starts folded the first time it has children: a task that
 * is neither worked on nor stuck. The `own` branch starts open.
 * @param node - the node.
 * @returns true for a task in any other state.
 */
function startsFolded(node: WorkNode): boolean {
  return node.kind === 'task' && node.state !== 'in_progress' && node.state !== 'stuck'
}

/**
 * Keep a number inside a range.
 * @param value - the number.
 * @param low - the smallest allowed value.
 * @param high - the largest allowed value; a range that ends below `low` yields `high`.
 * @returns `value` limited to the range.
 */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/**
 * The heading row: the page name and the counted items by state.
 * @param palette - the palette.
 * @param tree - the tree and its counts.
 * @returns `todos · <delivered>/<total> delivered`, then each of the in-progress, stuck, and deferred counts that is not zero.
 */
function heading(palette: Palette, tree: WorkTree): string {
  const facts = [`${String(tree.counts.delivered)}/${String(tree.total)} delivered`]
  for (const state of ['in_progress', 'stuck', 'deferred'] as const) {
    if (tree.counts[state] > 0) facts.push(`${String(tree.counts[state])} ${STATE_WORD[state]}`)
  }
  return `${palette.bold(palette.accent('todos'))} ${palette.dim(`· ${facts.join(' · ')}`)}`
}

/**
 * The rows the tree shows: every top-level node, and the children of each
 * node that is not folded.
 * @param nodes - the top-level nodes.
 * @param folded - keys of the nodes whose children are hidden.
 * @returns the rows in drawing order.
 */
function visibleRows(nodes: readonly WorkNode[], folded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const visit = (list: readonly WorkNode[], depth: number, parent: TreeRow | undefined): void => {
    for (const [sibling, node] of list.entries()) {
      const row: TreeRow = { node, index: rows.length, depth, sibling, parent }
      rows.push(row)
      if (node.children.length > 0 && !folded.has(node.key)) visit(node.children, depth + 1, row)
    }
  }
  visit(nodes, 0, undefined)
  return rows
}

/**
 * The slice of a list a pane shows around one item.
 *
 * A list that fits shows every item. A longer list keeps `focus` in view and
 * gives a row to the count of the items it leaves out on each side that has
 * any, so near either end only one count row is spent.
 * @param total - items in the list.
 * @param rows - rows the pane has; at least 1.
 * @param focus - the item to keep in view.
 * @returns the first shown item and how many are shown.
 */
function focusSlice(total: number, rows: number, focus: number): Slice {
  if (total <= rows) return { start: 0, count: total }
  const end = Math.max(rows - 1, 1)
  if (focus < end) return { start: 0, count: end }
  if (focus >= total - end) return { start: total - end, count: end }
  const count = Math.max(rows - 2, 1)
  return { start: clamp(focus - Math.floor(count / 2), 1, total - count - 1), count }
}

/**
 * The slice of a list a pane shows from one offset, the offset clamped so the
 * last screen ends on the last item.
 * @param total - items in the list.
 * @param rows - rows the pane has; at least 1.
 * @param top - how many items the pane is scrolled down.
 * @returns the first shown item and how many are shown.
 */
function scrollSlice(total: number, rows: number, top: number): Slice {
  if (total <= rows) return { start: 0, count: total }
  const start = clamp(top, 0, total - Math.max(rows - 1, 1))
  const room = Math.max(rows - (start > 0 ? 1 : 0), 1)
  return { start, count: start + room >= total ? total - start : Math.max(room - 1, 1) }
}

/**
 * The lines of a pane: the shown items with a count row on each side that
 * leaves items out, while the pane has a row to spare for it.
 * @param items - the whole list.
 * @param slice - the items shown.
 * @param rows - rows the pane has.
 * @returns at most `rows` lines when `rows` is at least 1.
 */
function paneLines<T>(items: readonly T[], slice: Slice, rows: number): PaneLine<T>[] {
  const lines: PaneLine<T>[] = []
  let spare = rows - slice.count
  if (slice.start > 0 && spare > 0) {
    lines.push({ kind: 'more', hidden: slice.start, above: true })
    spare -= 1
  }
  for (const item of items.slice(slice.start, slice.start + slice.count)) lines.push({ kind: 'item', item })
  const below = items.length - slice.start - slice.count
  if (below > 0 && spare > 0) lines.push({ kind: 'more', hidden: below, above: false })
  return lines
}

/**
 * The count row of a pane cut short.
 * @param palette - the palette.
 * @param line - how many items are left out and on which side.
 * @param indent - what the row starts with.
 * @returns `+<n> more above` or `+<n> more`, dim.
 */
function moreLine(palette: Palette, line: { hidden: number; above: boolean }, indent: string): Line {
  return [{ text: `${indent}+${String(line.hidden)} more${line.above ? ' above' : ''}`, style: palette.dim }]
}

/**
 * The text of a line with every run in its own style.
 * @param line - the runs.
 * @returns the styled text.
 */
function styledText(line: Line): string {
  return line.map(run => run.style(run.text)).join('')
}

/**
 * The text of a line without any style.
 * @param line - the runs.
 * @returns the bare characters.
 */
function bareText(line: Line): string {
  return line.map(run => run.text).join('')
}

/**
 * Draw one line at a motion level: settled in its own styles, or lifted as
 * one run so the lift reads across the whole line.
 * @param palette - the palette.
 * @param line - the runs.
 * @param width - the columns the line fits.
 * @param level - how far above its settled drawing the line is lifted.
 * @returns the drawn line.
 */
function drawLine(palette: Palette, line: Line, width: number, level: MotionLevel): string {
  if (level === 0) return truncateToWidth(styledText(line), width, ELLIPSIS)
  return pulse(palette, truncateToWidth(bareText(line), width, ELLIPSIS), level)
}

/**
 * The step at which one of a group's items reveals: the items share
 * {@link TODOS_PAGE_REVEAL_STEPS} steps, several per step in a long group,
 * and an item past `count` arrives at the last step.
 * @param position - the item's position in the group.
 * @param count - the items the group had when its reveal started.
 * @returns the step, from 0 to one less than {@link TODOS_PAGE_REVEAL_STEPS}.
 */
function revealStep(position: number, count: number): number {
  const perStep = Math.max(Math.ceil(count / TODOS_PAGE_REVEAL_STEPS), 1)
  return Math.min(Math.floor(position / perStep), TODOS_PAGE_REVEAL_STEPS - 1)
}

/**
 * The lift a motion that started at one instant draws now.
 * @param motion - the instants of the frame.
 * @param at - when the motion started; undefined for no motion.
 * @param ticks - how many steps the motion lasts.
 * @returns the level of the three-step ramp, `0` once it settled.
 */
function liftAt(motion: TodosPageMotion, at: number | undefined, ticks: number): MotionLevel {
  if (at === undefined) return 0
  return new Motion({ startedAt: at, ticks, stepMs: motion.stepMs, now: () => motion.now }).level()
}

/**
 * The highest of several lift levels.
 * @param levels - the levels.
 * @returns the highest, `0` when every one settled.
 */
function highest(levels: readonly MotionLevel[]): MotionLevel {
  return levels.reduce<MotionLevel>((high, level) => (level > high ? level : high), 0)
}

/**
 * How one tree line is drawn now.
 * @param motion - the instants of the frame; undefined draws it settled.
 * @param opening - when the line reveals in the opening reveal.
 * @param row - the row the line draws; undefined for a count row.
 * @returns undefined while the line is not revealed yet, otherwise its lift level.
 */
function treeLook(motion: TodosPageMotion | undefined, opening: number, row: TreeRow | undefined): MotionLevel | undefined {
  if (motion === undefined) return 0
  const parent = row?.parent
  const unfolded = parent === undefined ? undefined : motion.unfolded.get(parent.node.key)
  const unfold = row === undefined || unfolded === undefined
    ? undefined
    : unfolded.at + revealStep(row.sibling, unfolded.children) * motion.stepMs
  if (motion.now < opening || (unfold !== undefined && motion.now < unfold)) return undefined
  const changed = row === undefined ? undefined : motion.changed.get(row.node.key)
  return highest([
    liftAt(motion, opening, TODOS_PAGE_REVEAL_LIFT_TICKS),
    liftAt(motion, unfold, TODOS_PAGE_REVEAL_LIFT_TICKS),
    liftAt(motion, changed, TODOS_PAGE_CHANGE_LIFT_TICKS),
  ])
}

/**
 * The tree pane of one frame.
 * @param draw - the frame being drawn.
 * @param visible - the visible rows.
 * @param focus - the selected row.
 * @param width - the pane's columns.
 * @param rows - the pane's rows; at least 1.
 * @returns the lines and whether one moves.
 */
function treePane(draw: TodosPageDraw, visible: readonly TreeRow[], focus: number, width: number, rows: number): Pane {
  const { palette, motion } = draw
  const shown = paneLines(visible, focusSlice(visible.length, rows, focus), rows)
  const opening = (position: number): number => motion === undefined
    ? 0
    : motion.openedAt + revealStep(position, motion.openingLines ?? shown.length) * motion.stepMs
  let animated = false
  const lines = shown.map((entry, position) => {
    const row = entry.kind === 'item' ? entry.item : undefined
    const look = treeLook(motion, opening(position), row)
    if (look === undefined) {
      animated = true
      return ''
    }
    if (look > 0) animated = true
    if (entry.kind === 'more') return drawLine(palette, moreLine(palette, entry, BLANK_CELL), width, look)
    const frame = motion !== undefined && entry.item.node.state === 'in_progress' ? draw.source.spinner(entry.item.index) : undefined
    if (frame !== undefined) animated = true
    return drawLine(palette, treeLine(palette, entry.item, entry.item.index === focus, draw.folded, frame, width), width, look)
  })
  return { lines, animated }
}

/**
 * One tree row as runs: the selection marker, the indent, the fold marker,
 * the state glyph, the title, and the `<done>/<n>` count of its children
 * while the title keeps all of itself or {@link MIN_TITLE_COLUMNS} beside it.
 * @param palette - the palette.
 * @param row - the row.
 * @param picked - whether the row is selected.
 * @param folded - keys of the folded nodes.
 * @param frame - the spinner frame a worked row draws in place of its glyph.
 * @param width - the pane's columns.
 * @returns the runs, together no wider than `width` once the lead fits.
 */
function treeLine(
  palette: Palette,
  row: TreeRow,
  picked: boolean,
  folded: ReadonlySet<string>,
  frame: string | undefined,
  width: number,
): Line {
  const { node } = row
  const branch = node.children.length > 0
  const lead: Run[] = [
    picked ? { text: SELECTED_MARK, style: palette.accent } : { text: BLANK_CELL, style: unstyled },
    { text: ' '.repeat(row.depth * INDENT_COLUMNS), style: unstyled },
    { text: branch ? (folded.has(node.key) ? FOLDED_MARK : OPEN_MARK) : BLANK_CELL, style: palette.dim },
    { text: frame ?? WORK_GLYPH[node.state], style: palette[STATE_ROLE[node.state]] },
    { text: ' ', style: unstyled },
  ]
  const room = Math.max(width - visibleWidth(bareText(lead)), 0)
  const text = oneLine(treeTitle(node))
  const count = branch ? `${node.kind === 'own' ? ' · ' : '  '}${progress(node)}` : ''
  const counted = count !== '' && room - visibleWidth(count) >= Math.min(visibleWidth(text), MIN_TITLE_COLUMNS)
  const base = titleStyle(palette, node)
  const title: Run = {
    text: truncateToWidth(text, counted ? room - visibleWidth(count) : room, ELLIPSIS),
    style: picked ? styled => palette.bold(palette.accent(base(styled))) : base,
  }
  return counted ? [...lead, title, { text: count, style: palette.dim }] : [...lead, title]
}

/**
 * The style a node's title settles in.
 * @param palette - the palette.
 * @param node - the node.
 * @returns a delivered todo scratched out and dim, as the activity board draws
 * it; a delivered task dim; the `own` branch bold; any other title unstyled.
 */
function titleStyle(palette: Palette, node: WorkNode): Style {
  if (node.state === 'delivered') return node.kind === 'todo' ? text => palette.dim(palette.strikethrough(text)) : palette.dim
  return node.kind === 'own' ? palette.bold : unstyled
}

/**
 * A node's title as the tree and the detail name it.
 * @param node - the node.
 * @returns `#<taskId> <subject>` for a task, the title otherwise.
 */
function treeTitle(node: WorkNode): string {
  return node.taskId === undefined ? node.title : `#${node.taskId} ${node.title}`
}

/**
 * How many of a node's children are delivered.
 * @param node - the node.
 * @returns `<done>/<n>`.
 */
function progress(node: WorkNode): string {
  const done = node.children.filter(child => child.state === 'delivered').length
  return `${String(done)}/${String(node.children.length)}`
}

/**
 * Text on one line.
 * @param text - the text.
 * @returns every run of whitespace, line breaks included, collapsed to one space.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ')
}

/**
 * The detail pane of one frame.
 * @param draw - the frame being drawn.
 * @param row - the selected row.
 * @param width - the pane's columns.
 * @param rows - the pane's rows.
 * @returns the lines, the clamped scroll offset, the page size, and whether the pane moves.
 */
function detailPane(draw: TodosPageDraw, row: TreeRow, width: number, rows: number): Pane & { top: number; page: number } {
  const { palette, motion } = draw
  const content = detailLines(palette, row.node, draw.source.tree, width)
  const slice = scrollSlice(content.length, Math.max(rows, 1), draw.top)
  const shown = rows === 0 ? [] : paneLines(content, slice, rows)
  const faded = motion !== undefined && motion.now < motion.openedAt + TODOS_PAGE_DETAIL_FADE_STEPS * motion.stepMs
  const lines = shown.map((entry) => {
    const line = entry.kind === 'more' ? moreLine(palette, entry, '') : entry.item
    return faded ? palette.dim(truncateToWidth(bareText(line), width, ELLIPSIS)) : drawLine(palette, line, width, 0)
  })
  return { lines, top: slice.start, page: Math.max(rows - 2, 1), animated: faded && shown.length > 0 }
}

/**
 * Every detail line of one node, before scrolling: the title, the owner, and
 * the state; then each block the node has, after a blank line: its subtasks,
 * the tasks it waits on, the tasks it blocks, its write scopes, the owner's
 * narration, its description, and the turns a todo of the bound session's
 * list was written and last changed in.
 * @param palette - the palette.
 * @param node - the selected node.
 * @param tree - the whole tree, which names the tasks a node waits on or blocks.
 * @param width - the pane's columns.
 * @returns the lines as runs; a blank line is an empty run list.
 */
function detailLines(palette: Palette, node: WorkNode, tree: WorkTree, width: number): Line[] {
  const blocks: Line[][] = [[
    ...wrapped(treeTitle(node), width, palette.bold, ''),
    [{ text: 'owner  ', style: palette.dim }, ownerRun(palette, node.owner)],
    [{ text: 'state  ', style: palette.dim }, ...stateRuns(palette, node)],
  ]]
  if (node.children.length > 0) {
    blocks.push([
      [{ text: 'Subtasks', style: palette.heading }, { text: ` ${progress(node)}`, style: palette.dim }],
      ...node.children.map(child => itemLine(palette, child)),
    ])
  }
  const subjects = new Map(tree.nodes.flatMap(task => task.taskId === undefined ? [] : [[task.taskId, task.title] as const]))
  for (const [title, ids] of [['Waits on', node.waitsOn ?? []], ['Blocks', node.blocks ?? []]] as const) {
    if (ids.length === 0) continue
    blocks.push([
      [{ text: title, style: palette.heading }],
      ...ids.map((id): Line => [
        { text: '  ', style: unstyled },
        { text: `#${id}`, style: palette.dim },
        { text: oneLine(` ${subjects.get(id) ?? ''}`).trimEnd(), style: unstyled },
      ]),
    ])
  }
  const scopes = node.writeScopes ?? []
  if (scopes.length > 0) {
    blocks.push([[{ text: 'Scopes', style: palette.heading }], ...scopes.map((scope): Line => [{ text: `  ${scope}`, style: unstyled }])])
  }
  const note = node.note?.trim() ?? ''
  if (note !== '') blocks.push([[{ text: 'Now', style: palette.heading }], ...wrapped(`“${note}”`, width, unstyled, '  ')])
  const description = node.description?.trim() ?? ''
  if (description !== '') blocks.push(wrapped(description, width, palette.dim, ''))
  if (node.turns !== undefined) blocks.push(turnLines(palette, node.turns))
  return blocks.flatMap((block, index) => (index === 0 ? block : [[], ...block]))
}

/**
 * Text wrapped to a pane, one single-run line per wrapped line.
 * @param text - the text; line breaks start new lines.
 * @param width - the pane's columns.
 * @param style - the style every line settles in.
 * @param indent - what each line starts with.
 * @returns the lines.
 */
function wrapped(text: string, width: number, style: Style, indent: string): Line[] {
  return wrapTextWithAnsi(text, Math.max(width - indent.length, 1)).map(line => [{ text: `${indent}${line}`, style }])
}

/**
 * Who answers for a node.
 * @param palette - the palette.
 * @param owner - the node's owner, if it has one.
 * @returns `<name> · <role> · <status>`, the status omitted when the roster does not list the owner, or a dim `unowned`.
 */
function ownerRun(palette: Palette, owner: WorkOwner | undefined): Run {
  if (owner === undefined) return { text: UNOWNED, style: palette.dim }
  const facts = [owner.name, oneLine(owner.role)]
  if (owner.status !== undefined) facts.push(owner.status)
  return { text: facts.join(' · '), style: unstyled }
}

/**
 * A node's state with its reason spelled out.
 * @param palette - the palette.
 * @param node - the node.
 * @returns the state word in its state's color, then ` · <reason>` dim when the node has one.
 */
function stateRuns(palette: Palette, node: WorkNode): Run[] {
  const word: Run = { text: STATE_WORD[node.state], style: palette[STATE_ROLE[node.state]] }
  if (node.reason === undefined) return [word]
  const ids = node.waitsOn ?? []
  const reason = node.reason === 'blocked' && ids.length > 0
    ? `waits on ${ids.map(id => `#${id}`).join(', ')}`
    : REASON_TEXT[node.reason]
  return [word, { text: ` · ${reason}`, style: palette.dim }]
}

/**
 * One child of the selected node as a detail line.
 * @param palette - the palette.
 * @param child - the child.
 * @returns the state glyph and the title on one line.
 */
function itemLine(palette: Palette, child: WorkNode): Line {
  return [
    { text: '  ', style: unstyled },
    { text: WORK_GLYPH[child.state], style: palette[STATE_ROLE[child.state]] },
    { text: ' ', style: unstyled },
    { text: oneLine(child.title), style: titleStyle(palette, child) },
  ]
}

/**
 * The turns a todo of the bound session's list was written and last changed
 * in, worded as the todo picker words them.
 * @param palette - the palette.
 * @param turns - the turn facts.
 * @returns the appearance line, then the status line when the turns differ.
 */
function turnLines(palette: Palette, turns: TodoTransition): Line[] {
  const lines: Line[] = [[{ text: `first written in turn ${String(turns.firstTurn)}`, style: palette.dim }]]
  if (turns.statusTurn !== turns.firstTurn) {
    lines.push([{ text: `status last changed in turn ${String(turns.statusTurn)}`, style: palette.dim }])
  }
  return lines
}
