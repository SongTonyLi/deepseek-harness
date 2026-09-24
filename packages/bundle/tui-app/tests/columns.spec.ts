/** Cutting a rendered line at several columns in one pass, against pi-tui's own column slice. */

import { describe, expect, it } from 'vitest'
import { sliceByColumn } from '@earendil-works/pi-tui'
import { sliceColumns } from '../src/columns.ts'

/**
 * The pieces pi-tui's slice returns for the same cuts, the last one running past the line's end.
 * @param line - the rendered line.
 * @param cuts - ascending columns.
 * @returns one piece per range.
 */
function sliced(line: string, cuts: readonly number[]): string[] {
  const starts = [0, ...cuts]
  return starts.map((start, index) => sliceByColumn(line, start, (starts[index + 1] ?? start + 1_000) - start))
}

const LINES = [
  '',
  'plain ascii text',
  '\u001b[2m\u001b[3mdim italic\u001b[23m\u001b[22m tail',
  '\u001b[38;2;10;20;30mcolour\u001b[39m and 中文宽字 mixed',
  'emoji 👍🏽 and é combining',
  '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007 after',
  'unterminated \u001b[ sequence and \u001b]8;; open',
  '\u001b[1mbold\u001b[22m',
  'tab\there',
  '\u001b_cursor\u0007marker and \u001b]8;;https://example.com\u001b\\st link\u001b]8;;\u001b\\ end',
  'escape \u001bX not a sequence, \u001b_ unterminated',
]

describe('sliceColumns', () => {
  it('cuts every line exactly as pi-tui slices each range', () => {
    let seed = 7
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % limit
    }
    for (const line of LINES) {
      for (let trial = 0; trial < 60; trial += 1) {
        const cuts = Array.from({ length: random(6) }, () => random(30)).sort((a, b) => a - b)
        expect(sliceColumns(line, cuts), JSON.stringify({ line, cuts })).toEqual(sliced(line, cuts))
      }
    }
  })

  it('returns the whole line as one piece with no cuts', () => {
    expect(sliceColumns('\u001b[2mhi\u001b[22m', [])).toEqual(['\u001b[2mhi\u001b[22m'])
  })
})
