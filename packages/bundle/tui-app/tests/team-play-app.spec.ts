/** The terminal Team start card and live room use standard child discovery. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { KEY, bench, type Bench } from './bench.ts'
import { listed, provideTeam } from './team-bench.ts'
import { TEAM_EXPLAIN_LINE, TEAM_OFF_COMMAND, TEAM_ON_LINE } from '../src/team-intro.ts'

const ENTER_ALT = '\u001b[?1049h'
const LEAVE_ALT = '\u001b[?1049l'

async function open(test: Bench): Promise<void> {
  for (const char of '/team-play') test.terminal.type(char)
  test.terminal.type(KEY.enter)
  await test.settle()
}

function alt(test: Bench): string {
  const entered = test.terminal.written.lastIndexOf(ENTER_ALT)
  return test.terminal.written.slice(entered).replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '')
}

describe('Team start card and live room', () => {
  it('explains the enabled feature and gives a session mode command', async () => {
    const bare = await bench()
    expect(await bare.screen()).not.toContain(TEAM_ON_LINE)
    const test = await bench({ before(ctx) { provideTeam(ctx) } })
    const screen = await test.screen()
    for (const line of [TEAM_ON_LINE, TEAM_EXPLAIN_LINE, TEAM_OFF_COMMAND]) expect(screen).toContain(line)
    expect(TEAM_OFF_COMMAND).toBe('/team off')
  })

  it('rejects opening a room when the service is absent or Team mode is off', async () => {
    const bare = await bench()
    await open(bare)
    expect(await bare.screen()).toContain('Agent Teams are not enabled in this composition')
    const off = await bench({ before(ctx) { provideTeam(ctx).enabled = false } })
    await open(off)
    expect(await off.screen()).toContain('this session is not on a team')
    expect(off.terminal.written).not.toContain(ENTER_ALT)
  })

  it('shows current teammates and the shared task board, then restores the main screen', async () => {
    const test = await bench({ before(ctx) {
      provideTeam(ctx, () => [listed('session-ada', 'Ada')], () => [{
        id: 'task-1', revision: 1, subject: 'review the lockfile', description: 'Check dependency changes', status: 'pending',
        blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [],
      }])
    } })
    await open(test)
    expect(test.terminal.written).toContain(ENTER_ALT)
    expect(alt(test)).toContain('Ada')
    expect(alt(test)).toContain('review the lockfile')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.written).toContain(LEAVE_ALT)
    expect(await test.screen()).toContain('team · 1 teammate · tasks 0/1 done')
  })

  it('shows addressable teammate names and filters their exchanges', async () => {
    const test = await bench({ before(ctx) {
      provideTeam(ctx, () => [{
        kind: 'child', id: SessionId('session-checker'), parentId: SessionId('session-reviewer'), depth: 2,
        mode: 'continuable', name: 'checker', path: 'reviewer/checker', label: 'Inspect dependencies',
        activity: 'inactive', hasChildren: false,
      }])
    } })
    test.appendToolCall('spawn-checker', 'subagent', { description: 'Inspect dependencies', prompt: 'Check the lockfile' })
    test.appendToolResult('spawn-checker', [{ type: 'text', text: 'started subagent reviewer/checker' }], false,
      { kind: 'activation', name: 'reviewer/checker' })
    test.appendToolCall('message-checker', 'send_message', { agent: 'reviewer/checker', message: 'Check the tests' })
    await test.settle()

    for (const char of '/team') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(await test.screen()).toContain('reviewer/checker')
    test.terminal.type(KEY.escape)
    await test.settle()

    await open(test)
    expect(alt(test)).toContain('reviewer/checker')
    expect(alt(test)).toContain('Inspect dependencies')
    expect(alt(test)).toContain('spawn: Check the lockfile')
    expect(alt(test)).toContain('message: Check the tests')
    test.terminal.type(KEY.down)
    test.terminal.type('f')
    await test.settle()
    expect(alt(test)).toContain('Messages · with reviewer/checker · 2')
    expect(alt(test)).toContain('lead → reviewer/checker')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.written).toContain(LEAVE_ALT)
  })

  it('tears the room down when the app quits', async () => {
    const test = await bench({ before(ctx) { provideTeam(ctx) } })
    await open(test)
    test.app.hangup()
    expect(test.terminal.written).toContain(LEAVE_ALT)
  })
})
