/** The guarded main screen: the repaint window it hands its guard, its settle passes, and its suspension. */

import { describe, expect, it } from 'vitest'
import type { Component } from '@earendil-works/pi-tui'
import { GuardedMainScreen, repaintFloor } from '../src/screen.ts'
import { FakeTerminal } from './bench.ts'

/** A child that counts its renders and draws whatever it was last given. */
class Counted implements Component {
  renders = 0
  lines = ['first', 'tail']

  invalidate(): void {}

  render(): string[] {
    this.renders += 1
    return [...this.lines]
  }
}

/**
 * A screen over a terminal of a known height, with one child.
 * @param rows - rows the terminal shows.
 * @param guard - the guard the screen settles each frame through.
 * @returns the screen, its terminal, and its child.
 */
function screenWith(rows: number, guard: (viewportTop: number, width: number, frameLines: number) => boolean): {
  screen: GuardedMainScreen
  terminal: FakeTerminal
  child: Counted
} {
  const terminal = new FakeTerminal()
  terminal.rows = rows
  const child = new Counted()
  const screen = new GuardedMainScreen(terminal, true, guard)
  screen.addChild(child)
  return { screen, terminal, child }
}

describe('repaintFloor', () => {
  it('leaves a block that begins inside the window untouched', () => {
    expect(repaintFloor(10, 10)).toBe(0)
    expect(repaintFloor(10, 0)).toBe(0)
  })

  it('counts the lines of a block that reach above the window', () => {
    expect(repaintFloor(0, 10)).toBe(10)
    expect(repaintFloor(4, 10)).toBe(6)
  })
})

describe('GuardedMainScreen', () => {
  it('builds the frame once and writes it when the guard changed nothing', () => {
    const { screen, child } = screenWith(40, () => false)
    expect(screen.render(20)).toEqual(['first', 'tail'])
    expect(child.renders).toBe(1)
  })

  it('builds the frame again and writes the second one when the guard changed a line', () => {
    let passes = 0
    const { screen, child } = screenWith(40, (viewportTop, width) => {
      passes += 1
      child.lines = [`${String(viewportTop)} at ${String(width)}`, 'tail']
      return passes === 1
    })
    expect(screen.render(20)).toEqual(['0 at 20', 'tail'])
    expect(child.renders).toBe(2)
  })

  it('stops settling once the pass limit is reached, and writes the frame it built last', () => {
    let passes = 0
    const { screen, child } = screenWith(40, () => {
      passes += 1
      child.lines = [`pass ${String(passes)}`]
      return true
    })
    expect(screen.render(20)).toEqual(['pass 2'])
    expect(child.renders).toBe(3)
  })

  it('offers the boundary the frame just built will impose, ahead of writing it', () => {
    const tops: number[] = []
    const { screen, child } = screenWith(10, (viewportTop) => {
      tops.push(viewportTop)
      return false
    })
    child.lines = Array.from({ length: 32 }, (_, index) => `line ${String(index)}`)
    screen.renderNow()
    expect(tops).toEqual([22])
  })

  it('hands the guard the frame\'s own length, which is what places an overlay', () => {
    const seen: number[] = []
    const { screen, child } = screenWith(10, (_viewportTop, _width, frameLines) => {
      seen.push(frameLines)
      return false
    })
    child.lines = Array.from({ length: 32 }, (_, index) => `line ${String(index)}`)
    screen.renderNow()
    child.lines = ['one line']
    screen.renderNow()
    expect(seen).toEqual([32, 1])
  })

  it('never clears the screen when the frame shrinks, which is what lets an overlay pad it', () => {
    const { screen } = screenWith(10, () => false)
    // pi-tui's shrink path would write ESC[2J ESC[H ESC[3J and take the
    // terminal's scrollback with it; the reader pads the frame to the
    // terminal height and back on every open and close.
    expect(screen.getClearOnShrink()).toBe(false)
  })

  it('keeps the boundary the renderer already imposed after the frame shrank again', () => {
    const tops: number[] = []
    const { screen, child } = screenWith(10, (viewportTop) => {
      tops.push(viewportTop)
      return false
    })
    child.lines = Array.from({ length: 32 }, (_, index) => `line ${String(index)}`)
    screen.renderNow()
    // The renderer left its viewport top at 22 and never lowers it, so the
    // shorter frame's own boundary of 20 is not what the next write is judged
    // against.
    child.lines = child.lines.slice(0, 30)
    screen.renderNow()
    expect(tops).toEqual([22, 22])
  })
})

describe('suspending the main screen', () => {
  it('writes nothing while suspended and draws the surface that took the terminal instead', () => {
    const { screen, terminal, child } = screenWith(10, () => false)
    screen.renderNow()
    expect(terminal.output).not.toBe('')
    let drawn = 0
    screen.suspend(() => { drawn += 1 })
    terminal.output = ''
    child.lines = ['first', 'second', 'tail']
    screen.renderNow()
    screen.requestRender()
    // Every render request reaches the surface holding the terminal, and the
    // conversation the terminal is no longer showing is left alone.
    expect(drawn).toBe(2)
    expect(terminal.output).toBe('')
  })

  it('draws what changed while it was suspended, and only that', async () => {
    const { screen, terminal, child } = screenWith(10, () => false)
    screen.renderNow()
    screen.suspend(() => {})
    child.lines = ['first', 'tail', 'landed while away']
    screen.renderNow()
    terminal.output = ''
    screen.resume()
    await new Promise(resolve => setTimeout(resolve, 20))
    // The terminal restored the screen the renderer last wrote, so the line
    // that landed meanwhile is the one line the first frame back writes.
    expect(terminal.output).toContain('landed while away')
    expect(terminal.output).not.toContain('first')
  })

  it('resumes only from a suspension, and a forced request cannot discard the held screen', () => {
    const { screen, terminal, child } = screenWith(10, () => false)
    screen.renderNow()
    screen.resume()
    let drawn = 0
    screen.suspend(() => { drawn += 1 })
    terminal.output = ''
    child.lines = ['rewritten']
    screen.requestRender(true)
    screen.renderNow(true)
    expect(drawn).toBe(2)
    expect(terminal.output).toBe('')
  })
})
