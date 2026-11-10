/**
 * Cutting a rendered line at several columns in one pass, and reading the
 * styling its escape sequences leave in force.
 *
 * pi-tui's `sliceByColumn` walks a line from its first character on every
 * call and opens each piece with every escape sequence written before it, so
 * a fade that recolors `n` runs of one line reads that line about `2n` times
 * per frame and writes the line's whole styling history once per run.
 * {@link sliceColumns} reads the line once and opens each piece after a cut
 * with only the styling in force at that cut.
 * @module @deepseek-ai/dsh-tui-app/columns
 */

import { visibleWidth } from '@earendil-works/pi-tui'

/** Grapheme segmenter for the text between escape sequences. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Control Sequence Introducer. */
const CSI = '\u001b['

/** Opening of an OSC 8 hyperlink sequence, which an empty target closes. */
const OSC8 = '\u001b]8;'

/** SGR codes that take a color in the parameters after them: foreground, background, underline color. */
const EXTENDED_COLOR_CODES: ReadonlySet<number> = new Set([38, 48, 58])

/** SGR codes that restore the terminal's default foreground, background, and underline color. */
const DEFAULT_COLOR_CODES: ReadonlySet<number> = new Set([39, 49, 59])

/** SGR codes that turn an attribute on, which a cut restores while they stay in force. */
const ATTRIBUTE_CODES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 7, 8, 9])

/** SGR codes that turn attributes off, each with the codes whose attributes it ends. */
const ATTRIBUTE_ENDS: ReadonlyMap<number, readonly number[]> = new Map([
  [22, [1, 2]],
  [23, [3]],
  [24, [4]],
  [25, [5]],
  [27, [7]],
  [28, [8]],
  [29, [9]],
])

/**
 * The terminal escape sequence starting at `index`, as pi-tui recognizes one:
 * a CSI sequence ending in `m`, `G`, `K`, `H`, or `J`, or an OSC or APC
 * sequence ending in BEL or ST. An unterminated sequence is text.
 * @param line - the rendered line.
 * @param index - where the sequence would start.
 * @returns the sequence's length, or 0 when none starts there.
 */
function escapeLength(line: string, index: number): number {
  if (line[index] !== '\u001b') return 0
  const kind = line[index + 1]
  if (kind === '[') {
    for (let end = index + 2; end < line.length; end += 1) {
      if ('mGKHJ'.includes(line[end] as string)) return end + 1 - index
    }
    return 0
  }
  if (kind === ']' || kind === '_') {
    for (let end = index + 2; end < line.length; end += 1) {
      if (line[end] === '\u0007') return end + 1 - index
      if (line[end] === '\u001b' && line[end + 1] === '\\') return end + 2 - index
    }
  }
  return 0
}

/** One part of a rendered line: an escape sequence, or the text between two of them. */
export interface LinePart {
  /** The part's characters. */
  text: string
  /** Whether the part is one escape sequence, as {@link lineParts} recognizes one. */
  sequence: boolean
}

/**
 * Split a rendered line into its escape sequences and the text between them.
 * A sequence is a CSI sequence ending in `m`, `G`, `K`, `H`, or `J`, or an OSC
 * or APC sequence ending in BEL or ST, which is what pi-tui steps over when it
 * measures a line; an unterminated sequence is text.
 * @param line - the rendered line.
 * @returns the parts in line order; consecutive text is one part.
 */
export function* lineParts(line: string): Generator<LinePart, void, void> {
  let index = 0
  while (index < line.length) {
    const length = escapeLength(line, index)
    if (length > 0) {
      yield { text: line.slice(index, index + length), sequence: true }
      index += length
      continue
    }
    let end = index + 1
    while (end < line.length && escapeLength(line, end) === 0) end += 1
    yield { text: line.slice(index, end), sequence: false }
    index = end
  }
}

/**
 * Whether one escape sequence is SGR, the sequence that sets text attributes.
 * @param sequence - one escape sequence from {@link lineParts}.
 * @returns true for `ESC[` parameters `m`.
 */
export function isSgr(sequence: string): boolean {
  return sequence.startsWith(CSI) && sequence.endsWith('m')
}

/**
 * The attribute changes one SGR sequence makes, in order. A `38`, `48`, or
 * `58` code is one change together with the parameters its color takes:
 * `2;R;G;B`, `5;N`, or the one mode parameter it carries otherwise. Every
 * other parameter is a change of its own. An empty parameter reads as 0, so
 * `ESC[m` and the first slot of `ESC[;1m` are full resets.
 * @param sequence - an SGR sequence, `ESC[` through the final `m`.
 * @returns the changes, each the numeric parameters it consists of; a
 * parameter that is not a number reads as `NaN`.
 */
export function sgrChanges(sequence: string): number[][] {
  const body = sequence.slice(CSI.length, -1)
  const parts = body === '' ? [0] : body.split(';').map(part => part === '' ? 0 : Number(part))
  const changes: number[][] = []
  let index = 0
  while (index < parts.length) {
    const code = parts[index] as number
    const length = EXTENDED_COLOR_CODES.has(code) ? extendedColorLength(parts[index + 1]) : 1
    changes.push(parts.slice(index, index + length))
    index += length
  }
  return changes
}

/**
 * How many parameters an extended color change spans, its own code included.
 * @param mode - the parameter after the `38`, `48`, or `58`.
 * @returns 5 for `2;R;G;B`, 3 for `5;N`, 1 when the sequence ends at the code, and 2 for any other mode.
 */
function extendedColorLength(mode: number | undefined): number {
  if (mode === 2) return 5
  if (mode === 5) return 3
  return mode === undefined ? 1 : 2
}

/**
 * Whether one SGR code sets or clears the foreground.
 * @param code - a change's first parameter, from {@link sgrChanges}.
 * @returns true for `30`-`39` and `90`-`97`.
 */
export function setsForeground(code: number): boolean {
  return (code >= 30 && code <= 39) || (code >= 90 && code <= 97)
}

/**
 * The color slot one SGR code sets or clears.
 * @param code - the change's first parameter.
 * @returns `38` for a foreground code, `48` for a background code, `58` for
 * an underline color code, or undefined for a code that sets no color.
 */
function colorSlot(code: number): number | undefined {
  if (setsForeground(code)) return 38
  if ((code >= 40 && code <= 49) || (code >= 100 && code <= 107)) return 48
  return code === 58 || code === 59 ? 58 : undefined
}

/**
 * The styling a line's escape sequences leave in force at one point of a
 * walk: each attribute set since the last full reset and not ended since, the
 * latest foreground, background, and underline color, and the hyperlink an
 * OSC 8 sequence opened and none closed. A code this does not model is not
 * restored.
 */
class StylingInForce {
  /** Each attribute in force, by the code that set it, as the parameter that set it. */
  private readonly attributes = new Map<number, string>()
  /** The background and underline color in force, by slot (`48`, `58`), as the parameters that set each. */
  private readonly colors = new Map<number, string>()
  /** The parameters that set the foreground in force; undefined for the terminal default. */
  private foreground: string | undefined
  /** The OSC 8 sequence that opened the hyperlink in force. */
  private link: string | undefined

  /**
   * Take one escape sequence into the styling.
   * @param sequence - one escape sequence of the line, in line order.
   */
  read(sequence: string): void {
    if (sequence.startsWith(OSC8)) {
      this.link = linkTarget(sequence) === '' ? undefined : sequence
      return
    }
    if (!isSgr(sequence)) return
    for (const change of sgrChanges(sequence)) this.apply(change)
  }

  /**
   * The sequences that restore this styling over the line's own styling: the
   * hyperlink opener, one SGR with every attribute and the background and
   * underline colors, and one SGR with the foreground, each present only when
   * something of it is in force.
   * @returns the restoring sequences; empty when nothing is in force.
   */
  restore(): string {
    const rest = [...this.attributes.values(), ...this.colors.values()]
    const others = rest.length === 0 ? '' : `${CSI}${rest.join(';')}m`
    const foreground = this.foreground === undefined ? '' : `${CSI}${this.foreground}m`
    return `${this.link ?? ''}${others}${foreground}`
  }

  /**
   * Apply one change from {@link sgrChanges}.
   * @param change - the change's parameters.
   */
  private apply(change: readonly number[]): void {
    const code = change[0] as number
    if (code === 0) {
      this.attributes.clear()
      this.colors.clear()
      this.foreground = undefined
      return
    }
    if (ATTRIBUTE_CODES.has(code)) {
      this.attributes.set(code, String(code))
      return
    }
    const ended = ATTRIBUTE_ENDS.get(code)
    if (ended !== undefined) {
      for (const attribute of ended) this.attributes.delete(attribute)
      return
    }
    const slot = colorSlot(code)
    if (slot === undefined) return
    const parameters = DEFAULT_COLOR_CODES.has(code) ? undefined : change.join(';')
    if (slot === 38) this.foreground = parameters
    else if (parameters === undefined) this.colors.delete(slot)
    else this.colors.set(slot, parameters)
  }
}

/**
 * The target an OSC 8 sequence links to.
 * @param sequence - `ESC]8;params;target` ended by BEL or ST.
 * @returns the target; empty for the sequence that closes a hyperlink.
 */
function linkTarget(sequence: string): string {
  const body = sequence.slice(OSC8.length, sequence.endsWith('\u0007') ? -1 : -2)
  return body.slice(body.indexOf(';') + 1)
}

/**
 * Cut `line` into the column ranges between consecutive cuts.
 *
 * A piece a grapheme starts in opens with the styling in force at its first
 * column, as {@link StylingInForce} restores it, and never with the sequences
 * that styling was built from. The escape sequences inside a range follow that
 * restore, so a sequence at a cut column styles the range it starts rather
 * than the one before it.
 * @param line - the rendered line, escape sequences included.
 * @param cuts - ascending columns; equal neighbours make an empty range.
 * @returns `cuts.length + 1` pieces: columns `[0, cuts[0])`, then each range
 * between two cuts, then everything from the last cut on. A grapheme belongs
 * to the range its first column is in, and a range no grapheme starts in holds
 * only the escape sequences inside it.
 */
export function sliceColumns(line: string, cuts: readonly number[]): string[] {
  const starts = [0, ...cuts]
  const pieces = starts.map(() => '')
  const drawn = starts.map(() => false)
  // The styling in force when the walk reached each range's first column.
  const restores = starts.map(() => '')
  const styling = new StylingInForce()
  let column = 0
  let range = 0
  let reached = 1
  const advance = (): void => {
    while (range + 1 < starts.length && (starts[range + 1] as number) <= column) range += 1
    while (reached < starts.length && (starts[reached] as number) <= column) {
      restores[reached] = styling.restore()
      reached += 1
    }
  }
  advance()
  for (const part of lineParts(line)) {
    if (part.sequence) {
      styling.read(part.text)
      pieces[range] = `${pieces[range] as string}${part.text}`
      continue
    }
    for (const { segment } of GRAPHEMES.segment(part.text)) {
      if (!drawn[range]) {
        drawn[range] = true
        pieces[range] = `${restores[range] as string}${pieces[range] as string}`
      }
      pieces[range] = `${pieces[range] as string}${segment}`
      column += visibleWidth(segment)
      advance()
    }
  }
  return pieces
}
