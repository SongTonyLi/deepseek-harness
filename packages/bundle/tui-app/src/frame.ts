/**
 * Pure box drawing for the surfaces that own a mode: the rounded rules that
 * frame one, the inverse chip that names it, the two edges of a body row, and
 * the legend step a width can hold.
 *
 * A frame is drawn exactly while a mode is active, so new geometry at a fixed
 * place is what reports the mode change. Text arrives already styled and only
 * the glyphs drawn here take the tone, so a caller keeps its own emphasis.
 * Every returned line fits the width it was given: pi-tui refuses a frame
 * holding a line wider than the terminal.
 * @module @deepseek-ai/dsh-tui-app/frame
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { pulse, type MotionLevel } from './motion.ts'
import type { Palette, Style } from './style.ts'

/** Which palette role a frame's own glyphs take. */
export type FrameTone =
  /** The surface holding the keyboard: accent rules. */
  | 'focus'
  /** A surface that cannot act on what it shows: dim rules. */
  | 'muted'

/**
 * Columns one rule spends on itself: the two corners and the space on each
 * side of its text. A caller sizing text for a rule subtracts this.
 */
export const RULE_MARGIN = 4

/** Columns the ` ─ ` between the chip and the title takes. */
const CHIP_MARGIN = 3

/** What opens a top rule. */
const TOP_LEFT = '╭'

/** What closes a top rule. */
const TOP_RIGHT = '╮'

/** What opens a bottom rule. */
const BOTTOM_LEFT = '╰'

/** What closes a bottom rule. */
const BOTTOM_RIGHT = '╯'

/** What opens a rule drawn between two parts of one frame. */
const LEGEND_LEFT = '├'

/** What closes a rule drawn between two parts of one frame. */
const LEGEND_RIGHT = '┤'

/** What a rule fills the width between its texts with. */
const FILL = '─'

/** The border drawn on each side of a body row. */
const SIDE = '│'

/**
 * Columns a body row spends on itself: the two borders and the space inside
 * each. A caller wrapping text for a body row subtracts this.
 */
export const BODY_MARGIN = 4

/** What separates the chip from the title on a top rule. */
const CHIP_JOIN = ` ${FILL} `

/** The mark the chip opens with, the one inverse block this surface draws. */
const CHIP_MARK = '●'

/** What ends a line the width cut short; one column, so the mark itself fits. */
const ELLIPSIS = '…'

/** The texts one rule carries besides its own glyphs. */
export interface FrameRule {
  /** Text the rule opens with, already styled; omitted leaves the rule bare. */
  left?: string
  /** Text the rule ends with, already styled; omitted fills to the closing corner. */
  right?: string
  /** Columns the line must fit exactly. */
  width: number
  /** The palette the rule's own glyphs are styled with. */
  palette: Palette
  /** Which role those glyphs take. */
  tone: FrameTone
  /**
   * How far above its settled drawing the rule's own glyphs are lifted right
   * now; omitted and `0` both draw the settled rule. A muted rule takes no
   * lift: a dim frame reports that the surface cannot act on what it shows,
   * and brightening it would say the opposite.
   */
  level?: MotionLevel
}

/** A top rule: the mode chip, then what the surface is showing. */
export interface TopRule extends Omit<FrameRule, 'left'> {
  /** The mode chip, from {@link chip}; omitted opens the rule with its title. */
  chip?: string
  /** What the surface is showing, already styled. */
  title?: string
}

/**
 * The chip that names the active mode: the one inverse block this surface
 * draws, so a mode change is visible at a glance.
 * @param palette - the palette the chip is styled with.
 * @param text - the mode's name, as it is drawn.
 * @returns the chip, padded by one space on each side.
 */
export function chip(palette: Palette, text: string): string {
  return palette.inverse(palette.accent(` ${CHIP_MARK} ${text} `))
}

/**
 * Columns a rule leaves its own text.
 * @param width - the width the rule fits.
 * @param chipText - the chip a top rule opens with; omitted for a rule with none.
 * @returns the columns the title, the legend, and the readout share; at least 1.
 */
export function ruleRoom(width: number, chipText = ''): number {
  const chipColumns = chipText === '' ? 0 : visibleWidth(chipText) + CHIP_MARGIN
  return Math.max(1, width - RULE_MARGIN - chipColumns)
}

/**
 * The widest legend a width can hold.
 * @param steps - the declared steps, widest first.
 * @param width - the columns the legend has.
 * @returns the first step that fits, and the last step when none does — a
 * surface that names no way back would be worse than one cut short.
 */
export function fitLegend(steps: readonly string[], width: number): string {
  for (const step of steps) {
    if (visibleWidth(step) <= width) return step
  }
  return steps.at(-1) ?? ''
}

/**
 * One rule of a frame.
 * @param open - the opening glyph.
 * @param close - the closing glyph.
 * @param parts - the texts, the width, the palette, and the tone.
 * @param chipText - the chip the rule opens with; empty for a rule with none.
 * @returns the line, exactly `width` columns while the closing glyph fits.
 */
function rule(open: string, close: string, parts: FrameRule, chipText: string): string {
  const width = Math.max(1, parts.width)
  const { palette, level = 0 } = parts
  const paint: Style = parts.tone === 'focus'
    ? text => pulse(palette, palette.accent(text), level)
    : palette.dim
  const leading = [chipText, parts.left ?? '']
    .filter(text => text !== '')
    .join(paint(CHIP_JOIN))
  const head = leading === '' ? paint(open) : `${paint(open)} ${leading} `
  const right = parts.right ?? ''
  const tail = right === '' ? paint(close) : ` ${right} ${paint(close)}`
  // The subject gives way before the readout: what the width hides must not
  // be the position the surface reports.
  const room = width - visibleWidth(tail)
  const cut = room >= 1 ? truncateToWidth(head, room, ELLIPSIS) : ''
  const fill = paint(FILL.repeat(Math.max(0, width - visibleWidth(cut) - visibleWidth(tail))))
  return truncateToWidth(`${cut}${fill}${tail}`, width, ELLIPSIS)
}

/**
 * The rule a framed surface opens with.
 * @param parts - the chip, the title, an optional readout, the width, the
 * palette, and the tone.
 * @returns the line, exactly `width` columns.
 */
export function topRule(parts: TopRule): string {
  const { chip: chipText, title, ...rest } = parts
  return rule(TOP_LEFT, TOP_RIGHT, { ...rest, left: title ?? '' }, chipText ?? '')
}

/**
 * The rule a framed surface ends with, which carries its legend.
 * @param parts - the legend, an optional readout, the width, the palette, and the tone.
 * @returns the line, exactly `width` columns.
 */
export function bottomRule(parts: FrameRule): string {
  return rule(BOTTOM_LEFT, BOTTOM_RIGHT, parts, '')
}

/**
 * A rule drawn between two parts of one frame, for the legend of a surface
 * that goes on below it.
 * @param parts - the legend, an optional readout, the width, the palette, and the tone.
 * @returns the line, exactly `width` columns.
 */
export function legendRule(parts: FrameRule): string {
  return rule(LEGEND_LEFT, LEGEND_RIGHT, parts, '')
}

/**
 * One row inside a frame, closed on both sides: the content is padded to the
 * room between the borders, so a frame reads as one box however short its
 * rows are. Content wrapped at {@link BODY_MARGIN} columns less than the width
 * is drawn whole; anything wider is cut.
 * @param content - the row, already styled and already wrapped.
 * @param width - the columns the line must fit.
 * @param palette - the palette the borders are styled with.
 * @param tone - which role those borders take.
 * @param level - how far above its settled drawing the borders are lifted, so
 * the whole outline of a frame moves as one; `0` draws the settled borders.
 * @returns the line, exactly `width` columns while both borders fit.
 */
export function bodyLine(content: string, width: number, palette: Palette, tone: FrameTone, level: MotionLevel = 0): string {
  const border = tone === 'focus' ? pulse(palette, palette.accent(SIDE), level) : palette.dim(SIDE)
  const columns = Math.max(1, width)
  const room = columns - BODY_MARGIN
  // A width too narrow to close the row keeps the opening border and the text.
  if (room < 1) return truncateToWidth(`${border} ${content}`, columns, ELLIPSIS)
  const cut = truncateToWidth(content, room, ELLIPSIS)
  const padding = ' '.repeat(Math.max(0, room - visibleWidth(cut)))
  return `${border} ${cut}${padding} ${border}`
}
