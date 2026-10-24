/** The Agent Teams start card and the `/team-play` team room, driven through the real app. */

import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { BENCH_SPINNER_MS, KEY, bench, type Bench, type BenchChild } from './bench.ts'
import { TEAM_EXPLAIN_LINE, TEAM_OFF_COMMAND, TEAM_OFF_LINE, TEAM_ON_LINE } from '../src/team-intro.ts'
import { TEAM_NOT_MEMBER_NOTICE } from '../src/team.ts'
import type { TeamMemberRow, TeamTaskRow } from '../src/team-panel.ts'

const ENTER_ALT = '\u001b[?1049h'
const LEAVE_ALT = '\u001b[?1049l'

const ABSENT = 'Agent Teams are not enabled in this composition'

function typeLine(test: Bench, text: string): void {
  for (const char of text) test.terminal.type(char)
  test.terminal.type(KEY.enter)
}

function member(row: Pick<TeamMemberRow, 'id' | 'name' | 'role' | 'status'> & Partial<TeamMemberRow>): TeamMemberRow {
  return { diagnostics: [], ...row }
}

function task(row: Pick<TeamTaskRow, 'id' | 'subject' | 'status'> & Partial<TeamTaskRow>): TeamTaskRow {
  return {
    revision: 1,
    description: 'body',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    ...row,
  }
}

const lead = member({ id: 'session-tui-test', name: 'lead', role: 'lead', status: 'inactive' })
const ada = member({ id: 'session-ada', name: 'ada', role: 'teammate', status: 'inactive', description: 'reviews the diff' })
const bo = member({ id: 'session-bo', name: 'bo', role: 'teammate', status: 'inactive', description: 'writes the release notes' })

function teams(ctx: Context, members: () => readonly TeamMemberRow[], tasks: () => readonly TeamTaskRow[] = () => []): void {
  ctx.provide('agentTeams', {
    tryMembership: () => ({}),
    listMembers: () => members(),
    listTasks: () => tasks(),
  })
}

function call(seq: number, name: string, args: unknown): never {
  return {
    type: 'tool/call',
    seq,
    time: seq,
    data: { turn: 1, step: 1, callId: ToolCallId(`call-${String(seq)}`), name, arguments: JSON.stringify(args) },
  } as never
}

function queued(seq: number, senderId: string, senderName: string, targetId: string, text: string): never {
  return {
    type: 'team/message/queued',
    seq,
    time: seq,
    data: {
      version: 2,
      teamId: 'session-tui-test',
      message: { id: `team-message-${String(seq)}`, senderId, senderName, targetId, content: [{ type: 'text', text }] },
    },
  } as never
}

/**
 * The rows the alternate screen shows now: every row the latest open page
 * painted, replayed from the writes since the terminal entered it.
 * @param test - the bench whose terminal wrote them.
 * @returns one string per terminal row.
 */
function altRows(test: Bench): string[] {
  const written = test.terminal.written
  const entered = written.lastIndexOf(ENTER_ALT)
  const left = written.indexOf(LEAVE_ALT, entered)
  const chunk = written.slice(entered, left === -1 ? undefined : left)
  const rows = Array.from({ length: test.terminal.rows }, () => '')
  const parts = chunk.split(/\u001b\[(\d+);1H\u001b\[2K/u)
  for (let at = 1; at < parts.length; at += 2) {
    rows[Number(parts[at]) - 1] = (parts[at + 1] ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '')
  }
  return rows
}

function alt(test: Bench): string {
  return altRows(test).join('\n')
}

async function open(test: Bench): Promise<void> {
  typeLine(test, '/team-play')
  await test.settle()
}

describe('the start card', () => {
  it('explains the feature in static text while the service is mounted', async () => {
    const bare = await bench()
    expect(await bare.screen()).not.toContain(TEAM_ON_LINE)

    const mounted = await bench({
      before(ctx) {
        ctx.provide('agentTeams', { listMembers: () => [] })
      },
    })
    const screen = await mounted.screen()
    for (const line of [
      TEAM_ON_LINE,
      TEAM_EXPLAIN_LINE,
      '/team-play   live team room: roles, current work, tasks, and messages',
      '/team        roster and shared task board',
      TEAM_OFF_LINE,
      TEAM_OFF_COMMAND,
    ]) expect(screen).toContain(line)
    expect(mounted.tickArmed(BENCH_SPINNER_MS)).toBe(false)
    mounted.runTick(BENCH_SPINNER_MS)
    expect(await mounted.screen()).toContain(TEAM_EXPLAIN_LINE)
  })

  it('is not drawn over a session that already has a prompt, a tool call, or a reply', async () => {
    const history: Record<string, never> = {
      prompt: {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
      } as never,
      'tool call': call(1, 'bash', { command: 'ls' }),
      reply: {
        type: 'assistant/message',
        seq: 1,
        time: 1,
        data: {
          stream: [],
          turn: 1,
          step: 1,
          message: createAssistantMessage({ content: [{ type: 'text', text: 'hi there' }], source: { provider: 'test-provider', model: 'test-model' } }),
        },
      } as never,
    }
    for (const [label, event] of Object.entries(history)) {
      const test = await bench({
        before(ctx) {
          ctx.provide('agentTeams', { listMembers: () => [] })
        },
        history: [event],
      })
      expect(await test.screen(), label).not.toContain(TEAM_ON_LINE)
    }
  })
})

describe('/team-play', () => {
  it('refuses when Agent Teams is not mounted', async () => {
    const test = await bench()
    await open(test)
    expect(await test.screen()).toContain(ABSENT)
    expect(test.terminal.written).not.toContain(ENTER_ALT)
  })

  it('refuses on a session that is not on a team', async () => {
    const test = await bench({
      before(ctx) {
        ctx.provide('agentTeams', { tryMembership: () => undefined, listMembers: () => [], listTasks: () => [] })
      },
    })
    await open(test)
    expect(await test.screen()).toContain(TEAM_NOT_MEMBER_NOTICE)
    expect(test.terminal.written).not.toContain(ENTER_ALT)
  })

  it('shows each member with its role and current work, the tasks, and the messages, and Esc returns', async () => {
    const test = await bench({
      before(ctx) {
        teams(
          ctx,
          () => [lead, ada, bo],
          () => [
            task({ id: '1', subject: 'review the lockfile', status: 'in_progress', ownerName: 'ada' }),
            task({ id: '2', subject: 'write the notes', status: 'pending', blockedBy: ['1'], ready: false }),
            task({ id: '3', subject: 'plan', status: 'completed', ownerName: 'lead' }),
          ],
        )
      },
      history: [
        call(1, 'spawn_teammate', { name: 'ada', prompt: 'inspect the lockfile' }),
        call(2, 'send_message', { target: 'bo', message: 'draft the notes' }),
      ],
    })
    await test.settle()
    await open(test)
    const rows = altRows(test)
    expect(rows).toHaveLength(test.terminal.rows)
    expect(rows[0]).toBe('team play · 2 teammates · 0 working · tasks 1/3 done')
    expect(rows[1]).toContain('Enter opens')
    const screen = alt(test)
    expect(screen).toMatch(/▸ ○ lead +orchestrator +inactive/u)
    expect(screen).toMatch(/ada +reviews the diff +review the lockfile/u)
    expect(screen).toMatch(/bo +writes the release notes +inactive/u)
    expect(screen).toMatch(/#1 ◐ review the lockfile +ada/u)
    expect(screen).toMatch(/#2 ○ write the notes +unowned +blocked by #1/u)
    expect(screen).toMatch(/#3 ✓ plan +lead/u)
    expect(screen).toContain('Messages · 2')
    expect(screen).toContain('lead → ada  spawn: inspect the lockfile')
    expect(screen).toContain('lead → bo  message: draft the notes')

    const room = test.terminal.written.length
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.written.slice(room)).toContain(LEAVE_ALT)
  })

  it('closes on q and on Ctrl+C', async () => {
    const test = await bench({
      before(ctx) {
        teams(ctx, () => [lead])
      },
    })
    await open(test)
    const first = test.terminal.written.length
    test.terminal.type('q')
    await test.settle()
    expect(test.terminal.written.slice(first)).toContain(LEAVE_ALT)

    await open(test)
    const second = test.terminal.written.length
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.terminal.written.slice(second)).toContain(LEAVE_ALT)
  })

  it('shows only the lead and a hint while the team has no teammate', async () => {
    const test = await bench({
      before(ctx) {
        teams(ctx, () => [lead])
      },
    })
    await open(test)
    const screen = alt(test)
    expect(screen).toContain('team play · 0 teammates · 0 working · tasks 0/0 done')
    expect(screen).toContain('No teammates yet — ask for work that splits into independent parts and the lead will delegate it.')
    expect(screen).toContain('No tasks yet.')
    expect(screen).toContain('No messages yet.')
    expect(screen).not.toContain('lead → ')
  })

  it('opens the selected teammate as a live session, and says the lead has no session to open', async () => {
    const test = await bench({
      before(ctx) {
        teams(ctx, () => [lead, ada])
      },
    })
    await test.createChild({ id: 'session-ada' })
    await open(test)

    test.terminal.type(KEY.enter)
    await test.settle()
    expect(altRows(test)[1]).toBe('the lead has no teammate session to open')
    expect(test.hostCalls.some(entry => entry.startsWith('observe'))).toBe(false)

    test.terminal.type(KEY.down)
    const room = test.terminal.written.length
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.written.slice(room)).toContain(LEAVE_ALT)
    expect(test.hostCalls).toContain('observe-resident:session-ada')
  })

  it('narrows the messages to the selected member with f', async () => {
    const test = await bench({
      before(ctx) {
        teams(ctx, () => [lead, ada, bo])
      },
      history: [
        call(1, 'send_message', { target: 'ada', message: 'check the lockfile' }),
        call(2, 'send_message', { target: 'bo', message: 'draft the notes' }),
      ],
    })
    await open(test)
    expect(alt(test)).toContain('Messages · 2')

    test.terminal.type(KEY.down)
    test.terminal.type('f')
    await test.settle()
    let screen = alt(test)
    expect(screen).toContain('Messages · with ada · 1')
    expect(screen).toContain('lead → ada  message: check the lockfile')
    expect(screen).not.toContain('draft the notes')

    test.terminal.type('f')
    await test.settle()
    screen = alt(test)
    expect(screen).toContain('Messages · 2')
    expect(screen).toContain('draft the notes')
  })

  it('lists a message between two teammates from the lead log once, from its sender to its target', async () => {
    const test = await bench({
      before(ctx) {
        teams(ctx, () => [lead, ada, bo])
      },
      history: [
        queued(1, 'session-ada', 'ada', 'session-bo', 'the lockfile\nchanged'),
        call(2, 'send_message', { target: 'bo', message: 'the lockfile changed' }),
        queued(3, 'session-bo', 'bo', 'session-tui-test', 'got it'),
        {
          type: 'user/message',
          seq: 4,
          time: 4,
          data: createUserMessage({ content: [{ type: 'text', text: 'Team message from bo: got it' }], source: { kind: 'user' } }),
        } as never,
        {
          type: 'team/message/delivered',
          seq: 5,
          time: 5,
          data: { version: 2, teamId: 'session-tui-test', messageId: 'team-message-1', targetId: 'session-bo' },
        } as never,
      ],
    })
    await open(test)
    const screen = alt(test)
    expect(screen).toContain('Messages · 2')
    expect(screen).toContain('ada → bo  message: the lockfile changed')
    expect(screen).toContain('bo → lead  message: got it')
    expect(screen).not.toContain('lead → bo')
    expect(screen).not.toContain('lead → team')

    test.terminal.type(KEY.down)
    test.terminal.type(KEY.down)
    test.terminal.type('f')
    await test.settle()
    expect(alt(test)).toContain('Messages · with bo · 2')
  })

  it('pages the messages with PgUp and PgDn', async () => {
    const test = await bench({
      before(ctx) {
        teams(ctx, () => [lead, ada])
      },
      history: Array.from({ length: 100 }, (_, index) => call(index + 1, 'send_message', { target: 'ada', message: `step ${String(index + 1)}` })),
    })
    await open(test)
    expect(alt(test)).toContain('step 100')
    test.terminal.type(KEY.pageUp)
    await test.settle()
    expect(alt(test)).not.toContain('step 100')
    expect(alt(test)).toMatch(/Messages · 100 · \d+ earlier · 31 later/u)
    test.terminal.type(KEY.pageDown)
    await test.settle()
    expect(alt(test)).toContain('step 100')
  })

  it('repaints when the roster changes with a team event', async () => {
    let members = [lead]
    const test = await bench({
      before(ctx) {
        teams(ctx, () => members)
      },
    })
    await open(test)
    expect(alt(test)).toContain('0 teammates')

    members = [lead, ada]
    test.session.append('team/member', {
      version: 2,
      teamId: 'session-tui-test',
      member: { id: 'session-ada', name: 'ada', description: '', provider: 'test-provider', context: 'fresh', phase: 'active' },
    } as never)
    await test.settle()
    expect(alt(test)).toContain('1 teammate ·')
    expect(alt(test)).toContain('lead → ada  spawn: active')
  })

  it('shows what a running teammate last narrated, and repaints as it speaks', async () => {
    let status: TeamMemberRow['status'] = 'inactive'
    const listed = [{
      kind: 'child',
      id: 'session-ada',
      activity: 'running',
      mode: 'continuable',
      hasChildren: false,
      parentId: 'session-tui-test',
      depth: 1,
      label: 'ada',
    }]
    const test = await bench({
      subagents: () => Promise.resolve(listed as never),
      before(ctx) {
        teams(ctx, () => [lead, { ...ada, status }])
      },
    })
    const kid: BenchChild = await test.createChild({ id: 'session-ada' })
    status = 'running'
    kid.setStatus('running')
    test.tick(0)
    await test.settle()
    await open(test)
    expect(alt(test)).toMatch(/ada +reviews the diff +running/u)

    kid.session.append('turn/start', { turn: 1 })
    kid.session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Reading the lockfile. Now comparing it with the manifest.' }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    await test.settle()
    expect(alt(test)).toMatch(/ada +reviews the diff +Now comparing it with the manifest\./u)
  })

  it('steps the spinner only while a teammate runs and motion is on', async () => {
    let status: TeamMemberRow['status'] = 'inactive'
    const make = (reducedMotion: boolean): Promise<Bench> => bench({
      reducedMotion,
      before(ctx) {
        teams(ctx, () => [{ ...lead, status: 'inactive' }, { ...ada, status }])
      },
    })
    const idle = await make(false)
    await open(idle)
    expect(idle.tickArmed(BENCH_SPINNER_MS)).toBe(false)

    status = 'running'
    const moving = await make(false)
    await open(moving)
    expect(moving.tickArmed(BENCH_SPINNER_MS)).toBe(true)
    const before = altRows(moving).find(row => row.includes('ada'))
    moving.runTick(BENCH_SPINNER_MS)
    const after = altRows(moving).find(row => row.includes('ada'))
    expect(after).not.toBe(before)
    expect(after).toMatch(/^ {2}\S ada/u)

    status = 'inactive'
    moving.runTick(BENCH_SPINNER_MS)
    expect(moving.tickArmed(BENCH_SPINNER_MS)).toBe(false)

    status = 'running'
    const still = await make(true)
    await open(still)
    expect(still.tickArmed(BENCH_SPINNER_MS)).toBe(false)
    expect(altRows(still).find(row => row.includes('ada'))).toMatch(/^ {2}● ada/u)
  })

  it('draws an empty roster when the service stops answering for this session', async () => {
    let member = true
    const test = await bench({
      before(ctx) {
        ctx.provide('agentTeams', {
          tryMembership: () => member ? {} : undefined,
          listMembers: () => [lead, ada],
          listTasks: () => [],
        })
      },
      history: [call(1, 'send_message', { target: 'ada', message: 'hello' })],
    })
    await open(test)
    expect(alt(test)).toContain('lead → ada  message: hello')

    member = false
    test.session.append('team/member', {
      version: 2,
      teamId: 'session-tui-test',
      member: { id: 'session-ada', name: 'ada', description: '', provider: 'test-provider', context: 'fresh', phase: 'active' },
    } as never)
    await test.settle()
    const screen = alt(test)
    expect(screen).toContain('team play · 0 teammates · 0 working · tasks 0/0 done')
    expect(screen).toContain('No teammates yet')
    expect(screen).toContain('lead → ada  spawn: active')
  })

  it('lists the calls of the tools the plugin scopes onto the agent', async () => {
    const test = await bench({
      before(ctx) {
        teams(ctx, () => [lead])
        ctx.provide('tools', {
          get: () => undefined,
          schemas: (scope?: unknown) => scope === undefined
            ? [{ name: 'bash' }]
            : [{ name: 'bash' }, { name: 'team_vote' }],
        } as never)
      },
      history: [call(1, 'bash', { command: 'ls' }), call(2, 'team_vote', { choice: 'yes' })],
    })
    await open(test)
    const screen = alt(test)
    expect(screen).toContain('Messages · 1')
    expect(screen).toContain('lead → team  message: choice: yes')
  })

  it('is taken down when the app quits', async () => {
    const test = await bench({
      before(ctx) {
        teams(ctx, () => [lead])
      },
    })
    await open(test)
    const room = test.terminal.written.length
    test.app.stop()
    expect(test.terminal.written.slice(room)).toContain(LEAVE_ALT)
  })
})
