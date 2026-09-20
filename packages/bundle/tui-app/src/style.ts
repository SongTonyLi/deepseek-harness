/**
 * The terminal palette: one table of SGR open/close pairs behind named roles,
 * so components never emit raw escape codes. A disabled palette returns text
 * unchanged for dumb terminals and captured output.
 * @module @deepseek-ai/dsh-tui-app/style
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'

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
  /** Pale cyan on the dark-mode cool scale; Markdown headings and list markers. */
  heading: Style
  /** Deeper blue on the same scale; Markdown links and inline code. */
  link: Style
  success: Style
  warning: Style
  error: Style
  /** Inverted foreground/background, used for the selected row. */
  inverse: Style
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
  heading: ['38;5;117', '39'],
  link: ['38;5;75', '39'],
  success: ['32', '39'],
  warning: ['33', '39'],
  error: ['31', '39'],
  inverse: ['7', '27'],
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
   * Colour one fenced block.
   * @param code - the block's source.
   * @param lang - the fence's info string, if it carried one.
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
