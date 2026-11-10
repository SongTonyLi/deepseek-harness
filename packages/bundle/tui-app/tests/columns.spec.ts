/** Cutting a rendered line at several columns in one pass, each piece opening with the styling in force at its cut. */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { lineParts, sgrChanges, sliceColumns } from '../src/columns.ts'

/** A 24-bit foreground. */
function fg(r: number, g: number, b: number): string {
  return `\u001b[38;2;${String(r)};${String(g)};${String(b)}m`
}

const RESET_FG = '\u001b[39m'

/** A highlighted code line: one color per token, each closed before the next opens. */
const HIGHLIGHTED = [
  `${fg(255, 123, 114)}const${RESET_FG} `,
  `${fg(210, 168, 255)}step${RESET_FG} `,
  `${fg(230, 237, 243)}=${RESET_FG} `,
  `${fg(121, 192, 255)}11${RESET_FG}`,
].join('')

/** Lines the alignment property is checked over. */
const LINES = [
  '',
  'plain ascii text',
  '\u001b[2m\u001b[3mdim italic\u001b[23m\u001b[22m tail',
  `${fg(10, 20, 30)}colour${RESET_FG} and 中文宽字 mixed`,
  'emoji 👍🏽 and é combining 👨‍👩‍👧 family',
  '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007 after',
  'unterminated \u001b[ sequence and \u001b]8;; open',
  '\u001b[1mbold\u001b[22m',
  'tab\there',
  '\u001b_cursor\u0007marker and \u001b]8;;https://example.com\u001b\\st link\u001b]8;;\u001b\\ end',
  'escape \u001bX not a sequence, \u001b_ unterminated',
  HIGHLIGHTED,
]

/**
 * The visible width of each column range, as the cuts ask for it and the
 * line can fill it: a grapheme counts in the range its first column is in.
 * @param line - the rendered line.
 * @param cuts - ascending columns.
 * @returns the width each piece should draw.
 */
function rangeWidths(line: string, cuts: readonly number[]): number[] {
  const starts = [0, ...cuts]
  const widths = starts.map(() => 0)
  let column = 0
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(stripTerminalSequences(line))) {
    let range = 0
    while (range + 1 < starts.length && (starts[range + 1] as number) <= column) range += 1
    widths[range] = (widths[range] as number) + visibleWidth(segment)
    column += visibleWidth(segment)
  }
  return widths
}

describe('sliceColumns', () => {
  it('opens each piece after a cut with only the latest foreground, however many colors came before', () => {
    // Cut before `step`, inside `=`'s gap, and before `11`: each piece opens
    // with the one foreground in force there, never the history behind it.
    const pieces = sliceColumns(HIGHLIGHTED, [6, 8, 13])
    expect(pieces).toEqual([
      `${fg(255, 123, 114)}const${RESET_FG} `,
      `${fg(210, 168, 255)}st`,
      `${fg(210, 168, 255)}ep${RESET_FG} ${fg(230, 237, 243)}=${RESET_FG} `,
      `${fg(121, 192, 255)}11${RESET_FG}`,
    ])
    for (const piece of pieces.slice(1)) expect(piece.match(/\u001b\[38;/gu)?.length ?? 0).toBeLessThanOrEqual(2)
  })

  it('styles a range with the color sequence that sits exactly at its cut', () => {
    // `step` starts at column 6, where its own color is written: the restore
    // of what was in force there comes first, so the token keeps its color.
    const line = `${fg(230, 237, 243)}a = ${fg(210, 168, 255)}step${RESET_FG}`
    expect(sliceColumns(line, [4])).toEqual([
      `${fg(230, 237, 243)}a = `,
      `${fg(230, 237, 243)}${fg(210, 168, 255)}step${RESET_FG}`,
    ])
  })

  it('restores the attributes still in force since the last full reset, and drops the ended ones', () => {
    const line = '\u001b[1m\u001b[3mab\u001b[23mcd\u001b[48;5;236m\u001b[4mef\u001b[0mgh\u001b[9m\u001b[58;5;1mij\u001b[24;29;59mkl'
    expect(sliceColumns(line, [1, 3, 5, 7, 9, 11])).toEqual([
      '\u001b[1m\u001b[3ma',
      '\u001b[1;3mb\u001b[23mc',
      '\u001b[1md\u001b[48;5;236m\u001b[4me',
      '\u001b[1;4;48;5;236mf\u001b[0mg',
      'h\u001b[9m\u001b[58;5;1mi',
      '\u001b[9;58;5;1mj\u001b[24;29;59mk',
      'l',
    ])
  })

  it('restores the background and drops it once the line clears it', () => {
    const line = '\u001b[48;2;1;2;3m\u001b[2mab\u001b[49;22mcd'
    expect(sliceColumns(line, [1, 3])).toEqual(['\u001b[48;2;1;2;3m\u001b[2ma', '\u001b[2;48;2;1;2;3mb\u001b[49;22mc', 'd'])
    expect(sliceColumns('\u001b[101mab\u001b[49mc', [1, 2])).toEqual(['\u001b[101ma', '\u001b[101mb', '\u001b[101m\u001b[49mc'])
  })

  it('reads every SGR parameter form the line may carry', () => {
    // An empty sequence and an empty first parameter are full resets; the
    // 16-color, bright, 256-color, and default codes set the foreground; a
    // malformed extended color is restored as written; an unmodelled code is not.
    const line = '\u001b[31ma\u001b[mb\u001b[;94mc\u001b[38;5;141md\u001b[11me\u001b[38;9mf\u001b[39mg'
    expect(sliceColumns(line, [1, 2, 3, 4, 5, 6])).toEqual([
      '\u001b[31ma',
      '\u001b[31m\u001b[mb',
      '\u001b[;94mc',
      '\u001b[94m\u001b[38;5;141md',
      '\u001b[38;5;141m\u001b[11me',
      '\u001b[38;5;141m\u001b[38;9mf',
      '\u001b[38;9m\u001b[39mg',
    ])
  })

  it('reopens a hyperlink open at the cut, in its own terminator, and not one already closed', () => {
    const bel = '\u001b]8;;https://example.com\u0007'
    const st = '\u001b]8;id=1;https://example.org\u001b\\'
    expect(sliceColumns(`${bel}link\u001b]8;;\u0007 ${st}more\u001b]8;;\u001b\\`, [2, 5, 7])).toEqual([
      `${bel}li`,
      `${bel}nk\u001b]8;;\u0007 `,
      `${st}mo`,
      `${st}re\u001b]8;;\u001b\\`,
    ])
  })

  it('restores no cursor marker, erase sequence, or other non-styling sequence', () => {
    const line = '\u001b_pi:c\u0007ab\u001b[Kcd\u001b]0;title\u0007ef'
    expect(sliceColumns(line, [1, 3, 5])).toEqual(['\u001b_pi:c\u0007a', 'b\u001b[Kc', 'd\u001b]0;title\u0007e', 'f'])
  })

  it('keeps the sequences of a range no grapheme starts in, with no restore', () => {
    const line = `${fg(1, 2, 3)}ab${RESET_FG}`
    expect(sliceColumns(line, [2, 2, 9])).toEqual([`${fg(1, 2, 3)}ab`, '', RESET_FG, ''])
  })

  it('returns the whole line as one piece with no cuts', () => {
    expect(sliceColumns('\u001b[2mhi\u001b[22m', [])).toEqual(['\u001b[2mhi\u001b[22m'])
  })

  it('keeps a wide character and an emoji cluster whole, in the range its first column is in', () => {
    // 中 spans columns 2-3 and 👍🏽 columns 5-6: a cut inside either leaves it
    // whole on the left, and a cut beside it splits nothing.
    const line = `ab${fg(1, 2, 3)}中c👍🏽d`
    expect(sliceColumns(line, [3, 6])).toEqual([`ab${fg(1, 2, 3)}中`, `${fg(1, 2, 3)}c👍🏽`, `${fg(1, 2, 3)}d`])
    expect(sliceColumns(line, [2, 4, 5, 7])).toEqual([
      'ab',
      `${fg(1, 2, 3)}中`,
      `${fg(1, 2, 3)}c`,
      `${fg(1, 2, 3)}👍🏽`,
      `${fg(1, 2, 3)}d`,
    ])
  })

  it('loses no grapheme and keeps every column aligned under any cuts', () => {
    let seed = 7
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % limit
    }
    for (const line of LINES) {
      for (let trial = 0; trial < 60; trial += 1) {
        const cuts = Array.from({ length: random(6) }, () => random(30)).sort((a, b) => a - b)
        const pieces = sliceColumns(line, cuts)
        const label = JSON.stringify({ line, cuts })
        expect(pieces, label).toHaveLength(cuts.length + 1)
        expect(pieces.map(piece => stripTerminalSequences(piece)).join(''), label).toBe(stripTerminalSequences(line))
        expect(pieces.map(piece => visibleWidth(piece)), label).toEqual(rangeWidths(line, cuts))
      }
    }
  })
})

describe('lineParts', () => {
  it('splits sequences from text, and reads an unterminated sequence as text', () => {
    expect([...lineParts('a\u001b[1mb\u001b[ c\u001b]8;;x')]).toEqual([
      { text: 'a', sequence: false },
      { text: '\u001b[1m', sequence: true },
      { text: 'b\u001b[ c\u001b]8;;x', sequence: false },
    ])
  })
})

describe('sgrChanges', () => {
  it('groups each extended color with its parameters and reads an empty parameter as a reset', () => {
    expect(sgrChanges('\u001b[m')).toEqual([[0]])
    expect(sgrChanges('\u001b[;1;38;2;1;2;3;48;5;9;58;9;38m')).toEqual([[0], [1], [38, 2, 1, 2, 3], [48, 5, 9], [58, 9], [38]])
    expect(sgrChanges('\u001b[4:3m')).toEqual([[Number.NaN]])
  })
})
