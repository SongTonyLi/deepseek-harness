/** The Agent Teams roster commands and the team summary. */

import type { Context } from '@deepseek-ai/cordis'
import { TeamId } from '@deepseek-ai/dsh-experimental-agent-team'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { KEY, bench, type Bench } from './bench.ts'
import type { TeamMemberRow, TeamTaskRow } from '../src/team-panel.ts'

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

const lead = member({ id: 'session-lia', name: 'Lia', role: 'lead', status: 'inactive', description: 'keeps the roster' })
const ada = member({ id: 'session-ada', name: 'Ada', role: 'teammate', status: 'inactive' })

function teams(ctx: Context, members: () => readonly TeamMemberRow[], tasks: () => readonly TeamTaskRow[]): void {
  ctx.provide('agentTeams', {
    tryMembership: () => ({}),
    listMembers: () => members(),
    listTasks: () => tasks(),
  })
}

describe('team commands', () => {
  it('notices when Agent Teams is not in this composition', async () => {
    const test = await bench()
    for (const command of ['/team', '/team-tools', '/team-panel']) {
      typeLine(test, command)
      await test.settle()
    }
    const screen = await test.screen()
    expect(screen).toContain(ABSENT)
    expect(screen.match(/Agent Teams are not enabled in this composition/gu)).toHaveLength(3)
    expect(screen).not.toContain('team ·')
  })

  it('draws the summary, hides it, and shows it again', async () => {
    const tasks = [task({ id: 'task-1', subject: 'write tests', status: 'pending' })]
    const test = await bench({
      before(ctx) {
        teams(ctx, () => [lead, ada], () => tasks)
        ctx.provide('tools', {
          schemas: (scope?: unknown) => scope === undefined
            ? [{ name: 'bash', description: 'Run a command' }]
            : [
              { name: 'bash', description: 'Run a command' },
              { name: 'spawn_teammate', description: 'Create one teammate' },
              { name: 'team_vote', description: 'Cast a vote' },
            ],
        } as never)
      },
    })
    expect(await test.screen()).toContain('team · 1 teammate · tasks 0/1 done · /team-play')

    typeLine(test, '/team-panel')
    await test.settle()
    expect(await test.screen()).not.toContain('team ·')

    typeLine(test, '/team-panel')
    await test.settle()
    expect(await test.screen()).toContain('team · 1 teammate · tasks 0/1 done · /team-play')

    typeLine(test, '/team-panel off')
    await test.settle()
    expect(await test.screen()).not.toContain('team ·')

    typeLine(test, '/team-panel on')
    await test.settle()
    expect(await test.screen()).toContain('team · 1 teammate · tasks 0/1 done · /team-play')

    typeLine(test, '/team-tools')
    await test.settle()
    const tools = test.terminal.text()
    expect(tools).toContain('spawn_teammate  Create one teammate')
    expect(tools).toContain('team_vote  Cast a vote')
    expect(tools).not.toContain('bash  Run a command')

    test.appendPrompt('hello')
    await test.settle()
    expect(await test.screen()).toContain('team · 1 teammate · tasks 0/1 done · /team-play')
  })

  it('forces an empty roster on and rejects another argument', async () => {
    const test = await bench({
      before(ctx) {
        teams(ctx, () => [lead], () => [])
      },
    })
    expect(await test.screen()).not.toContain('team ·')

    typeLine(test, '/team-panel')
    await test.settle()
    expect(await test.screen()).toContain('team · no teammates or shared tasks yet')

    typeLine(test, '/team-panel sideways')
    await test.settle()
    expect(test.terminal.text()).toContain('usage: /team-panel · /team-panel on · /team-panel off')
    expect(await test.screen()).toContain('team · no teammates or shared tasks yet')

    typeLine(test, '/team-panel')
    await test.settle()
    expect(await test.screen()).not.toContain('team ·')

    typeLine(test, '/team-panel off')
    await test.settle()
    typeLine(test, '/team-panel')
    await test.settle()
    expect(await test.screen()).toContain('team · no teammates or shared tasks yet')
  })

  it('notices a session that is not on a team and an empty roster', async () => {
    const outsider = await bench({
      before(ctx) {
        ctx.provide('agentTeams', {
          tryMembership: () => undefined,
          listMembers: () => [],
          listTasks: () => [],
        })
      },
    })
    for (const command of ['/team', '/team-tools', '/team-panel']) {
      typeLine(outsider, command)
      await outsider.settle()
    }
    expect(outsider.terminal.text().match(/this session is not on a team/gu)).toHaveLength(3)

    const empty = await bench({
      before(ctx) {
        teams(ctx, () => [], () => [task({ id: 'gone', subject: 'gone', status: 'deleted' })])
      },
    })
    typeLine(empty, '/team')
    await empty.settle()
    expect(empty.terminal.text()).toContain('no teammates or shared tasks yet')
    typeLine(empty, '/team-tools')
    await empty.settle()
    expect(empty.terminal.text()).toContain('no Agent Teams tools are visible to this agent')
  })

  it('opens a teammate session and leaves the lead on its detail page', async () => {
    const test = await bench({
      before(ctx) {
        teams(ctx, () => [lead, ada], () => [task({ id: 'task-1', subject: 'write tests', status: 'pending' })])
      },
    })
    await test.createChild({ id: 'session-ada' })
    typeLine(test, '/team')
    await test.settle()
    expect(test.terminal.text()).toContain('Ada')

    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('keeps the roster')
    expect(test.hostCalls.some(call => call.startsWith('observe'))).toBe(false)

    test.terminal.type(KEY.escape)
    await test.settle()
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.hostCalls).toContain('observe-resident:session-ada')
    expect(await test.screen()).toContain('subagent Ada')
  })

  it('redraws the summary ahead of the subagent panel when a team event arrives', async () => {
    let members = [lead]
    const test = await bench({
      subagents: () => Promise.resolve([{
        kind: 'child',
        id: 'session-kid',
        activity: 'running',
        mode: 'one-shot',
        hasChildren: false,
        parentId: 'session-tui-test',
        depth: 1,
      }] as never),
      before(ctx) {
        teams(ctx, () => members, () => [])
      },
    })
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    test.tick(0)
    await test.settle()
    expect(await test.screen()).toContain('subagents ·')
    expect(await test.screen()).not.toContain('team ·')

    members = [lead, ada]
    test.session.append('team/member', {
      version: 2,
      teamId: TeamId('session-tui-test'),
      member: {
        id: SessionId('session-ada'),
        name: 'Ada',
        description: '',
        provider: 'test-provider',
        context: 'fresh',
        phase: 'active',
      },
    })
    await test.settle()
    const screen = await test.screen()
    const teamAt = screen.indexOf('team · 1 teammate · tasks 0/0 done · /team-play')
    const subAt = screen.indexOf('subagents ·')
    expect(teamAt).toBeGreaterThanOrEqual(0)
    expect(subAt).toBeGreaterThan(teamAt)

    typeLine(test, '/team-panel on')
    await test.settle()
    expect(await test.screen()).toContain('team · 1 teammate · tasks 0/0 done · /team-play')
    test.setStatus('idle')
    await test.settle()
    expect(await test.screen()).toContain('team · 1 teammate · tasks 0/0 done · /team-play')
  })

  it('leaves the list when the picker is cancelled', async () => {
    const test = await bench({
      before(ctx) {
        teams(ctx, () => [lead, ada], () => [])
      },
    })
    typeLine(test, '/team')
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.hostCalls.some(call => call.startsWith('observe'))).toBe(false)
    expect(await test.screen()).toContain('team · 1 teammate · tasks 0/0 done · /team-play')
  })
})
