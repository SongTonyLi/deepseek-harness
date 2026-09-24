/**
 * The terminal palette: one table of SGR open/close pairs behind named roles,
 * so components never emit raw escape codes. A disabled palette returns text
 * unchanged for dumb terminals and captured output.
 * @module @deepseek-ai/dsh-tui-app/style
 */

import { visibleWidth, wrapTextWithAnsi, type EditorTheme, type MarkdownTheme, type SelectListTheme } from '@earendil-works/pi-tui'
import type { DiffMark } from './diff.ts'

/** One styling function: wraps `text` in an SGR pair, or returns it verbatim. */
export type Style = (text: string) => string

/** Semantic roles the terminal surface draws with. */
export interface Palette {
  /** Recessed secondary text. */
  dim: Style
  bold: Style
  italic: Style
  underline: Style
  /** Scratched-out text, used for completed todo content. */
  strikethrough: Style
  /** Brand and focus color. */
  accent: Style
  /** Warm heading and list-marker color. */
  heading: Style
  /** Violet links, inline code, and secondary status facts. */
  link: Style
  success: Style
  warning: Style
  error: Style
  /** Inverted foreground/background, used for the selected row. */
  inverse: Style
  /**
   * A dark-grey background tint behind the user's own prompt rows; only the
   * background changes, so every foreground role nests inside it.
   */
  band: Style
  /** Whether styling is active; false yields verbatim text from every role. */
  readonly enabled: boolean
}

const ESC = '\u001b['

/** SGR open/close code pairs by role. */
const SGR: Record<Exclude<keyof Palette, 'enabled'>, readonly [open: string, close: string]> = {
  dim: ['2', '22'],
  bold: ['1', '22'],
  italic: ['3', '23'],
  underline: ['4', '24'],
  strikethrough: ['9', '29'],
  accent: ['36', '39'],
  heading: ['38;5;215', '39'],
  link: ['38;5;141', '39'],
  success: ['32', '39'],
  warning: ['33', '39'],
  error: ['31', '39'],
  inverse: ['7', '27'],
  band: ['48;5;236', '49'],
}

/**
 * Build the palette.
 * @param enabled - whether escape sequences are emitted; false makes every role the identity.
 * @returns the palette.
 */
export function createPalette(enabled: boolean): Palette {
  const role = (name: keyof typeof SGR): Style => {
    const [open, close] = SGR[name]
    return enabled ? text => `${ESC}${open}m${text}${ESC}${close}m` : text => text
  }
  return {
    dim: role('dim'),
    bold: role('bold'),
    italic: role('italic'),
    underline: role('underline'),
    strikethrough: role('strikethrough'),
    accent: role('accent'),
    heading: role('heading'),
    link: role('link'),
    success: role('success'),
    warning: role('warning'),
    error: role('error'),
    inverse: role('inverse'),
    band: role('band'),
    enabled,
  }
}

/**
 * Paint added and removed diff rows while leaving context and metadata rows
 * unchanged. `source` stays plain so syntax-colored rows can be classified.
 * @param rows - rows after optional syntax highlighting.
 * @param source - corresponding plain rows carrying the diff prefixes.
 * @param palette - active terminal palette.
 * @returns the rows with additions green and removals red.
 */
export function paintDiffRows(rows: readonly string[], source: readonly string[], palette: Palette): string[] {
  return rows.map((row, index) => {
    const plain = source[index]
    if (plain?.startsWith('+ ') === true) return palette.success(row)
    if (plain?.startsWith('- ') === true) return palette.error(row)
    return row
  })
}

/**
 * Lay one row on the {@link Palette.band} tint across the full width.
 * @param palette - the active palette.
 * @param row - the styled row, at most `width` columns.
 * @param width - the columns the band spans.
 * @returns the row padded to `width` under the tint; the row unchanged, with
 * no padding, when the palette is disabled.
 */
export function bandRow(palette: Palette, row: string, width: number): string {
  return palette.enabled ? palette.band(`${row}${' '.repeat(Math.max(0, width - visibleWidth(row)))}`) : row
}

/** Narrowest width a diff box is drawn at: two borders, two spaces, and one column of text. */
const DIFF_BOX_MIN_WIDTH = 5

/**
 * Wrap rows to `width`, framing each run of consecutive additions in a green
 * rounded box and each run of consecutive removals in a red one, so a change
 * reads as one region. A removal run directly followed by an addition run
 * draws as two stacked boxes, the old text above the new. Every returned line
 * is at most `width` columns, and every box line is exactly `width`.
 * @param rows - the styled rows.
 * @param marks - per row, whether it is an addition or a removal; undefined
 * for a row outside every box.
 * @param width - the columns the rows fit.
 * @param palette - the active palette; a disabled one draws the boxes uncolored.
 * @returns the wrapped rows with the boxes drawn around the changes; rows
 * wrapped without boxes when the width cannot hold a box.
 */
export function boxDiffRows(rows: readonly string[], marks: readonly (DiffMark | undefined)[], width: number, palette: Palette): string[] {
  const out: string[] = []
  const inner = width - 4
  let open: DiffMark | undefined
  const close = (): void => {
    if (open === undefined) return
    const paint = open === 'added' ? palette.success : palette.error
    out.push(paint(`╰${'─'.repeat(width - 2)}╯`))
    open = undefined
  }
  for (const [index, row] of rows.entries()) {
    const mark = width < DIFF_BOX_MIN_WIDTH ? undefined : marks[index]
    if (mark !== open) close()
    if (mark === undefined) {
      out.push(...wrapTextWithAnsi(row, Math.max(1, width)))
      continue
    }
    const paint = mark === 'added' ? palette.success : palette.error
    if (open === undefined) out.push(paint(`╭${'─'.repeat(width - 2)}╮`))
    open = mark
    for (const part of wrapTextWithAnsi(row, inner)) {
      out.push(`${paint('│')} ${part}${' '.repeat(Math.max(0, inner - visibleWidth(part)))} ${paint('│')}`)
    }
  }
  close()
  return out
}

/**
 * Decide whether the terminal gets color: `NO_COLOR` (any non-empty value)
 * wins, then a non-empty non-zero `FORCE_COLOR`, then whether stdout is a TTY.
 * @param env - the process environment.
 * @param isTty - whether stdout is a terminal.
 * @returns true when SGR styling should be emitted.
 */
export function colorEnabled(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true
  return isTty
}

/** What a Markdown theme asks of a syntax highlighter. */
export interface CodeHighlighter {
  /**
   * Colour one fenced block, file row group, or shell command.
   * @param code - the block's source.
   * @param lang - the fence's info string, a file extension, or `shellscript`.
   * @returns one styled line per source line, or undefined to draw it plain.
   */
  lines(code: string, lang: string | undefined): string[] | undefined
}

/**
 * The Markdown theme derived from the palette.
 * @param palette - the active palette.
 * @param highlight - colours fenced code; omitted draws every block plain,
 * which is also what a block whose language has no grammar here draws as.
 * @returns a complete pi-tui Markdown theme.
 */
export function markdownTheme(palette: Palette, highlight?: CodeHighlighter): MarkdownTheme {
  return {
    highlightCode: (code, lang) => highlight?.lines(code, lang) ?? code.split('\n'),
    heading: text => palette.bold(palette.heading(text)),
    link: text => palette.underline(palette.link(text)),
    linkUrl: palette.dim,
    code: palette.link,
    codeBlock: text => text,
    codeBlockBorder: palette.dim,
    quote: text => palette.italic(palette.dim(text)),
    quoteBorder: palette.dim,
    hr: palette.dim,
    listBullet: palette.heading,
    bold: palette.bold,
    italic: palette.italic,
    strikethrough: palette.strikethrough,
    underline: palette.underline,
  }
}

/**
 * The select-list theme derived from the palette.
 * @param palette - the active palette.
 * @returns a complete pi-tui select-list theme.
 */
export function selectListTheme(palette: Palette): SelectListTheme {
  return {
    selectedPrefix: palette.accent,
    selectedText: text => palette.bold(palette.accent(text)),
    description: palette.dim,
    scrollInfo: palette.dim,
    noMatch: palette.dim,
  }
}

/**
 * The editor theme derived from the palette.
 * @param palette - the active palette.
 * @returns a complete pi-tui editor theme.
 */
export function editorTheme(palette: Palette): EditorTheme {
  return { borderColor: palette.dim, selectList: selectListTheme(palette) }
}
