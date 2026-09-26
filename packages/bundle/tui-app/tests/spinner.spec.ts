/** Working-indicator frames and the activity-word shimmer. */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { SPINNER_MS, shimmer, spinnerFrame } from '../src/spinner.ts'
import { createPalette } from '../src/style.ts'

describe('spinner', () => {
  it('steps one braille frame per period and wraps after the last', () => {
    expect(spinnerFrame(0)).toBe('⠋')
    expect(spinnerFrame(SPINNER_MS - 1)).toBe('⠋')
    expect(spinnerFrame(SPINNER_MS)).toBe('⠙')
    expect(spinnerFrame(SPINNER_MS * 9)).toBe('⠏')
    expect(spinnerFrame(SPINNER_MS * 10)).toBe('⠋')
  })

  it('sweeps a bold character with plain neighbours across dim text', () => {
    const on = createPalette(true)
    expect(shimmer(on, 'thinking', 0)).toBe(`${on.bold('t')}h${on.dim('inking')}`)
    expect(shimmer(on, 'thinking', SPINNER_MS * 3)).toBe(`${on.dim('th')}i${on.bold('n')}k${on.dim('ing')}`)
    expect(visibleWidth(shimmer(on, 'thinking', SPINNER_MS * 3))).toBe(8)
  })

  it('rests past the end of the word before the next pass', () => {
    const on = createPalette(true)
    expect(shimmer(on, 'go', SPINNER_MS * 4)).toBe(on.dim('go'))
    expect(shimmer(on, 'go', SPINNER_MS * 8)).toBe(`${on.bold('g')}o`)
  })

  it('sweeps whole graphemes, so a combined character is never split', () => {
    const on = createPalette(true)
    expect(shimmer(on, 'e\u0301a', 0)).toBe(`${on.bold('e\u0301')}a`)
  })

  it('returns the text unchanged on a disabled palette', () => {
    expect(shimmer(createPalette(false), 'calling bash', SPINNER_MS * 2)).toBe('calling bash')
  })
})
