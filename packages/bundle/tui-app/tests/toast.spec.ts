/** The transient line: its box, its clock, and where the renderer lets it float. */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { ToastClock, ToastPane, toastDrawable, toastOverlay } from '../src/toast.ts'
import { buildFadeRamp, type FadeStyle } from '../src/fade.ts'
import { createPalette } from '../src/style.ts'

/** One line without the sequences a cut mark closes itself with. */
function plain(line: string | undefined): string {
  return (line ?? '').replaceAll(/\u001b\[[0-9;]*m/gu, '')
}

/** A ramp from black towards white, which is what a terminal that reports its background yields. */
const RAMP: FadeStyle = { capability: 'truecolor', ramp: buildFadeRamp({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 4) }

/** The terminal that draws no ramp at all. */
const NO_RAMP: FadeStyle = { capability: 'none', ramp: [] }

/**
 * One pane at full strength.
 * @param text - what the line says.
 * @param color - whether the palette emits SGR.
 * @returns the pane.
 */
function pane(text: string, color = false): ToastPane {
  return new ToastPane(text, { palette: createPalette(color), age: () => undefined, style: () => NO_RAMP })
}

describe('the box', () => {
  it('draws three lines of exactly the render width and pads the text across the middle one', () => {
    const lines = pane('stopping').render(30)
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(visibleWidth(line)).toBe(30)
    expect(lines[0]).toBe(`╭${'─'.repeat(28)}╮`)
    expect(lines[1]).toBe(`│ stopping${' '.repeat(19)}│`)
    expect(lines[2]).toBe(`╰${'─'.repeat(28)}╯`)
  })

  it('cuts a line the width cannot hold, and still fills the width', () => {
    const lines = pane('press Esc again to stop turn 3').render(16)
    expect(plain(lines[1])).toBe('│ press Esc ag…│')
    for (const line of lines) expect(visibleWidth(line)).toBe(16)
  })

  it('never draws narrower than its own frame', () => {
    for (const line of pane('x').render(1)) expect(visibleWidth(line)).toBe(4)
  })

  it('styles every line through the palette', () => {
    const lines = pane('dim me', true).render(20)
    for (const line of lines) expect(line.startsWith('\u001b[2m')).toBe(true)
  })

  it('recolors the whole box while it fades out', () => {
    const fading = new ToastPane('fading', { palette: createPalette(true), age: () => 1, style: () => RAMP })
    const settled = new ToastPane('fading', { palette: createPalette(true), age: () => 4, style: () => RAMP })
    expect(fading.render(20)).not.toEqual(settled.render(20))
    // Past the last level the box comes back in the colors it settles in.
    expect(settled.render(20)).toEqual(pane('fading', true).render(20))
    fading.invalidate()
  })
})

describe('where the box may float', () => {
  it('asks for at least its own text and keeps the terminal\'s own share otherwise', () => {
    const options = toastOverlay('press Ctrl+C again to quit', () => true)
    expect(options.minWidth).toBe('press Ctrl+C again to quit'.length + 3)
    expect(options.width).toBe('40%')
    expect(options.anchor).toBe('top-right')
    expect(options.nonCapturing).toBe(true)
    expect(options.visible?.(80, 24)).toBe(true)
  })

  it('draws only while the viewport\'s own first lines are still repaintable', () => {
    expect(toastDrawable(0)).toBe(true)
    expect(toastDrawable(1)).toBe(true)
    expect(toastDrawable(2)).toBe(false)
  })
})

/**
 * One clock over a hand-stepped instant.
 * @param options - the hold, the fade, and whether the terminal draws a ramp.
 * @returns the clock and the setter that moves its instant.
 */
function clockAt(options: { holdMs?: number; fading?: boolean } = {}): { clock: ToastClock; at: (ms: number) => void } {
  let now = 1000
  const clock = new ToastClock({
    shownAt: now,
    holdMs: options.holdMs ?? 2000,
    steps: 4,
    stepMs: 50,
    fading: options.fading ?? true,
    now: () => now,
  })
  return { clock, at: (ms) => { now = 1000 + ms } }
}

describe('the clock', () => {
  it('holds at full strength, then fades, then expires', () => {
    const { clock, at } = clockAt()
    expect(clock.lifetimeMs()).toBe(2200)
    expect(clock.age()).toBeUndefined()
    expect(clock.needsRepaint()).toBe(true)
    at(1999)
    expect(clock.age()).toBeUndefined()
    at(2000)
    expect(clock.age()).toBe(0)
    at(2100)
    expect(clock.age()).toBe(2)
    expect(clock.expired()).toBe(false)
    at(2200)
    expect(clock.expired()).toBe(true)
    expect(clock.needsRepaint()).toBe(false)
  })

  it('settles at once for a line that came down early', () => {
    const { clock } = clockAt()
    expect(clock.needsRepaint()).toBe(true)
    clock.settle()
    expect(clock.expired()).toBe(true)
    expect(clock.needsRepaint()).toBe(false)
  })

  it('has no fade phase at all on a terminal that draws no ramp', () => {
    const { clock, at } = clockAt({ fading: false })
    expect(clock.lifetimeMs()).toBe(2000)
    at(1999)
    expect(clock.expired()).toBe(false)
    at(2000)
    expect(clock.expired()).toBe(true)
  })
})
