/** Terminal Team commands use shared task boards and ordinary subagent identities. */
import { describe, expect, it } from 'vitest'
import { KEY, bench, type Bench } from './bench.ts'
import { listed, provideTeam } from './team-bench.ts'

function typeLine(test: Bench, text: string): void {
  for (const char of text) test.terminal.type(char)
  test.terminal.type(KEY.enter)
}

describe('team commands', () => {
  it('reports an unavailable Team service', async () => {
    const test = await bench()
    for (const command of ['/team', '/team-tools', '/team-panel']) {
      typeLine(test, command)
      await test.settle()
    }
    expect((await test.screen()).match(/Agent Teams are not enabled in this composition/gu)).toHaveLength(3)
  })

  it('browses continuable child labels and opens their existing sessions', async () => {
    const test = await bench({ before(ctx) { provideTeam(ctx, () => [listed('session-ada', 'Ada')]) } })
    await test.createChild({ id: 'session-ada' })
    expect(await test.screen()).toContain('team · 1 teammate · tasks 0/0 done · /team-play')
    typeLine(test, '/team')
    await test.settle()
    expect(test.terminal.text()).toContain('Ada')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.hostCalls).toContain('observe-resident:session-ada')
  })

  it('toggles the summary independently of Team mode', async () => {
    const test = await bench({ before(ctx) { provideTeam(ctx, () => [listed('session-ada', 'Ada')]) } })
    typeLine(test, '/team-panel off')
    await test.settle()
    expect(await test.screen()).not.toContain('team ·')
    typeLine(test, '/team-panel on')
    await test.settle()
    expect(await test.screen()).toContain('team · 1 teammate')
    typeLine(test, '/team-panel sideways')
    await test.settle()
    expect(test.terminal.text()).toContain('usage: /team-panel')
  })

  it('changes the root Team selection without discarding children', async () => {
    const test = await bench({ before(ctx) { provideTeam(ctx, () => [listed('session-ada', 'Ada')]) } })
    typeLine(test, '/team off')
    await test.settle()
    expect(await test.screen()).not.toContain('Agent Teams on')
    typeLine(test, '/team on')
    await test.settle()
    expect(await test.screen()).toContain('Agent Teams on')
    expect(await test.screen()).toContain('team · 1 teammate')
    typeLine(test, '/team sideways')
    await test.settle()
    expect(test.terminal.text()).toContain('usage: /team · /team on · /team off')
  })

  it('shows a forced empty task board and allows cancelling the roster picker', async () => {
    const test = await bench({ before(ctx) { provideTeam(ctx) } })
    typeLine(test, '/team-panel on')
    await test.settle()
    expect(await test.screen()).toContain('no teammates or shared tasks yet')
    typeLine(test, '/team')
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.hostCalls.some(call => call.startsWith('observe'))).toBe(false)
  })
})
