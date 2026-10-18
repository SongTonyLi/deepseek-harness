/**
 * The terminal palette: one table of SGR open/close pairs behind named roles,
 * so components never emit raw escape codes. Colored roles draw from the
 * Tokyo Night (Night) hues, as 24-bit color on a terminal that declares
 * truecolor and as the nearest xterm-256 index otherwise. A disabled palette
 * returns text unchanged for dumb terminals and captured output. The palette
 * also says whether the keys a surface names are clickable, because it is what
 * every surface draws a key chip with.
 * @module @deepseek-ai/dsh-tui-app/style
 */

import { visibleWidth, wrapTextWithAnsi, type EditorTheme, type MarkdownTheme, type SelectListTheme } from '@earendil-works/pi-tui'
import type { DiffMark } from './diff.ts'

/** One styling function: wraps `text` in an SGR pair, or returns it verbatim. */
export type Style = (text: string) => string

/** The Tokyo Night (Night) hues the palette's colored roles draw from. */
export type Hue = 'blue' | 'cyan' | 'teal' | 'green' | 'yellow' | 'orange' | 'red' | 'magenta' | 'purple'

/** How the palette encodes a hue. */
export type PaletteDepth =
  /** `ESC[38;2;R;G;Bm`, the exact Tokyo Night color. */
  | 'truecolor'
  /** `ESC[38;5;Nm`, the nearest of the 256 indexed colors. */
  | 'ansi256'

/** Semantic roles the terminal surface draws with. */
export interface Palette {
  /** Recessed secondary text. */
  dim: Style
  bold: Style
  italic: Style
  underline: Style
  /** Scratched-out text, used for completed todo content. */
  strikethrough: Style
  /** Blue brand and focus color. */
  accent: Style
  /** Orange heading and list-marker color. */
  heading: Style
  /** Magenta links, inline code, and secondary status facts. */
  link: Style
  /** Green. */
  success: Style
  /** Yellow. */
  warning: Style
  /** Red. */
  error: Style
  /** Cyan name of a tool a call runs. */
  tool: Style
  /** Teal subject of a tool call: the path, command, or query it acts on. */
  subject: Style
  /** Purple name of the model a session talks to. */
  model: Style
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
  /**
   * Every hue as a foreground, for an encoding whose colors only tell
   * categories apart, such as the cells of the context-usage grid; text with
   * a meaning draws with the role that names it.
   */
  readonly hue: Readonly<Record<Hue, Style>>
  /** Whether styling is active; false yields verbatim text from every role. */
  readonly enabled: boolean
  /**
   * Whether a click on a drawn key presses it: each key chip then carries the
   * zero-width mark the screens resolve a click against, and the application
   * turns the terminal's mouse reports on. Independent of {@link Palette.enabled},
   * so keys stay clickable without color.
   */
  readonly clickableKeys: boolean
}

const ESC = '\u001b['

/** SGR that resets the foreground, closing every hue. */
const FOREGROUND_CLOSE = '39'

/** Each hue's Tokyo Night (Night) color and its nearest xterm-256 index. */
const HUES: Record<Hue, readonly [rgb: string, ansi256: number]> = {
  blue: ['#7aa2f7', 111],
  cyan: ['#7dcfff', 117],
  teal: ['#73daca', 80],
  green: ['#9ece6a', 149],
  yellow: ['#e0af68', 179],
  orange: ['#ff9e64', 215],
  red: ['#f7768e', 210],
  magenta: ['#bb9af7', 141],
  purple: ['#9d7cd8', 140],
}

/** Roles that are one hue as a foreground. */
type HueRole = 'accent' | 'heading' | 'link' | 'success' | 'warning' | 'error' | 'tool' | 'subject' | 'model' | 'addedSign' | 'removedSign'

/** The hue each colored role draws in. */
const ROLE_HUES: Record<HueRole, Hue> = {
  accent: 'blue',
  heading: 'orange',
  link: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  tool: 'cyan',
  subject: 'teal',
  model: 'purple',
  addedSign: 'green',
  removedSign: 'red',
}

/** SGR open/close code pairs of the roles that are not a hue. */
const SGR: Record<Exclude<keyof Palette, HueRole | 'hue' | 'enabled' | 'clickableKeys'>, readonly [open: string, close: string]> = {
  dim: ['2', '22'],
  bold: ['1', '22'],
  italic: ['3', '23'],
  underline: ['4', '24'],
  strikethrough: ['9', '29'],
  inverse: ['7', '27'],
  band: ['48;5;236', '49'],
  injectedBand: ['48;5;234', '49'],
  addedBand: ['48;5;22', '49'],
  removedBand: ['48;5;52', '49'],
}

/**
 * The SGR parameters that set one hue as the foreground.
 * @param hue - the hue.
 * @param depth - how the terminal encodes it.
 * @returns e.g. `38;2;122;162;247` or `38;5;111`.
 */
function hueOpen(hue: Hue, depth: PaletteDepth): string {
  const [rgb, ansi256] = HUES[hue]
  if (depth === 'ansi256') return `38;5;${String(ansi256)}`
  const value = Number.parseInt(rgb.slice(1), 16)
  return `38;2;${String(value >> 16)};${String((value >> 8) & 0xff)};${String(value & 0xff)}`
}

/**
 * Whether the environment declares 24-bit color: `COLORTERM` of `truecolor` or `24bit`.
 * @param env - the process environment.
 * @returns true when `ESC[38;2;R;G;Bm` is understood.
 */
export function declaresTruecolor(env: NodeJS.ProcessEnv): boolean {
  const colorterm = (env.COLORTERM ?? '').toLowerCase()
  return colorterm === 'truecolor' || colorterm === '24bit'
}

/**
 * Decide how the palette encodes its hues.
 * @param env - the process environment.
 * @returns `truecolor` when the environment declares it, otherwise `ansi256`.
 */
export function paletteDepth(env: NodeJS.ProcessEnv): PaletteDepth {
  return declaresTruecolor(env) ? 'truecolor' : 'ansi256'
}

/**
 * Build the palette.
 * @param enabled - whether escape sequences are emitted; false makes every role the identity.
 * @param clickableKeys - whether key chips carry click marks; false by default.
 * @param depth - how hues are encoded; `ansi256` by default.
 * @returns the palette.
 */
export function createPalette(enabled: boolean, clickableKeys = false, depth: PaletteDepth = 'ansi256'): Palette {
  const wrap = (open: string, close: string): Style =>
    enabled ? text => `${ESC}${open}m${text}${ESC}${close}m` : text => text
  const role = (name: keyof typeof SGR): Style => wrap(...SGR[name])
  const paint = (name: Hue): Style => wrap(hueOpen(name, depth), FOREGROUND_CLOSE)
  const hue: Record<Hue, Style> = {
    blue: paint('blue'),
    cyan: paint('cyan'),
    teal: paint('teal'),
    green: paint('green'),
    yellow: paint('yellow'),
    orange: paint('orange'),
    red: paint('red'),
    magenta: paint('magenta'),
    purple: paint('purple'),
  }
  const colored = (name: HueRole): Style => hue[ROLE_HUES[name]]
  return {
    dim: role('dim'),
    bold: role('bold'),
    italic: role('italic'),
    underline: role('underline'),
    strikethrough: role('strikethrough'),
    accent: colored('accent'),
    heading: colored('heading'),
    link: colored('link'),
    success: colored('success'),
    warning: colored('warning'),
    error: colored('error'),
    tool: colored('tool'),
    subject: colored('subject'),
    model: colored('model'),
    inverse: role('inverse'),
    band: role('band'),
    injectedBand: role('injectedBand'),
    addedBand: role('addedBand'),
    removedBand: role('removedBand'),
    addedSign: colored('addedSign'),
    removedSign: colored('removedSign'),
    hue,
    enabled,
    clickableKeys,
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
  /** Advance when the same code may produce different rows; omit for immutable highlighters. */
  readonly revision?: number | undefined

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
