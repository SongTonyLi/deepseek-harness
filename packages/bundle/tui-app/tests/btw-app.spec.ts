/** `/btw` opens a temporary side agent as a view over the working session, which it leaves alone. */

import { describe, expect, it } from 'vitest'
import { KEY, bench, type Bench } from './bench.ts'

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

/** The text of every follow-up the scripted Agents took. */
function followupTexts(test: Bench): string[] {
  return test.calls.followups.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('/btw', () => {
  it('opens a side agent view, asks it the question, and leaves the working session alone', async () => {
    // Every bench Agent shares one status, and a new side agent is idle.
    const test = await bench()
    test.appendPrompt('the task')
    const logged = test.session.snapshotEvents().length
    await send(test, '/btw what is the task')
    expect(test.hostCalls).toEqual(['aside:session-tui-test'])
    const side = test.opened.at(-1)?.bound
    expect(side?.agent.session.id).toBe('session-btw-1')
    expect(followupTexts(test)).toEqual(['what is the task'])
    expect(test.calls.injections.map(message => message.source)).toEqual([{ kind: 'tui-app', form: 'notice', summary: 'btw · side agent' }])
    expect(test.calls.steers).toEqual([])
    expect(test.calls.cancels).toBe(0)
    expect(test.session.snapshotEvents().length).toBe(logged)
    const page = await test.screen()
    expect(page).toContain('btw side agent')
    expect(page).toContain('what is the task')

    await send(test, 'and a follow-up')
    expect(followupTexts(test)).toEqual(['what is the task', 'and a follow-up'])
    await send(test, '/btw one more')
    expect(followupTexts(test)).toEqual(['what is the task', 'and a follow-up', 'one more'])
    expect(test.hostCalls).toEqual(['aside:session-tui-test'])

    test.terminal.type('\u0010')
    await test.settle()
    const back = await test.screen()
    expect(back).toContain('btw ended · back in session session-tui-test')
    expect(back).not.toContain('btw side agent')
    expect(test.opened.at(-1)?.disposed).toBe(1)
    expect(test.calls.cancels).toBe(0)
  })

  it('opens the page without a question and says so when /btw is repeated empty', async () => {
    const test = await bench()
    await send(test, '/btw')
    expect(test.calls.followups).toEqual([])
    expect(test.calls.injections).toHaveLength(1)
    await send(test, '/btw')
    expect(await test.screen()).toContain('this is already a btw side agent')
  })

  it('answers an approval from the working session while the side agent is on screen', async () => {
    const test = await bench({ running: true })
    await send(test, '/btw hi')
    const outcome = test.ctx.waterfall('approval/request', { agent: test.agent, toolName: 'shell', reason: 'run it' } as never, () => Promise.resolve('unavailable' as never))
    await test.settle()
    expect(await test.screen()).toContain('session session-tui-test, behind this view, asks:')
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(await outcome).not.toBe('unavailable')
  })

  it('reports a side agent the host cannot open and stays on the session', async () => {
    const test = await bench({ hostFailure: 'no model' })
    await send(test, '/btw why')
    const screen = await test.screen()
    expect(screen).toContain('opening btw failed: no model')
    expect(screen).not.toContain('btw side agent')
    expect(test.calls.injections).toEqual([])
  })

  it('refuses to open while a switch is in progress and ends a side agent that opens after quitting', async () => {
    const gate = { release: () => {} }
    const test = await bench({ hostGate: gate })
    await send(test, '/btw first')
    await send(test, '/btw second')
    expect(await test.screen()).toContain('wait for the session switch to finish')
    test.terminal.type(KEY.ctrlD)
    await test.settle()
    gate.release()
    await test.settle()
    expect(test.opened.at(-1)?.disposed).toBe(1)
  })

  it('ends the side agent with the session when quitting from it', async () => {
    const options: Parameters<typeof bench>[0] & object = {}
    const test = await bench(options)
    await send(test, '/btw q')
    options.disposeFailure = 'still busy'
    test.terminal.type(KEY.ctrlD)
    await test.settle()
    expect(test.quits.map(bound => bound.agent.session.id)).toEqual(['session-tui-test'])
    expect(test.opened.at(-1)?.disposed).toBe(1)
  })
})
