/** The alternate screen: what it writes to take the terminal, to draw on it, and to give it back. */

import { describe, expect, it } from 'vitest'
import { AlternateScreen } from '../src/alt-screen.ts'
import { FakeTerminal } from './bench.ts'

/** Switch to the alternate screen. */
const ENTER = '\u001b[?1049h'

/** Switch back to the main screen. */
const LEAVE = '\u001b[?1049l'

/**
 * A screen over a terminal a spec reads what was written to.
 * @param columns - the terminal's width.
 * @returns the screen and its terminal.
 */
function screenOver(columns = 40): { screen: AlternateScreen; terminal: FakeTerminal } {
  const terminal = new FakeTerminal()
  terminal.columns = columns
  return { screen: new AlternateScreen(terminal), terminal }
}

/**
 * What one paint wrote, with the synchronized-output pair taken off.
 * @param terminal - the terminal, whose recorded output is cleared.
 * @returns the rows and the cursor moves between them.
 */
function drawn(terminal: FakeTerminal): string {
  const output = terminal.output
  terminal.output = ''
  return output.replaceAll('\u001b[?2026h', '').replaceAll('\u001b[?2026l', '')
}

describe('the alternate screen', () => {
  it('takes the terminal once and gives it back once', () => {
    const { screen, terminal } = screenOver()
    expect(screen.active).toBe(false)
    screen.enter()
    expect(screen.active).toBe(true)
    expect(terminal.output).toContain(ENTER)
    // Taking a terminal already taken writes nothing, so a caller that asks
    // twice cannot leave the terminal one switch deep.
    terminal.output = ''
    screen.enter()
    expect(terminal.output).toBe('')

    screen.leave()
    expect(screen.active).toBe(false)
    expect(terminal.output).toContain(LEAVE)
    terminal.output = ''
    screen.leave()
    expect(terminal.output).toBe('')
  })

  it('writes only the rows whose text changed', () => {
    const { screen, terminal } = screenOver()
    screen.enter()
    drawn(terminal)
    screen.paint(['first', 'second', 'third'])
    const whole = drawn(terminal)
    expect(whole).toContain('first')
    expect(whole).toContain('third')

    screen.paint(['first', 'changed', 'third'])
    const second = drawn(terminal)
    expect(second).toContain('changed')
    expect(second).not.toContain('first')
    expect(second).not.toContain('third')

    // A frame with nothing new in it writes no row at all.
    screen.paint(['first', 'changed', 'third'])
    expect(drawn(terminal)).toBe('')
  })

  it('addresses every row absolutely, so drawing the last one cannot scroll', () => {
    const { screen, terminal } = screenOver()
    screen.enter()
    drawn(terminal)
    screen.paint(['top', 'middle', 'bottom'])
    const frame = drawn(terminal)
    expect(frame).toContain('\u001b[1;1H')
    expect(frame).toContain('\u001b[3;1H')
    expect(frame).not.toContain('\n')
  })

  it('clears the rows a shorter frame no longer draws', () => {
    const { screen, terminal } = screenOver()
    screen.enter()
    screen.paint(['one', 'two', 'three'])
    drawn(terminal)
    screen.paint(['one'])
    const shorter = drawn(terminal)
    expect(shorter).toContain('\u001b[2;1H\u001b[2K')
    expect(shorter).toContain('\u001b[3;1H\u001b[2K')
  })

  it('draws every row again after the terminal changed width', () => {
    const { screen, terminal } = screenOver()
    screen.enter()
    screen.paint(['one', 'two'])
    drawn(terminal)
    // A terminal that resized cleared this screen itself and rewrapped what
    // it held, so the rows it still shows say nothing about what is drawn.
    terminal.columns = 60
    screen.paint(['one', 'two'])
    const repainted = drawn(terminal)
    expect(repainted).toContain('one')
    expect(repainted).toContain('two')
  })

  it('writes nothing while the main screen is the one the terminal shows', () => {
    const { screen, terminal } = screenOver()
    screen.paint(['nothing to see'])
    expect(terminal.output).toBe('')
    screen.enter()
    screen.paint(['drawn'])
    screen.leave()
    // Rows are held per visit, so the next visit draws the screen in full.
    drawn(terminal)
    screen.enter()
    screen.paint(['drawn'])
    expect(drawn(terminal)).toContain('drawn')
  })
})
