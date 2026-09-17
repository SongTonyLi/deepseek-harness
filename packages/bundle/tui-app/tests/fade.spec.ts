/** The streaming fade: the ramp, its three encodings, the tail state, and the ANSI-aware recolor over rendered lines. */

import { describe, expect, it } from 'vitest'
import type { RgbColor } from '@earendil-works/pi-tui'
import {
  FADE_FAST_WINDOW_TICKS,
  FADE_STEPS,
  FADE_TICK_MS,
  FadeTracker,
  buildFadeRamp,
  fadeSgr,
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

describe('defaults', () => {
  it('ships five brightness levels, a 40ms tick, and a ten-tick fast-stream window', () => {
    expect(FADE_STEPS).toBe(5)
    expect(FADE_TICK_MS).toBe(40)
    expect(FADE_FAST_WINDOW_TICKS).toBe(10)
  })
})

describe('buildFadeRamp', () => {
  it('interpolates from the background towards the foreground in even steps', () => {
    expect(buildFadeRamp({ r: 20, g: 20, b: 20 }, { r: 220, g: 220, b: 220 })).toEqual([
      { r: 60, g: 60, b: 60 },
      { r: 100, g: 100, b: 100 },
      { r: 140, g: 140, b: 140 },
      { r: 180, g: 180, b: 180 },
      { r: 220, g: 220, b: 220 },
    ])
  })

  it('mixes each channel on its own', () => {
    expect(buildFadeRamp(BLACK, INK)).toEqual([
      { r: 40, g: 20, b: 10 },
      { r: 80, g: 40, b: 20 },
      { r: 120, g: 60, b: 30 },
      { r: 160, g: 80, b: 40 },
      { r: 200, g: 100, b: 50 },
    ])
  })

  it('ends at the foreground itself rather than a rounded interpolation of it', () => {
    const fractional: RgbColor = { r: 200.5, g: 100.5, b: 50.5 }
    const ramp = buildFadeRamp(BLACK, fractional)
    expect(ramp.at(-1)).toEqual(fractional)
    expect(ramp.at(-1)).toEqual({ r: 200.5, g: 100.5, b: 50.5 })
  })

  it('honours a non-default step count', () => {
    expect(buildFadeRamp(BLACK, { r: 90, g: 60, b: 30 }, 3)).toEqual([
      { r: 30, g: 20, b: 10 },
      { r: 60, g: 40, b: 20 },
      { r: 90, g: 60, b: 30 },
    ])
    expect(buildFadeRamp(BLACK, INK, 2)).toEqual([{ r: 100, g: 50, b: 25 }, INK])
  })
})

describe('fadeSgr', () => {
  it('writes 24-bit foreground bytes per ramp level', () => {
    expect(sgrAt(0)).toBe('\u001b[38;2;40;20;10m')
    expect(sgrAt(3)).toBe('\u001b[38;2;160;80;40m')
    expect(sgrAt(4)).toBe('\u001b[38;2;200;100;50m')
  })

  it('draws an age past the ramp at its last level', () => {
    expect(sgrAt(9)).toBe(sgrAt(4))
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
    const tracker = new FadeTracker()
    tracker.append('one two three')
    expect(tracker.spans()).toEqual([
      { text: 'one ', age: 0 },
      { text: 'two ', age: 0 },
      { text: 'three', age: 0 },
    ])
  })

  it('holds a word open across deltas that split it, keeping the tick it first appeared', () => {
    const tracker = new FadeTracker()
    tracker.append('Hel')
    expect(tracker.spans()).toEqual([{ text: 'Hel', age: 0 }])
    tracker.tick()
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
    const tracker = new FadeTracker()
    tracker.append('done ')
    tracker.tick()
    tracker.append('next')
    expect(tracker.spans()).toEqual([
      { text: 'done ', age: 1 },
      { text: 'next', age: 0 },
    ])
  })

  it('carries a whitespace-only delta into the word that follows it', () => {
    const tracker = new FadeTracker()
    tracker.append('  ')
    expect(tracker.spans()).toEqual([{ text: '  ', age: 0 }])
    tracker.append('hi')
    expect(tracker.spans()).toEqual([{ text: '  hi', age: 0 }])
  })

  it('ignores an empty delta', () => {
    const tracker = new FadeTracker()
    tracker.append('')
    expect(tracker.spans()).toEqual([])
  })

  it('splits a newline like any other boundary', () => {
    const tracker = new FadeTracker()
    tracker.append('first\n\nsecond')
    expect(tracker.spans()).toEqual([
      { text: 'first\n\n', age: 0 },
      { text: 'second', age: 0 },
    ])
  })
})

describe('FadeTracker tail membership', () => {
  it('ages every chunk one level per tick and drops it at the step count', () => {
    const tracker = new FadeTracker()
    tracker.append('alpha ')
    for (let age = 1; age < FADE_STEPS; age += 1) {
      tracker.tick()
      expect(tracker.spans()).toEqual([{ text: 'alpha ', age }])
    }
    tracker.tick()
    expect(tracker.spans()).toEqual([])
  })

  it('asks for a repaint only while a chunk still draws below the last level', () => {
    const tracker = new FadeTracker({ steps: 3 })
    tracker.append('word ')
    expect(tracker.needsRepaint()).toBe(true)
    expect(tracker.tick()).toBe(true)
    expect(tracker.needsRepaint()).toBe(true)
    expect(tracker.tick()).toBe(true)
    expect(tracker.spans()).toEqual([{ text: 'word ', age: 2 }])
    expect(tracker.needsRepaint()).toBe(false)
    expect(tracker.tick()).toBe(false)
    expect(tracker.spans()).toEqual([])
  })

  it('needs no repaint with an empty tail', () => {
    const tracker = new FadeTracker()
    expect(tracker.needsRepaint()).toBe(false)
    expect(tracker.tick()).toBe(false)
  })

  it('starts a fresh chunk once an open word has left the tail', () => {
    const tracker = new FadeTracker({ steps: 2 })
    tracker.append('abc')
    tracker.tick()
    expect(tracker.spans()).toEqual([{ text: 'abc', age: 1 }])
    tracker.tick()
    expect(tracker.spans()).toEqual([])
    tracker.append('def')
    expect(tracker.spans()).toEqual([{ text: 'def', age: 0 }])
  })

  it('keeps chunks of one tick together and ages a later one apart', () => {
    const tracker = new FadeTracker()
    tracker.append('one ')
    tracker.append('two ')
    tracker.tick()
    tracker.append('three ')
    expect(tracker.spans()).toEqual([
      { text: 'one ', age: 1 },
      { text: 'two ', age: 1 },
      { text: 'three ', age: 0 },
    ])
  })
})

describe('FadeTracker fast streams', () => {
  it('turns the effect off once every tick of the window has received a chunk', () => {
    const tracker = new FadeTracker({ fastWindowTicks: 3 })
    for (let tick = 0; tick < 3; tick += 1) {
      tracker.append(`chunk${tick} `)
      tracker.tick()
    }
    expect(tracker.spans()).toHaveLength(3)
    tracker.append('sustained ')
    expect(tracker.spans()).toEqual([])
    expect(tracker.needsRepaint()).toBe(false)
  })

  it('keeps the effect off while the rate holds', () => {
    const tracker = new FadeTracker({ fastWindowTicks: 2 })
    for (let tick = 0; tick < 4; tick += 1) {
      tracker.append('fast ')
      tracker.tick()
    }
    tracker.append('still fast ')
    expect(tracker.spans()).toEqual([])
  })

  it('fades again after one tick without an arrival', () => {
    const tracker = new FadeTracker({ fastWindowTicks: 3 })
    for (let tick = 0; tick < 4; tick += 1) {
      tracker.append('fast ')
      tracker.tick()
    }
    tracker.tick()
    tracker.append('slow ')
    expect(tracker.spans()).toEqual([{ text: 'slow ', age: 0 }])
  })

  it('leaves a partly-faded tail alone at the moment it turns off, so nothing darkens', () => {
    const tracker = new FadeTracker({ fastWindowTicks: 2 })
    tracker.append('early ')
    tracker.tick()
    tracker.append('later ')
    tracker.tick()
    expect(tracker.spans()).toHaveLength(2)
    tracker.append('burst ')
    expect(tracker.spans()).toEqual([])
  })
})

describe('FadeTracker flush', () => {
  it('drops the whole tail and tracks again from the next delta', () => {
    const tracker = new FadeTracker()
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
    const tracker = new FadeTracker()
    tracker.append('par')
    tracker.flush()
    tracker.append('tial')
    expect(tracker.spans()).toEqual([{ text: 'tial', age: 0 }])
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
  it('brightens the trailing edge one tick at a time and settles it byte-identically', () => {
    const tracker = new FadeTracker({ steps: 3 })
    const ramp = buildFadeRamp(BLACK, WHITE, 3)
    const style: FadeStyle = { capability: 'truecolor', ramp }
    const lines = ['the quick brown fox']
    tracker.append('the quick brown ')
    tracker.tick()
    tracker.append('fox')
    expect(recolorTail(lines, tracker.spans(), style)).toEqual([
      `${fadeSgr(style, 1)}the quick brown ${fadeSgr(style, 0)}fox\u001b[39m`,
    ])
    tracker.tick()
    expect(recolorTail(lines, tracker.spans(), style)).toEqual([
      `${fadeSgr(style, 2)}the quick brown ${fadeSgr(style, 1)}fox\u001b[39m`,
    ])
    tracker.tick()
    expect(tracker.spans()).toEqual([{ text: 'fox', age: 2 }])
    tracker.tick()
    expect(tracker.spans()).toEqual([])
    expect(recolorTail(lines, tracker.spans(), style)).toEqual(lines)
  })
})
