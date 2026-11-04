/** Agent Teams tool lines, roster rows, and the optional service read. */

import { stripVTControlCharacters } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it } from 'vitest'
import {
  TEAMMATE_TITLE_ROLE_COLUMNS,
  isTeamPanelEvent,
  memberLabel,
  readTeamSnapshot,
  teamBrowseRows,
  teamToolRows,
  teammateViewTitle,
} from '../src/team.ts'
import type { TeamMemberRow, TeamTaskRow } from '../src/team-panel.ts'

const agent = {} as Agent

function ctx(service: unknown): Context {
  return { get: (name: string) => (name === 'agentTeams' ? service : undefined) } as Context
}

function member(row: Pick<TeamMemberRow, 'id' | 'name' | 'role' | 'status'> & Partial<TeamMemberRow>): TeamMemberRow {
  return { diagnostics: [], ...row }
}

function task(row: Pick<TeamTaskRow, 'id' | 'subject' | 'status'> & Partial<TeamTaskRow>): TeamTaskRow {
  return {
    revision: 3,
    description: 'body',
    blockedBy: [],
    writeScopes: [],
    ready: false,
    writeScopeWarnings: [],
    ...row,
  }
}

describe('team rows', () => {
  it('prints tools the plugin scopes onto the agent and skips the global ones', () => {
    const rows = teamToolRows([
      { name: 'bash', description: 'Run a command' },
      { name: 'team_vote', description: 'Cast a vote' },
      { name: 'spawn_teammate', description: 'Create one teammate' },
      { name: 'unnamed', description: 4 },
    ], new Set(['bash']))
    expect(rows).toEqual([
      'spawn_teammate  Create one teammate',
      'team_vote  Cast a vote',
      'unnamed',
    ])
    expect(teamToolRows(undefined)).toEqual([])
  })

  it('keeps the lead and a failed member off the session list and drops a deleted task', () => {
    const rows = teamBrowseRows([
      member({ id: 'lia', name: 'Lia', role: 'lead', status: 'inactive', description: 'keeps the roster' }),
      member({ id: 'ada', name: 'Ada', role: 'teammate', status: 'inactive', model: 'glm', diagnostics: ['slow start'], specialty: 'review' } as TeamMemberRow),
      member({ id: 'bea', name: 'Bea', role: 'teammate', status: 'running', diagnostics: [], slots: 2, remote: true, tags: ['a'] } as TeamMemberRow),
      member({ id: 'cy', name: 'Cy', role: 'teammate', status: 'provisioning' }),
      member({ id: 'dee', name: 'Dee', role: 'teammate', status: 'failed', description: 'could not start' }),
    ], [
      task({
        id: 'task-1',
        subject: 'write tests',
        status: 'pending',
        ownerName: 'Ada',
        ready: true,
        blockedBy: ['task-0'],
        writeScopes: ['src'],
        writeScopeWarnings: ['src is wide'],
      }),
      task({ id: 'task-2', subject: 'gone', status: 'deleted' }),
      task({ id: 'task-3', subject: 'unstaffed', status: 'in_progress' }),
    ])
    expect(rows.map(row => row.item.label)).toEqual(['Lia', 'Ada', 'Bea', 'Cy', 'Dee', 'write tests', 'unstaffed'])
    expect(rows[0]?.choice).toBeUndefined()
    expect(rows[1]?.choice).toMatchObject({
      id: 'ada',
      depth: 1,
      label: 'Ada',
      description: 'teammate · inactive · glm',
      target: 'session',
      mode: 'continuable',
      enterable: true,
    })
    expect(rows[2]?.choice).toMatchObject({ id: 'bea', mode: 'continuable', enterable: true })
    expect(rows[2]?.lines).toEqual(['Bea', 'teammate', 'running', 'remote: true', 'slots: 2'])
    expect(rows[3]?.choice).toBeUndefined()
    expect(rows[4]?.choice).toBeUndefined()
    expect(rows[5]?.choice).toBeUndefined()
    expect(rows[1]?.lines).toEqual(['Ada', 'teammate', 'inactive', 'glm', 'slow start', 'specialty: review'])
    expect(rows[0]?.lines).toEqual(['Lia', 'lead', 'inactive', 'keeps the roster'])
    expect(rows[4]?.lines).toEqual(['Dee', 'teammate', 'failed', 'could not start'])
    expect(rows[5]?.lines).toEqual([
      'task-1',
      '3',
      'pending',
      'Ada',
      'ready',
      'body',
      'task-0',
      'src',
      'src is wide',
    ])
    expect(rows[6]?.lines).toEqual(['task-3', '3', 'in_progress', 'unowned', 'blocked', 'body'])
    expect(rows[6]?.item.description).toBe('in_progress · unowned · blocked')
  })

  it('refreshes Team views for Team mode, task, and historical events', () => {
    expect(isTeamPanelEvent('team/mode')).toBe(true)
    expect(isTeamPanelEvent('team/task')).toBe(true)
    expect(isTeamPanelEvent('team/member')).toBe(true)
    expect(isTeamPanelEvent('team/message/queued')).toBe(true)
    expect(isTeamPanelEvent('user/message')).toBe(false)
  })
})

describe('team member names', () => {
  const lead = member({ id: 'lia', name: 'lead', role: 'lead', status: 'running' })
  const reviewer = member({ id: 'rae', name: 'Rae', role: 'teammate', status: 'running', description: 'reviews the lockfile' })
  const bare = member({ id: 'bo', name: 'Bo', role: 'teammate', status: 'inactive' })

  it('labels a member by name and role for the activity board', () => {
    expect(memberLabel(lead)).toBe('lead · orchestrator')
    expect(memberLabel(reviewer)).toBe('Rae · reviews the lockfile')
    expect(memberLabel(bare)).toBe('Bo · teammate')
    expect(memberLabel({ ...bare, description: '  ' })).toBe('Bo · teammate')
  })

  it('puts a role written over several lines on one line', () => {
    expect(memberLabel({ ...reviewer, description: 'reviews the lockfile.\n\n  Reports   once' }))
      .toBe('Rae · reviews the lockfile. Reports once')
  })

  it('titles a teammate view and cuts a long role', () => {
    expect(teammateViewTitle(reviewer)).toBe('teammate Rae · reviews the lockfile')
    expect(teammateViewTitle(bare)).toBe('teammate Bo · teammate')
    const role = 'audits every dependency the lead added since the last release and reports'
    const title = stripVTControlCharacters(teammateViewTitle({ ...reviewer, description: role }))
    expect(title).toBe(`teammate Rae · ${role.slice(0, TEAMMATE_TITLE_ROLE_COLUMNS - 1)}…`)
  })
})


describe('Team task boards and subagent catalogs', () => {
  it('uses current model selections and resolves task owners through continuable labels', () => {
    const root = { id: SessionId('root'), status: 'running', model: { current: () => ({ provider: 'route', model: 'switched' }) } } as Agent
    const child = { id: SessionId('child'), status: 'idle', model: { current: () => ({ provider: 'route', model: 'override' }) } } as Agent
    const entries: SubagentDescendantListEntry[] = [
      { kind: 'child', id: child.id, parentId: root.id, depth: 1, mode: 'continuable', label: 'reviewer', activity: 'running', hasChildren: false },
      { kind: 'child', id: SessionId('cold'), parentId: root.id, depth: 1, mode: 'continuable', label: 'tester', activity: 'inactive', hasChildren: false },
      { kind: 'child', id: SessionId('one-shot'), parentId: root.id, depth: 1, mode: 'one-shot', activity: 'inactive', hasChildren: false },
    ]
    let enabled = true
    const services = {
      agentTeams: { isEnabled: () => enabled, listTasks: () => [
        { ...task({ id: 'task-1', subject: 'Review', status: 'pending' }), ownerId: child.id },
        { ...task({ id: 'task-2', subject: 'Offline owner', status: 'pending' }), ownerId: 'unavailable' },
      ] },
      subagents: { rootOf: () => root },
      agents: { get: (id: string) => id === child.id ? child : undefined },
    }
    const context = { get: (key: keyof typeof services) => services[key] } as Context
    const snapshot = readTeamSnapshot(context, child, entries)
    expect(snapshot).toMatchObject({ kind: 'team', members: [
      { id: 'root', name: 'lead', role: 'lead', status: 'running', model: 'switched' },
      { id: 'child', name: 'reviewer', role: 'teammate', status: 'inactive', model: 'override' },
      { id: 'cold', name: 'tester', role: 'teammate', status: 'inactive' },
    ], tasks: [{ ownerName: 'reviewer' }, { ownerName: 'unavailable' }] })
    if (snapshot.kind !== 'team') throw new Error('expected Team snapshot')
    expect(snapshot.members[2]).not.toHaveProperty('model')
    enabled = false
    expect(readTeamSnapshot(context, child, entries)).toEqual({ kind: 'not-member' })
  })

  it('reports missing services and unavailable root or task projections', () => {
    expect(readTeamSnapshot(ctx(undefined), agent)).toEqual({ kind: 'absent' })
    const context = { get: (key: string) => key === 'subagents' ? {} : {
      isEnabled: () => { throw new Error('root unavailable') },
    } } as Context
    expect(readTeamSnapshot(context, agent)).toEqual({ kind: 'not-member' })
  })
})
