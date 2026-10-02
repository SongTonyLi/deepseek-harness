/** The newest prompt pinned over the first row of the main screen once the conversation has scrolled it out of view. */

import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { pinnedPromptRow } from '../src/pinned-prompt.ts'
import { pageContentWidth, pageMargin } from '../src/screen.ts'
import { createPalette } from '../src/style.ts'
import { KEY, bench, type Bench } from './bench.ts'

/** The scrollback-clear sequence pi-tui writes on a full redraw. */
const CLEAR_SCROLLBACK = '\u001b[3J'

/** Rows of a terminal far shorter than the conversations here. */
const ROWS = 20

/** A listed subagent whose Agent is not resident, so viewing it resumes it through the host. */
const SETTLED = [{
  kind: 'child',
  id: 'session-done',
  activity: 'inactive',
  mode: 'one-shot',
  hasChildren: false,
  parentId: 'session-tui-test',
  depth: 1,
  label: 'finished',
}]

/**
 * A Markdown list drawn one row per item.
 * @param count - how many items.
 * @param tag - what each item says before its number.
 * @returns the Markdown.
 */
function listRows(count: number, tag = 'reply line'): string {
  return Array.from({ length: count }, (_, index) => `- ${tag} ${String(index)}`).join('\n')
}

/**
 * The first row of the main screen while the bar names one prompt, as a
 * disabled palette draws it: the page margin, then the bar.
 * @param prompt - the prompt the bar names.
 * @returns the pattern for the whole row.
 */
function barRow(prompt: string): RegExp {
  return new RegExp(`^  ❯ ${prompt} *$`, 'u')
}

/**
 * The reply row drawn directly above another one, which is the row the bar
 * covers while that other one is the second row of the screen.
 * @param row - a drawn `- reply line <n>` row.
 * @returns the pattern for the row above it.
 */
function rowAbove(row: string | undefined): RegExp {
  const match = /- reply line (\d+)/u.exec(row ?? '')
  if (match === null) throw new Error(`not a reply row: ${row ?? ''}`)
  return new RegExp(`- reply line ${String(Number(match[1]) - 1)}(?!\\d)`, 'u')
}

/**
 * The rows the terminal shows after one complete repaint, top first.
 * @param test - the running bench.
 * @returns the viewport's rows.
 */
async function viewport(test: Bench): Promise<string[]> {
  return (await test.screen()).split('\r\n').slice(-test.terminal.rows)
}

/**
 * A bench on a short terminal with one prompt answered far past the bottom of the screen.
 * @param options - bench options.
 * @returns the running bench.
 */
async function tall(options: Parameters<typeof bench>[0] = {}): Promise<Bench> {
  const test = await bench(options)
  test.terminal.rows = ROWS
  test.appendPrompt('first prompt')
  test.appendAssistant([{ type: 'text', text: listRows(30) }])
  await test.settle()
  return test
}

/**
 * Type one line into the input and send it.
 * @param test - the running bench.
 * @param line - the line.
 */
async function send(test: Bench, line: string): Promise<void> {
  for (const char of line) test.terminal.type(char)
  test.terminal.type(KEY.enter)
  await test.settle()
}

describe('the pinned prompt', () => {
  it('draws no bar while the newest prompt is still on screen', async () => {
    const test = await bench()
    test.terminal.rows = ROWS
    test.appendPrompt('first prompt')
    test.appendAssistant([{ type: 'text', text: listRows(5) }])
    await test.settle()
    expect((await viewport(test)).some(row => row.startsWith('  ❯ '))).toBe(false)

    // A turn taller than the screen, then a newer prompt answered in a few rows.
    test.appendAssistant([{ type: 'text', text: listRows(30, 'more') }])
    test.appendPrompt('second prompt')
    test.appendAssistant([{ type: 'text', text: listRows(3, 'short') }])
    await test.settle()
    const shown = await viewport(test)
    expect(shown.some(row => row.startsWith('  ❯ '))).toBe(false)
    expect(shown).toContain(' ❯ second prompt')
  })

  it('pins the newest prompt over the first row once the conversation outgrows the screen', async () => {
    const test = await tall()
    const shown = await viewport(test)
    expect(shown[0]).toMatch(barRow('first prompt'))
    expect(shown[1]).toMatch(/^ - reply line \d+/u)
    // A disabled palette draws the bar as plain text after the margin.
    expect(test.terminal.output).toContain(`${pageMargin(test.terminal.columns)} ❯ first prompt `)
  })

  it('follows the prompt of every newer turn', async () => {
    const test = await tall()
    test.appendPrompt('second prompt')
    test.appendAssistant([{ type: 'text', text: listRows(2, 'short') }])
    await test.settle()
    expect((await viewport(test)).some(row => row.startsWith('  ❯ '))).toBe(false)

    test.appendAssistant([{ type: 'text', text: listRows(30, 'long') }])
    await test.settle()
    expect((await viewport(test))[0]).toMatch(barRow('second prompt'))

    // A prompt whose answer outgrows the screen before the next frame takes
    // the bar over in that frame.
    test.appendPrompt('third prompt')
    test.appendAssistant([{ type: 'text', text: listRows(30, 'longer') }])
    await test.settle()
    expect((await viewport(test))[0]).toMatch(barRow('third prompt'))
  })

  it('collapses a prompt of several lines into one row cut to the width between the margins', async () => {
    const test = await bench()
    test.terminal.rows = ROWS
    test.appendPrompt('first line\nsecond line with a much longer tail than fits')
    test.appendAssistant([{ type: 'text', text: listRows(30) }])
    await test.settle()
    test.terminal.output = ''
    test.terminal.resize(40)
    await test.settle()
    const shown = test.terminal.text().split('\r\n').slice(-ROWS)
    expect(shown[0]?.trimEnd()).toBe('  ❯ first line second line with a much…')
  })

  it('draws the bar on the prompt band across the width between the margins while colour is on', async () => {
    const test = await tall({ color: true })
    test.terminal.output = ''
    test.terminal.resize(96)
    await test.settle()
    const row = pinnedPromptRow(createPalette(true), ['first prompt'], pageContentWidth(96))
    expect(test.terminal.output).toContain(`${pageMargin(96)}${row}`)
  })

  it('writes back the row it covered before the terminal scrolls it away, and never clears the scrollback', async () => {
    const test = await tall()
    const covered = rowAbove((await viewport(test))[1])
    test.terminal.output = ''
    test.appendAssistant([{ type: 'text', text: listRows(3, 'grown') }])
    await test.settle()
    expect(test.terminal.output).not.toContain(CLEAR_SCROLLBACK)
    // The renderer repaints from the row the bar left, which the grown frame
    // draws as conversation again, and only then the bar at the new first row.
    const written = test.terminal.text()
    expect(written).toMatch(covered)
    expect(written.search(covered)).toBeLessThan(written.indexOf('  ❯ first prompt '))
  })

  it('stays down while the renderer cannot repaint the first row, until the conversation grows past it', async () => {
    const test = await tall({ running: true })
    const shown = await viewport(test)
    expect(shown[0]).toMatch(barRow('first prompt'))
    const covered = rowAbove(shown[1])
    test.terminal.output = ''
    // The working line leaves with the turn, so the frame ends above the line
    // the renderer last raised its repaint window to.
    test.setStatus('idle')
    await test.settle()
    expect(test.terminal.text()).toMatch(covered)
    expect(test.terminal.text()).not.toContain('❯ first prompt')

    test.appendAssistant([{ type: 'text', text: listRows(4, 'grown') }])
    await test.settle()
    expect(test.terminal.text()).toContain('  ❯ first prompt ')
    expect(test.terminal.output).not.toContain(CLEAR_SCROLLBACK)
  })

  it('draws no bar over the docked chrome of a terminal too short to show the conversation', async () => {
    const test = await tall()
    test.terminal.rows = 4
    expect((await viewport(test)).some(row => row.includes('❯'))).toBe(false)
  })

  it('leaves the reader to pin its own bar, and is back when the reader closes', async () => {
    const test = await tall()
    const before = test.terminal.written.length
    test.terminal.output = ''
    test.terminal.type(KEY.ctrlG)
    test.terminal.type(KEY.down)
    await test.settle()
    // The reader draws its own bar in place of its top rule, on the screen it owns.
    expect(test.terminal.output).toContain('\u001b[1;1H\u001b[2K ❯ first prompt ')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
    expect((await viewport(test))[0]).toMatch(barRow('first prompt'))
  })

  it('takes the bar down with the last frame when the application stops', async () => {
    const test = await tall()
    const covered = rowAbove((await viewport(test))[1])
    test.terminal.output = ''
    test.app.stop()
    expect(test.terminal.text()).toMatch(covered)
    expect(test.terminal.text()).not.toContain('❯ first prompt')
    expect(test.terminal.output).not.toContain(CLEAR_SCROLLBACK)
  })

  it('names the newest prompt of the session on screen, a subagent view included', async () => {
    const test = await tall({
      subagents: () => Promise.resolve(SETTLED as never),
      openedHistory: [
        { type: 'user/message', seq: 0, time: 1, data: createUserMessage({ content: [{ type: 'text', text: 'child task' }], source: { kind: 'user' } }) },
        {
          type: 'assistant/message',
          seq: 1,
          time: 2,
          data: {
            stream: [],
            turn: 1,
            step: 1,
            message: createAssistantMessage({ content: [{ type: 'text', text: listRows(30, 'child line') }], source: { provider: 'p', model: 'm' } }),
          },
        },
      ] as never[],
    })
    expect((await viewport(test))[0]).toMatch(barRow('first prompt'))
    await send(test, '/subagents')
    test.terminal.type(KEY.enter)
    await test.settle()
    expect((await viewport(test))[0]).toMatch(barRow('child task'))
    test.terminal.type('\u0010')
    await test.settle()
    expect((await viewport(test))[0]).toMatch(barRow('first prompt'))
  })

  it('draws no bar over a session with no prompt to name', async () => {
    const test = await tall()
    expect((await viewport(test))[0]).toMatch(barRow('first prompt'))
    await send(test, '/new')
    expect((await viewport(test)).some(row => row.includes('❯'))).toBe(false)
  })
})
