/** The side-question page: what it draws, which keys it answers, and when the answer floats. */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { AsidePane, type AsideBody, type AsideRevealClock } from '../src/btw-screen.ts'
import type { FadeStyle } from '../src/fade.ts'
import { createPalette } from '../src/style.ts'

/** A palette that returns its text unchanged, so a spec reads the drawn columns. */
const PLAIN = createPalette(false)

/** Keys as the raw bytes a terminal sends. */
const KEY = {
  escape: '\u001b',
  up: '\u001b[A',
  down: '\u001b[B',
  pageUp: '\u001b[5~',
  pageDown: '\u001b[6~',
  home: '\u001b[H',
  end: '\u001b[F',
  ctrlG: '\u0007',
} as const

/** One answer line a scroll spec can find after wrapping. */
function answerLine(index: number): string {
  return `a${String(index).padStart(2, '0')}`
}

/**
 * A page a spec can resize and type into.
 * @param options - the question and the terminal size.
 * @returns the pane, how often it closed, and helpers to draw and type.
 */
function mounted(options: { question?: string; rows?: number; width?: number } = {}): {
  pane: AsidePane
  exits: number
  draw(): string
  lines(): string[]
  type(data: string): string
  setRows(rows: number): void
} {
  let rows = options.rows ?? 24
  const width = options.width ?? 80
  let exits = 0
  const pane = new AsidePane({
    palette: PLAIN,
    question: options.question ?? 'why is the fade late',
    rows: () => rows,
    onExit: () => { exits += 1 },
  })
  const lines = (): string[] => pane.render(width).map(stripTerminalSequences)
  const draw = (): string => lines().join('\n')
  draw()
  return {
    pane,
    get exits() { return exits },
    draw,
    lines,
    type(data: string): string {
      pane.handleInput(data)
      return draw()
    },
    setRows(next: number) { rows = next },
  }
}

describe('the side-question page', () => {
  it('fills the screen and opens asking, with the question pinned', () => {
    const test = mounted()
    expect(test.lines()).toHaveLength(24)
    expect(test.draw()).toContain('BTW')
    expect(test.draw()).toContain('asking')
    expect(test.draw()).toContain('question')
    expect(test.draw()).toContain('why is the fade late')
    expect(test.draw()).toContain('answer')
    expect(test.draw()).toContain('asking…')
    expect(test.draw()).toContain('Space page')
    test.setRows(12)
    expect(test.lines()).toHaveLength(12)
    test.setRows(0)
    expect(test.pane.render(80)).toHaveLength(1)
    test.pane.invalidate()
    expect(test.draw()).toContain('too small')
  })

  it('scrolls the answer and leaves the question where it was', () => {
    const lines = Array.from({ length: 30 }, (_unused, index) => answerLine(index))
    const test = mounted({ question: 'pinned question', rows: 18 })
    test.pane.show({ status: 'ready', text: lines.join('\n') })
    const top = test.draw()
    expect(top).toContain('pinned question')
    expect(top).toContain('a00')
    expect(top).not.toContain('a29')
    expect(test.type(KEY.down)).toContain('a01')
    expect(test.type('k')).toContain('a00')
    expect(test.type('j')).toContain('a01')
    expect(test.type(KEY.up)).toContain('a00')
    // A page keeps one answer line of overlap. Under this question the window is 13 rows.
    const paged = test.type(KEY.pageDown)
    expect(paged).toContain('a12')
    expect(paged).not.toContain('a00')
    const nextPage = test.type(' ')
    expect(nextPage).toContain('a29')
    expect(nextPage).not.toContain('a12')
    expect(test.type('b')).toContain('a05')
    expect(test.type(KEY.pageUp)).toContain('a00')
    expect(test.type(KEY.end)).toContain('a29')
    expect(test.type('G')).toContain('a29')
    expect(test.draw()).not.toContain('a00')
    expect(test.type(KEY.home)).toContain('a00')
    expect(test.type('g')).toContain('a00')
    expect(test.type(KEY.down)).toContain('a01')
    // A key the page claims nothing for leaves the answer where it was.
    expect(test.type('z')).toContain('a01')
    expect(test.type('\u0001')).toContain('a01')
    expect(test.draw()).toContain('pinned question')
    // Past either end the offset stays put.
    expect(test.type('g')).toContain('a00')
    expect(test.type(KEY.up)).toContain('a00')
    expect(test.type('G')).toContain('a29')
    expect(test.type(KEY.down)).toContain('a29')
    test.pane.show({ status: 'ready', text: 'only the end' })
    expect(test.draw()).toContain('only the end')
    expect(test.draw()).toContain('ready')
  })

  it('reclamps the offset when the width gives the answer a taller window', () => {
    const lines = Array.from({ length: 30 }, (_unused, index) => answerLine(index))
    let width = 24
    const pane = new AsidePane({
      palette: PLAIN,
      question: 'q'.repeat(60),
      rows: () => 18,
      onExit: () => {},
    })
    pane.show({ status: 'answering', text: lines.join('\n') })
    const shown = (): string => pane.render(width).map(stripTerminalSequences).join('\n')
    pane.handleInput(KEY.end)
    expect(shown()).toContain('a19')
    expect(shown()).not.toContain('a17')
    width = 80
    expect(shown()).toContain('a17')
    expect(shown()).toContain('a29')
    expect(shown()).not.toContain('a00')
  })

  it('drops to the shortest legend, and to one dim line when the screen cannot hold a frame', () => {
    const wide = mounted({ width: 80 })
    expect(wide.draw()).toContain('↑↓ scroll · Space page · Esc closes')
    const narrow = mounted({ width: 12, rows: 8 })
    expect(narrow.draw()).toContain('Esc')
    expect(narrow.draw()).not.toContain('scroll')

    const tiny = mounted({ rows: 3, width: 40 })
    expect(tiny.lines()).toHaveLength(3)
    expect(tiny.lines()[0]).toContain('too small')
    expect(tiny.lines()[1]).toBe('')
    expect(tiny.type(KEY.down)).toContain('too small')
    expect(tiny.type('q')).toContain('too small')
    expect(tiny.type(KEY.ctrlG)).toContain('too small')
    expect(tiny.exits).toBe(0)
    tiny.pane.handleInput(KEY.escape)
    tiny.pane.handleInput(KEY.escape)
    expect(tiny.exits).toBe(1)
  })

  it('closes once on Escape, q, Ctrl+G, and withdrawal', () => {
    const escaped = mounted()
    escaped.pane.handleInput(KEY.escape)
    escaped.pane.handleInput('q')
    escaped.pane.withdraw()
    expect(escaped.exits).toBe(1)

    const quit = mounted()
    quit.pane.handleInput('q')
    quit.pane.withdraw()
    expect(quit.exits).toBe(1)

    const reader = mounted()
    reader.pane.handleInput(KEY.ctrlG)
    reader.pane.handleInput(KEY.ctrlG)
    expect(reader.exits).toBe(1)

    const withdrawn = mounted()
    withdrawn.pane.withdraw()
    withdrawn.pane.withdraw()
    expect(withdrawn.exits).toBe(1)
  })

  it('wraps an asking page that already has text, and the finished answers', () => {
    const test = mounted({ rows: 16 })
    test.pane.show({ status: 'asking', text: 'still waiting' })
    expect(test.draw()).toContain('still waiting')
    expect(test.draw()).not.toContain('asking…')
    test.pane.show({ status: 'failed', text: 'the model refused' })
    expect(test.draw()).toContain('failed')
    expect(test.draw()).toContain('the model refused')
    test.pane.show({ status: 'cancelled', text: 'cancelled' })
    expect(test.draw()).toContain('cancelled')
    test.pane.show({ status: 'asking', text: '' })
    expect(test.draw()).toContain('asking…')
  })
})

describe('the side-question page\'s reveal', () => {
  /** A truecolor ramp from near black to a light gray foreground. */
  const STYLE: FadeStyle = { capability: 'truecolor', ramp: [{ r: 8, g: 8, b: 8 }, { r: 220, g: 220, b: 220 }] }

  /**
   * A page whose reveals run on a clock the spec moves.
   * @param motion - whether the terminal runs motion at all.
   * @returns the pane, how often a reveal was asked for, and helpers to draw and settle.
   */
  function revealing(motion = true): {
    pane: AsidePane
    starts: number
    draw(width?: number): string[]
    settle(): void
  } {
    let age: number | undefined
    let starts = 0
    const pane = new AsidePane({
      palette: createPalette(true),
      question: 'WHY_PINNED',
      rows: () => 16,
      effects: {
        style: () => STYLE,
        startReveal: (): AsideRevealClock | undefined => {
          starts += 1
          if (!motion) return undefined
          age = 0
          return { age: () => age }
        },
      },
      onExit: () => {},
    })
    return {
      pane,
      get starts() { return starts },
      draw: (width = 80) => pane.render(width),
      settle() { age = undefined },
    }
  }

  it('recolors the answer lines only, and does not restart while the answer is still streaming', () => {
    const test = revealing()
    expect(test.draw().map(stripTerminalSequences).join('\n')).toContain('asking…')
    expect(test.starts).toBe(0)
    const body: AsideBody = { status: 'answering', text: 'ANSWER_FLOATS' }
    test.pane.show(body)
    expect(test.starts).toBe(1)
    const floating = test.draw()
    test.pane.show({ status: 'answering', text: 'ANSWER_FLOATS' })
    expect(test.starts).toBe(1)
    expect(test.draw()).toEqual(floating)
    test.pane.render(40)
    expect(test.starts).toBe(1)
    test.settle()
    const settled = test.draw()
    expect(floating.map(stripTerminalSequences)).toEqual(settled.map(stripTerminalSequences))
    expect(floating).not.toEqual(settled)
    const questionAt = settled.findIndex(line => stripTerminalSequences(line).includes('WHY_PINNED'))
    const answerAt = settled.findIndex(line => stripTerminalSequences(line).includes('ANSWER_FLOATS'))
    expect(questionAt).toBeGreaterThanOrEqual(0)
    expect(answerAt).toBeGreaterThan(questionAt)
    expect(floating[questionAt]).toBe(settled[questionAt])
    expect(floating[answerAt]).not.toBe(settled[answerAt])
    expect(test.draw()).toEqual(settled)
    test.pane.show({ status: 'ready', text: 'ANSWER_FLOATS' })
    expect(test.starts).toBe(2)
    test.pane.show({ status: 'failed', text: 'ANSWER_FLOATS' })
    expect(test.starts).toBe(3)
    test.pane.show({ status: 'cancelled', text: 'ANSWER_FLOATS' })
    expect(test.starts).toBe(4)
  })

  it('draws settled lines when the terminal runs no motion and when no effects are given', () => {
    const still = revealing(false)
    still.pane.show({ status: 'answering', text: 'ANSWER_FLOATS' })
    expect(still.starts).toBe(1)
    const first = still.draw()
    expect(still.draw()).toEqual(first)
    still.pane.show({ status: 'ready', text: 'ANSWER_FLOATS' })
    expect(still.starts).toBe(2)

    const plain = new AsidePane({
      palette: PLAIN,
      question: 'WHY_PINNED',
      rows: () => 12,
      onExit: () => {},
    })
    plain.show({ status: 'ready', text: 'ANSWER_FLOATS' })
    const settled = plain.render(40)
    expect(plain.render(40)).toEqual(settled)
    expect(settled.join('\n')).not.toContain('\u001b[38;2;')
    expect(settled.map(stripTerminalSequences).join('\n')).toContain('WHY_PINNED')
    expect(settled.map(stripTerminalSequences).join('\n')).toContain('ANSWER_FLOATS')
  })
})
