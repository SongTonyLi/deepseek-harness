/** The pinned prompt bar: its row, when the main screen floats it, where, and what a click on it presses. */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { keyAt, paintKeys } from '../src/key-chips.ts'
import { PinnedPromptPane, pinnedPromptDrawable, pinnedPromptOverlay, pinnedPromptRow } from '../src/pinned-prompt.ts'
import { GuardedMainScreen, PAGE_MARGIN_COLUMNS, pageContentWidth } from '../src/screen.ts'
import { createPalette } from '../src/style.ts'
import { FakeTerminal } from './bench.ts'

/** A palette that returns its text unchanged, so a spec reads the drawn columns. */
const PLAIN = createPalette(false)

/** A palette that draws the prompt band. */
const COLOR = createPalette(true)

/** The prompt band's own opening sequence. */
const BAND = '\u001b[48;5;236m'

/** The left page margin every drawn line is moved right by. */
const MARGIN = ' '.repeat(PAGE_MARGIN_COLUMNS)

describe('pinnedPromptRow', () => {
  it('leads with the prompt glyph and collapses every row and run of whitespace to one line', () => {
    expect(pinnedPromptRow(PLAIN, ['fix the fade', '  at \t the top  '], 40)).toBe(' ❯ fix the fade at the top ')
  })

  it('cuts a prompt wider than the bar with an ellipsis', () => {
    const row = stripTerminalSequences(pinnedPromptRow(PLAIN, ['first line', 'second line with extra text'], 24))
    expect(row).toBe(' ❯ first line second li…')
    expect(visibleWidth(row)).toBe(24)
  })

  it('fills the whole width on the prompt band while colour is on, and pads nothing without it', () => {
    expect(pinnedPromptRow(COLOR, ['run the tests'], 20)).toBe(`${BAND} ❯ run the tests    \u001b[49m`)
    expect(pinnedPromptRow(PLAIN, ['run the tests'], 20)).toBe(' ❯ run the tests ')
  })
})

describe('pinnedPromptDrawable', () => {
  /** A prompt that ended ten lines above a viewport over the conversation's own rows. */
  const geometry = { promptEnd: 10, transcriptEnd: 50, viewportStart: 20, viewportFloor: 0 }

  it('draws while every line of the prompt lies above a conversation row the renderer can repaint', () => {
    expect(pinnedPromptDrawable(geometry)).toBe(true)
    expect(pinnedPromptDrawable({ ...geometry, promptEnd: 20 })).toBe(true)
  })

  it('draws nothing while any line of the prompt is still in view', () => {
    expect(pinnedPromptDrawable({ ...geometry, promptEnd: 21 })).toBe(false)
    expect(pinnedPromptDrawable({ ...geometry, viewportStart: 0, promptEnd: 4 })).toBe(false)
  })

  it('draws nothing over the docked chrome', () => {
    expect(pinnedPromptDrawable({ ...geometry, transcriptEnd: 20 })).toBe(false)
  })

  it('draws nothing where the renderer can no longer repaint the viewport\'s first row', () => {
    expect(pinnedPromptDrawable({ ...geometry, viewportFloor: 1 })).toBe(false)
  })
})

/** A child that draws whatever it was last given. */
class Lines implements Component {
  constructor(public lines: string[]) {}

  invalidate(): void {}

  render(): string[] {
    return [...this.lines]
  }
}

describe('the floating bar', () => {
  it('floats on the viewport\'s first row across the whole width without taking the keyboard', () => {
    expect(pinnedPromptOverlay()).toEqual({ anchor: 'top-left', width: '100%', margin: { top: 0 }, nonCapturing: true })
  })

  it('lays the bar out inside the page margins, and without them on a terminal too narrow for both', () => {
    const pane = new PinnedPromptPane(COLOR, ['run the tests'])
    pane.invalidate()
    expect(pane.render(30)).toEqual([`${MARGIN}${pinnedPromptRow(COLOR, ['run the tests'], pageContentWidth(30))}`])
    expect(visibleWidth(pane.render(30)[0] ?? '')).toBe(PAGE_MARGIN_COLUMNS + pageContentWidth(30))
    expect(pane.render(6)).toEqual([pinnedPromptRow(COLOR, ['run the tests'], 6)])
  })

  it('covers the first row of the viewport and takes that row\'s keys with it, so a click there presses nothing', () => {
    const terminal = new FakeTerminal()
    terminal.rows = 4
    const clickable = createPalette(false, true)
    const screen = new GuardedMainScreen(terminal, true, () => false)
    screen.addChild(new Lines(['one', 'two', paintKeys(clickable, 'Esc input'), 'three', paintKeys(clickable, 'Esc input'), 'four']))
    screen.renderNow()
    // The viewport shows the last four of six lines, so its first row is line 2.
    expect(keyAt(screen.keyFrame().keys, 2, MARGIN.length)).toBe('\u001b')

    screen.showOverlay(new PinnedPromptPane(clickable, ['the prompt']), pinnedPromptOverlay())
    terminal.output = ''
    screen.renderNow()
    expect(stripTerminalSequences(terminal.output)).toContain(`${MARGIN} ❯ the prompt `)
    const { keys } = screen.keyFrame()
    expect(keyAt(keys, 2, MARGIN.length)).toBeUndefined()
    expect(keyAt(keys, 4, MARGIN.length)).toBe('\u001b')
  })
})
