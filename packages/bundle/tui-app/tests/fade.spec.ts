/** The streaming fade: the ramp, its three encodings, the wall-clock tail state, the block clocks, and the recolor transforms. */

import { describe, expect, it } from 'vitest'
import type { RgbColor } from '@earendil-works/pi-tui'
import { AssistantBlock } from '../src/blocks.ts'
import {
  BlockFadeClock,
  FADE_STEPS,
  FADE_TICK_MS,
  FadeRegistry,
  FadeTracker,
  buildFadeRamp,
  fadeSgr,
  mixFadeColor,
  recolorLines,
  recolorTail,
  resolveFadeCapability,
  type FadeStyle,
} from '../src/fade.ts'
import { createPalette } from '../src/style.ts'

const BLACK: RgbColor = { r: 0, g: 0, b: 0 }
const WHITE: RgbColor = { r: 255, g: 255, b: 255 }
const INK: RgbColor = { r: 200, g: 100, b: 50 }

/** Truecolor style over a black-to-INK ramp of the default length. */
const COLOR: FadeStyle = { capability: 'truecolor', ramp: buildFadeRamp(BLACK, INK) }

/** Two-level style; its ramp is never read. */
const DIM_STYLE: FadeStyle = { capability: 'dim', ramp: [] }

/** The truecolor sequence one age opens with. */
function sgrAt(age: number): string {
  return fadeSgr(COLOR, age)
}

/** Relative luminance of one ramp level, for the monotonicity checks. */
function luminance(color: RgbColor): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
}

/** Truecolor foregrounds a recolor overlay wrote. */
function fadeRgbs(text: string): RgbColor[] {
  return [...text.matchAll(/\u001b\[38;2;(\d+);(\d+);(\d+)m/g)].map(([, r, g, b]) => ({
    r: Number(r),
    g: Number(g),
    b: Number(b),
  }))
}

/** A palette-colored card glyph, as ToolBlock draws the status mark. */
const YELLOW_GLYPH = '\u001b[33m\u25cf\u001b[39m'

/** Dim italic reasoning, as AssistantBlock wraps streamed reasoning. */
const DIM_REASONING = '\u001b[2m\u001b[3mhello world\u001b[23m\u001b[22m'

/**
 * A clock the spec moves by hand, standing in for the application's wall clock.
 * @returns the clock's reader and the mover that steps it.
 */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let ms = 1_000
  return { now: () => ms, advance: (by: number) => { ms += by } }
}

describe('defaults', () => {
  it('ships eight brightness levels, each lasting 33ms', () => {
    expect(FADE_STEPS).toBe(8)
    expect(FADE_TICK_MS).toBe(33)
  })
})

describe('buildFadeRamp', () => {
  it('eases the levels with smoothstep and mixes them in linear light', () => {
    // Level 1 of 4 sits at t = 0.25, smoothstep 0.15625 of the way from black
    // to white in linear light, which encodes back to 110 on every channel.
    expect(buildFadeRamp(BLACK, WHITE, 4)).toEqual([
      { r: 110, g: 110, b: 110 },
      { r: 188, g: 188, b: 188 },
      { r: 237, g: 237, b: 237 },
      { r: 255, g: 255, b: 255 },
    ])
  })

  it('mixes each channel on its own', () => {
    expect(buildFadeRamp(BLACK, INK, 4)).toEqual([
      { r: 85, g: 39, b: 16 },
      { r: 146, g: 71, b: 34 },
      { r: 185, g: 92, b: 46 },
      { r: 200, g: 100, b: 50 },
    ])
  })

  it('brightens every level over the one below it', () => {
    const levels = buildFadeRamp(BLACK, INK).map(luminance)
    expect(levels).toHaveLength(FADE_STEPS)
    for (const [index, level] of levels.entries()) {
      const previous = levels[index - 1]
      if (previous !== undefined) expect(level).toBeGreaterThan(previous)
    }
  })

  it('darkens every level towards a dark foreground over a light background', () => {
    const levels = buildFadeRamp(WHITE, BLACK).map(luminance)
    for (const [index, level] of levels.entries()) {
      const previous = levels[index - 1]
      if (previous !== undefined) expect(level).toBeLessThan(previous)
    }
  })

  it('ends at the foreground itself rather than a rounded interpolation of it', () => {
    const fractional: RgbColor = { r: 200.5, g: 100.5, b: 50.5 }
    expect(buildFadeRamp(BLACK, fractional).at(-1)).toEqual(fractional)
  })

  it('honours a non-default step count', () => {
    expect(buildFadeRamp(BLACK, INK, 2)).toEqual([{ r: 146, g: 71, b: 34 }, INK])
  })
})

describe('mixFadeColor', () => {
  it('returns the endpoints exactly and eases the interior with smoothstep in linear light', () => {
    expect(mixFadeColor(BLACK, WHITE, 0)).toEqual(BLACK)
    expect(mixFadeColor(BLACK, WHITE, 1)).toEqual(WHITE)
    // t = 0.25, smoothstep 0.15625 of the way from black to white in linear light.
    expect(mixFadeColor(BLACK, WHITE, 0.25)).toEqual({ r: 110, g: 110, b: 110 })
  })

  it('clamps a position outside 0..1 onto the nearer endpoint', () => {
    expect(mixFadeColor(BLACK, INK, -1)).toEqual(BLACK)
    expect(mixFadeColor(BLACK, INK, 2)).toEqual(INK)
  })
})

describe('fadeSgr', () => {
  it('writes 24-bit foreground bytes per ramp level', () => {
    expect(sgrAt(0)).toBe('\u001b[38;2;44;17;5m')
    expect(sgrAt(3)).toBe('\u001b[38;2;146;71;34m')
    expect(sgrAt(FADE_STEPS - 1)).toBe('\u001b[38;2;200;100;50m')
  })

  it('floors a fractional age onto a ramp slot so reply text keeps integer fade-in levels', () => {
    expect(fadeSgr(COLOR, 0.9)).toBe(sgrAt(0))
    expect(fadeSgr(COLOR, 3.2)).toBe(sgrAt(3))
  })

  it('draws an age past the ramp at its last level', () => {
    expect(sgrAt(FADE_STEPS + 4)).toBe(sgrAt(FADE_STEPS - 1))
  })

  it('maps a level onto the 232..255 grayscale indices', () => {
    const grays: FadeStyle = {
      capability: 'ansi256',
      ramp: [BLACK, { r: 88, g: 88, b: 88 }, { r: 138, g: 138, b: 138 }, WHITE],
    }
    expect(fadeSgr(grays, 0)).toBe('\u001b[38;5;232m')
    expect(fadeSgr(grays, 1)).toBe('\u001b[38;5;240m')
    expect(fadeSgr(grays, 2)).toBe('\u001b[38;5;245m')
    expect(fadeSgr(grays, 3)).toBe('\u001b[38;5;255m')
  })

  it('weights a colored level by luminance before picking a gray', () => {
    const colored: FadeStyle = { capability: 'ansi256', ramp: [{ r: 0, g: 120, b: 0 }] }
    // 0.7152 * 120 is 85.8: the nearest gray value is 88, index 240.
    expect(fadeSgr(colored, 0)).toBe('\u001b[38;5;240m')
  })

  it('draws the two youngest ages faint and every later age as rendered', () => {
    expect(fadeSgr(DIM_STYLE, 0)).toBe('\u001b[2m')
    expect(fadeSgr(DIM_STYLE, 1)).toBe('\u001b[2m')
    expect(fadeSgr(DIM_STYLE, 2)).toBe('')
    expect(fadeSgr(DIM_STYLE, 7)).toBe('')
  })

  it('writes nothing without a capability, and nothing for a ramp with no levels', () => {
    expect(fadeSgr({ capability: 'none', ramp: COLOR.ramp }, 0)).toBe('')
    expect(fadeSgr({ capability: 'truecolor', ramp: [] }, 0)).toBe('')
  })
})

describe('resolveFadeCapability', () => {
  const enabled = { paletteEnabled: true, reducedMotion: false }

  it('drops the ramp for NO_COLOR, a disabled palette, and reduced motion', () => {
    expect(resolveFadeCapability({ ...enabled, env: { NO_COLOR: '1', COLORTERM: 'truecolor' } })).toBe('none')
    expect(resolveFadeCapability({ paletteEnabled: false, reducedMotion: false, env: { COLORTERM: 'truecolor' } })).toBe('none')
    expect(resolveFadeCapability({ paletteEnabled: true, reducedMotion: true, env: { COLORTERM: 'truecolor' } })).toBe('none')
  })

  it('treats an empty NO_COLOR as unset', () => {
    expect(resolveFadeCapability({ ...enabled, env: { NO_COLOR: '', COLORTERM: 'truecolor' } })).toBe('truecolor')
  })

  it('reads COLORTERM for 24-bit terminals without regard to case', () => {
    expect(resolveFadeCapability({ ...enabled, env: { COLORTERM: 'truecolor' } })).toBe('truecolor')
    expect(resolveFadeCapability({ ...enabled, env: { COLORTERM: '24bit' } })).toBe('truecolor')
    expect(resolveFadeCapability({ ...enabled, env: { COLORTERM: 'TrueColor', TERM: 'xterm-256color' } })).toBe('truecolor')
  })

  it('falls back to grayscale indices for a 256-color TERM', () => {
    expect(resolveFadeCapability({ ...enabled, env: { TERM: 'xterm-256color' } })).toBe('ansi256')
    expect(resolveFadeCapability({ ...enabled, env: { TERM: 'screen-256color', COLORTERM: '' } })).toBe('ansi256')
  })

  it('falls back to the two-level mode for every other terminal', () => {
    expect(resolveFadeCapability({ ...enabled, env: { TERM: 'xterm' } })).toBe('dim')
    expect(resolveFadeCapability({ ...enabled, env: {} })).toBe('dim')
  })

  it('draws no ramp on a dumb terminal', () => {
    expect(resolveFadeCapability({ ...enabled, env: { TERM: 'dumb', COLORTERM: 'truecolor' } })).toBe('none')
  })
})

describe('FadeTracker chunking', () => {
  it('splits a delta into words, each keeping the whitespace that follows it', () => {
    const tracker = new FadeTracker({ now: clock().now })
    tracker.append('one two three')
    expect(tracker.spans()).toEqual([
      { text: 'one ', age: 0 },
      { text: 'two ', age: 0 },
      { text: 'three', age: 0 },
    ])
  })

  it('holds a word open across deltas that split it, keeping the moment it first appeared', () => {
    const time = clock()
    const tracker = new FadeTracker({ stepMs: 10, now: time.now })
    tracker.append('Hel')
    expect(tracker.spans()).toEqual([{ text: 'Hel', age: 0 }])
    time.advance(10)
    tracker.append('lo wor')
    expect(tracker.spans()).toEqual([
      { text: 'Hello ', age: 1 },
      { text: 'wor', age: 0 },
    ])
    tracker.append('ld ')
    expect(tracker.spans()).toEqual([
      { text: 'Hello ', age: 1 },
      { text: 'world ', age: 0 },
    ])
  })

  it('closes a word that ends on whitespace, so the next delta starts a new chunk', () => {
    const time = clock()
    const tracker = new FadeTracker({ stepMs: 10, now: time.now })
    tracker.append('done ')
    time.advance(10)
    tracker.append('next')
    expect(tracker.spans()).toEqual([
      { text: 'done ', age: 1 },
      { text: 'next', age: 0 },
    ])
  })

  it('carries a whitespace-only delta into the word that follows it', () => {
    const tracker = new FadeTracker({ now: clock().now })
    tracker.append('  ')
    expect(tracker.spans()).toEqual([{ text: '  ', age: 0 }])
    tracker.append('hi')
    expect(tracker.spans()).toEqual([{ text: '  hi', age: 0 }])
  })

  it('ignores an empty delta', () => {
    const tracker = new FadeTracker({ now: clock().now })
    tracker.append('')
    expect(tracker.spans()).toEqual([])
  })

  it('splits a newline like any other boundary', () => {
    const tracker = new FadeTracker({ now: clock().now })
    tracker.append('first\n\nsecond')
    expect(tracker.spans()).toEqual([
      { text: 'first\n\n', age: 0 },
      { text: 'second', age: 0 },
    ])
  })
})

describe('FadeTracker wall-clock ages', () => {
  it('reads every chunk at the level its own elapsed time asks for', () => {
    const time = clock()
    const tracker = new FadeTracker({ stepMs: 20, now: time.now })
    tracker.append('early ')
    time.advance(20)
    tracker.append('late ')
    time.advance(20)
    // One instant, two levels: the words appeared 20 ms apart and stay a level apart.
    expect(tracker.spans()).toEqual([
      { text: 'early ', age: 2 },
      { text: 'late ', age: 1 },
    ])
  })

  it('brightens a chunk between two periods, so a delta-driven render draws the fractional age the clock reached', () => {
    const time = clock()
    const tracker = new FadeTracker({ stepMs: 20, now: time.now })
    tracker.append('word ')
    time.advance(30)
    expect(tracker.spans()).toEqual([{ text: 'word ', age: 1.5 }])
    time.advance(10)
    expect(tracker.spans()).toEqual([{ text: 'word ', age: 2 }])
  })

  it('drops a chunk from the tail once the whole fade has elapsed', () => {
    const time = clock()
    const tracker = new FadeTracker({ steps: 4, stepMs: 20, now: time.now })
    tracker.append('alpha ')
    time.advance(20 * 3)
    expect(tracker.tick()).toBe(true)
    expect(tracker.spans()).toEqual([{ text: 'alpha ', age: 3 }])
    time.advance(20)
    expect(tracker.tick()).toBe(false)
    expect(tracker.spans()).toEqual([])
  })

  it('asks for a repaint until the chunk has used the full steps * stepMs duration', () => {
    const time = clock()
    const tracker = new FadeTracker({ steps: 3, stepMs: 20, now: time.now })
    tracker.append('word ')
    expect(tracker.needsRepaint()).toBe(true)
    expect(tracker.tick()).toBe(true)
    time.advance(20)
    expect(tracker.needsRepaint()).toBe(true)
    time.advance(20)
    expect(tracker.needsRepaint()).toBe(true)
    time.advance(20)
    expect(tracker.needsRepaint()).toBe(false)
    expect(tracker.tick()).toBe(false)
  })

  it('needs no repaint with an empty tail', () => {
    const tracker = new FadeTracker({ now: clock().now })
    expect(tracker.needsRepaint()).toBe(false)
    expect(tracker.tick()).toBe(false)
  })

  it('starts a fresh chunk once an open word has left the tail', () => {
    const time = clock()
    const tracker = new FadeTracker({ steps: 2, stepMs: 20, now: time.now })
    tracker.append('abc')
    time.advance(20)
    expect(tracker.spans()).toEqual([{ text: 'abc', age: 1 }])
    time.advance(20)
    tracker.tick()
    expect(tracker.spans()).toEqual([])
    tracker.append('def')
    expect(tracker.spans()).toEqual([{ text: 'def', age: 0 }])
  })

  it('keeps chunks of one instant together and ages a later one apart', () => {
    const time = clock()
    const tracker = new FadeTracker({ stepMs: 20, now: time.now })
    tracker.append('one ')
    tracker.append('two ')
    time.advance(20)
    tracker.append('three ')
    expect(tracker.spans()).toEqual([
      { text: 'one ', age: 1 },
      { text: 'two ', age: 1 },
      { text: 'three ', age: 0 },
    ])
  })
})

describe('FadeTracker flush', () => {
  it('drops the whole tail and tracks again from the next delta', () => {
    const tracker = new FadeTracker({ now: clock().now })
    tracker.append('hello ')
    tracker.append('world')
    expect(tracker.spans()).toHaveLength(2)
    tracker.flush()
    expect(tracker.spans()).toEqual([])
    expect(tracker.needsRepaint()).toBe(false)
    tracker.append('again')
    expect(tracker.spans()).toEqual([{ text: 'again', age: 0 }])
  })

  it('does not rejoin the word that was open when the tail was flushed', () => {
    const tracker = new FadeTracker({ now: clock().now })
    tracker.append('par')
    tracker.flush()
    tracker.append('tial')
    expect(tracker.spans()).toEqual([{ text: 'tial', age: 0 }])
  })
})

describe('BlockFadeClock', () => {
  it('reports a fractional age from elapsed time over the full duration', () => {
    const time = clock()
    const fade = new BlockFadeClock({ bornAt: time.now(), stepMs: 20, steps: 4, now: time.now })
    expect(fade.age()).toBe(0)
    expect(fade.progress()).toBe(0)
    time.advance(10)
    expect(fade.age()).toBe(0.5)
    expect(fade.progress()).toBe(0.125)
    time.advance(10)
    expect(fade.age()).toBe(1)
    time.advance(30)
    expect(fade.age()).toBe(2.5)
    expect(fade.progress()).toBe(0.625)
    const early = new BlockFadeClock({ bornAt: time.now() + 40, stepMs: 20, steps: 4, now: time.now })
    expect(early.progress()).toBe(0)
    expect(early.age()).toBe(0)
  })

  it('settles at t >= 1 so the block draws in the colors it rendered itself', () => {
    const time = clock()
    const fade = new BlockFadeClock({ bornAt: time.now(), stepMs: 20, steps: 4, now: time.now })
    expect(fade.needsRepaint()).toBe(true)
    time.advance(20 * 4 - 1)
    expect(fade.age()).toBeCloseTo(3.95, 5)
    expect(fade.progress()).toBeCloseTo(0.9875, 5)
    expect(fade.needsRepaint()).toBe(true)
    time.advance(1)
    expect(fade.age()).toBeUndefined()
    expect(fade.progress()).toBe(1)
    expect(fade.needsRepaint()).toBe(false)
  })
})

describe('FadeRegistry', () => {
  /**
   * A member that reports what the spec last set on it.
   * @param moving - whether it starts out still brightening.
   * @returns the member, with its flag open for the spec to move.
   */
  function member(moving: boolean): { needsRepaint(): boolean; moving: boolean } {
    return { moving, needsRepaint() { return this.moving } }
  }

  it('needs a repaint while any member still moves', () => {
    const registry = new FadeRegistry()
    expect(registry.needsRepaint()).toBe(false)
    registry.add(member(false))
    expect(registry.needsRepaint()).toBe(false)
    registry.add(member(true))
    expect(registry.needsRepaint()).toBe(true)
  })

  it('forgets the members that settled and keeps the ones that have not', () => {
    const registry = new FadeRegistry()
    const first = member(true)
    const second = member(true)
    registry.add(first)
    registry.add(second)
    first.moving = false
    registry.tick()
    expect(registry.needsRepaint()).toBe(true)
    second.moving = false
    registry.tick()
    // Both are forgotten, so neither is followed if it reports movement again.
    second.moving = true
    expect(registry.needsRepaint()).toBe(false)
  })

  it('forgets every member when the terminal draws another session', () => {
    const registry = new FadeRegistry()
    registry.add(member(true))
    registry.clear()
    expect(registry.needsRepaint()).toBe(false)
  })
})

describe('recolorLines', () => {
  it('floats each run from a lifted color toward the palette color it settles in', () => {
    const painted = recolorLines([YELLOW_GLYPH], 0, COLOR)
    const colors = fadeRgbs(painted[0] ?? '')
    expect(colors.length).toBeGreaterThan(0)
    expect(luminance(colors[0] ?? BLACK)).toBeGreaterThan(luminance(INK))
    expect(painted[0]).toContain('\u001b[33m')
    expect(painted[0]?.endsWith('\u001b[39m')).toBe(true)
  })

  it('recedes continuously rather than snapping between fade-in ramp slots', () => {
    const luma = (age: number): number => luminance(fadeRgbs(recolorLines([YELLOW_GLYPH], age, COLOR)[0] ?? '')[0] ?? BLACK)
    expect(luma(1)).toBeGreaterThan(luma(3))
    expect(luma(3)).toBeGreaterThan(luma(5))
    expect(recolorLines([YELLOW_GLYPH], 3, COLOR)[0]).not.toContain(sgrAt(0))
    expect(recolorLines([YELLOW_GLYPH], 3, COLOR)[0]).not.toContain(sgrAt(1))
  })

  it('returns the original lines at t >= 1, byte-identical to the unfaded component output', () => {
    expect(recolorLines([YELLOW_GLYPH], COLOR.ramp.length, COLOR)).toEqual([YELLOW_GLYPH])
    expect(recolorLines([YELLOW_GLYPH], COLOR.ramp.length + 2, COLOR)).toEqual([YELLOW_GLYPH])
  })

  it('keeps the last overlay near the settled palette color rather than leaping to the fade-in background', () => {
    const start = fadeRgbs(recolorLines([YELLOW_GLYPH], 0, COLOR)[0] ?? '')[0] ?? BLACK
    const almost = fadeRgbs(recolorLines([YELLOW_GLYPH], COLOR.ramp.length - 0.1, COLOR)[0] ?? '')[0] ?? BLACK
    const settled = recolorLines([YELLOW_GLYPH], COLOR.ramp.length, COLOR)
    expect(settled).toEqual([YELLOW_GLYPH])
    expect(luminance(almost)).toBeLessThan(luminance(start))
    expect(luminance(almost)).toBeGreaterThan(luminance(COLOR.ramp[0] ?? BLACK) + 40)
  })

  it('leaves empty lines alone, so the blank rows around a card are never repainted', () => {
    const painted = recolorLines(['', YELLOW_GLYPH, ''], 1, COLOR)
    expect(painted[0]).toBe('')
    expect(painted[2]).toBe('')
    expect(fadeRgbs(painted[1] ?? '').length).toBeGreaterThan(0)
  })

  it('returns copies when the style writes nothing', () => {
    const lines = ['a card row']
    expect(recolorLines(lines, 0, { capability: 'none', ramp: COLOR.ramp })).toEqual(lines)
    expect(recolorLines(lines, 0, { capability: 'none', ramp: COLOR.ramp })).not.toBe(lines)
    expect(recolorLines(lines, 0, { capability: 'truecolor', ramp: [] })).toEqual(lines)
  })

  it('leaves the lines before the first repaintable one in the colors they were drawn in', () => {
    const painted = recolorLines(['above', YELLOW_GLYPH], 0, COLOR, 1)
    expect(painted[0]).toBe('above')
    expect(fadeRgbs(painted[1] ?? '').length).toBeGreaterThan(0)
    expect(recolorLines(['above', YELLOW_GLYPH], 0, COLOR, 2)).toEqual(['above', YELLOW_GLYPH])
  })

  it('keeps the two-level overlay on for the whole flight, then the caller hands off to settled bytes', () => {
    expect(recolorLines(['row'], 0, DIM_STYLE)).toEqual(['\u001b[2mrow\u001b[22m'])
    expect(recolorLines(['row'], 7, DIM_STYLE)).toEqual(['\u001b[2mrow\u001b[22m'])
    expect(recolorLines(['', 'row', ''], 0, DIM_STYLE)).toEqual(['', '\u001b[2mrow\u001b[22m', ''])
    expect(recolorLines(['above', 'row'], 0, DIM_STYLE, 1)).toEqual(['above', '\u001b[2mrow\u001b[22m'])
  })

  it('reads 256-color, truecolor, and default-foreground runs as their settled RGB', () => {
    const indexed = recolorLines(['\u001b[38;5;196mred\u001b[39m'], 0, COLOR)
    expect(fadeRgbs(indexed[0] ?? '').length).toBeGreaterThan(0)
    const direct = recolorLines(['\u001b[38;2;10;20;30mdirect\u001b[39m'], 0, COLOR)
    const last = fadeRgbs(recolorLines(['\u001b[38;2;10;20;30mdirect\u001b[39m'], 7.9, COLOR)[0] ?? '')[0]
    expect(last?.r).toBeLessThan((fadeRgbs(direct[0] ?? '')[0]?.r ?? 0) + 1)
    expect(last?.r).toBeGreaterThan(8)
    const dimmed = recolorLines(['\u001b[2mbody\u001b[22m'], 0, COLOR)
    expect(luminance(fadeRgbs(dimmed[0] ?? '')[0] ?? BLACK)).toBeGreaterThan(luminance(INK) - 1)
    const bright = recolorLines(['\u001b[91mhi\u001b[39m'], 0, COLOR)
    expect(fadeRgbs(bright[0] ?? '').length).toBeGreaterThan(0)
    const reset = recolorLines(['\u001b[31mred\u001b[0mplain'], 7.9, COLOR)
    expect(reset[0]).toContain('plain')
    const grayIndexed = recolorLines(['\u001b[38;5;240mgray\u001b[39m'], 0, COLOR)
    expect(fadeRgbs(grayIndexed[0] ?? '').length).toBeGreaterThan(0)
    const sixteen = recolorLines(['\u001b[38;5;1mansi\u001b[39m'], 0, COLOR)
    expect(fadeRgbs(sixteen[0] ?? '').length).toBeGreaterThan(0)
    const background = recolorLines(['\u001b[48;2;1;2;3m\u001b[31mred\u001b[39m'], 0, COLOR)
    expect(fadeRgbs(background[0] ?? '').length).toBeGreaterThan(0)
    const cube = recolorLines(['\u001b[38;5;208morange\u001b[39m'], 0, COLOR)
    expect(fadeRgbs(cube[0] ?? '').length).toBeGreaterThan(0)
    const dimOff = recolorLines(['\u001b[2m\u001b[22mbody'], 0, COLOR)
    expect(dimOff[0]).toContain('body')
    expect(fadeRgbs(recolorLines(['plain'], 0, COLOR)[0] ?? '').length).toBeGreaterThan(0)
    expect(fadeRgbs(recolorLines(['\u001b[mreset'], 0, COLOR)[0] ?? '').length).toBeGreaterThan(0)
    expect(fadeRgbs(recolorLines(['\u001b[38mloose\u001b[39m'], 0, COLOR)[0] ?? '').length).toBeGreaterThan(0)
    expect(fadeRgbs(recolorLines(['\u001b[38;2mshort\u001b[39m'], 0, COLOR)[0] ?? '').length).toBeGreaterThan(0)
    expect(fadeRgbs(recolorLines(['\u001b[38;9mother\u001b[39m'], 0, COLOR)[0] ?? '').length).toBeGreaterThan(0)
    expect(fadeRgbs(recolorLines(['\u001b[48;5;0m\u001b[32mgreen\u001b[39m'], 0, COLOR)[0] ?? '').length).toBeGreaterThan(0)
    expect(fadeRgbs(recolorLines(['\u001b[48;9m\u001b[32mgreen\u001b[39m'], 0, COLOR)[0] ?? '').length).toBeGreaterThan(0)
    expect(fadeRgbs(recolorLines(['\u001b[38;5mclip\u001b[39m'], 0, COLOR)[0] ?? '').length).toBeGreaterThan(0)
    expect(fadeRgbs(recolorLines(['\u001b[1;32mgreen\u001b[39m'], 0, COLOR)[0] ?? '').length).toBeGreaterThan(0)
    expect(fadeRgbs(recolorLines(['\u001b[;31mred\u001b[39m'], 0, COLOR)[0] ?? '').length).toBeGreaterThan(0)
  })

  it('encodes a float-out mix as a 256-color index, not a fade-in gray slot', () => {
    const gray: FadeStyle = { capability: 'ansi256', ramp: buildFadeRamp(BLACK, WHITE) }
    const painted = recolorLines([YELLOW_GLYPH], 0, gray)[0] ?? ''
    expect(painted).toMatch(/\u001b\[38;5;\d+m/)
    expect(painted).not.toContain('\u001b[38;2;')
    expect(recolorLines([YELLOW_GLYPH], gray.ramp.length, gray)).toEqual([YELLOW_GLYPH])
  })
})

describe('recolorTail', () => {
  it('recolors the trailing columns one chunk covers', () => {
    expect(recolorTail(['hello world'], [{ text: 'world', age: 0 }], COLOR)).toEqual([
      `hello ${sgrAt(0)}world\u001b[39m`,
    ])
  })

  it('gives each age its own run, oldest leftmost', () => {
    const spans = [{ text: 'hello ', age: 2 }, { text: 'world', age: 0 }]
    expect(recolorTail(['hello world'], spans, COLOR)).toEqual([
      `${sgrAt(2)}hello ${sgrAt(0)}world\u001b[39m`,
    ])
  })

  it('merges chunks that share an age into one run', () => {
    const spans = [{ text: 'foo ', age: 0 }, { text: 'bar', age: 0 }]
    expect(recolorTail(['foo bar'], spans, COLOR)).toEqual([`${sgrAt(0)}foo bar\u001b[39m`])
  })

  it('steps over the escape sequences the markdown renderer already emitted', () => {
    const rendered = '\u001b[1mbold\u001b[22m tail'
    expect(recolorTail([rendered], [{ text: 'tail', age: 1 }], COLOR)).toEqual([
      `\u001b[1mbold\u001b[22m ${sgrAt(1)}\u001b[1m\u001b[22mtail\u001b[39m`,
    ])
  })

  it('counts wide characters as the two columns they occupy', () => {
    expect(recolorTail(['ab\u4f60\u597d'], [{ text: '\u4f60\u597d', age: 0 }], COLOR)).toEqual([
      `ab${sgrAt(0)}\u4f60\u597d\u001b[39m`,
    ])
  })

  it('follows a chunk across the line break the renderer wrapped it at', () => {
    const spans = [{ text: 'hello ', age: 1 }, { text: 'world', age: 0 }]
    expect(recolorTail(['hello', 'world'], spans, COLOR)).toEqual([
      `${sgrAt(1)}hello\u001b[39m`,
      `${sgrAt(0)}world\u001b[39m`,
    ])
  })

  it('steps over the blank lines a block renders around its body', () => {
    expect(recolorTail(['', 'hello world', ''], [{ text: 'world', age: 0 }], COLOR)).toEqual([
      '',
      `hello ${sgrAt(0)}world\u001b[39m`,
      '',
    ])
  })

  it('returns the lines the tail does not reach unchanged', () => {
    const lines = ['settled paragraph', '', 'hello world']
    const painted = recolorTail(lines, [{ text: 'world', age: 0 }], COLOR)
    expect(painted[0]).toBe(lines[0])
    expect(painted[1]).toBe(lines[1])
  })

  it('draws a chunk the renderer rewrote at the foreground, together with every older chunk', () => {
    const spans = [{ text: '**bold** ', age: 3 }, { text: 'and ', age: 1 }, { text: 'tail', age: 0 }]
    expect(recolorTail(['bold and tail'], spans, COLOR)).toEqual([
      `bold ${sgrAt(1)}and ${sgrAt(0)}tail\u001b[39m`,
    ])
  })

  it('draws the whole tail at the foreground when the newest chunk is missing', () => {
    const lines = ['nothing alike']
    expect(recolorTail(lines, [{ text: 'first ', age: 1 }, { text: 'absent', age: 0 }], COLOR)).toEqual(lines)
  })

  it('returns the lines untouched without a capability, without a tail, and without lines', () => {
    const lines = ['hello world']
    expect(recolorTail(lines, [{ text: 'world', age: 0 }], { capability: 'none', ramp: COLOR.ramp })).toEqual(lines)
    expect(recolorTail(lines, [], COLOR)).toEqual(lines)
    expect(recolorTail([], [{ text: 'world', age: 0 }], COLOR)).toEqual([])
  })

  it('floors a fractional age onto the fade-in ramp so reply text keeps integer slots', () => {
    expect(recolorTail(['hello world'], [{ text: 'world', age: 0.9 }], COLOR)).toEqual([
      `hello ${sgrAt(0)}world\u001b[39m`,
    ])
  })
})

describe('recolorTail float-out', () => {
  it('starts brighter than the dim settle and recedes, then returns the original dim italic bytes', () => {
    const young = recolorTail([DIM_REASONING], [{ text: 'world', age: 0 }], COLOR, 0, 'out')
    const mid = recolorTail([DIM_REASONING], [{ text: 'world', age: 4 }], COLOR, 0, 'out')
    const last = recolorTail([DIM_REASONING], [{ text: 'world', age: 7.9 }], COLOR, 0, 'out')
    const done = recolorTail([DIM_REASONING], [{ text: 'world', age: 8 }], COLOR, 0, 'out')
    const youngLuma = luminance(fadeRgbs(young[0] ?? '')[0] ?? BLACK)
    const midLuma = luminance(fadeRgbs(mid[0] ?? '')[0] ?? BLACK)
    const lastLuma = luminance(fadeRgbs(last[0] ?? '')[0] ?? BLACK)
    expect(youngLuma).toBeGreaterThan(midLuma)
    expect(midLuma).toBeGreaterThan(lastLuma)
    expect(lastLuma).toBeGreaterThan(luminance(COLOR.ramp[0] ?? BLACK) + 20)
    expect(done).toEqual([DIM_REASONING])
  })

  it('keeps the two-level overlay on the tail for the whole flight, then the caller drops the spans', () => {
    const young = recolorTail([DIM_REASONING], [{ text: 'world', age: 0 }], DIM_STYLE, 0, 'out')
    expect(young[0]).toContain('\u001b[2m')
    expect(young).not.toEqual([DIM_REASONING])
    expect(recolorTail([DIM_REASONING], [], DIM_STYLE, 0, 'out')).toEqual([DIM_REASONING])
    expect(recolorTail([DIM_REASONING], [{ text: 'world', age: 0 }], { capability: 'none', ramp: COLOR.ramp }, 0, 'out')).toEqual([DIM_REASONING])
    expect(recolorTail([DIM_REASONING], [{ text: 'world', age: 0 }], { capability: 'truecolor', ramp: [] }, 0, 'out')).toEqual([DIM_REASONING])
    expect(recolorTail([DIM_REASONING], [{ text: 'world', age: 8 }], { capability: 'ansi256', ramp: COLOR.ramp }, 0, 'out')).toEqual([DIM_REASONING])
    expect(recolorTail([DIM_REASONING], [{ text: 'world', age: 0 }], { capability: 'ansi256', ramp: COLOR.ramp }, 0, 'out')[0]).toMatch(/\u001b\[38;5;\d+m/)
  })
})

describe('recolorTail restore', () => {
  it('ends only the foreground, so an enclosing bold survives the recolored run', () => {
    const rendered = '\u001b[1mbold tail'
    expect(recolorTail([rendered], [{ text: 'tail', age: 0 }], COLOR)).toEqual([
      `\u001b[1mbold ${sgrAt(0)}\u001b[1mtail\u001b[39m`,
    ])
  })

  it('keeps the line closing sequences the renderer emitted ahead of the restore', () => {
    const rendered = 'plain \u001b[1mbold\u001b[22m'
    expect(recolorTail([rendered], [{ text: 'bold', age: 0 }], COLOR)).toEqual([
      `plain ${sgrAt(0)}\u001b[1mbold\u001b[22m\u001b[39m`,
    ])
  })

  it('ends intensity in the two-level mode, which also ends an enclosing bold', () => {
    const rendered = '\u001b[1mbold tail'
    expect(recolorTail([rendered], [{ text: 'tail', age: 0 }], DIM_STYLE)).toEqual([
      '\u001b[1mbold \u001b[2m\u001b[1mtail\u001b[22m',
    ])
  })
})

describe('tracker and transform together', () => {
  it('brightens the trailing edge as time passes and settles it byte-identically', () => {
    const time = clock()
    const tracker = new FadeTracker({ steps: 3, stepMs: 20, now: time.now })
    const style: FadeStyle = { capability: 'truecolor', ramp: buildFadeRamp(BLACK, WHITE, 3) }
    const lines = ['the quick brown fox']
    tracker.append('the quick brown ')
    time.advance(20)
    tracker.append('fox')
    expect(recolorTail(lines, tracker.spans(), style)).toEqual([
      `${fadeSgr(style, 1)}the quick brown ${fadeSgr(style, 0)}fox\u001b[39m`,
    ])
    time.advance(20)
    expect(recolorTail(lines, tracker.spans(), style)).toEqual([
      `${fadeSgr(style, 2)}the quick brown ${fadeSgr(style, 1)}fox\u001b[39m`,
    ])
    time.advance(20)
    tracker.tick()
    expect(tracker.spans()).toEqual([{ text: 'fox', age: 2 }])
    time.advance(20)
    tracker.tick()
    expect(tracker.spans()).toEqual([])
    expect(recolorTail(lines, tracker.spans(), style)).toEqual(lines)
  })

  it('reports no change from a floor once reasoning has receded past the duration', () => {
    const block = new AssistantBlock({ palette: createPalette(false), toolPreviewLines: 2 }, 1)
    block.appendReasoning('thinking hard')
    block.setReasoningFade({
      spans: () => [{ text: 'hard', age: 5 }],
      style: () => DIM_STYLE,
      steps: 5,
      flush: () => {},
    })
    expect(block.setRepaintFloor(2)).toBe(false)
  })

  it('floats a card clock out without a settle snap: t >= 1 is the original lines', () => {
    const time = clock()
    const fade = new BlockFadeClock({ bornAt: time.now(), stepMs: 20, steps: 4, now: time.now })
    const startAge = fade.age()
    expect(startAge).toBe(0)
    const start = recolorLines([YELLOW_GLYPH], startAge ?? 0, COLOR)
    time.advance(20 * 4 - 1)
    const almostAge = fade.age()
    expect(almostAge).toBeDefined()
    const almost = recolorLines([YELLOW_GLYPH], almostAge ?? 0, COLOR)
    time.advance(1)
    expect(fade.age()).toBeUndefined()
    expect(recolorLines([YELLOW_GLYPH], COLOR.ramp.length, COLOR)).toEqual([YELLOW_GLYPH])
    const startLuma = luminance(fadeRgbs(start[0] ?? '')[0] ?? BLACK)
    const almostLuma = luminance(fadeRgbs(almost[0] ?? '')[0] ?? BLACK)
    expect(almostLuma).toBeLessThan(startLuma)
    expect(almostLuma).toBeGreaterThan(luminance(COLOR.ramp[0] ?? BLACK) + 40)
    expect(almost).not.toEqual([YELLOW_GLYPH])
  })
})
