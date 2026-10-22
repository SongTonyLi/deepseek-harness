/** Agent Teams tool lines, roster rows, and the optional service read. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import {
  isTeamPanelEvent,
  readAgentTeams,
  readTeam,
  readTeamSnapshot,
  teamBrowseRows,
  teamToolRows,
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

function reader(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tryMembership: () => ({}),
    listMembers: () => [],
    listTasks: () => [],
    ...overrides,
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
      member({ id: 'bea', name: 'Bea', role: 'teammate', status: 'running' }),
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

  it('reads a mounted reader and reports a missing one', () => {
    expect(isTeamPanelEvent('team/member')).toBe(true)
    expect(isTeamPanelEvent('team/task')).toBe(true)
    expect(isTeamPanelEvent('team/message/queued')).toBe(true)
    expect(isTeamPanelEvent('team/message/delivered')).toBe(true)
    expect(isTeamPanelEvent('team/vote')).toBe(true)
    expect(isTeamPanelEvent('user/message')).toBe(false)
    const ada = member({ id: 'ada', name: 'Ada', role: 'teammate', status: 'inactive' })
    const pending = task({ id: 'task-1', subject: 'write tests', status: 'pending' })
    const service = {
      rows: [ada],
      tryMembership() { return this.rows.length > 0 ? {} : undefined },
      listMembers() { return this.rows },
      listTasks: () => [pending],
    }
    expect(readAgentTeams(ctx(service))).toBe(service)
    expect(readTeam(service, agent)).toEqual({ kind: 'team', members: [ada], tasks: [pending] })
    expect(readTeamSnapshot(ctx(service), agent)).toEqual({ kind: 'team', members: [ada], tasks: [pending] })
    expect(readAgentTeams(ctx(undefined))).toBeUndefined()
    expect(readAgentTeams(ctx(null))).toBeUndefined()
    expect(readAgentTeams(ctx(4))).toBeUndefined()
    expect(readAgentTeams(ctx({ listMembers() { return [] } }))).toBeUndefined()
    expect(readAgentTeams(ctx(reader({ tryMembership: 'no' })))).toBeUndefined()
    expect(readAgentTeams(ctx(reader({ listMembers: 'no' })))).toBeUndefined()
    expect(readAgentTeams(ctx(reader({ listTasks: 'no' })))).toBeUndefined()
    expect(readAgentTeams(ctx({ tryMembership: () => ({}), listTasks: () => [] }))).toBeUndefined()
    expect(readAgentTeams(ctx({ tryMembership: () => ({}), listMembers: () => [] }))).toBeUndefined()
    expect(readTeam(undefined, agent)).toEqual({ kind: 'absent' })
    expect(readTeam(null, agent)).toEqual({ kind: 'absent' })
    expect(readTeam(4, agent)).toEqual({ kind: 'absent' })
    expect(readTeam({ listMembers() { return [] } }, agent)).toEqual({ kind: 'absent' })
    expect(readTeam(reader({ tryMembership: 'no' }), agent)).toEqual({ kind: 'absent' })
    expect(readTeam(reader({ listMembers: 'no' }), agent)).toEqual({ kind: 'absent' })
    expect(readTeam(reader({ listTasks: 'no' }), agent)).toEqual({ kind: 'team', members: [], tasks: [] })
    expect(readTeam({
      tryMembership: () => ({}),
      listTasks: () => [],
    }, agent)).toEqual({ kind: 'absent' })
    expect(readTeam({
      tryMembership: () => ({}),
      listMembers: () => [],
    }, agent)).toEqual({ kind: 'team', members: [], tasks: [] })
    expect(readTeam(reader({ tryMembership: () => undefined }), agent)).toEqual({ kind: 'not-member' })
    expect(readTeam(reader({
      tryMembership: () => { throw new Error('down') },
    }), agent)).toEqual({ kind: 'not-member' })
    expect(readTeam(reader({
      listMembers: () => { throw new Error('down') },
    }), agent)).toEqual({ kind: 'not-member' })
    expect(readTeam(reader({
      listTasks: () => { throw new Error('down') },
    }), agent)).toEqual({ kind: 'not-member' })
    expect(readTeam(reader({ listMembers: () => 'nope' }), agent)).toEqual({ kind: 'not-member' })
    expect(readTeam(reader({ listTasks: () => 'nope' }), agent)).toEqual({ kind: 'not-member' })
  })
})
