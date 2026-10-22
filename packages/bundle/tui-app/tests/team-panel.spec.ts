/** The docked team summary: counts, a hidden roster, deleted tasks, and the capped rows. */

import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/style.ts'
import {
  TEAM_PANEL_EMPTY,
  TEAM_PANEL_MAX_ROWS,
  renderTeamPanel,
  teamPanelLine,
  teamPanelView,
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

function draw(members: readonly TeamMemberRow[], tasks: readonly TeamTaskRow[], hidden = false): string {
  return renderTeamPanel(teamPanelView({ members, tasks, hidden }), { palette, width: 100 })
}

describe('teamPanelLine', () => {
  const lead = member({ id: 'lia', name: 'Lia', role: 'lead', status: 'inactive' })
  const ada = member({ id: 'ada', name: 'Ada', role: 'teammate', status: 'inactive' })
  const pending = task({ id: 'task-1', subject: 'write tests', status: 'pending' })

  it('draws nothing until a teammate or a live task exists', () => {
    expect(teamPanelLine({ members: [], tasks: [] }, palette)).toBe('')
    expect(teamPanelLine({ members: [lead], tasks: [] }, palette)).toBe('')
    expect(teamPanelLine({
      members: [lead],
      tasks: [task({ id: 'gone', subject: 'gone', status: 'deleted' })],
    }, palette)).toBe('')
  })

  it('counts every member, the running ones, and tasks that are not deleted', () => {
    expect(teamPanelLine({
      members: [lead, member({ id: 'ada', name: 'Ada', role: 'teammate', status: 'running' })],
      tasks: [pending, task({ id: 'gone', subject: 'gone', status: 'deleted' })],
    }, palette)).toBe('team · 2 members · 1 running · 1 tasks')
  })

  it('hides a roster and forces the empty line', () => {
    expect(teamPanelLine({ members: [ada], tasks: [pending], hidden: true, forced: true }, palette)).toBe('')
    expect(teamPanelLine({ members: [lead], tasks: [], forced: true }, palette)).toBe(TEAM_PANEL_EMPTY)
    expect(teamPanelLine({ members: [ada], tasks: [], forced: true }, palette)).toBe('team · 1 members · 0 running · 0 tasks')
  })
})

describe('team panel', () => {
  it('draws nothing for an empty roster', () => {
    expect(draw([], [])).toBe('')
  })

  it('draws nothing when the only member is the lead and there is no task', () => {
    expect(draw([member({ id: 'lia', name: 'Lia', role: 'lead', status: 'inactive' })], [])).toBe('')
  })

  it('counts every member and leaves the teammate name off the summary', () => {
    const text = draw([
      member({ id: 'lia', name: 'Lia', role: 'lead', status: 'inactive' }),
      member({ id: 'ada', name: 'Ada', role: 'teammate', status: 'inactive' }),
    ], [])
    expect(text).toBe('team · 2 members · 0 running · 0 tasks')
    expect(text).not.toContain('Ada')
  })

  it('counts a shared task when the roster has no teammate', () => {
    expect(draw([
      member({ id: 'lia', name: 'Lia', role: 'lead', status: 'inactive' }),
    ], [task({ id: 'task-1', subject: 'write tests', status: 'pending' })])).toBe('team · 1 members · 0 running · 1 tasks')
  })

  it('counts a running member and a task that is not deleted', () => {
    const text = draw([
      member({ id: 'lia', name: 'Lia', role: 'lead', status: 'running' }),
      member({ id: 'ada', name: 'Ada', role: 'teammate', status: 'inactive' }),
    ], [
      task({ id: 'task-1', subject: 'write tests', status: 'pending' }),
      task({ id: 'task-2', subject: 'gone', status: 'deleted' }),
    ])
    expect(text).toBe('team · 2 members · 1 running · 1 tasks')
  })

  it('draws nothing when the user hid the panel', () => {
    const text = draw([
      member({ id: 'ada', name: 'Ada', role: 'teammate', status: 'running' }),
    ], [task({ id: 'task-1', subject: 'write tests', status: 'pending' })], true)
    expect(text).toBe('')
  })

  it('draws the forced-empty line only while the summary has nothing to show', () => {
    const empty = teamPanelView({ members: [], tasks: [], hidden: false })
    expect(renderTeamPanel(empty, { palette, width: 100, forcedEmpty: TEAM_PANEL_EMPTY })).toBe(TEAM_PANEL_EMPTY)
    expect(renderTeamPanel(empty, { palette, width: 100 })).toBe('')
    const shown = teamPanelView({
      members: [member({ id: 'ada', name: 'Ada', role: 'teammate', status: 'inactive' })],
      tasks: [],
      hidden: false,
    })
    expect(renderTeamPanel(shown, { palette, width: 100, forcedEmpty: TEAM_PANEL_EMPTY })).toBe('team · 1 members · 0 running · 0 tasks')
  })

  it('keeps six focused rows and reports the rest', () => {
    const members = [member({ id: 'ada', name: 'Ada', role: 'teammate', status: 'inactive', model: 'glm' })]
    const tasks = Array.from({ length: 7 }, (_, index) => task({
      id: `task-${String(index)}`,
      subject: `task ${String(index)}`,
      status: 'pending',
      ownerName: index === 0 ? 'Ada' : undefined,
      ready: index !== 1,
    }))
    tasks.push(task({ id: 'gone', subject: 'deleted task', status: 'deleted' }))
    const view = teamPanelView({ members, tasks, hidden: false })
    expect(view.rows).toHaveLength(TEAM_PANEL_MAX_ROWS)
    expect(view.hidden).toBe(2)
    expect(view.taskCount).toBe(7)
    const focused = renderTeamPanel(view, { palette, selected: 0, width: 120 })
    expect(focused).toContain('Ada · teammate · inactive · glm')
    expect(focused).toContain('task 0 · pending · Ada · ready')
    expect(focused).toContain('task 1 · pending · unowned · blocked')
    expect(focused).toContain('+2 more · /team lists them all')
    expect(focused).not.toContain('deleted task')
    const fitted = teamPanelView({
      members: [member({ id: 'ada', name: 'Ada', role: 'teammate', status: 'inactive' })],
      tasks: [task({ id: 'task-1', subject: 'write tests', status: 'in_progress' })],
      hidden: false,
    })
    const open = renderTeamPanel(fitted, { palette, selected: 1, width: 120 })
    expect(open).toContain('Ada · teammate · inactive')
    expect(open).toContain('write tests · in_progress · unowned · ready')
    expect(open).not.toContain('more · /team')
  })
})
