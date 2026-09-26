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
  /**
   * A darker tint than {@link Palette.band}, closer to the terminal
   * background, behind a prompt steered or injected into a running turn.
   */
  injectedBand: Style
  /** The background tint filling a row a diff adds; foreground roles nest inside it. */
  addedBand: Style
  /** The background tint filling a row a diff removes; foreground roles nest inside it. */
  removedBand: Style
  /** The `+` of an added row, light enough to read against {@link Palette.addedBand}. */
  addedSign: Style
  /** The `-` of a removed row, light enough to read against {@link Palette.removedBand}. */
  removedSign: Style
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
  injectedBand: ['48;5;234', '49'],
  addedBand: ['48;5;22', '49'],
  removedBand: ['48;5;52', '49'],
  addedSign: ['38;5;120', '39'],
  removedSign: ['38;5;210', '39'],
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
    injectedBand: role('injectedBand'),
    addedBand: role('addedBand'),
    removedBand: role('removedBand'),
    addedSign: role('addedSign'),
    removedSign: role('removedSign'),
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
 * Lay one row on a background tint across the full width.
 * @param palette - the active palette.
 * @param row - the styled row, at most `width` columns.
 * @param width - the columns the band spans.
 * @param band - the tint; {@link Palette.band} by default.
 * @returns the row padded to `width` under the tint; the row unchanged, with
 * no padding, when the palette is disabled.
 */
export function bandRow(palette: Palette, row: string, width: number, band: Style = palette.band): string {
  return palette.enabled ? band(`${row}${' '.repeat(Math.max(0, width - visibleWidth(row)))}`) : row
}

/**
 * The `+` or `-` of a changed row, painted apart from the tint the row is
 * filled with. The sign sits in the plain row's own prefix - the file line
 * number, when the diff carries one, then the sign and a space - and syntax
 * colour starts after it, so the styled row opens with the same characters.
 * @param row - the styled row.
 * @param plain - the same row before any syntax colour.
 * @param mark - whether the row is an addition or a removal.
 * @param palette - the active palette.
 * @returns the row with its sign painted, or unchanged when the styled row
 * does not open with the plain prefix.
 */
function paintDiffSign(row: string, plain: string, mark: DiffMark, palette: Palette): string {
  const sign = mark === 'added' ? '+' : '-'
  const at = plain.indexOf(`${sign} `)
  if (at === -1 || !row.startsWith(plain.slice(0, at + 1))) return row
  const paint = mark === 'added' ? palette.addedSign : palette.removedSign
  return `${row.slice(0, at)}${paint(sign)}${row.slice(at + 1)}`
}

/**
 * Wrap rows to `width` and fill each changed row edge to edge with its own
 * background tint - green for an addition, red for a removal - so a run of
 * changes reads as one region without spending a column on a border. The `+`
 * and `-` are painted in their own lighter colour, apart from the fill, and a
 * wrapped continuation carries the tint with no sign of its own. Every
 * returned line is at most `width` columns, and every filled line is exactly
 * `width`; a disabled palette pads nothing and returns the rows as they are.
 * @param rows - the styled rows.
 * @param plain - the same rows before any syntax colour, which carry the signs.
 * @param marks - per row, whether it is an addition or a removal; undefined
 * for a row no tint fills.
 * @param width - the columns the rows fit.
 * @param palette - the active palette.
 * @returns the wrapped rows, the changed ones filled.
 */
export function bandDiffRows(
  rows: readonly string[],
  plain: readonly string[],
  marks: readonly (DiffMark | undefined)[],
  width: number,
  palette: Palette,
): string[] {
  const columns = Math.max(1, width)
  const out: string[] = []
  for (const [index, row] of rows.entries()) {
    const mark = marks[index]
    if (mark === undefined) {
      out.push(...wrapTextWithAnsi(row, columns))
      continue
    }
    const fill = mark === 'added' ? palette.addedBand : palette.removedBand
    const signed = paintDiffSign(row, plain[index] ?? '', mark, palette)
    for (const part of wrapTextWithAnsi(signed, columns)) {
      out.push(palette.enabled ? fill(`${part}${' '.repeat(Math.max(0, columns - visibleWidth(part)))}`) : part)
    }
  }
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
