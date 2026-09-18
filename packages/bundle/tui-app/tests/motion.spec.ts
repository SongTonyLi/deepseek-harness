/** The chrome motion clock and the three-level lift its call sites draw with. */

import { describe, expect, it } from 'vitest'
import { LANDING_TICKS, Motion, READER_OPEN_TICKS, SEGMENT_TICKS, STEP_TICKS, pulse, type MotionLevel } from '../src/motion.ts'
import { createPalette } from '../src/style.ts'

/** The period every case measures in. */
const STEP_MS = 10

/**
 * A motion over a clock the case moves by hand.
 * @param ticks - how many periods it lasts.
 * @returns the motion and the clock that drives it.
 */
function motion(ticks = LANDING_TICKS): { clock: Motion; at: (ms: number) => void } {
  let now = 1000
  const clock = new Motion({ startedAt: now, ticks, stepMs: STEP_MS, now: () => now })
  return { clock, at: (ms) => { now = 1000 + ms } }
}

describe('Motion', () => {
  it('walks the peak, the lifted level, and the settled one across its ticks', () => {
    const { clock, at } = motion()
    const span = LANDING_TICKS * STEP_MS
    expect(clock.level()).toBe(2)
    at(span / 3 - 1)
    expect(clock.level()).toBe(2)
    at(span / 3)
    expect(clock.level()).toBe(1)
    at((span * 2) / 3 - 1)
    expect(clock.level()).toBe(1)
    at((span * 2) / 3)
    expect(clock.level()).toBe(0)
    // A settled motion stays settled however long the session runs.
    at(span * 100)
    expect(clock.level()).toBe(0)
  })

  it('stops asking for a repaint at the end of its ticks', () => {
    const { clock, at } = motion(STEP_TICKS)
    const span = STEP_TICKS * STEP_MS
    expect(clock.needsRepaint()).toBe(true)
    // The last third draws the settled level and still moves, which is what a
    // reveal grows through.
    at(span - 1)
    expect(clock.level()).toBe(0)
    expect(clock.needsRepaint()).toBe(true)
    at(span)
    expect(clock.needsRepaint()).toBe(false)
  })

  it('reports how far through it is, clamped at both ends', () => {
    const { clock, at } = motion(SEGMENT_TICKS)
    expect(clock.progress()).toBe(0)
    at(SEGMENT_TICKS * STEP_MS / 2)
    expect(clock.progress()).toBeCloseTo(0.5)
    at(SEGMENT_TICKS * STEP_MS * 3)
    expect(clock.progress()).toBe(1)
  })

  it('settles at once when it was given no length to run', () => {
    const clock = new Motion({ startedAt: 0, ticks: READER_OPEN_TICKS, stepMs: 0, now: () => 0 })
    expect(clock.progress()).toBe(1)
    expect(clock.level()).toBe(0)
    expect(clock.needsRepaint()).toBe(false)
  })
})

describe('pulse', () => {
  it('lifts the settled drawing and hands it back unchanged once settled', () => {
    const palette = createPalette(true)
    const settled = palette.dim('subagents')
    expect(pulse(palette, settled, 0)).toBe(settled)
    expect(pulse(palette, settled, 1)).toBe(`\u001b[36m${settled}\u001b[39m`)
    expect(pulse(palette, settled, 2)).toBe(`\u001b[1m\u001b[36m${settled}\u001b[39m\u001b[22m`)
  })

  it('draws every level verbatim on a terminal with no styling at all', () => {
    const plain = createPalette(false)
    for (const level of [0, 1, 2] as MotionLevel[]) expect(pulse(plain, '┃ ', level)).toBe('┃ ')
  })
})
