/** The streaming fade: the ramp, its three encodings, the wall-clock tail state, the block clocks, and the recolor transforms. */

import { describe, expect, it } from 'vitest'
import type { RgbColor } from '@earendil-works/pi-tui'
import {
  BlockFadeClock,
  FADE_STEPS,
  FADE_TICK_MS,
  FadeRegistry,
  FadeTracker,
  buildFadeRamp,
  fadeSgr,
  recolorLines,
  recolorTail,
  resolveFadeCapability,
  type FadeStyle,
} from '../src/fade.ts'

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

describe('fadeSgr', () => {
  it('writes 24-bit foreground bytes per ramp level', () => {
    expect(sgrAt(0)).toBe('\u001b[38;2;44;17;5m')
    expect(sgrAt(3)).toBe('\u001b[38;2;146;71;34m')
    expect(sgrAt(FADE_STEPS - 1)).toBe('\u001b[38;2;200;100;50m')
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

  it('brightens a chunk between two periods, so a delta-driven render draws the level the clock reached', () => {
    const time = clock()
    const tracker = new FadeTracker({ stepMs: 20, now: time.now })
    tracker.append('word ')
    time.advance(30)
    expect(tracker.spans()).toEqual([{ text: 'word ', age: 1 }])
    time.advance(10)
    expect(tracker.spans()).toEqual([{ text: 'word ', age: 2 }])
  })

  it('drops a chunk from the tail once the whole fade has elapsed', () => {
    const time = clock()
    const tracker = new FadeTracker({ steps: 4, stepMs: 20, now: time.now })
    tracker.append('alpha ')
    time.advance(20 * 3)
    expect(tracker.tick()).toBe(false)
    expect(tracker.spans()).toEqual([{ text: 'alpha ', age: 3 }])
    time.advance(20)
    tracker.tick()
    expect(tracker.spans()).toEqual([])
  })

  it('asks for a repaint only while a chunk still draws below the last level', () => {
    const time = clock()
    const tracker = new FadeTracker({ steps: 3, stepMs: 20, now: time.now })
    tracker.append('word ')
    expect(tracker.needsRepaint()).toBe(true)
    expect(tracker.tick()).toBe(true)
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
  it('reports the level the elapsed time asks for', () => {
    const time = clock()
    const fade = new BlockFadeClock({ bornAt: time.now(), stepMs: 20, steps: 4, now: time.now })
    expect(fade.age()).toBe(0)
    time.advance(20)
    expect(fade.age()).toBe(1)
    time.advance(30)
    expect(fade.age()).toBe(2)
  })

  it('withholds the last level, so the block settles into the colors it rendered itself', () => {
    const time = clock()
    const fade = new BlockFadeClock({ bornAt: time.now(), stepMs: 20, steps: 4, now: time.now })
    expect(fade.needsRepaint()).toBe(true)
    time.advance(20 * 3)
    expect(fade.age()).toBeUndefined()
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
  it('opens the level and re-asserts it after every sequence the line already carries', () => {
    const line = '\u001b[33m\u25cf\u001b[39m \u001b[1mbash\u001b[22m'
    expect(recolorLines([line], 0, COLOR)).toEqual([
      `${sgrAt(0)}\u001b[33m${sgrAt(0)}\u25cf\u001b[39m${sgrAt(0)} \u001b[1m${sgrAt(0)}bash\u001b[22m${sgrAt(0)}\u001b[39m`,
    ])
  })

  it('leaves empty lines alone, so the blank rows around a card are never repainted', () => {
    expect(recolorLines(['', 'body', ''], 1, COLOR)).toEqual(['', `${sgrAt(1)}body\u001b[39m`, ''])
  })

  it('returns copies when the style writes nothing for this level', () => {
    const lines = ['a card row']
    expect(recolorLines(lines, 0, { capability: 'none', ramp: COLOR.ramp })).toEqual(lines)
    expect(recolorLines(lines, 4, DIM_STYLE)).toEqual(lines)
    expect(recolorLines(lines, 4, DIM_STYLE)).not.toBe(lines)
  })

  it('leaves the lines before the first repaintable one in the colors they were drawn in', () => {
    expect(recolorLines(['above', 'inside'], 0, COLOR, 1)).toEqual(['above', `${sgrAt(0)}inside\u001b[39m`])
    expect(recolorLines(['above', 'inside'], 0, COLOR, 2)).toEqual(['above', 'inside'])
  })

  it('ends the two-level mode with the sequence that restores intensity', () => {
    expect(recolorLines(['row'], 0, DIM_STYLE)).toEqual(['\u001b[2mrow\u001b[22m'])
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

  it('leaves the columns of an age the two-level mode no longer dims alone', () => {
    const spans = [{ text: 'aa ', age: 3 }, { text: 'bb', age: 0 }]
    expect(recolorTail(['aa bb'], spans, DIM_STYLE)).toEqual(['aa \u001b[2mbb\u001b[22m'])
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
})
