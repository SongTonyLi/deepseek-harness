/** The reader pane: what it re-reads per render, what each key means, and how it settles. */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import type { SectionSource } from '../src/navigation.ts'
import { READER_MIN_COLUMNS } from '../src/reader.ts'
import { ReaderPane, type ReaderEffects, type ReaderExit } from '../src/reader-screen.ts'
import { KEY } from './bench.ts'
import { source, transcript } from './section-source.ts'
import { createPalette } from '../src/style.ts'

/** A palette that returns its text unchanged, so a spec reads the drawn columns. */
const PLAIN = createPalette(false)

/**
 * A reader over a transcript a spec can grow under it.
 * @param options - the section to open on and the terminal size.
 * @returns the pane, the blocks it reads, and helpers to draw and type.
 */
function mounted(options: { block?: number; part?: number; rows?: number; width?: number } = {}): {
  pane: ReaderPane
  blocks: SectionSource[]
  exits: ReaderExit[]
  draw(): string
  type(data: string): string
} {
  const blocks = transcript()
  const rows = options.rows ?? 40
  const width = options.width ?? 95
  const exits: ReaderExit[] = []
  const pane = new ReaderPane({
    palette: PLAIN,
    blocks: () => blocks,
    rows: () => rows,
    minColumns: READER_MIN_COLUMNS,
    cursor: { block: options.block ?? 2, part: options.part ?? 1 },
    onExit: (exit) => { exits.push(exit) },
  })
  const draw = (): string => pane.render(width).map(stripTerminalSequences).join('\n')
  // The application draws the reader once when it takes the terminal, before
  // the first key reaches it.
  draw()
  return {
    pane,
    blocks,
    exits,
    draw,
    type(data: string): string {
      pane.handleInput(data)
      return draw()
    },
  }
}

describe('the reader pane', () => {
  it('re-reads the transcript on every render, so a section that lands shows up', () => {
    const test = mounted()
    expect(test.draw()).not.toContain('landed after opening')
    test.blocks.push(source('assistant', [{ kind: 'reply', rows: ['landed after opening'] }], { turn: 3 }))
    // The reply joined the newest turn, which the list renumbers at once.
    expect(test.draw()).toContain('3  run the tests')
    test.pane.handleInput(KEY.left)
    test.pane.handleInput(KEY.end)
    expect(test.type(KEY.right)).toContain('landed after opening')
  })

  it('walks every turn\'s sections in the list and opens the turn beside it', () => {
    const test = mounted()
    // The list opens on the section the reader was reading, with that turn's
    // own sections under it and every other turn still one row each.
    const listed = test.type(KEY.left)
    expect(listed).toContain('sections · ')
    expect(listed).toContain('❯ 1  fix the fade…')
    expect(listed).toContain('▸ ¶ Reply')
    // Up and Down walk the sections, crossing into the turn either side.
    expect(test.type(KEY.up)).toContain('▸ ✻ Thinking')
    expect(test.type(KEY.up)).toContain('▸ ❯ Prompt')
    const crossed = test.type(KEY.up)
    expect(crossed).toContain('▸ ⬡ system prompt')
    expect(crossed).toContain('❯ 0  session start')
    // Page steps a whole turn, and Home and End reach the conversation's ends.
    expect(test.type(KEY.pageDown)).toContain('❯ 1  fix the fade…')
    expect(test.type(KEY.end)).toContain('❯ 2  run the tests')
    expect(test.type(KEY.home)).toContain('❯ 0  session start')
    // Right opens the turn the list holds; Tab and Enter cross the same way.
    const opened = test.type(KEY.right)
    expect(opened).toContain('│ ┃ ⬡ system prompt')
    expect(opened).toContain('scrolls · ')
    expect(test.type(KEY.tab)).toContain('sections · ')
    expect(test.type(KEY.enter)).toContain('scrolls · ')
    expect(test.type(KEY.shiftTab)).toContain('sections · ')
    // A printable key the list claims nothing for leaves it where it was.
    expect(test.type('z')).toContain('sections · ')
  })

  it('scrolls and pages the turn it opened on', () => {
    const test = mounted()
    // The reader opens on the reply, which starts five rows into its turn.
    expect(test.draw()).toContain('row 6/52')
    expect(test.type(KEY.down)).toContain('row 7/52')
    expect(test.type(KEY.up)).toContain('row 6/52')
    // A page stops at the panel's own end, which is fifteen rows down here.
    expect(test.type(KEY.pageDown)).toContain('row 16/52')
    expect(test.type(KEY.pageUp)).toContain('row 1/52')
    expect(test.type(KEY.end)).toContain('row 16/52')
    expect(test.type(KEY.home)).toContain('row 1/52')
    // A key the panel claims nothing for leaves it exactly where it was.
    expect(test.type('z')).toContain('row 1/52')
  })

  it('narrows the list with a query and clears it again', () => {
    const test = mounted()
    test.pane.handleInput(KEY.left)
    expect(test.type(KEY.slash)).toContain('/ ')
    expect(test.type('green')).toContain('/ green')
    expect(test.draw()).toContain('1/3 turns')
    expect(test.type(KEY.backspace)).toContain('/ gree')
    expect(test.type(KEY.ctrlU)).toContain('/ ')
    expect(test.type('green')).toContain('/ green')
    // Enter keeps the narrowed list and closes the query line.
    expect(test.type(KEY.enter)).toContain('sections · ')
    expect(test.draw()).toContain('1/3 turns')
    test.pane.handleInput(KEY.slash)
    // A key the query line types nothing for leaves the query alone.
    expect(test.type(KEY.up)).toContain('/ ')
    expect(test.type(KEY.escape)).toContain('/ ')
    expect(test.type(KEY.escape)).toContain('sections · ')
    expect(test.draw()).not.toContain('turns ┤')
  })

  it('closes on Escape from the turn it was reading and from the list', async () => {
    const reading = mounted()
    reading.pane.handleInput(KEY.escape)
    expect(reading.exits).toMatchObject([{ target: 'transcript' }])

    const listed = mounted()
    listed.pane.handleInput(KEY.left)
    listed.pane.handleInput(KEY.escape)
    expect(listed.exits).toMatchObject([{ target: 'transcript' }])
  })

  it('draws one panel at a time on a terminal too narrow for both', () => {
    const test = mounted({ width: 50 })
    expect(test.draw()).toContain('reply row 0')
    // Left gives the keyboard back to the list, which takes the whole body.
    const listed = test.type(KEY.left)
    expect(listed).toContain('❯ 1  fix the fade at the top')
    expect(listed).not.toContain('reply row 0')
    expect(test.type(KEY.right)).toContain('reply row 0')
  })

  it('re-anchors on the section being read when the terminal is rewrapped', () => {
    const blocks = transcript()
    let rows = 40
    const pane = new ReaderPane({
      palette: PLAIN,
      blocks: () => blocks,
      rows: () => rows,
      minColumns: READER_MIN_COLUMNS,
      cursor: { block: 3, part: 1 },
      onExit: () => {},
    })
    const drawn = pane.render(95).map(stripTerminalSequences).join('\n')
    // The tool result is the turn's last section, far past one body of rows.
    expect(drawn).toContain('clean tree')
    rows = 12
    expect(pane.render(95).map(stripTerminalSequences).join('\n')).toContain('clean tree')
    expect(pane.render(60).map(stripTerminalSequences).join('\n')).toContain('clean tree')
  })

  it('answers only the keys that leave on a terminal it cannot draw in', async () => {
    const test = mounted({ rows: 6, width: 20 })
    expect(test.draw()).toContain('terminal too small')
    // Nothing else moves, and Escape still brings the keyboard back.
    expect(test.type(KEY.down)).toContain('terminal too small')
    test.pane.handleInput(KEY.escape)
    expect(test.exits).toMatchObject([{ target: 'transcript' }])
  })

  it('closes to the input on Ctrl+G and on withdrawal, and settles only once', async () => {
    const test = mounted()
    test.pane.handleInput(KEY.ctrlG)
    test.pane.withdraw()
    expect(test.exits).toMatchObject([{ target: 'editor' }])
    // A key after the settlement changes nothing.
    expect(test.type(KEY.down)).toContain(' ● READER ')

    const withdrawn = mounted()
    withdrawn.pane.withdraw()
    expect(withdrawn.exits).toMatchObject([{ target: 'editor' }])
  })

  it('settles itself when the transcript it was reading is gone', () => {
    const blocks: SectionSource[] = transcript()
    const exits: ReaderExit[] = []
    const pane = new ReaderPane({
      palette: PLAIN,
      blocks: () => blocks,
      rows: () => 40,
      minColumns: READER_MIN_COLUMNS,
      cursor: { block: 2, part: 1 },
      onExit: (exit) => { exits.push(exit) },
    })
    expect(pane.render(95)).toHaveLength(40)
    blocks.length = 0
    expect(pane.render(95)).toEqual(Array.from({ length: 40 }, () => ''))
    expect(exits).toMatchObject([{ target: 'editor' }])
  })

  it('falls back to the newest section when the remembered one carries nothing', () => {
    const blocks = [source('assistant', [], { turn: 1 }), source('user', [{ kind: 'user', rows: ['still here'] }], { turn: 1 })]
    const pane = new ReaderPane({
      palette: PLAIN,
      blocks: () => blocks,
      rows: () => 40,
      minColumns: READER_MIN_COLUMNS,
      cursor: { block: 0, part: 0 },
      onExit: () => {},
    })
    expect(pane.render(95).map(stripTerminalSequences).join('\n')).toContain('still here')
  })

  it('draws nothing of its own state when invalidated', () => {
    const test = mounted()
    test.pane.invalidate()
    expect(test.draw()).toContain(' ● READER ')
  })

  it('fills the screen it was given, whatever the terminal is', () => {
    const blocks = transcript()
    let rows = 40
    const pane = new ReaderPane({
      palette: PLAIN,
      blocks: () => blocks,
      rows: () => rows,
      minColumns: READER_MIN_COLUMNS,
      cursor: { block: 2, part: 1 },
      onExit: () => {},
    })
    // The reader owns the whole alternate screen, so every row of it is the
    // reader's to draw and a resize is answered by the next drawing.
    expect(pane.render(95)).toHaveLength(40)
    rows = 12
    expect(pane.render(95)).toHaveLength(12)
    rows = 60
    expect(pane.render(95)).toHaveLength(60)
  })

  it('answers the pager keys beside the named ones', () => {
    const test = mounted()
    // In the turn: j and k scroll, g and G reach its ends, Space and b page.
    expect(test.type('j')).toContain('row 7/52')
    expect(test.type('k')).toContain('row 6/52')
    expect(test.type('G')).toContain('row 16/52')
    expect(test.type('g')).toContain('row 1/52')
    expect(test.type(' ')).toContain('row 16/52')
    expect(test.type('b')).toContain('row 1/52')
    // ] and [ step a whole turn from either panel.
    expect(test.type(']')).toContain('turn 3 of 3')
    expect(test.type('[')).toContain('turn 2 of 3')
    // In the list: j and k step sections, g and G reach the conversation's ends.
    test.pane.handleInput(KEY.left)
    expect(test.type('k')).toContain('▸ ⬡ system prompt')
    expect(test.type('j')).toContain('▸ ❯ Prompt')
    expect(test.type('G')).toContain('❯ 2  run the tests')
    expect(test.type('g')).toContain('❯ 0  session start')
    expect(test.type(']')).toContain('turn 2 of 3')
    expect(test.type(KEY.pageUp)).toContain('turn 1 of 3')
    // A control key neither panel names moves nothing.
    expect(test.type('\u0001')).toContain('turn 1 of 3')
    expect(test.exits).toEqual([])
  })

  it('closes on q from either panel, and types it on the query line', () => {
    const reading = mounted()
    reading.pane.handleInput('q')
    expect(reading.exits).toMatchObject([{ target: 'transcript' }])

    const listed = mounted()
    listed.pane.handleInput(KEY.left)
    listed.pane.handleInput(KEY.slash)
    expect(listed.type('q')).toContain('/ q')
    expect(listed.exits).toEqual([])
    listed.pane.handleInput(KEY.enter)
    listed.pane.handleInput('q')
    expect(listed.exits).toMatchObject([{ target: 'transcript' }])
  })
})

describe('the reader pane\'s effects', () => {
  /** A truecolor ramp from near black to a light gray foreground. */
  const STYLE = { capability: 'truecolor' as const, ramp: [{ r: 8, g: 8, b: 8 }, { r: 220, g: 220, b: 220 }] }

  /**
   * A reader whose reveals run on a clock the spec moves.
   * @param motion - whether the terminal runs motion at all.
   * @returns the pane, the reveals it started, and helpers to draw, type, and settle.
   */
  function revealing(motion = true): {
    pane: ReaderPane
    starts: number
    draw(): string[]
    type(data: string): string[]
    settle(): void
  } {
    const blocks = transcript()
    let age: number | undefined
    const test = {
      starts: 0,
      pane: undefined as ReaderPane | undefined,
    }
    const effects: ReaderEffects = {
      style: () => STYLE,
      background: () => ({ r: 0, g: 0, b: 0 }),
      startReveal: () => {
        if (!motion) return undefined
        test.starts += 1
        age = 0
        return { age: () => age }
      },
    }
    const pane = new ReaderPane({
      palette: createPalette(true),
      blocks: () => blocks,
      rows: () => 40,
      minColumns: READER_MIN_COLUMNS,
      cursor: { block: 2, part: 1 },
      effects,
      onExit: () => {},
    })
    return {
      pane,
      get starts() { return test.starts },
      draw: () => pane.render(95),
      type(data: string): string[] {
        pane.handleInput(data)
        return pane.render(95)
      },
      settle() { age = undefined },
    }
  }

  it('reveals the turn it opens on and settles to the static drawing', () => {
    const test = revealing()
    const opening = test.draw()
    expect(test.starts).toBe(1)
    test.settle()
    const settled = test.draw()
    // The reveal changed colors on the same rows and nothing else.
    expect(opening).toHaveLength(settled.length)
    expect(opening.map(stripTerminalSequences)).toEqual(settled.map(stripTerminalSequences))
    expect(opening).not.toEqual(settled)
    // A settled reader stays settled on the next drawing.
    expect(test.draw()).toEqual(settled)
    expect(test.starts).toBe(1)
    // The prompt at the top of the turn sits on its band.
    expect(test.type('g').join('\n')).toContain('\u001b[48;2;')
  })

  it('reveals another turn, and one section the list steps to, but never a scroll', () => {
    const test = revealing()
    test.draw()
    test.settle()
    test.draw()
    test.type(KEY.down)
    expect(test.starts).toBe(1)
    test.type(KEY.pageDown)
    expect(test.starts).toBe(1)
    test.type(']')
    expect(test.starts).toBe(2)
    // The list steps from the prompt to the reply of the same turn.
    test.pane.handleInput(KEY.left)
    test.type(KEY.down)
    expect(test.starts).toBe(3)
    // A step that lands where it was reveals nothing.
    test.type('G')
    expect(test.starts).toBe(3)
  })

  it('draws the settled reader on a terminal that runs no motion', () => {
    const test = revealing(false)
    const first = test.draw()
    expect(test.starts).toBe(0)
    expect(test.draw()).toEqual(first)
  })
})
