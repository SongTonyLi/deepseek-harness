/**
 * Key chips: each key a surface names - `Ctrl+G`, `Esc`, `Shift+↑`, the
 * reader's `q` - is drawn apart from the words around it, and on a palette
 * with clickable keys carries a zero-width mark naming the key, so a click on
 * its cells presses that key.
 *
 * The mark is an APC sequence. pi-tui measures, wraps, and truncates APC as
 * zero columns, as it does its own cursor marker, so a chip lays out exactly
 * as its bare label. The screens take every mark out of a frame before they
 * write it ({@link takeKeyFrame}) and keep the columns each marked key
 * occupies; no mark reaches the terminal.
 *
 * Pure: hint text in, styled text out; drawn lines in, clean lines and the
 * cells of each key out.
 * @module @deepseek-ai/dsh-tui-app/key-chips
 */

import { visibleWidth } from '@earendil-works/pi-tui'
import type { Palette, Style } from './style.ts'

/** Which key names a text may carry. */
export type KeyVocabulary =
  /**
   * A legend, picker hint, or key list the terminal surface writes: every
   * named key, chord, and arrow, plus the single-character keys the legends
   * name (`E`, `I`, `q`, `b`, `jk`, `?`, `/`, `@`, `[`, `]`).
   */
  | 'legend'
  /**
   * Prose that can interpolate names, paths, and error text: named keys,
   * chords, and arrows only, so a lone letter or slash in the interpolated
   * part is never drawn as a key.
   */
  | 'prose'

/** A `Ctrl` letter, or a `Shift` chord over `Tab`, `Enter`, or one or two arrows. */
const CHORD = String.raw`Ctrl\+[A-Z]|Shift\+(?:Tab|Enter|[↑↓←→]{1,2})`

/** Keys the surfaces name by word. */
const NAMED = 'Esc|Enter|Tab|Space|PgUp|PgDn|Home|End'

/** One arrow, or a pair drawn as one token such as `↑↓`. */
const ARROWS = '[↑↓←→]{1,2}'

/** The single-character keys a legend names, and the `jk` pair the reader draws as one token. */
const CHARACTERS = String.raw`jk|[EIqb?/@[\]]`

/** A key token starts the text or follows whitespace or an opening parenthesis. */
const BEFORE = String.raw`(?<=^|[\s(])`

/** A key token ends the text or precedes whitespace or closing punctuation. */
const AFTER = String.raw`(?=$|[\s,.;:)])`

/** The tokens each vocabulary recognizes; global, so each search restarts at index 0 through `matchAll`. */
const TOKENS: Record<KeyVocabulary, RegExp> = {
  legend: new RegExp(`${BEFORE}(?:${CHORD}|${NAMED}|${ARROWS}|${CHARACTERS})${AFTER}`, 'gu'),
  prose: new RegExp(`${BEFORE}(?:${CHORD}|${NAMED}|${ARROWS})${AFTER}`, 'gu'),
}

/** The CSI final byte of each arrow key. */
const ARROW_FINAL: ReadonlyMap<string, string> = new Map([['↑', 'A'], ['↓', 'B'], ['→', 'C'], ['←', 'D']])

/**
 * The bytes a press of each word-named key and `Shift` word chord sends, in
 * the legacy encoding every terminal reads, except `Shift+Enter`, which only
 * the CSI-u form distinguishes from `Enter`.
 */
const NAMED_BYTES: ReadonlyMap<string, string> = new Map([
  ['Esc', '\u001b'],
  ['Enter', '\r'],
  ['Tab', '\t'],
  ['Space', ' '],
  ['PgUp', '\u001b[5~'],
  ['PgDn', '\u001b[6~'],
  ['Home', '\u001b[H'],
  ['End', '\u001b[F'],
  ['Shift+Tab', '\u001b[Z'],
  ['Shift+Enter', '\u001b[13;2u'],
])

/** A `Ctrl` letter chord. */
const CTRL_LETTER = /^Ctrl\+([A-Z])$/u

/** One arrow, shifted or not. */
const ARROW_KEY = /^(Shift\+)?([↑↓←→])$/u

/** A single-character key, which sends itself. */
const CHARACTER_KEY = /^[jkEIqb?/@[\]]$/u

/** Offset between an uppercase letter's code and the control code `Ctrl` with it sends. */
const CONTROL_OFFSET = 64

/**
 * The bytes one press of a key sends.
 * @param key - the key as a chip names it: `Ctrl+G`, `Shift+↑`, `Esc`, `q`.
 * @returns the bytes a terminal sends for that press, or undefined for a name
 * outside the vocabulary, which no click presses.
 */
export function keyBytes(key: string): string | undefined {
  const named = NAMED_BYTES.get(key)
  if (named !== undefined) return named
  const ctrl = CTRL_LETTER.exec(key)
  if (ctrl !== null) return String.fromCharCode((ctrl[1] as string).charCodeAt(0) - CONTROL_OFFSET)
  const arrow = ARROW_KEY.exec(key)
  if (arrow !== null) {
    const final = ARROW_FINAL.get(arrow[2] as string) as string
    return arrow[1] === undefined ? `\u001b[${final}` : `\u001b[1;2${final}`
  }
  return CHARACTER_KEY.test(key) ? key : undefined
}

/** One chip: the text drawn and the key a click on it presses. */
interface Chip {
  /** The characters drawn, part of a token. */
  readonly label: string
  /** The key a click on the label presses, as {@link keyBytes} names it. */
  readonly key: string
}

/**
 * The chips one token draws as: a pair of arrows or `jk` is one chip per
 * character, and a `Shift` chord over two arrows shifts both, so each drawn
 * character presses the key it names.
 * @param token - the matched token.
 * @returns the chips in drawing order.
 */
function chipsOf(token: string): Chip[] {
  const pair = /^(Shift\+)?([↑↓←→])([↑↓←→])$/u.exec(token)
  if (pair !== null) {
    const shift = pair[1] ?? ''
    const first = `${shift}${pair[2] as string}`
    const second = pair[3] as string
    return [{ label: first, key: first }, { label: second, key: `${shift}${second}` }]
  }
  if (token === 'jk') return [{ label: 'j', key: 'j' }, { label: 'k', key: 'k' }]
  return [{ label: token, key: token }]
}

/** What opens a key mark; the screens search a drawn line for it before anything else. */
const MARK_PREFIX = '\u001b_dsh-key;'

/** What ends a key mark. */
const MARK_END = '\u0007'

/** One mark: the columns its chip spans, then the key it presses. */
const MARK = /\u001b_dsh-key;(\d+);([^\u0007\u001b]*)\u0007/gu

/**
 * The zero-width mark that names the key under the columns after it.
 * @param width - the columns the chip's label takes.
 * @param key - the key the chip presses.
 * @returns the APC sequence.
 */
function mark(width: number, key: string): string {
  return `${MARK_PREFIX}${String(width)};${key}${MARK_END}`
}

/**
 * How a chip is drawn: the accent color, underlined, so a key reads apart
 * from the words around it, and as something to click, with or without
 * color.
 * @param palette - the active palette.
 * @returns the chip style.
 */
function chipStyle(palette: Palette): Style {
  return text => palette.underline(palette.accent(text))
}

/**
 * Draw the keys a text names as chips and every other run of it in `base`.
 *
 * The runs are styled apart rather than nested, so a chip neither inherits
 * nor cancels the style of the text around it. The text keeps its visible
 * width: the marks are zero columns wide.
 * @param palette - the active palette; its `clickableKeys` decides whether
 * each chip carries its key mark.
 * @param text - the text, unstyled.
 * @param base - the style of the runs between chips; dim by default.
 * @param vocabulary - which key names count; `legend` by default.
 * @returns the styled text.
 */
export function paintKeys(
  palette: Palette,
  text: string,
  base: Style = palette.dim,
  vocabulary: KeyVocabulary = 'legend',
): string {
  const style = chipStyle(palette)
  let out = ''
  let last = 0
  for (const match of text.matchAll(TOKENS[vocabulary])) {
    if (match.index > last) out += base(text.slice(last, match.index))
    for (const chip of chipsOf(match[0])) {
      out += `${palette.clickableKeys ? mark(visibleWidth(chip.label), chip.key) : ''}${style(chip.label)}`
    }
    last = match.index + match[0].length
  }
  if (last < text.length) out += base(text.slice(last))
  return out
}

/** The cells of one marked key on a drawn line. */
export interface KeySpot {
  /** First column the chip takes, counted from 0. */
  readonly from: number
  /** The column after the chip's last one. */
  readonly to: number
  /** The bytes a press of the key sends. */
  readonly bytes: string
}

/** One drawn line with its marks taken out. */
export interface MarkedLine {
  /** The line as it is written: every key mark removed. */
  readonly line: string
  /** Where each marked key sits, left to right. */
  readonly spots: readonly KeySpot[]
}

/**
 * Take the key marks out of one drawn line.
 * @param line - the line as a component drew it.
 * @returns the line without marks and the cells of each key they named. A
 * chip the width cut short spans no column past the line's end, and a mark
 * naming a key outside the vocabulary is removed without a spot.
 */
export function takeKeySpots(line: string): MarkedLine {
  if (!line.includes(MARK_PREFIX)) return { line, spots: [] }
  let clean = ''
  let column = 0
  let last = 0
  const found: KeySpot[] = []
  for (const match of line.matchAll(MARK)) {
    const text = line.slice(last, match.index)
    clean += text
    column += visibleWidth(text)
    const bytes = keyBytes(match[2] as string)
    if (bytes !== undefined) found.push({ from: column, to: column + Number(match[1]), bytes })
    last = match.index + match[0].length
  }
  clean += line.slice(last)
  const end = visibleWidth(clean)
  const spots = found.filter(spot => spot.from < end).map(spot => ({ ...spot, to: Math.min(spot.to, end) }))
  return { line: clean, spots }
}

/** The keys one frame draws, by the frame line or screen row they are on. */
export type KeyFrame = ReadonlyMap<number, readonly KeySpot[]>

/** A frame that draws no key. */
export const EMPTY_KEY_FRAME: KeyFrame = new Map()

/** One frame with its marks taken out. */
export interface MarkedFrame {
  /** The frame as it is written. */
  readonly lines: string[]
  /** Where its keys sit. */
  readonly keys: KeyFrame
}

/**
 * Take the key marks out of a whole frame.
 * @param lines - the frame as the tree drew it.
 * @returns the lines to write and the keys each one draws.
 */
export function takeKeyFrame(lines: readonly string[]): MarkedFrame {
  const keys = new Map<number, readonly KeySpot[]>()
  const clean = lines.map((line, index) => {
    const marked = takeKeySpots(line)
    if (marked.spots.length > 0) keys.set(index, marked.spots)
    return marked.line
  })
  return { lines: clean, keys }
}

/**
 * The key drawn at one cell of a frame.
 * @param keys - the frame's keys.
 * @param line - the frame line or screen row.
 * @param column - the column, counted from 0.
 * @returns the bytes that key sends, or undefined when no chip covers the cell.
 */
export function keyAt(keys: KeyFrame, line: number, column: number): string | undefined {
  return keys.get(line)?.find(spot => column >= spot.from && column < spot.to)?.bytes
}
