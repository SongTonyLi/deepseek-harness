/**
 * The `/context` report: how the bound session's context window splits
 * across the system prompt, tool definitions, instruction files, skills,
 * other injected context, and the conversation, drawn as a grid of cells
 * beside a legend.
 *
 * {@link contextUsage} joins the token meter's per-node prices with the
 * transcript's surface mirror (`./compaction.ts`), so no historical event is
 * read again. The cells holding tokens the newest turn added are the hot
 * region. {@link ContextUsageBlock} fills the grid on open, sweeps a shimmer
 * through the hot region, blinks the first free cell, and re-reads the usage
 * while a turn runs; it then settles on the drawing
 * {@link contextUsageLines} returns at rest, which is also all a terminal
 * without motion draws. Every frame of one block at one width has the same
 * line count.
 * @module @deepseek-ai/dsh-tui-app/context-usage
 */

import { truncateToWidth, type Component } from '@earendil-works/pi-tui'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SurfaceNode } from './compaction.ts'
import type { RegisteredFade } from './fade.ts'
import type { Palette, Style } from './style.ts'
import { formatTokens } from './transcript.ts'

/** What a share of the context window holds, in legend order. */
export type ContextCategoryId = 'system' | 'tools' | 'instructions' | 'skills' | 'context' | 'messages'

/** Every category, in the order the grid fills and the legend lists them. */
export const CONTEXT_CATEGORIES: readonly ContextCategoryId[] = ['system', 'tools', 'instructions', 'skills', 'context', 'messages']

/** The legend label of each category. */
const CATEGORY_LABEL: Readonly<Record<ContextCategoryId, string>> = {
  system: 'System prompt',
  tools: 'System tools',
  instructions: 'Instructions',
  skills: 'Skills',
  context: 'Injected context',
  messages: 'Messages',
}

/** One category's estimated tokens. */
export interface ContextCategory {
  readonly id: ContextCategoryId
  /** Estimated tokens on the current surface, or in the tool definitions for `tools`. */
  readonly tokens: number
  /** The part of {@link ContextCategory.tokens} the newest turn added. */
  readonly hotTokens: number
}

/** One read of how the context window is used. */
export interface ContextUsage {
  /** The `provider/model` the next request uses. */
  readonly model: string
  /** Tokens the next request's prompt would cost; the category sum when no provider sample exists. */
  readonly used: number
  /** The route's context window; absent until a model request recorded one. */
  readonly window?: number
  /** The turn the hot tokens belong to; `0` before the first turn. */
  readonly turn: number
  /** Every category in {@link CONTEXT_CATEGORIES} order, zero-token ones included. */
  readonly categories: readonly ContextCategory[]
}

/** One priced surface node, as `ctx.tokenMeter.measure()` reports it. */
export interface PricedNode {
  readonly seq: SessionSeq
  readonly tokens: number
}

/** What {@link contextUsage} joins. */
export interface ContextUsageInput {
  readonly model: string
  /** The transcript's current turn. */
  readonly turn: number
  /** The measured surface nodes. */
  readonly priced: readonly PricedNode[]
  /** The transcript's surface mirror, which names each node. */
  readonly surface: readonly SurfaceNode[]
  /** Estimated tokens of the tool definitions the latest request header carries. */
  readonly toolsTokens: number
  /** Context occupancy from the `contextPressure` projection, when it has one. */
  readonly used?: number
  readonly window?: number
}

/**
 * Attribute every priced node to a category and to the hot region.
 * @param input - the measurement, the surface mirror, and the occupancy facts.
 * @returns the usage; a node the mirror does not name counts as `messages`.
 */
export function contextUsage(input: ContextUsageInput): ContextUsage {
  const named = new Map(input.surface.map(node => [node.seq, node]))
  const tokens = new Map<ContextCategoryId, number>()
  const hot = new Map<ContextCategoryId, number>()
  tokens.set('tools', input.toolsTokens)
  for (const { seq, tokens: price } of input.priced) {
    const node = named.get(seq)
    const id = categoryOf(node)
    tokens.set(id, (tokens.get(id) ?? 0) + price)
    const fact = node?.fact
    if (input.turn > 0 && fact !== undefined && fact.kind !== 'system' && fact.turn === input.turn) {
      hot.set(id, (hot.get(id) ?? 0) + price)
    }
  }
  const categories = CONTEXT_CATEGORIES.map(id => ({ id, tokens: tokens.get(id) ?? 0, hotTokens: hot.get(id) ?? 0 }))
  const total = categories.reduce((sum, category) => sum + category.tokens, 0)
  return {
    model: input.model,
    used: input.used ?? total,
    ...input.window === undefined ? {} : { window: input.window },
    turn: input.turn,
    categories,
  }
}

/**
 * The category one mirrored node belongs to.
 * @param node - the node, or undefined when the mirror does not hold it.
 * @returns the category.
 */
function categoryOf(node: SurfaceNode | undefined): ContextCategoryId {
  if (node === undefined) return 'messages'
  const { fact } = node
  switch (fact.kind) {
    case 'system':
      return 'system'
    case 'context':
      return node.group ?? 'context'
    case 'prompt':
    case 'summary':
    case 'reply':
    case 'result':
    case 'developer':
      return 'messages'
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(fact, 'surface fact')
  }
}

/** Cells the grid divides the context window into. */
export const GRID_CELLS = 200

/** Cells per grid row when the width allows; narrower widths draw half as many. */
const WIDE_GRID_COLUMNS = 20

/** Columns between the grid and the legend. */
const LEGEND_GAP = 3

/**
 * Columns kept for the legend beside the grid. The layout depends on this
 * reserve rather than on the legend's own width, so a live re-read whose
 * numbers grow never moves the legend under the grid.
 */
const LEGEND_COLUMNS = 36

/** A used cell. */
const FULL_GLYPH = '⛁'
/** A free cell. */
const FREE_GLYPH = '⛶'
/** The hot-region marker in the legend. */
const HOT_GLYPH = '▲'

/** One grid cell: the category it shows, or undefined for free space. */
export type GridCell = { readonly category: ContextCategoryId; readonly hot: boolean } | undefined

/**
 * Lay the usage out on {@link GRID_CELLS} cells: the used share of the
 * window split across the categories by their estimates, each category's hot
 * cells at its own end, then free space. A nonzero category always gets a
 * cell. Without a known window the categories share every cell.
 * @param usage - one read of the usage.
 * @returns the cells in fill order.
 */
export function gridCells(usage: ContextUsage): GridCell[] {
  const used = usage.categories.filter(category => category.tokens > 0)
  const share = usage.window === undefined
    ? GRID_CELLS
    : Math.round(Math.min(1, usage.used / usage.window) * GRID_CELLS)
  const cells: GridCell[] = []
  const target = used.length === 0 ? 0 : Math.min(GRID_CELLS, Math.max(share, used.length))
  for (const { category, count } of allocate(used, target)) {
    const hot = category.hotTokens === 0 ? 0 : Math.min(count, Math.max(1, Math.round(count * category.hotTokens / category.tokens)))
    for (let cell = 0; cell < count; cell++) cells.push({ category: category.id, hot: cell >= count - hot })
  }
  while (cells.length < GRID_CELLS) cells.push(undefined)
  return cells
}

/**
 * Split `target` cells across categories by tokens with the largest-remainder
 * rule, giving each category at least one cell.
 * @param categories - the categories with tokens, in fill order.
 * @param target - the cells to hand out; at least one per category, and 0 for none.
 * @returns one count per category, in the same order, summing to `target`.
 */
function allocate(categories: readonly ContextCategory[], target: number): { readonly category: ContextCategory; count: number }[] {
  const sum = categories.reduce((total, category) => total + category.tokens, 0)
  const shares = categories.map((category, index) => {
    const exact = category.tokens / sum * target
    return { category, index, count: Math.max(1, Math.floor(exact)), remainder: exact - Math.floor(exact) }
  })
  let left = target - shares.reduce((total, entry) => total + entry.count, 0)
  const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  while (left > 0) {
    for (const entry of byRemainder.slice(0, left)) entry.count++
    left = target - shares.reduce((total, entry) => total + entry.count, 0)
  }
  while (left < 0) {
    const largest = shares.reduce((most, entry) => entry.count > most.count ? entry : most)
    largest.count--
    left++
  }
  return shares
}

/** What one animation frame changes about the resting drawing. */
export interface ContextUsageFrame {
  /** Share of the used cells drawn so far, from 0 to 1. */
  readonly fill: number
  /** Steps the hot-region shimmer has taken; undefined draws the hot region at rest. */
  readonly wave?: number
  /** Whether the first free cell, where the next tokens land, is lit. */
  readonly frontier: boolean
  /** Whether the block is re-reading the usage while a turn runs. */
  readonly live: boolean
}

/** The resting drawing: every cell filled, no shimmer, no lit frontier. */
export const AT_REST: ContextUsageFrame = { fill: 1, frontier: false, live: false }

/** Hot cells the shimmer's head travels past the region's end before it starts over. */
const WAVE_TRAIL = 6

/**
 * Draw the report.
 * @param usage - one read of the usage.
 * @param palette - the terminal palette.
 * @param width - the columns the block lays out in.
 * @param frame - the animation frame; defaults to {@link AT_REST}.
 * @returns the lines, each at most `width` columns, as many for every frame
 * and usage at one width.
 */
export function contextUsageLines(usage: ContextUsage, palette: Palette, width: number, frame: ContextUsageFrame = AT_REST): string[] {
  const columns = width >= gridWidth(WIDE_GRID_COLUMNS) ? WIDE_GRID_COLUMNS : WIDE_GRID_COLUMNS / 2
  const grid = gridRows(gridCells(usage), columns, palette, frame)
  const legend = legendRows(usage, palette, frame)
  const left = gridWidth(columns)
  // Beside the legend the grid draws its wide rows, fewer than the legend has.
  const body = width >= left + LEGEND_GAP + LEGEND_COLUMNS
    ? legend.map((entry, row) => {
      const cells = grid[row] ?? ' '.repeat(left)
      return entry === '' ? cells : `${cells}${' '.repeat(LEGEND_GAP)}${entry}`
    })
    : [...grid, '', ...legend]
  return ['', palette.bold('Context usage'), ...body, ''].map(line => truncateToWidth(line, width, '…'))
}

/**
 * Columns one grid row takes.
 * @param columns - cells per row.
 * @returns the width, one space between each two cells.
 */
function gridWidth(columns: number): number {
  return columns * 2 - 1
}

/**
 * The grid rows of one frame.
 * @param cells - the laid-out cells.
 * @param columns - cells per row.
 * @param palette - the terminal palette.
 * @param frame - the animation frame.
 * @returns the rows.
 */
function gridRows(cells: readonly GridCell[], columns: number, palette: Palette, frame: ContextUsageFrame): string[] {
  const usedCount = cells.filter(cell => cell !== undefined).length
  const hotCount = cells.filter(cell => cell?.hot === true).length
  const filled = Math.ceil(Math.min(1, Math.max(0, frame.fill)) * usedCount)
  const head = frame.wave === undefined || hotCount === 0 ? undefined : frame.wave % (hotCount + WAVE_TRAIL)
  const drawn: string[] = []
  let used = 0
  let hot = 0
  for (const [index, cell] of cells.entries()) {
    if (cell === undefined || used >= filled) {
      const lit = frame.frontier && index === usedCount && filled === usedCount
      drawn.push(lit ? palette.bold(palette.accent(FREE_GLYPH)) : palette.dim(FREE_GLYPH))
      if (cell !== undefined) used++
      continue
    }
    used++
    const color = categoryStyle(palette, cell.category)
    if (!cell.hot) {
      drawn.push(color(FULL_GLYPH))
      continue
    }
    drawn.push(hotCell(palette, color, head === undefined ? undefined : head - hot))
    hot++
  }
  const rows: string[] = []
  for (let start = 0; start < drawn.length; start += columns) rows.push(drawn.slice(start, start + columns).join(' '))
  return rows
}

/**
 * One hot cell: bold at rest; under the shimmer, inverse at the head, bold
 * in the two cells behind it, and plain elsewhere, so a bright band sweeps
 * through the region.
 * @param palette - the terminal palette.
 * @param color - the cell's category color.
 * @param behind - how many cells the shimmer's head is past this cell; undefined at rest.
 * @returns the drawn cell.
 */
function hotCell(palette: Palette, color: Style, behind: number | undefined): string {
  if (behind === undefined) return palette.bold(color(FULL_GLYPH))
  if (behind === 0) return palette.inverse(palette.bold(color(FULL_GLYPH)))
  if (behind === 1 || behind === 2) return palette.bold(color(FULL_GLYPH))
  return color(FULL_GLYPH)
}

/**
 * The legend rows: the model, the occupancy, the hot region, then one row per
 * category and the free space. The row count never depends on the usage.
 * @param usage - one read of the usage.
 * @param palette - the terminal palette.
 * @param frame - the animation frame, which marks a live read.
 * @returns the rows.
 */
function legendRows(usage: ContextUsage, palette: Palette, frame: ContextUsageFrame): string[] {
  const { window, used } = usage
  const occupancy = window === undefined
    ? `${formatTokens(used)} tokens · window not reported yet`
    : `${formatTokens(used)}/${formatTokens(window)} tokens (${percent(used / window, true)})`
  const share = (tokens: number): string => {
    const base = window ?? usage.categories.reduce((sum, category) => sum + category.tokens, 0)
    return base > 0 ? ` (${percent(tokens / base, false)})` : ''
  }
  const rows = [
    palette.bold(usage.model),
    occupancy,
    hotRow(usage, palette, frame),
    '',
    palette.dim(palette.italic('Estimated usage by category')),
    ...usage.categories.map(category =>
      `${categoryStyle(palette, category.id)(FULL_GLYPH)} ${CATEGORY_LABEL[category.id]}: ${formatTokens(category.tokens)} tokens${share(category.tokens)}`),
  ]
  rows.push(window === undefined
    ? `${palette.dim(FREE_GLYPH)} Free space: unknown`
    : `${palette.dim(FREE_GLYPH)} Free space: ${formatTokens(Math.max(0, window - used))}${share(Math.max(0, window - used))}`)
  return rows
}

/**
 * The hot-region row.
 * @param usage - one read of the usage.
 * @param palette - the terminal palette.
 * @param frame - the animation frame.
 * @returns e.g. `▲ hot: +2.1k tokens in turn 3 · live`.
 */
function hotRow(usage: ContextUsage, palette: Palette, frame: ContextUsageFrame): string {
  const live = frame.live ? palette.dim(' · live') : ''
  if (usage.turn === 0) return palette.dim(`${HOT_GLYPH} hot: no turn yet`) + live
  const tokens = usage.categories.reduce((sum, category) => sum + category.hotTokens, 0)
  if (tokens === 0) return palette.dim(`${HOT_GLYPH} hot: nothing added in turn ${String(usage.turn)}`) + live
  return `${palette.bold(palette.error(HOT_GLYPH))} hot: +${formatTokens(tokens)} tokens in turn ${String(usage.turn)}${live}`
}

/**
 * The color one category draws in.
 * @param palette - the terminal palette.
 * @param id - the category.
 * @returns its style.
 */
function categoryStyle(palette: Palette, id: ContextCategoryId): Style {
  switch (id) {
    case 'system':
      return palette.hue.blue
    case 'tools':
      return palette.hue.cyan
    case 'instructions':
      return palette.hue.orange
    case 'skills':
      return palette.hue.yellow
    case 'context':
      return palette.hue.green
    case 'messages':
      return palette.hue.magenta
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(id, 'context category')
  }
}

/**
 * A ratio as a percentage to one decimal, dropping a trailing `.0` from 10% up.
 * @param ratio - the share, from 0.
 * @param whole - round to a whole number, as the occupancy does.
 * @returns e.g. `0.0%`, `0.2%`, `98.8%`, `100%`.
 */
function percent(ratio: number, whole: boolean): string {
  const value = ratio * 100
  if (whole) return `${String(Math.round(value))}%`
  const tenths = Math.round(value * 10) / 10
  return tenths >= 10 && Number.isInteger(tenths) ? `${String(tenths)}%` : `${tenths.toFixed(1)}%`
}

/** Milliseconds the grid takes to fill on open. */
const FILL_MS = 480

/** Milliseconds the hot region shimmers after open before a settled turn lets the block rest. */
const SHIMMER_MS = 3200

/** Milliseconds per shimmer step. */
const WAVE_STEP_MS = 70

/** Milliseconds the first free cell stays lit, then dark, while live. */
const BLINK_MS = 400

/** Milliseconds between re-reads of the usage. */
const REFRESH_MS = 250

/** What one {@link ContextUsageBlock} reads and animates with. */
export interface ContextUsageBlockOptions {
  /**
   * Read the usage now.
   * @returns the bound session's current usage.
   */
  readonly read: () => ContextUsage
  /**
   * Whether a turn is running, which keeps the block re-reading.
   * @returns true while the bound session runs a turn.
   */
  readonly live: () => boolean
  /**
   * The wall clock; absent draws the resting report and never animates.
   * @returns the current time in milliseconds.
   */
  readonly now?: () => number
}

/** The inputs and output of the last render, which a render with equal inputs returns again. */
interface RenderMemo {
  readonly width: number
  readonly usage: ContextUsage
  readonly frame: ContextUsageFrame
  readonly floor: number
  readonly lines: string[]
}

/**
 * The `/context` transcript block. While it moves it is a
 * {@link RegisteredFade}: the application calls {@link ContextUsageBlock.tick}
 * on each fade period, and it settles once the open animation ran and no
 * turn runs, when it is retired, or once every row left the repaint window.
 * Rows above the repaint floor keep the text last drawn there.
 */
export class ContextUsageBlock implements Component, RegisteredFade {
  private usage: ContextUsage
  private frame: ContextUsageFrame
  private readonly bornAt: number
  private refreshedAt: number
  private settled: boolean
  private floor = 0
  private shown: { readonly width: number; readonly lines: readonly string[] } | undefined
  private memo: RenderMemo | undefined

  /**
   * @param palette - the terminal palette.
   * @param options - the usage reader, the live check, and the clock.
   */
  constructor(private readonly palette: Palette, private readonly options: ContextUsageBlockOptions) {
    this.usage = options.read()
    const now = options.now?.()
    this.bornAt = now ?? 0
    this.refreshedAt = this.bornAt
    this.settled = now === undefined
    this.frame = this.settled ? AT_REST : frameAt(0, options.live())
  }

  /** @returns true until the block settled. */
  needsRepaint(): boolean {
    return !this.settled
  }

  /** Advance one fade period: re-read the usage when it is due, then move the animation or settle. */
  tick(): void {
    const clock = this.options.now
    if (this.settled || clock === undefined) return
    const now = clock()
    const live = this.options.live()
    if (!live && now - this.bornAt >= SHIMMER_MS) {
      this.usage = this.options.read()
      this.rest()
      return
    }
    if (now - this.refreshedAt >= REFRESH_MS) {
      this.usage = this.options.read()
      this.refreshedAt = now
    }
    const next = frameAt(now - this.bornAt, live)
    if (frameKey(next) !== frameKey(this.frame)) this.frame = next
  }

  /** Settle on the last read without reading again, for a session switch or a newer `/context`. */
  retire(): void {
    this.rest()
  }

  /**
   * Hold the rows the renderer can no longer repaint.
   * @param floor - the first block line the renderer may repaint.
   */
  setRepaintFloor(floor: number): void {
    this.floor = floor
    if (this.shown !== undefined && floor >= this.shown.lines.length) this.rest()
  }

  invalidate(): void {
    this.memo = undefined
  }

  render(width: number): string[] {
    const memo = this.memo
    if (memo?.width === width && memo.usage === this.usage && memo.frame === this.frame && memo.floor === this.floor) return memo.lines
    const lines = contextUsageLines(this.usage, this.palette, width, this.frame)
    const shown = this.shown
    if (shown?.width === width) {
      const held = Math.min(this.floor, lines.length, shown.lines.length)
      lines.splice(0, held, ...shown.lines.slice(0, held))
    }
    this.shown = { width, lines }
    this.memo = { width, usage: this.usage, frame: this.frame, floor: this.floor, lines }
    return lines
  }

  private rest(): void {
    this.settled = true
    this.frame = AT_REST
  }
}

/**
 * The animation frame at one moment after open.
 * @param elapsed - milliseconds since the block opened.
 * @param live - whether a turn runs.
 * @returns the frame.
 */
function frameAt(elapsed: number, live: boolean): ContextUsageFrame {
  return {
    fill: Math.min(1, elapsed / FILL_MS),
    wave: Math.floor(elapsed / WAVE_STEP_MS),
    frontier: live && Math.floor(elapsed / BLINK_MS) % 2 === 0,
    live,
  }
}

/**
 * A key equal for exactly the frames that draw the same.
 * @param frame - the frame.
 * @returns its fields joined.
 */
function frameKey(frame: ContextUsageFrame): string {
  return `${String(frame.fill)}|${String(frame.wave)}|${String(frame.frontier)}|${String(frame.live)}`
}
