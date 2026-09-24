/** The shortcuts every region answers: todos, the parent session, the key list, and a redraw. */

import { describe, expect, it } from 'vitest'
import { KEY, bench } from './bench.ts'

/** `Ctrl+T`, `Ctrl+P`, and `Ctrl+L` as the terminal sends them. */
const CTRL = { t: '\u0014', p: '\u0010', l: '\u000c' } as const

describe('shortcuts', () => {
  it('lists the commands and keys on ? from an empty input, and types ? inside a draft', async () => {
    const test = await bench()
    await test.settle()
    test.terminal.type('?')
    await test.settle()
    expect(await test.screen()).toContain('Ctrl+T todos · Ctrl+P parent session')
    for (const char of 'why') test.terminal.type(char)
    test.terminal.type('?')
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'why?' }]])
    const source = test.calls.followups[0]?.source
    const record: { readonly rpcId?: unknown } = source ?? {}
    expect(source?.kind).toBe('user')
    expect(record.rpcId).toEqual(expect.any(String))
  })

  it('opens the todo list on Ctrl+T from any region', async () => {
    const test = await bench()
    await test.settle()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(CTRL.t)
    await test.settle()
    expect(await test.screen()).toContain('no todos yet')
  })

  it('answers Ctrl+P at the root session and redraws the whole screen on Ctrl+L', async () => {
    const test = await bench()
    await test.settle()
    test.terminal.type(CTRL.p)
    await test.settle()
    expect(await test.screen()).toContain('this is the root session; /parent returns from a subagent view')
    test.terminal.output = ''
    test.terminal.type(CTRL.l)
    await test.settle()
    expect(test.terminal.output).toContain('dsh · session session-tui-test')
  })
})
