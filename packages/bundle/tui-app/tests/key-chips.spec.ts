/** Key chips: which key names a text draws as chips, the bytes each presses, and the cells the screens keep for them. */

import { describe, expect, it } from 'vitest'
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeyId } from '@earendil-works/pi-tui'
import { EMPTY_KEY_FRAME, keyAt, keyBytes, paintKeys, takeKeyFrame, takeKeySpots } from '../src/key-chips.ts'
import { HINTS, KEY_LINES } from '../src/keys.ts'
import { READER_HINTS } from '../src/reader.ts'
import { createPalette } from '../src/style.ts'

/** Draws no color and marks every chip. */
const clickable = createPalette(false, true)

/** The keys a text draws as chips, left to right, with the bytes each presses. */
function chips(text: string, vocabulary: 'legend' | 'prose' = 'legend'): [string, string][] {
  const { line, spots } = takeKeySpots(paintKeys(clickable, text, value => value, vocabulary))
  return spots.map(spot => [line.slice(spot.from, spot.to), spot.bytes])
}

/** The labels a text draws as chips. */
function labels(text: string, vocabulary: 'legend' | 'prose' = 'legend'): string[] {
  return chips(text, vocabulary).map(([label]) => label)
}

describe('keyBytes', () => {
  it('sends the bytes pi-tui reads as the key each chip names', () => {
    const named: [string, KeyId][] = [
      ['Esc', 'escape'],
      ['Enter', 'enter'],
      ['Tab', 'tab'],
      ['Space', 'space'],
      ['PgUp', 'pageUp'],
      ['PgDn', 'pageDown'],
      ['Home', 'home'],
      ['End', 'end'],
      ['Shift+Tab', 'shift+tab'],
      ['Shift+Enter', 'shift+enter'],
      ['Ctrl+G', 'ctrl+g'],
      ['Ctrl+O', 'ctrl+o'],
      ['Ctrl+C', 'ctrl+c'],
      ['↑', 'up'],
      ['↓', 'down'],
      ['←', 'left'],
      ['→', 'right'],
      ['Shift+↑', 'shift+up'],
      ['Shift+↓', 'shift+down'],
      ['Shift+←', 'shift+left'],
      ['Shift+→', 'shift+right'],
    ]
    for (const [label, key] of named) expect(matchesKey(keyBytes(label) ?? '', key), label).toBe(true)
  })

  it('types a single-character key as itself', () => {
    for (const key of ['j', 'k', 'E', 'I', 'q', 'b', '?', '/', '@', '[', ']']) expect(keyBytes(key)).toBe(key)
  })

  it('presses nothing for a name outside the vocabulary', () => {
    for (const name of ['Alt+X', 'Ctrl+g', 'x', 'constructor', '', 'Shift+A']) expect(keyBytes(name)).toBeUndefined()
  })
})

describe('paintKeys', () => {
  it('finds every key the legends name, in drawing order', () => {
    expect(labels(HINTS.transcript[0] as string)).toEqual(['↑', '↓', '←', '→', 'Space', 'Ctrl+G', 'Esc'])
    expect(labels(HINTS.queue[0] as string)).toEqual(['↑', '↓', 'Enter', 'E', 'I', 'Esc'])
    expect(labels(READER_HINTS.list[0])).toEqual(['↑', '↓', 'j', 'k', 'PgUp', 'PgDn', '[', ']', '→', '/', 'Esc', 'q'])
    expect(labels(READER_HINTS.pane[0])).toEqual(['↑', '↓', 'j', 'k', 'PgUp', 'PgDn', 'Space', 'b', '[', ']', '←', 'Esc', 'q'])
    expect(labels('Enter, Esc, or ← returns')).toEqual(['Enter', 'Esc', '←'])
    expect(labels('Shift+Tab effort list · Shift+←→ words')).toEqual(['Shift+Tab', 'Shift+←', '→'])
  })

  it('shifts both arrows of a shifted pair and splits every pair into one chip per key', () => {
    expect(chips('Shift+↑↓ nav')).toEqual([['Shift+↑', '\u001b[1;2A'], ['↓', '\u001b[1;2B']])
    expect(chips('↑↓ jk')).toEqual([['↑', '\u001b[A'], ['↓', '\u001b[B'], ['j', 'j'], ['k', 'k']])
  })

  it('draws a key only as a whole token', () => {
    expect(labels('Escape Entered Ctrl+Gx a/b ↑10k ↓3 (Ctrl+S steers) Esc.')).toEqual(['Ctrl+S', 'Esc'])
  })

  it('leaves the single-character keys out of prose', () => {
    expect(labels('press Esc; E and I and / and ? stay text', 'prose')).toEqual(['Esc'])
    expect(labels('press Esc; E and I and / and ? stay text')).toEqual(['Esc', 'E', 'I', '/', '?'])
  })

  it('styles the chips apart from the text around them and keeps the width', () => {
    const palette = createPalette(true)
    const painted = paintKeys(palette, 'Ctrl+G reader · Esc input')
    expect(painted).toBe(
      '\u001b[3m\u001b[36mCtrl+G\u001b[39m\u001b[23m\u001b[2m reader · \u001b[22m\u001b[3m\u001b[36mEsc\u001b[39m\u001b[23m\u001b[2m input\u001b[22m',
    )
    expect(paintKeys(palette, 'no keys here', palette.link)).toBe('\u001b[38;5;141mno keys here\u001b[39m')
    expect(visibleWidth(paintKeys(createPalette(true, true), 'Ctrl+G reader · Esc input'))).toBe(visibleWidth('Ctrl+G reader · Esc input'))
  })

  it('draws a chip italic in the accent color with no underline, behind the mark a click on it resolves', () => {
    const chip = '\u001b[3m\u001b[36mCtrl+O\u001b[39m\u001b[23m'
    expect(paintKeys(createPalette(true), 'Ctrl+O')).toBe(chip)
    const marked = paintKeys(createPalette(true, true), 'Ctrl+O')
    expect(marked).toBe(`\u001b_dsh-key;6;Ctrl+O\u0007${chip}`)
    expect(takeKeySpots(marked)).toEqual({ line: chip, spots: [{ from: 0, to: 6, bytes: '\u000f' }] })
  })

  it('marks a chip only on a palette whose keys are clickable', () => {
    expect(paintKeys(createPalette(false), 'Esc input')).toBe('Esc input')
    expect(paintKeys(clickable, 'Esc input')).not.toBe('Esc input')
    expect(takeKeySpots(paintKeys(clickable, 'Esc input')).line).toBe('Esc input')
  })

  it('keeps every key of the help lines clickable after wrapping', () => {
    for (const line of Object.values(KEY_LINES).flat()) {
      const painted = paintKeys(clickable, line)
      const wrapped = wrapTextWithAnsi(painted, 24).map(takeKeySpots)
      expect(wrapped.flatMap(part => part.spots)).toHaveLength(takeKeySpots(painted).spots.length)
    }
  })
})

describe('takeKeySpots', () => {
  it('returns a line with no mark as it is', () => {
    expect(takeKeySpots('plain')).toEqual({ line: 'plain', spots: [] })
  })

  it('counts columns past styling and wide characters', () => {
    const painted = `\u001b[1m全角\u001b[22m ${paintKeys(clickable, 'Esc')}`
    expect(takeKeySpots(painted)).toEqual({ line: '\u001b[1m全角\u001b[22m Esc', spots: [{ from: 5, to: 8, bytes: '\u001b' }] })
  })

  it('removes a mark naming a key outside the vocabulary without a spot', () => {
    expect(takeKeySpots('a\u001b_dsh-key;3;Alt+X\u0007Alt b')).toEqual({ line: 'aAlt b', spots: [] })
  })

  it('ends a chip the width cut short at the end of the line', () => {
    const cut = truncateToWidth(paintKeys(clickable, 'press Ctrl+C again'), 9, '…')
    const { spots } = takeKeySpots(cut)
    expect(spots).toEqual([{ from: 6, to: 9, bytes: '\u0003' }])
    const gone = truncateToWidth(paintKeys(clickable, 'press Ctrl+C again'), 6, '')
    expect(takeKeySpots(gone).spots).toEqual([])
  })
})

describe('a key frame', () => {
  it('keeps the keys of each line by its index and answers the key under a cell', () => {
    const { lines, keys } = takeKeyFrame(['plain', paintKeys(clickable, 'go · Esc input'), paintKeys(clickable, '↑↓')])
    expect(lines).toEqual(['plain', 'go · Esc input', '↑↓'])
    expect(keyAt(keys, 1, 5)).toBe('\u001b')
    expect(keyAt(keys, 1, 7)).toBe('\u001b')
    expect(keyAt(keys, 1, 8)).toBeUndefined()
    expect(keyAt(keys, 1, 4)).toBeUndefined()
    expect(keyAt(keys, 2, 0)).toBe('\u001b[A')
    expect(keyAt(keys, 2, 1)).toBe('\u001b[B')
    expect(keyAt(keys, 0, 0)).toBeUndefined()
    expect(keyAt(EMPTY_KEY_FRAME, 1, 5)).toBeUndefined()
  })
})
