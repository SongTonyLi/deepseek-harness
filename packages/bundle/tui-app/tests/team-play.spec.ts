/** The start card and the team room: exchanges read from the log, the three sections, and the page's keys. */

import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/style.ts'
import {
  TEAM_PLAY_EMPTY_HINT,
  TEAM_PLAY_HINTS,
  TeamPlay,
  beatsFromEvents,
  teamRoomFrame,
  type TeamBeat,
  type TeamLogEvent,
  type TeamRoomDraw,
  type TeamRoomSource,
} from '../src/team-play.ts'
import {
  TEAM_EXPLAIN_LINE,
  TEAM_OFF_COMMAND,
  TEAM_OFF_LINE,
  TEAM_ON_LINE,
  TeamIntro,
  agentTeamsMounted,
  teamIntroLines,
} from '../src/team-intro.ts'
import type { TeamMemberRow, TeamTaskRow } from '../src/team-panel.ts'

const palette = createPalette(false)

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

const lead = member({ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' })
const reviewer = member({ id: 'session-reviewer', name: 'reviewer', role: 'teammate', status: 'running', description: 'checks the diff for regressions' })
const writer = member({ id: 'session-writer', name: 'writer', role: 'teammate', status: 'inactive' })

function source(parts: Partial<TeamRoomSource> = {}): TeamRoomSource {
  return {
    members: [lead, reviewer, writer],
    tasks: [],
    beats: [],
    note: () => undefined,
    spinner: () => undefined,
    ...parts,
  }
}

function draw(parts: Partial<TeamRoomDraw> = {}): TeamRoomDraw {
  return {
    palette,
    source: source(),
    selected: undefined,
    filtered: false,
    back: 0,
    notice: undefined,
    width: 100,
    rows: 24,
    ...parts,
  }
}

/** Drop the reset sequences the width cutter writes around an ellipsis. */
function plain(lines: readonly string[]): string[] {
  return lines.map(line => line.replace(/\u001b\[[0-9;]*m/gu, ''))
}

function frame(parts: Partial<TeamRoomDraw> = {}): string[] {
  return plain(teamRoomFrame(draw(parts)).lines)
}

function beat(from: string, to: string, text: string, kind: TeamBeat['kind'] = 'message'): TeamBeat {
  return { from, to, kind, text }
}

/** One beat as `<kind> <from>→<to> <text>`. */
function line(item: TeamBeat): string {
  return `${item.kind} ${item.from}→${item.to} ${item.text}`
}

describe('beats from the session log', () => {
  it('reads spawn, message, task, and a received team message, once each', () => {
    const beats = beatsFromEvents([
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/call', data: { name: 'spawn_teammate', arguments: '{"name":"reviewer","prompt":"inspect the lockfile"}' } },
      { type: 'tool/call', data: { name: 'send_message', arguments: '{"target":"reviewer","message":"the lockfile changed"}' } },
      { type: 'tool/call', data: { name: 'spawn_teammate', arguments: 'not-json' } },
      { type: 'team/member', data: { member: { name: 'reviewer', phase: 'active' } } },
      { type: 'team/task', data: { task: { subject: 'read the lockfile', status: 'pending' } } },
      {
        type: 'user/message',
        data: { message: { content: [{ type: 'text', text: 'Team message from reviewer: looks consistent' }] } },
      },
    ], 'lead')
    expect(beats.map(line)).toEqual([
      'spawn lead→reviewer inspect the lockfile',
      'message lead→reviewer the lockfile changed',
      'task lead→board pending read the lockfile',
      'message reviewer→lead looks consistent',
    ])
  })

  it('lists the task calls of a log that has no task record, as a teammate logs them', () => {
    expect(beatsFromEvents([
      { type: 'tool/call', data: { name: 'team_task_update', arguments: '{"action":"claim"}' } },
      { type: 'tool/call', data: { name: 'team_task_update', arguments: '{"action":"claim"}' } },
      { type: 'tool/call', data: { name: 'team_task_update', arguments: '{"action":"complete","subject":"read the lockfile"}' } },
    ], 'ada').map(line)).toEqual([
      'task ada→board claim',
      'task ada→board claim',
      'task ada→board complete read the lockfile',
    ])
  })

  it('plays a tool the plugin added and a new team event, and skips a global command', () => {
    const beats = beatsFromEvents([
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/call', data: { name: 'team_vote', arguments: '{"choice":"yes"}' } },
      { type: 'team/vote', data: { choice: 'yes' } },
    ], 'lead', new Set(['team_vote']))
    expect(beats.map(beat => `${beat.kind} ${beat.from}→${beat.to} ${beat.text}`)).toEqual([
      'message lead→team choice: yes',
      'message lead→team yes',
    ])
  })
})

describe('beats from unusual events', () => {
  function summarize(events: Parameters<typeof beatsFromEvents>[0], names?: ReadonlySet<string>): string[] {
    return beatsFromEvents(events, 'lead', names).map(item => `${item.kind} ${item.from}→${item.to} ${item.text}`)
  }

  it('skips events that are not exchanges', () => {
    expect(summarize([
      { type: 'assistant/message', data: {} },
      { type: 'tool/call', data: 'not an object' },
      { type: 'tool/call', data: { name: 7 } },
      { type: 'tool/call', data: { name: 'bash', arguments: 4 } },
      { type: 'tool/call', data: { name: 'bash', arguments: '[1]' } },
      { type: 'user/message', data: { message: { content: 'plain' } } },
      { type: 'user/message', data: { message: { content: [{ type: 'image' }, { type: 'text', text: 'hello there' }] } } },
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Team message from : hello' }] } } },
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Team message from ada:   ' }], source: { kind: 'agent-message' } } } },
      { type: 'user/message', data: { message: { content: [], source: { kind: 'agent-message' } } } },
    ])).toEqual([
      'message teammate→lead Team message from ada:   ',
    ])
  })

  it('reads calls by the argument that names the exchange', () => {
    expect(summarize([
      { type: 'tool/call', data: { name: 'send_message', arguments: '{"target":"ada"}' } },
      { type: 'tool/call', data: { name: 'send_message', arguments: '{"name":"ada","message":"hi"}' } },
      { type: 'tool/call', data: { name: 'spawn_teammate', arguments: '{"prompt":"do it"}' } },
      { type: 'tool/call', data: { name: 'spawn_teammate', arguments: '{"prompt":"do it","target":"ada"}' } },
      { type: 'tool/call', data: { name: 'task', arguments: '{"subject":"s","target":"ada"}' } },
      { type: 'tool/call', data: { name: 'task', arguments: '{"action":"claim"}' } },
      { type: 'tool/call', data: { name: 'task', arguments: '{"subject":"only"}' } },
      { type: 'tool/call', data: { name: 'send_message', arguments: '{"target":"  ","message":"hi"}' } },
    ])).toEqual([
      'message lead→ada send_message',
      'message lead→ada hi',
      'spawn lead→team do it',
      'message lead→ada spawn_teammate',
      'task lead→ada s',
      'task lead→board claim',
      'task lead→board only',
      'message lead→team hi',
    ])
  })

  it('names a scoped tool by its first string argument, or by its own name', () => {
    expect(summarize([
      { type: 'tool/call', data: { name: 'team_vote', arguments: '{"count":3}' } },
      { type: 'tool/call', data: { name: 'team_vote', arguments: 'broken' } },
      { type: 'tool/call', data: { name: 'team_vote', arguments: '{"count":3,"choice":"yes"}' } },
    ], new Set(['team_vote']))).toEqual([
      'message lead→team team_vote',
      'message lead→team team_vote',
      'message lead→team choice: yes',
    ])
  })

  it('reads roster, task, and message events of every shape', () => {
    expect(summarize([
      { type: 'team/member', data: { member: {} } },
      { type: 'team/member', data: { member: { name: 'ada', error: 'no model' } } },
      { type: 'team/member', data: { member: { name: 'bo' } } },
      { type: 'team/task', data: { task: { subject: 'plan' } } },
      { type: 'team/task', data: { task: { status: 'done' } } },
      { type: 'team/task', data: { task: {} } },
      { type: 'team/message', data: { message: { senderName: 'ada', text: 'hi' } } },
      { type: 'team/message', data: { message: { name: 'bo', status: 'ok', phase: 'late' } } },
      { type: 'team/message', data: { message: { subject: 'topic', message: 'body' } } },
      { type: 'team/note', data: { stray: ' ', other: 'first' } },
      { type: 'team/ping', data: 5 },
    ])).toEqual([
      'spawn lead→teammate member',
      'spawn lead→ada member',
      'spawn ada→lead failed: no model',
      'spawn lead→bo member',
      'task lead→board plan',
      'task lead→board done',
      'task lead→board task',
      'message lead→ada hi',
      'message lead→bo late',
      'message lead→topic body',
      'message lead→team first',
      'message lead→team ping',
    ])
  })
})

describe('beats from the Team Lead log', () => {
  const names = new Map([['session-lead', 'lead'], ['session-ada', 'ada'], ['session-bo', 'bo']])

  function read(events: Parameters<typeof beatsFromEvents>[0], toolNames?: ReadonlySet<string>): string[] {
    return beatsFromEvents(events, 'lead', toolNames, names).map(line)
  }

  function queuedEvent(message: Record<string, unknown>): TeamLogEvent {
    return { type: 'team/message/queued', data: { version: 2, teamId: 'session-lead', message: { id: 'team-message-1', ...message } } }
  }

  function memberEvent(row: Record<string, unknown>): TeamLogEvent {
    return { type: 'team/member', data: { version: 2, teamId: 'session-lead', member: row } }
  }

  function taskEvent(row: Record<string, unknown>): TeamLogEvent {
    return { type: 'team/task', data: { version: 2, teamId: 'session-lead', task: { revision: 1, description: '', blockedBy: [], writeScopes: [], ...row } } }
  }

  it('reads a peer message from its sender to its target, resolved by session id', () => {
    expect(read([
      queuedEvent({
        senderId: 'session-ada',
        senderName: 'ada',
        targetId: 'session-bo',
        content: [{ type: 'text', text: 'check  the\nlockfile' }, { type: 'image' }, { type: 'text', text: 'twice' }],
      }),
      queuedEvent({ senderId: 'session-bo', targetId: 'session-lead', content: [{ type: 'text', text: 'done' }] }),
      queuedEvent({ senderId: 'session-ghost', senderName: 'ghost', targetId: 'session-ghost', content: [{ type: 'text', text: 'boo' }] }),
      queuedEvent({ senderId: 'session-ghost', content: [{ type: 'text', text: 'who' }] }),
    ])).toEqual([
      'message ada→bo check the lockfile twice',
      'message bo→lead done',
      'message ghost→teammate boo',
      'message teammate→teammate who',
    ])
  })

  it('reads a message without a text block as a non-text message', () => {
    expect(read([
      queuedEvent({ senderId: 'session-ada', targetId: 'session-bo', content: [{ type: 'image' }] }),
      queuedEvent({ senderId: 'session-ada', targetId: 'session-bo', content: [{ type: 'text', text: '  \n ' }] }),
      queuedEvent({ senderId: 'session-ada', targetId: 'session-bo', content: 'plain' }),
      queuedEvent({ senderId: 'session-ada', targetId: 'session-bo' }),
      { type: 'team/message/queued', data: {} },
    ])).toEqual([
      'message ada→bo (non-text message)',
      'message ada→bo (non-text message)',
      'message ada→bo (non-text message)',
      'message ada→bo (non-text message)',
      'message teammate→teammate (non-text message)',
    ])
  })

  it('adds no row for a delivery receipt', () => {
    expect(read([
      queuedEvent({ senderId: 'session-ada', targetId: 'session-bo', content: [{ type: 'text', text: 'hi' }] }),
      { type: 'team/message/delivered', data: { version: 2, teamId: 'session-lead', messageId: 'team-message-1', targetId: 'session-bo' } },
    ])).toEqual(['message ada→bo hi'])
  })

  it('drops the message rows that a queued record already lists', () => {
    expect(read([
      { type: 'tool/call', data: { name: 'spawn_teammate', arguments: '{"name":"bo","prompt":"write the notes"}' } },
      { type: 'tool/call', data: { name: 'send_message', arguments: '{"target":"bo","message":"start now"}' } },
      { type: 'tool/call', data: { name: 'team_task_update', arguments: '{"action":"claim"}' } },
      queuedEvent({ senderId: 'session-lead', targetId: 'session-bo', content: [{ type: 'text', text: 'start now' }] }),
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Team message from bo: ready' }] } } },
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'ready' }], source: { kind: 'agent-message' } } } },
      queuedEvent({ senderId: 'session-bo', targetId: 'session-lead', content: [{ type: 'text', text: 'ready' }] }),
    ])).toEqual([
      'spawn lead→bo write the notes',
      'task lead→board claim',
      'message lead→bo start now',
      'message bo→lead ready',
    ])
  })

  it('keeps the message rows of a log without a queued record, as a teammate logs them', () => {
    expect(beatsFromEvents([
      { type: 'tool/call', data: { name: 'send_message', arguments: '{"target":"bo","message":"start now"}' } },
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Team message from lead: thanks' }] } } },
      { type: 'team/message/delivered', data: { messageId: 'team-message-1', targetId: 'session-bo' } },
    ], 'ada', undefined, names).map(line)).toEqual([
      'message ada→bo start now',
      'message lead→ada thanks',
    ])
  })

  it('lists each member once, from its spawn call when it has one', () => {
    expect(read([
      { type: 'tool/call', data: { name: 'spawn_teammate', arguments: '{"name":"ada","prompt":"inspect the lockfile"}' } },
      memberEvent({ id: 'session-ada', name: 'ada', phase: 'provisioning' }),
      memberEvent({ id: 'session-ada', name: 'ada', phase: 'active' }),
      memberEvent({ id: 'session-bo', name: 'bo', phase: 'provisioning' }),
      memberEvent({ id: 'session-bo', name: 'bo', phase: 'active' }),
      memberEvent({ name: 'cy' }),
      memberEvent({ name: 'cy', phase: 'active' }),
      memberEvent({ id: 'session-ada', phase: 'active' }),
      { type: 'team/member', data: {} },
    ])).toEqual([
      'spawn lead→ada inspect the lockfile',
      'spawn lead→bo provisioning',
      'spawn lead→cy member',
      'spawn lead→teammate member',
    ])
  })

  it('names a member by its session id when the record lacks the name', () => {
    expect(read([memberEvent({ id: 'session-bo', phase: 'active' }), memberEvent({ id: 'session-ghost', phase: 'active' })])).toEqual([
      'spawn lead→bo active',
      'spawn lead→teammate active',
    ])
  })

  it('lists a failed member apart from its spawn row', () => {
    expect(read([
      { type: 'tool/call', data: { name: 'spawn_teammate', arguments: '{"name":"ada","prompt":"inspect"}' } },
      memberEvent({ id: 'session-ada', name: 'ada', phase: 'provisioning' }),
      memberEvent({ id: 'session-ada', name: 'ada', phase: 'failed', error: 'no model' }),
      memberEvent({ id: 'session-bo', name: 'bo', phase: 'provisioning' }),
      memberEvent({ id: 'session-bo', name: 'bo', phase: 'failed' }),
      memberEvent({ id: 'session-cy', name: 'cy', phase: 'active', error: 'late fault' }),
    ])).toEqual([
      'spawn lead→ada inspect',
      'spawn ada→lead failed: no model',
      'spawn lead→bo provisioning',
      'spawn bo→lead failed',
      'spawn lead→cy active',
      'spawn cy→lead failed: late fault',
    ])
  })

  it('captions a task revision with its status and attributes it to its owner', () => {
    expect(read([
      taskEvent({ id: '1', subject: 'review the lockfile', status: 'pending' }),
      taskEvent({ id: '1', subject: 'review the lockfile', status: 'in_progress', ownerId: 'session-ada' }),
      taskEvent({ id: '2', subject: 'write the notes', status: 'pending' }),
      taskEvent({ id: '1', subject: 'review the lockfile', status: 'completed', ownerId: 'session-ada' }),
      taskEvent({ id: '2', subject: 'write the notes', status: 'pending', ownerId: 'session-ghost' }),
    ])).toEqual([
      'task lead→board pending review the lockfile',
      'task ada→board in_progress review the lockfile',
      'task lead→board pending write the notes',
      'task ada→board completed review the lockfile',
      'task lead→board pending write the notes',
    ])
  })

  it('skips a revision that keeps the status and the owner', () => {
    expect(read([
      taskEvent({ id: '1', subject: 'review', status: 'in_progress', ownerId: 'session-ada' }),
      taskEvent({ id: '1', subject: 'review the lockfile', status: 'in_progress', ownerId: 'session-ada' }),
      taskEvent({ id: '1', subject: 'review the lockfile', status: 'in_progress', ownerId: 'session-bo' }),
      taskEvent({ id: '1', subject: 'review the lockfile', status: 'in_progress' }),
    ])).toEqual([
      'task ada→board in_progress review',
      'task bo→board in_progress review the lockfile',
      'task lead→board in_progress review the lockfile',
    ])
  })

  it('collapses identical consecutive task records and keeps a repeat that follows another row', () => {
    expect(read([
      { type: 'team/task', data: {} },
      { type: 'team/task', data: { task: { subject: 'plan', status: 'pending' } } },
      { type: 'team/task', data: { task: { subject: 'plan', status: 'pending' } } },
      queuedEvent({ senderId: 'session-ada', targetId: 'session-bo', content: [{ type: 'text', text: 'hi' }] }),
      { type: 'team/task', data: { task: { subject: 'plan', status: 'pending' } } },
    ])).toEqual([
      'task lead→board task',
      'task lead→board pending plan',
      'message ada→bo hi',
      'task lead→board pending plan',
    ])
  })

  it('drops the task rows that task records already list', () => {
    expect(read([
      { type: 'tool/call', data: { name: 'team_task_create', arguments: '{"subject":"review the lockfile"}' } },
      taskEvent({ id: '1', subject: 'review the lockfile', status: 'pending' }),
      { type: 'tool/call', data: { name: 'team_task_update', arguments: '{"action":"claim"}' } },
      taskEvent({ id: '1', subject: 'review the lockfile', status: 'in_progress', ownerId: 'session-ada' }),
    ])).toEqual([
      'task lead→board pending review the lockfile',
      'task ada→board in_progress review the lockfile',
    ])
  })

  it('lists a team event of a later release with the first field that is not an id', () => {
    expect(read([
      {
        type: 'team/vote',
        data: { version: 2, id: 'i', teamId: 't', messageId: 'm', senderId: 's', targetId: 'x', ownerId: 'o', count: 3, choice: 'yes' },
      },
      { type: 'team/shutdown', data: { teamId: 't', id: 'i' } },
      { type: 'team/pause', data: {} },
    ])).toEqual([
      'message lead→team yes',
      'message lead→team shutdown',
      'message lead→team pause',
    ])
  })
})

describe('the start card', () => {
  it('explains the feature, names the two commands, and says how to turn it off', () => {
    expect(teamIntroLines({ palette, width: 100 })).toEqual([
      TEAM_ON_LINE,
      TEAM_EXPLAIN_LINE,
      '/team-play   live team room: roles, current work, tasks, and messages',
      '/team        roster and shared task board',
      TEAM_OFF_LINE,
      TEAM_OFF_COMMAND,
    ])
    expect(TEAM_ON_LINE).toBe('Agent Teams is on')
  })

  it('draws the same lines on every render and fits the width', () => {
    const card = new TeamIntro(palette)
    card.invalidate()
    const first = card.render(100)
    expect(card.render(100)).toEqual(first)
    expect(first).toEqual(teamIntroLines({ palette, width: 100 }))
    for (const line of card.render(30)) expect(visibleWidth(line)).toBeLessThanOrEqual(30)
    for (const line of teamIntroLines({ palette, width: 0 })) expect(visibleWidth(line)).toBeLessThanOrEqual(1)
  })

  it('is mounted only when the service exposes listMembers', () => {
    expect(agentTeamsMounted({ listMembers: () => [] })).toBe(true)
    expect(agentTeamsMounted({ listMembers: 4 })).toBe(false)
    expect(agentTeamsMounted({})).toBe(false)
    expect(agentTeamsMounted(null)).toBe(false)
    expect(agentTeamsMounted(undefined)).toBe(false)
  })
})

describe('the heading', () => {
  it('counts teammates, the teammates that work, and the finished tasks', () => {
    const lines = frame({
      source: source({
        tasks: [
          task({ id: '1', subject: 'a', status: 'completed' }),
          task({ id: '2', subject: 'b', status: 'in_progress', ownerName: 'reviewer' }),
          task({ id: '3', subject: 'gone', status: 'deleted' }),
        ],
      }),
    })
    expect(lines[0]).toBe('team play · 2 teammates · 1 working · tasks 1/2 done')
    expect(lines[1]).toBe(TEAM_PLAY_HINTS[0])
  })

  it('says teammate for one and counts none for a lone lead', () => {
    expect(frame({ source: source({ members: [lead, writer] }) })[0]).toBe('team play · 1 teammate · 0 working · tasks 0/0 done')
    expect(frame({ source: source({ members: [lead] }) })[0]).toBe('team play · 0 teammates · 0 working · tasks 0/0 done')
  })

  it('narrows the legend with the width and lets a notice take its place', () => {
    expect(frame({ width: 60 })[1]).toBe(TEAM_PLAY_HINTS[2])
    expect(frame({ width: 30 })[1]).toBe(TEAM_PLAY_HINTS[3])
    expect(frame({ width: 12 })[1]).toBe(TEAM_PLAY_HINTS[4])
    expect(frame({ notice: 'writer failed to start' })[1]).toBe('writer failed to start')
  })
})

describe('the members', () => {
  it('lists the lead first with each role, the selection, and a status glyph', () => {
    const lines = frame({
      selected: 'session-reviewer',
      source: source({
        members: [lead, reviewer, writer, member({ id: 'p', name: 'prep', role: 'teammate', status: 'provisioning' }), member({ id: 'f', name: 'broken', role: 'teammate', status: 'failed' })],
      }),
    })
    const rows = lines.slice(3, 8)
    expect(rows[0]).toMatch(/^ {2}● lead {4,}orchestrator {2,}running$/u)
    expect(rows[1]).toMatch(/^▸ ● reviewer {2,}checks the diff for regressions {2}running$/u)
    expect(rows[2]).toMatch(/^ {2}○ writer {4,}teammate {2,}inactive$/u)
    expect(rows[3]).toMatch(/^ {2}◌ prep {4,}teammate {2,}provisioning$/u)
    expect(rows[4]).toMatch(/^ {2}✗ broken {2,}teammate {2,}failed$/u)
  })

  it('selects the first member until a known member is chosen', () => {
    expect(frame()[3]?.startsWith('▸')).toBe(true)
    expect(frame({ selected: 'session-unknown' })[3]?.startsWith('▸')).toBe(true)
    expect(frame({ selected: 'session-writer' })[5]?.startsWith('▸')).toBe(true)
  })

  it('shows the in-progress task a member owns, else its narration, else its status', () => {
    const lines = frame({
      source: source({
        tasks: [task({ id: '4', subject: 'review the lockfile', status: 'in_progress', ownerName: 'reviewer' })],
        note: id => id === 'session-writer' ? 'drafting the changelog' : id === 'session-lead' ? '' : undefined,
      }),
    }).join('\n')
    expect(lines).toMatch(/reviewer {2,}checks the diff for regressions {2}review the lockfile\n/u)
    expect(lines).toMatch(/writer {4,}teammate {2,}drafting the changelog\n/u)
    expect(lines).toMatch(/lead {4,}orchestrator {2,}running\n/u)
  })

  it('animates a running member and parks a static glyph when the spinner is off', () => {
    const spun = teamRoomFrame(draw({ source: source({ spinner: slot => `s${String(slot)}` }) }))
    expect(spun.animated).toBe(true)
    expect(spun.lines[3]).toContain('s0 lead')
    expect(spun.lines[4]).toContain('s1 reviewer')
    expect(spun.lines[5]).toContain('○ writer')
    const parked = teamRoomFrame(draw())
    expect(parked.animated).toBe(false)
    expect(parked.lines[3]).toContain('● lead')
    expect(teamRoomFrame(draw({ source: source({ members: [writer], spinner: () => 'x' }) })).animated).toBe(false)
  })

  it('shows the empty-team hint under the lead and wraps it on a narrow screen', () => {
    const wide = frame({ source: source({ members: [lead] }) })
    expect(wide[3]).toContain('lead')
    expect(wide[4]).toBe(`  ${TEAM_PLAY_EMPTY_HINT}`)
    const narrow = frame({ source: source({ members: [lead] }), width: 50 })
    expect(narrow.slice(4, 7).join('')).toContain('No teammates yet')
    expect(narrow[4]).not.toContain('delegate it.')
    expect(frame({ source: source({ members: [] }) })[3]).toBe(`  ${TEAM_PLAY_EMPTY_HINT}`)
  })

  it('folds members past the cap into a count and keeps the selection in view', () => {
    const many = [lead, ...Array.from({ length: 11 }, (_, index) => member({ id: `m${String(index)}`, name: `mate${String(index)}`, role: 'teammate', status: 'inactive' }))]
    const top = frame({ source: source({ members: many }) }).slice(3, 11)
    expect(top.at(-1)).toBe('  +5 more')
    expect(top[0]).toContain('lead')
    const bottom = frame({ source: source({ members: many }), selected: 'm10' })
    const rows = bottom.slice(3, 11)
    expect(rows.some(line => line.startsWith('▸') && line.includes('mate10'))).toBe(true)
    expect(rows.at(-1)).toBe('  +5 more')
  })

  it('cuts a long name and a long role to their columns', () => {
    const lines = frame({
      width: 60,
      source: source({
        members: [lead, member({ id: 'x', name: 'a-very-long-teammate-name', role: 'teammate', status: 'inactive', description: 'reviews every change in the repository against the style guide' })],
      }),
    })
    expect(lines[4]).toContain('a-very-long-tea…')
    expect(lines[4]).toMatch(/reviews every.*…/u)
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60)
  })
})

describe('the tasks', () => {
  it('lists each live task with its glyph, owner, and blockers', () => {
    const lines = frame({
      source: source({
        tasks: [
          task({ id: '1', subject: 'write tests', status: 'completed', ownerName: 'writer' }),
          task({ id: '2', subject: 'review the lockfile', status: 'in_progress', ownerName: 'reviewer' }),
          task({ id: '3', subject: 'ship it', status: 'pending', blockedBy: ['1', '2'], ready: false }),
          task({ id: '4', subject: 'removed', status: 'deleted' }),
        ],
      }),
    })
    const at = lines.indexOf('Tasks')
    expect(lines.slice(at + 1, at + 4)).toEqual([
      '  #1 ✓ write tests          writer',
      '  #2 ◐ review the lockfile  reviewer',
      '  #3 ○ ship it              unowned   blocked by #1, #2',
    ])
    expect(lines.join('\n')).not.toContain('removed')
  })

  it('says so when there is no task and folds the rest past the cap', () => {
    expect(frame().join('\n')).toContain('  No tasks yet.')
    const tasks = Array.from({ length: 12 }, (_, index) => task({ id: String(index + 1), subject: `task ${String(index + 1)}`, status: 'pending' }))
    const lines = frame({ source: source({ tasks }), rows: 40 })
    const at = lines.indexOf('Tasks')
    expect(lines.slice(at + 1, at + 9).at(-1)).toBe('  +5 more')
    expect(lines[at + 1]).toContain('#1 ○ task 1')
  })

  it('cuts a long subject to the width', () => {
    const lines = frame({
      width: 40,
      source: source({ tasks: [task({ id: '1', subject: 'a subject that does not fit in forty columns at all', status: 'pending', ownerName: 'reviewer' })] }),
    })
    const at = lines.indexOf('Tasks')
    expect(lines[at + 1]).toContain('…')
    expect(visibleWidth(lines[at + 1] ?? '')).toBeLessThanOrEqual(40)
  })
})

describe('the messages', () => {
  const beats = [
    beat('lead', 'reviewer', 'inspect the lockfile', 'spawn'),
    beat('lead', 'writer', 'draft the notes'),
    beat('reviewer', 'lead', 'looks   consistent\nto me'),
    beat('lead', 'board', 'create read the lockfile', 'task'),
  ]

  it('lists the exchanges oldest first, one line each, with the count', () => {
    const lines = frame({ source: source({ beats }) })
    const at = lines.findIndex(line => line.startsWith('Messages'))
    expect(lines[at]).toBe('Messages · 4')
    expect(lines.slice(at + 1, at + 5)).toEqual([
      '  lead → reviewer  spawn: inspect the lockfile',
      '  lead → writer  message: draft the notes',
      '  reviewer → lead  message: looks consistent to me',
      '  lead → board  task: create read the lockfile',
    ])
  })

  it('says so when nothing was exchanged', () => {
    const lines = frame()
    const at = lines.findIndex(line => line.startsWith('Messages'))
    expect(lines.slice(at, at + 2)).toEqual(['Messages · 0', '  No messages yet.'])
  })

  it('narrows to the exchanges of the selected member, whatever the case of its name', () => {
    const lines = frame({ source: source({ beats: [...beats, beat('Writer', 'lead', 'done')] }), filtered: true, selected: 'session-writer' })
    const at = lines.findIndex(line => line.startsWith('Messages'))
    expect(lines[at]).toBe('Messages · with writer · 2')
    expect(lines.slice(at + 1, at + 3)).toEqual([
      '  lead → writer  message: draft the notes',
      '  Writer → lead  message: done',
    ])
    const none = frame({ source: source({ beats }), filtered: true, selected: 'session-lead' })
    expect(none.join('\n')).toContain('Messages · with lead · 4')
    const quiet = frame({ source: source({ beats: [beat('lead', 'reviewer', 'x')] }), filtered: true, selected: 'session-writer' })
    expect(quiet.join('\n')).toContain('  No exchanges with writer yet.')
  })

  it('ignores the filter when the roster is empty', () => {
    const lines = frame({ source: source({ members: [], beats }), filtered: true })
    expect(lines.join('\n')).toContain('Messages · 4')
  })

  it('scrolls from the newest and clamps the offset to the exchanges it has', () => {
    const many = Array.from({ length: 30 }, (_, index) => beat('lead', 'reviewer', `step ${String(index + 1)}`))
    const newest = teamRoomFrame(draw({ source: source({ beats: many }), rows: 20 }))
    expect(newest.lines.at(-1)).toBe('  lead → reviewer  message: step 30')
    expect(newest.back).toBe(0)
    const scrolled = teamRoomFrame(draw({ source: source({ beats: many }), rows: 20, back: 5 }))
    expect(scrolled.lines.at(-1)).toBe('  lead → reviewer  message: step 25')
    expect(scrolled.lines.join('\n')).toMatch(/Messages · 30 · \d+ earlier · 5 later/u)
    const past = teamRoomFrame(draw({ source: source({ beats: many }), rows: 20, back: 500 }))
    expect(past.back).toBeLessThan(30)
    expect(past.lines.join('\n')).toContain('step 1\n')
    expect(past.lines.join('\n')).not.toContain('earlier')
    expect(newest.page).toBe(newest.lines.length - newest.lines.findIndex(line => line.startsWith('Messages')) - 2)
  })
})

describe('the frame size', () => {
  it('returns exactly the rows asked for, each line within the width', () => {
    const tasks = Array.from({ length: 12 }, (_, index) => task({ id: String(index + 1), subject: `task number ${String(index + 1)} with a rather long subject`, status: 'in_progress', ownerName: 'reviewer', blockedBy: ['1'] }))
    const beats = Array.from({ length: 40 }, (_, index) => beat('lead', 'reviewer', `a message of some length number ${String(index)}`))
    const many = [lead, ...Array.from({ length: 11 }, (_, index) => member({ id: `m${String(index)}`, name: `mate${String(index)}`, role: 'teammate', status: 'running', description: 'does one part of the work' }))]
    for (const width of [1, 10, 30, 80, 100, 140]) {
      for (const rows of [1, 3, 6, 10, 16, 24, 50]) {
        for (const members of [many, [lead], []]) {
          const lines = frame({ width, rows, source: source({ members, tasks, beats, spinner: () => '⠋' }), notice: 'a notice' })
          expect(lines, `${String(width)}x${String(rows)}`).toHaveLength(rows)
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  it('treats a degenerate size as one cell', () => {
    expect(teamRoomFrame(draw({ width: 0, rows: 0 })).lines).toHaveLength(1)
  })

  it('gives members and tasks room before the messages and the messages the rest', () => {
    const tasks = [task({ id: '1', subject: 'one', status: 'pending' }), task({ id: '2', subject: 'two', status: 'pending' })]
    const lines = frame({ rows: 30, source: source({ tasks, beats: [beat('lead', 'writer', 'hello')] }) })
    expect(lines.indexOf('Members')).toBe(2)
    expect(lines.indexOf('Tasks')).toBe(6)
    expect(lines[9]).toBe('Messages · 1')
    expect(lines[10]).toBe('  lead → writer  message: hello')
    expect(lines.slice(11).every(line => line === '')).toBe(true)
  })

  it('shrinks tasks first, then members, to keep the messages three rows', () => {
    const tasks = Array.from({ length: 6 }, (_, index) => task({ id: String(index + 1), subject: `task ${String(index + 1)}`, status: 'pending' }))
    const beats = Array.from({ length: 10 }, (_, index) => beat('lead', 'writer', `m${String(index)}`))
    const lines = frame({ rows: 12, source: source({ tasks, beats }) })
    expect(lines).toHaveLength(12)
    expect(lines.slice(2, 8).map(line => line.replace(/ {3,}/gu, '  '))).toEqual(['Members', '▸ ● lead  orchestrator  running', '  +2 more', 'Tasks', '  #1 ○ task 1  unowned', '  +5 more'])
    expect(lines.slice(-3)).toEqual(['  lead → writer  message: m7', '  lead → writer  message: m8', '  lead → writer  message: m9'])
  })
})

describe('the page', () => {
  function page(parts: Partial<TeamRoomSource> = {}): { play: TeamPlay; read: () => TeamRoomSource } {
    const read = (): TeamRoomSource => source(parts)
    return { play: new TeamPlay({ palette, source: read }), read }
  }
  const UP = '\u001b[A'
  const DOWN = '\u001b[B'
  const PAGE_UP = '\u001b[5~'
  const PAGE_DOWN = '\u001b[6~'
  const ENTER = '\r'
  const ESCAPE = '\u001b'

  it('closes on Escape and q', () => {
    const { play } = page()
    expect(play.handleInput(ESCAPE)).toEqual({ kind: 'close' })
    expect(play.handleInput('q')).toEqual({ kind: 'close' })
    expect(play.handleInput('z')).toBeUndefined()
  })

  it('moves the selection with the arrows and stops at the ends', () => {
    const { play } = page()
    expect(play.render(100, 24)[3]?.startsWith('▸')).toBe(true)
    play.handleInput(UP)
    expect(play.render(100, 24)[3]?.startsWith('▸')).toBe(true)
    play.handleInput(DOWN)
    expect(play.render(100, 24)[4]?.startsWith('▸')).toBe(true)
    play.handleInput(DOWN)
    play.handleInput(DOWN)
    expect(play.render(100, 24)[5]?.startsWith('▸')).toBe(true)
    expect(page({ members: [] }).play.handleInput(DOWN)).toBeUndefined()
  })

  it('opens a running or inactive teammate and says why it cannot open anyone else', () => {
    const provisioning = member({ id: 'p', name: 'prep', role: 'teammate', status: 'provisioning' })
    const failed = member({ id: 'f', name: 'broken', role: 'teammate', status: 'failed' })
    const { play } = page({ members: [lead, reviewer, writer, provisioning, failed] })
    expect(play.handleInput(ENTER)).toBeUndefined()
    expect(play.render(100, 24)[1]).toBe('the lead has no teammate session to open')
    play.handleInput(DOWN)
    const opened = play.handleInput(ENTER)
    expect(opened).toMatchObject({ kind: 'open', choice: { id: 'session-reviewer', label: 'reviewer', target: 'session', mode: 'continuable' } })
    expect(play.render(100, 24)[1]).toBe(TEAM_PLAY_HINTS[0])
    play.handleInput(DOWN)
    expect(play.handleInput(ENTER)).toMatchObject({ kind: 'open', choice: { id: 'session-writer' } })
    play.handleInput(DOWN)
    play.handleInput(ENTER)
    expect(play.render(100, 24)[1]).toBe('prep is still being created')
    play.handleInput(DOWN)
    play.handleInput(ENTER)
    expect(play.render(100, 24)[1]).toBe('broken failed to start; /team lists its diagnostics')
    play.handleInput('x')
    expect(play.render(100, 24)[1]).toBe(TEAM_PLAY_HINTS[0])
    expect(page({ members: [] }).play.handleInput(ENTER)).toBeUndefined()
  })

  it('toggles the filter with f and starts the list from the newest again', () => {
    const beats = [beat('lead', 'writer', 'one'), beat('lead', 'reviewer', 'two')]
    const { play } = page({ beats })
    expect(play.render(100, 24).join('\n')).toContain('Messages · 2')
    play.handleInput('f')
    expect(play.render(100, 24).join('\n')).toContain('Messages · with lead · 2')
    play.handleInput(DOWN)
    expect(play.render(100, 24).join('\n')).toContain('Messages · with reviewer · 1')
    play.handleInput('f')
    expect(play.render(100, 24).join('\n')).toContain('Messages · 2')
  })

  it('pages the messages with PgUp and PgDn', () => {
    const beats = Array.from({ length: 30 }, (_, index) => beat('lead', 'writer', `step ${String(index + 1)}`))
    const { play } = page({ beats })
    expect(play.render(100, 20).at(-1)).toContain('step 30')
    play.handleInput(PAGE_UP)
    const older = play.render(100, 20)
    expect(older.at(-1)).not.toContain('step 30')
    expect(older.join('\n')).toContain('later')
    play.handleInput(PAGE_DOWN)
    expect(play.render(100, 20).at(-1)).toContain('step 30')
    play.handleInput(PAGE_DOWN)
    expect(play.render(100, 20).at(-1)).toContain('step 30')
    for (let press = 0; press < 20; press += 1) play.handleInput(PAGE_UP)
    expect(play.render(100, 20).join('\n')).toContain('step 1\n')
  })

  it('reports whether the last frame animated', () => {
    const spinning = page({ spinner: () => '⠋' })
    expect(spinning.play.animates()).toBe(false)
    spinning.play.render(100, 24)
    expect(spinning.play.animates()).toBe(true)
    const still = page()
    still.play.render(100, 24)
    expect(still.play.animates()).toBe(false)
  })
})
