/** Pointer input: SGR mouse reports, clicks, the cursor query, and the keys a click presses. */

import { describe, expect, it } from 'vitest'
import type { Terminal } from '@earendil-works/pi-tui'
import { CURSOR_QUERY, DISABLE_MOUSE, ENABLE_MOUSE, PointerTerminal, parsePointer, type Cell } from '../src/pointer.ts'

/** A terminal that records every call made on it and lets the test send input. */
class Recorder implements Terminal {
  readonly calls: string[] = []
  columns = 80
  rows = 24
  kittyProtocolActive = true
  private onInput: ((data: string) => void) | undefined

  start(onInput: (data: string) => void): void {
    this.calls.push('start')
    this.onInput = onInput
  }

  stop(): void {
    this.calls.push('stop')
  }

  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    this.calls.push(`drain ${String(maxMs)} ${String(idleMs)}`)
    return Promise.resolve()
  }

  write(data: string): void {
    this.calls.push(`write ${data}`)
  }

  moveBy(lines: number): void {
    this.calls.push(`moveBy ${String(lines)}`)
  }

  hideCursor(): void {
    this.calls.push('hideCursor')
  }

  showCursor(): void {
    this.calls.push('showCursor')
  }

  clearLine(): void {
    this.calls.push('clearLine')
  }

  clearFromCursor(): void {
    this.calls.push('clearFromCursor')
  }

  clearScreen(): void {
    this.calls.push('clearScreen')
  }

  setTitle(title: string): void {
    this.calls.push(`setTitle ${title}`)
  }

  setProgress(active: boolean): void {
    this.calls.push(`setProgress ${String(active)}`)
  }

  /** Send one input sequence as the terminal would. */
  send(data: string): void {
    this.onInput?.(data)
  }
}

/** An SGR report of the left button at a 0-based cell. */
function left(column: number, row: number, release: boolean): string {
  return `\u001b[<0;${String(column + 1)};${String(row + 1)}${release ? 'm' : 'M'}`
}

/** A pointer terminal over a recorder, with everything it reports and delivers collected. */
function pointerOver(): { inner: Recorder; pointer: PointerTerminal; clicks: Cell[]; delivered: string[] } {
  const inner = new Recorder()
  const clicks: Cell[] = []
  const delivered: string[] = []
  const pointer = new PointerTerminal(inner, (cell) => { clicks.push(cell) })
  pointer.start((data) => { delivered.push(data) }, () => {})
  return { inner, pointer, clicks, delivered }
}

describe('parsePointer', () => {
  it('reads an SGR press and release as 0-based cells', () => {
    expect(parsePointer('\u001b[<0;10;5M')).toEqual({ button: 0, column: 9, row: 4, release: false })
    expect(parsePointer('\u001b[<16;1;1m')).toEqual({ button: 16, column: 0, row: 0, release: true })
  })

  it('reads nothing from other input', () => {
    for (const data of ['a', '\u001b[A', '\u001b[<0;10M', '\u001b[12;4R']) expect(parsePointer(data)).toBeUndefined()
  })
})

describe('PointerTerminal', () => {
  it('reports vertical wheel presses without sending mouse bytes to the editor', () => {
    const inner = new Recorder()
    const steps: number[] = []
    const delivered: string[] = []
    const pointer = new PointerTerminal(inner, () => {}, step => steps.push(step))
    pointer.start(data => delivered.push(data), () => {})
    for (const button of [64, 65, 68, 81]) inner.send(`\u001b[<${String(button)};1;1M`)
    inner.send('\u001b[<64;1;1m')
    inner.send('\u001b[<66;1;1M')
    expect(steps).toEqual([-1, 1, -1, 1])
    expect(delivered).toEqual([])
  })

  it('turns mouse reports on after the terminal starts and off before it stops', () => {
    const { inner, pointer } = pointerOver()
    expect(inner.calls).toEqual(['start', `write ${ENABLE_MOUSE}`])
    pointer.stop()
    expect(inner.calls.slice(2)).toEqual([`write ${DISABLE_MOUSE}`, 'stop'])
  })

  it('reports a left press and release on one cell as a click, whatever modifier is held', () => {
    const { inner, clicks, delivered } = pointerOver()
    inner.send(left(3, 7, false))
    inner.send(left(3, 7, true))
    inner.send('\u001b[<4;2;2M')
    inner.send('\u001b[<4;2;2m')
    expect(clicks).toEqual([{ column: 3, row: 7 }, { column: 1, row: 1 }])
    expect(delivered).toEqual([])
  })

  it('reports no click for a release elsewhere, a release alone, another button, motion, or the wheel', () => {
    const { inner, clicks, delivered } = pointerOver()
    inner.send(left(3, 7, false))
    inner.send(left(4, 7, true))
    inner.send(left(3, 7, true))
    for (const report of ['\u001b[<2;3;8M', '\u001b[<2;3;8m', '\u001b[<32;3;8M', '\u001b[<64;3;8M', '\u001b[<65;3;8M']) inner.send(report)
    inner.send('\u001b[M !!')
    expect(clicks).toEqual([])
    expect(delivered).toEqual([])
  })

  it('hands every other sequence to pi-tui unchanged', () => {
    const { inner, delivered } = pointerOver()
    for (const data of ['a', '\u001b[A', '\u001b[12;4R']) inner.send(data)
    expect(delivered).toEqual(['a', '\u001b[A', '\u001b[12;4R'])
  })

  it('asks for the cursor once and answers the newest caller with its 0-based row', () => {
    const { inner, pointer, delivered } = pointerOver()
    const rows: string[] = []
    pointer.locateCursor((row) => { rows.push(`first ${String(row)}`) })
    pointer.locateCursor((row) => { rows.push(`second ${String(row)}`) })
    expect(inner.calls.filter(call => call === `write ${CURSOR_QUERY}`)).toHaveLength(1)
    inner.send('x')
    inner.send('\u001b[12;4R')
    inner.send('\u001b[3;1R')
    expect(rows).toEqual(['second 11'])
    expect(delivered).toEqual(['x', '\u001b[3;1R'])
  })

  it('drops an unanswered cursor query when it stops', () => {
    const { inner, pointer, delivered } = pointerOver()
    const rows: number[] = []
    pointer.locateCursor((row) => { rows.push(row) })
    pointer.stop()
    inner.send('\u001b[12;4R')
    expect(rows).toEqual([])
    expect(delivered).toEqual(['\u001b[12;4R'])
  })

  it('presses a key by handing its bytes to pi-tui, and before it starts presses nothing', () => {
    const { pointer, delivered } = pointerOver()
    pointer.press('\u0007')
    expect(delivered).toEqual(['\u0007'])
    const idle = new PointerTerminal(new Recorder(), () => {})
    expect(() => { idle.press('\u0007') }).not.toThrow()
  })

  it('is otherwise the terminal it wraps', async () => {
    const { inner, pointer } = pointerOver()
    expect([pointer.columns, pointer.rows, pointer.kittyProtocolActive]).toEqual([80, 24, true])
    await pointer.drainInput(5, 1)
    pointer.write('x')
    pointer.moveBy(-2)
    pointer.hideCursor()
    pointer.showCursor()
    pointer.clearLine()
    pointer.clearFromCursor()
    pointer.clearScreen()
    pointer.setTitle('dsh')
    pointer.setProgress(true)
    expect(inner.calls.slice(2)).toEqual([
      'drain 5 1', 'write x', 'moveBy -2', 'hideCursor', 'showCursor', 'clearLine', 'clearFromCursor', 'clearScreen', 'setTitle dsh', 'setProgress true',
    ])
  })
})
