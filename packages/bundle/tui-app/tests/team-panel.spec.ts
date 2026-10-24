/** The docked team summary: teammate count, running names, task progress, hiding, and fitting to the width. */

import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createPalette } from '../src/style.ts'
import {
  TEAM_PANEL_EMPTY,
  teamPanelLine,
  type TeamMemberRow,
  type TeamTaskRow,
} from '../src/team-panel.ts'

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

const lead = member({ id: 'lia', name: 'Lia', role: 'lead', status: 'running' })

function teammate(name: string, status: TeamMemberRow['status'] = 'inactive'): TeamMemberRow {
  return member({ id: `session-${name.toLowerCase()}`, name, role: 'teammate', status })
}

function line(
  members: readonly TeamMemberRow[],
  tasks: readonly TeamTaskRow[],
  options: { width?: number; hidden?: boolean; forced?: boolean } = {},
): string {
  return stripVTControlCharacters(teamPanelLine({ members, tasks, width: options.width ?? 100, ...options }, palette))
}

describe('teamPanelLine', () => {
  const pending = task({ id: 'task-1', subject: 'write tests', status: 'pending' })

  it('draws nothing until a teammate or a live task exists', () => {
    expect(line([], [])).toBe('')
    expect(line([lead], [])).toBe('')
    expect(line([lead], [task({ id: 'gone', subject: 'gone', status: 'deleted' })])).toBe('')
  })

  it('counts teammates without the lead and counts completed tasks among the live ones', () => {
    expect(line(
      [lead, teammate('Ada'), teammate('Ben')],
      [
        task({ id: 'task-1', subject: 'a', status: 'completed' }),
        task({ id: 'task-2', subject: 'b', status: 'in_progress' }),
        pending,
        task({ id: 'gone', subject: 'gone', status: 'deleted' }),
        task({ id: 'gone-too', subject: 'gone too', status: 'deleted' }),
      ],
    )).toBe('team · 2 teammates · tasks 1/3 done · /team-play')
  })

  it('says teammate for exactly one', () => {
    expect(line([lead, teammate('Ada')], [])).toBe('team · 1 teammate · tasks 0/0 done · /team-play')
  })

  it('draws a shared task when the roster has no teammate', () => {
    expect(line([lead], [pending])).toBe('team · 0 teammates · tasks 0/1 done · /team-play')
  })

  it('names the running teammates and leaves the segment out when none runs', () => {
    expect(line([lead, teammate('Ada', 'running'), teammate('Ben'), teammate('Cy', 'running')], []))
      .toBe('team · 3 teammates · working: Ada, Cy · tasks 0/0 done · /team-play')
    expect(line([teammate('Ada', 'provisioning'), teammate('Ben', 'failed')], []))
      .toBe('team · 2 teammates · tasks 0/0 done · /team-play')
    expect(line([{ ...lead, status: 'running' }, teammate('Ada')], []))
      .not.toContain('working')
  })

  it('hides a roster and forces the empty line', () => {
    expect(line([teammate('Ada')], [pending], { hidden: true, forced: true })).toBe('')
    expect(line([lead], [], { forced: true })).toBe(TEAM_PANEL_EMPTY)
    expect(line([lead], [], { forced: false })).toBe('')
    expect(line([teammate('Ada')], [], { forced: true })).toBe('team · 1 teammate · tasks 0/0 done · /team-play')
  })

  it('dims the line', () => {
    const colored = teamPanelLine({ members: [teammate('Ada')], tasks: [], width: 100 }, createPalette(true))
    expect(colored).not.toBe(stripVTControlCharacters(colored))
    expect(stripVTControlCharacters(colored)).toBe('team · 1 teammate · tasks 0/0 done · /team-play')
  })

  describe('at a narrow width', () => {
    const roster = [
      lead,
      teammate('Ada', 'running'),
      teammate('Bartholomew', 'running'),
      teammate('Cy', 'running'),
      teammate('Di'),
    ]
    const full = 'team · 4 teammates · working: Ada, Bartholomew, Cy · tasks 0/0 done · /team-play'

    it('keeps every running name while it fits', () => {
      expect(line(roster, [], { width: visibleWidth(full) })).toBe(full)
    })

    it('drops names from the end and counts them as +<n>', () => {
      expect(line(roster, [], { width: visibleWidth(full) - 1 }))
        .toBe('team · 4 teammates · working: Ada, Bartholomew +1 · tasks 0/0 done · /team-play')
      expect(line(roster, [], { width: 70 }))
        .toBe('team · 4 teammates · working: Ada +2 · tasks 0/0 done · /team-play')
    })

    it('shrinks the running names to their number before it cuts the line', () => {
      expect(line(roster, [], { width: 62 })).toBe('team · 4 teammates · 3 working · tasks 0/0 done · /team-play')
    })

    it('ends a line that still does not fit with an ellipsis', () => {
      const text = line(roster, [], { width: 30 })
      expect(text).toBe('team · 4 teammates · 3 workin…')
      expect(visibleWidth(text)).toBe(30)
    })

    it('cuts the forced-empty line to the width as well', () => {
      expect(line([lead], [], { forced: true, width: 12 })).toBe('team · no t…')
    })
  })
})
