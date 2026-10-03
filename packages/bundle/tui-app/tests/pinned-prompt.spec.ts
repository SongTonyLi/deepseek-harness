/** The prompt row the reader pins: the glyph, collapsed whitespace, the ellipsis, and the band. */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { pinnedPromptRow } from '../src/pinned-prompt.ts'
import { createPalette } from '../src/style.ts'

/** A palette that returns its text unchanged, so a spec reads the drawn columns. */
const PLAIN = createPalette(false)

/** A palette that draws the prompt band. */
const COLOR = createPalette(true)

/** The prompt band's own opening sequence. */
const BAND = '\u001b[48;5;236m'

describe('pinnedPromptRow', () => {
  it('leads with the prompt glyph and collapses every row and run of whitespace to one line', () => {
    expect(pinnedPromptRow(PLAIN, ['fix the fade', '  at \t the top  '], 40)).toBe(' \u276f fix the fade at the top ')
  })

  it('cuts a prompt wider than the bar with an ellipsis', () => {
    const row = stripTerminalSequences(pinnedPromptRow(PLAIN, ['first line', 'second line with extra text'], 24))
    expect(row).toBe(' \u276f first line second li\u2026')
    expect(visibleWidth(row)).toBe(24)
  })

  it('fills the whole width on the prompt band while colour is on, and pads nothing without it', () => {
    expect(pinnedPromptRow(COLOR, ['run the tests'], 20)).toBe(`${BAND} \u276f run the tests    \u001b[49m`)
    expect(pinnedPromptRow(PLAIN, ['run the tests'], 20)).toBe(' \u276f run the tests ')
  })
})
