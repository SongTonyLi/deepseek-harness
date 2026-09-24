/** The growing-text component that rewraps only its last paragraph, against pi-tui's own `Text`. */

import { describe, expect, it } from 'vitest'
import { Text } from '@earendil-works/pi-tui'
import { createPalette } from '../src/style.ts'
import { TailWrappedText } from '../src/tail-wrap.ts'

const WORDS = ['think', 'about', 'the', 'file', 'carefully,', 'then', 'change', 'one', 'line', '中文宽字', '👍🏽', '\t', 'a-very-long-unbroken-token-that-must-split']

describe('TailWrappedText', () => {
  it('draws what Text draws while the text grows, styled or plain', () => {
    let seed = 11
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % limit
    }
    for (const color of [false, true]) {
      const palette = createPalette(color)
      const style = (text: string): string => palette.dim(palette.italic(text))
      const grown = new TailWrappedText()
      let raw = ''
      for (let step = 0; step < 200; step += 1) {
        raw += random(8) === 0 ? '\n' : `${WORDS[random(WORDS.length)] as string} `
        const width = [12, 30, 80][random(3)] as number
        grown.setText(style(raw.trimEnd()))
        const text = new Text(style(raw.trimEnd()), 0, 0)
        expect(grown.render(width), JSON.stringify({ raw, width })).toEqual(text.render(width))
      }
    }
  })

  it('falls back to a full wrap when an earlier line carries its own styling, and draws nothing for blank text', () => {
    const grown = new TailWrappedText()
    const styled = 'plain \u001b[1mbold\u001b[22m\nnext line'
    grown.setText(styled)
    expect(grown.render(8)).toEqual(new Text(styled, 0, 0).render(8))
    grown.setText('  ')
    expect(grown.render(8)).toEqual([])
    grown.setText('one\ntwo')
    // The same head at a new width wraps again; the same head at the same width is kept.
    expect(grown.render(4)).toEqual(new Text('one\ntwo', 0, 0).render(4))
    grown.setText('one\ntwo three')
    expect(grown.render(4)).toEqual(new Text('one\ntwo three', 0, 0).render(4))
    grown.setText('one\ntwo')
    const first = grown.render(8)
    expect(grown.render(8)).toBe(first)
    grown.invalidate()
    expect(grown.render(8)).toEqual(first)
    expect(grown.render(8)).not.toBe(first)
  })
})
