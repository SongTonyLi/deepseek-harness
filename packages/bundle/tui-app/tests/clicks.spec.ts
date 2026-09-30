/** Clicking a drawn key: the application presses the key a click lands on, on the main screen and in the reader. */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { DISABLE_MOUSE, ENABLE_MOUSE, type Cell } from '../src/pointer.ts'
import { KEY, bench, type Bench } from './bench.ts'

/** Switch back to the main screen, which is how the reader gives the terminal back. */
const LEAVE_READER = '\u001b[?1049l'

/** Drop CSI, OSC, and APC sequences, as the bench terminal's own text does. */
function plain(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b_[^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
}

/** Where one synchronized write starts and ends, which is how a whole frame reaches the terminal. */
const FRAME = /\u001b\[\?2026h([\s\S]*?)\u001b\[\?2026l/u

/**
 * Repaint the main screen in full and read back that repaint's lines, without
 * the frames written after it, such as a spinner's next glyph.
 * @param test - the bench.
 * @returns the frame's lines, top first.
 */
async function fullFrame(test: Bench): Promise<string[]> {
  await test.screen()
  const written = FRAME.exec(test.terminal.output)?.[1] ?? ''
  return plain(written).split('\r\n')
}

/**
 * Where a label is drawn on the main screen: the lowest frame line of a full
 * repaint that draws it, on the screen row that line lands on.
 * @param test - the bench, which is repainted in full.
 * @param label - the text to find; the cell is its first character.
 * @returns the 0-based cell.
 */
async function mainCell(test: Bench, label: string): Promise<Cell> {
  const lines = await fullFrame(test)
  const index = lines.findLastIndex(line => line.includes(label))
  expect(index, label).not.toBe(-1)
  const line = lines[index] as string
  // The repaint starts on the top row, so a frame taller than the terminal
  // scrolled its first lines off.
  const row = index - Math.max(0, lines.length - test.terminal.rows)
  return { row, column: visibleWidth(line.slice(0, line.indexOf(label))) }
}

/**
 * Where a label is drawn on the reader's screen, whose rows are each written
 * at an absolute position.
 * @param test - the bench, which is repainted in full.
 * @param label - the text to find; the cell is its first character.
 * @returns the 0-based cell.
 */
async function readerCell(test: Bench, label: string): Promise<Cell> {
  await test.screen()
  const parts = test.terminal.output.split(/\u001b\[(\d+);1H/u)
  for (let at = parts.length - 1; at >= 2; at -= 2) {
    const line = plain(parts[at] as string)
    if (line.includes(label)) return { row: Number(parts[at - 1]) - 1, column: visibleWidth(line.slice(0, line.indexOf(label))) }
  }
  throw new Error(`the reader draws no ${label}`)
}

/**
 * A bench with clickable keys whose transcript holds one turn the reader can open.
 * @param options - whether the Agent starts running.
 * @returns the bench.
 */
async function readable(options: { running?: boolean } = {}): Promise<Bench> {
  const test = await bench({ clickableKeys: true, ...options })
  test.appendPrompt('read the spec')
  test.appendAssistant([{ type: 'text', text: 'the reply' }])
  await test.settle()
  return test
}

describe('clicking a drawn key', () => {
  it('leaves the mouse to the terminal unless the keys are clickable', async () => {
    const test = await bench()
    expect(test.terminal.written).not.toContain(ENABLE_MOUSE)
    const clickable = await bench({ clickableKeys: true })
    expect(clickable.terminal.written).toContain(ENABLE_MOUSE)
    expect(clickable.terminal.written).not.toContain(DISABLE_MOUSE)
    clickable.terminal.type(KEY.ctrlD)
    expect(clickable.terminal.written).toContain(DISABLE_MOUSE)
    expect(clickable.terminal.stopped).toBe(true)
  })

  it('presses the key a click lands on, wherever the chip is drawn', async () => {
    const test = await bench({ clickableKeys: true })
    test.terminal.click(await mainCell(test, 'Shift+↓ status'))
    await test.settle()
    expect(await test.screen()).toContain('←→ segments · Enter details')
    // The bar's own legend names the way back, and clicking it takes it.
    const back = await mainCell(test, 'Esc input')
    test.terminal.click({ ...back, column: back.column + 2 })
    await test.settle()
    expect(await test.screen()).not.toContain('←→ segments')
  })

  it('places the click by the cursor, however far the frame has scrolled', async () => {
    const test = await bench({ clickableKeys: true })
    for (let turn = 0; turn < 30; turn += 1) test.appendPrompt(`prompt ${String(turn)}`)
    await test.settle()
    expect((await fullFrame(test)).length).toBeGreaterThan(test.terminal.rows)
    test.terminal.click(await mainCell(test, 'Shift+↓ status'))
    await test.settle()
    expect(await test.screen()).toContain('←→ segments · Enter details')
  })

  it('presses nothing for a click beside a chip or anywhere else', async () => {
    const test = await bench({ clickableKeys: true })
    const chip = await mainCell(test, 'Shift+↓ status')
    test.terminal.click({ ...chip, column: chip.column - 2 })
    test.terminal.click(await mainCell(test, 'test-model'))
    test.terminal.click({ row: 0, column: 0 })
    await test.settle()
    const screen = await test.screen()
    expect(screen).not.toContain('←→ segments')
    // No report reached the editor as typed text.
    typeLine(test, 'hello')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'hello' }]])
  })

  it('stops the running turn from the key the armed stop names', async () => {
    const test = await bench({ clickableKeys: true, running: true })
    test.terminal.type(KEY.escape)
    await test.settle()
    test.terminal.click(await mainCell(test, 'Esc again'))
    await test.settle()
    expect(test.calls.cancels).toBe(1)
  })

  it('presses the reader\'s keys on the reader\'s own screen', async () => {
    const test = await readable()
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    const legend = await readerCell(test, 'Esc closes')
    // Whether the reader gave the terminal back is read from what was
    // written: a repaint resizes the terminal, which moves the legend.
    test.terminal.output = ''
    test.terminal.click({ ...legend, column: legend.column - 3 })
    await test.settle()
    expect(test.terminal.output).not.toContain(LEAVE_READER)
    test.terminal.click(legend)
    await test.settle()
    expect(test.terminal.output).toContain(LEAVE_READER)
    expect(await test.screen()).not.toContain(' ● READER ')
  })

  it('presses nothing when the reader took the terminal before the cursor report arrived', async () => {
    const test = await readable({ running: true })
    test.terminal.type(KEY.escape)
    await test.settle()
    const stop = await mainCell(test, 'Esc again')
    test.terminal.cursorReply = 'held'
    test.terminal.click(stop)
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    test.terminal.output = ''
    // The click named Esc, which would close the reader that took the terminal meanwhile.
    test.terminal.answerCursor()
    await test.settle()
    expect(test.terminal.output).not.toContain(LEAVE_READER)
    expect(test.calls.cancels).toBe(0)
    expect(await test.screen()).toContain(' ● READER ')
  })
})

/**
 * Type one line into the editor and submit it.
 * @param test - the bench.
 * @param text - the line.
 */
function typeLine(test: Bench, text: string): void {
  for (const char of text) test.terminal.type(char)
  test.terminal.type(KEY.enter)
}
