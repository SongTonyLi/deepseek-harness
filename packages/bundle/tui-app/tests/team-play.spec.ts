/** Teammate exchanges: lanes, log reading, and the play page. */

import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/style.ts'
import { TEAM_OFF_COMMAND, TEAM_ON_LINE, teamIntroLines } from '../src/team-intro.ts'
import {
  SHOWCASE_BEATS,
  beatsFromEvents,
  lane,
  markerColumn,
  teamPlayLines,
} from '../src/team-play.ts'

const palette = createPalette(false)

describe('team lanes', () => {
  it('walks the marker from the sender to the receiver', () => {
    expect(markerColumn(0, 16)).toBe(0)
    expect(markerColumn(7, 16)).toBe(15)
    const start = lane('lead', 'reviewer', 0)
    const end = lane('lead', 'reviewer', 7)
    expect(start.indexOf('●')).toBeLessThan(end.indexOf('●'))
    expect(start.startsWith('lead ')).toBe(true)
    expect(end.endsWith(' reviewer')).toBe(true)
  })
})

describe('beats from the session log', () => {
  it('reads spawn, message, task, join, and a received team message', () => {
    const beats = beatsFromEvents([
      { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/call', data: { name: 'spawn_teammate', arguments: '{"name":"reviewer","prompt":"inspect the lockfile"}' } },
      { type: 'tool/call', data: { name: 'send_message', arguments: '{"target":"reviewer","message":"the lockfile changed"}' } },
      { type: 'tool/call', data: { name: 'team_task_create', arguments: '{"subject":"read the lockfile"}' } },
      { type: 'tool/call', data: { name: 'team_task_update', arguments: '{"action":"complete","subject":"read the lockfile"}' } },
      { type: 'tool/call', data: { name: 'spawn_teammate', arguments: 'not-json' } },
      { type: 'team/member', data: { member: { name: 'reviewer', phase: 'active' } } },
      { type: 'team/task', data: { task: { subject: 'read the lockfile', status: 'pending' } } },
      {
        type: 'user/message',
        data: { message: { content: [{ type: 'text', text: 'Team message from reviewer: looks consistent' }] } },
      },
    ], 'lead')
    expect(beats.map(beat => `${beat.kind} ${beat.from}→${beat.to} ${beat.text}`)).toEqual([
      'spawn lead→reviewer inspect the lockfile',
      'message lead→reviewer the lockfile changed',
      'task lead→board read the lockfile',
      'task lead→board complete read the lockfile',
      'spawn lead→reviewer active',
      'task lead→board pending read the lockfile',
      'message reviewer→lead looks consistent',
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

describe('the start card', () => {
  it('names the default and the disable command, and moves one showcase beat', () => {
    const opened = teamIntroLines({ palette, frame: 0, width: 100, reducedMotion: false })
    expect(opened.join('\n')).toContain(TEAM_ON_LINE)
    expect(opened.join('\n')).toContain(TEAM_OFF_COMMAND)
    expect(opened.join('\n')).toContain('spawn reviewer')
    expect(opened.join('\n')).not.toContain('the diff is consistent')
    const later = teamIntroLines({ palette, frame: 8, width: 100, reducedMotion: false })
    expect(later.join('\n')).toContain('check the diff')
    expect(later.join('\n')).not.toContain('spawn reviewer')
  })

  it('draws every showcase beat settled when motion is reduced', () => {
    const lines = teamIntroLines({ palette, frame: 0, width: 100, reducedMotion: true }).join('\n')
    for (const beat of SHOWCASE_BEATS) expect(lines).toContain(beat.text)
    expect(lines).toContain(lane('reviewer', 'lead', 7))
  })
})

describe('the play page', () => {
  it('plays the example when the session has no exchanges', () => {
    const lines = teamPlayLines({
      palette,
      beats: [],
      beat: 0,
      phase: 0,
      example: true,
      paused: false,
      width: 100,
      rows: 12,
    })
    expect(lines).toHaveLength(12)
    const text = lines.join('\n')
    expect(text).toContain('team play')
    expect(text).toContain('example · this session has no teammate messages yet')
    expect(text).toContain(TEAM_OFF_COMMAND)
    expect(text).toContain('check the diff')
    const narrow = teamPlayLines({
      palette,
      beats: [],
      beat: 0,
      phase: 0,
      example: true,
      paused: false,
      width: 80,
      rows: 12,
    }).join('\n')
    expect(narrow).toContain('example · this session has no teammate messages yet')
    expect(narrow).toContain(TEAM_OFF_COMMAND)
  })

  it('plays a logged exchange instead of the example', () => {
    const lines = teamPlayLines({
      palette,
      beats: [{ from: 'lead', to: 'reviewer', kind: 'message', text: 'inspect the lockfile' }],
      beat: 0,
      phase: 3,
      example: false,
      paused: true,
      width: 80,
      rows: 8,
    })
    const text = lines.join('\n')
    expect(text).toContain('inspect the lockfile')
    expect(text).toContain('1 interaction')
    expect(text).toContain('paused')
    expect(text).not.toContain('example ·')
  })
})
