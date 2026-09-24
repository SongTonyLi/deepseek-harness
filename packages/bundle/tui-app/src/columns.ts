/**
 * Cutting a rendered line at several columns in one pass.
 *
 * pi-tui's `sliceByColumn` walks a line from its first character on every
 * call, so a fade that recolors `n` runs of one line with it reads that line
 * about `2n` times on every frame. {@link sliceColumns} reads it once and
 * returns every piece, each exactly what `sliceByColumn` returns for the same
 * range: the escape sequences inside the range, and every sequence before the
 * range ahead of its first grapheme, so a piece drawn after recolored text
 * restores the line's own styling.
 * @module @deepseek-ai/dsh-tui-app/columns
 */

import { visibleWidth } from '@earendil-works/pi-tui'

/** Grapheme segmenter for the text between escape sequences. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

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

/**
 * Cut `line` into the column ranges between consecutive cuts.
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
  // Every sequence read before the walk reached a range's first column.
  const before = starts.map(() => '')
  let sequences = ''
  let column = 0
  let range = 0
  let reached = 1
  const advance = (): void => {
    while (range + 1 < starts.length && (starts[range + 1] as number) <= column) range += 1
    while (reached < starts.length && (starts[reached] as number) <= column) {
      before[reached] = sequences
      reached += 1
    }
  }
  const append = (text: string): void => {
    pieces[range] = `${pieces[range] as string}${text}`
  }
  advance()
  let index = 0
  while (index < line.length) {
    const length = escapeLength(line, index)
    if (length > 0) {
      const sequence = line.slice(index, index + length)
      sequences += sequence
      append(sequence)
      index += length
      continue
    }
    let end = index + 1
    while (end < line.length && escapeLength(line, end) === 0) end += 1
    for (const { segment } of GRAPHEMES.segment(line.slice(index, end))) {
      if (!drawn[range]) {
        drawn[range] = true
        append(before[range] as string)
      }
      append(segment)
      column += visibleWidth(segment)
      advance()
    }
    index = end
  }
  return pieces
}
