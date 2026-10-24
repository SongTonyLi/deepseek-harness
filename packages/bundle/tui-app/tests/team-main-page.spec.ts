/** A running team on the main page: one home per teammate, and the teammate view's title. */

import type { Context } from '@deepseek-ai/cordis'
import { TeamId } from '@deepseek-ai/dsh-experimental-agent-team'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { KEY, bench, type Bench, type BenchChild } from './bench.ts'
import type { TeamMemberRow, TeamTaskRow } from '../src/team-panel.ts'

const ROLE = 'reviews the lockfile'

const lead: TeamMemberRow = { id: 'session-tui-test', name: 'lead', role: 'lead', status: 'running', diagnostics: [] }

function teammate(status: TeamMemberRow['status'], description: string | undefined = ROLE): TeamMemberRow {
  return {
    id: 'session-ada',
    name: 'Ada',
    role: 'teammate',
    status,
    diagnostics: [],
    ...description === undefined ? {} : { description },
  }
}

interface Roster {
  members: TeamMemberRow[]
  tasks: TeamTaskRow[]
}

function provideTeam(ctx: Context, roster: Roster): void {
  ctx.provide('agentTeams', {
    tryMembership: () => ({}),
    listMembers: () => roster.members,
    listTasks: () => roster.tasks,
  })
}

/** One descendant listing entry of the lead, as the subagent runtime answers with. */
function listed(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    kind: 'child',
    id,
    activity: 'running',
    mode: 'one-shot',
    hasChildren: false,
    parentId: 'session-tui-test',
    depth: 1,
    ...extra,
  }
}

/** Answer the lead's listing with `entries`, and every other session's with none. */
function listing(entries: readonly unknown[]): (id: SessionId) => Promise<never> {
  return id => Promise.resolve((id === 'session-tui-test' ? entries : []) as never)
}

function typeLine(test: Bench, text: string): void {
  for (const char of text) test.terminal.type(char)
  test.terminal.type(KEY.enter)
}

function narrate(child: BenchChild, text: string): void {
  child.session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test-provider', model: 'test-model' } }),
  }, { surfaceOp: 'append' })
}

/** Let the app read a listing it was just told is stale, and draw the board row the child's start gives. */
async function start(test: Bench, child: BenchChild): Promise<void> {
  test.ctx.emit('subagent/start', { runId: `run-${child.id}`, provider: 'test', id: child.id, local: true } as never)
  child.setStatus('running')
  test.tick(0)
  await test.settle()
}

function joined(test: Bench): void {
  test.session.append('team/member', {
    version: 2,
    teamId: TeamId('session-tui-test'),
    member: {
      id: SessionId('session-ada'),
      name: 'Ada',
      description: ROLE,
      provider: 'test-provider',
      context: 'fresh',
      phase: 'active',
    },
  })
}

describe('a running team on the main page', () => {
  it('draws a teammate once: on the team line and the board, not in the subagent panel', async () => {
    const roster: Roster = { members: [lead, teammate('running')], tasks: [] }
    const test = await bench({
      subagents: listing([
        listed('session-ada', { label: 'generic-listing', mode: 'continuable' }),
        listed('session-kid', { label: 'explorer' }),
      ]),
      before(ctx) { provideTeam(ctx, roster) },
    })
    const ada = await test.createChild({ id: 'session-ada' })
    const kid = await test.createChild({ id: 'session-kid' })
    await start(test, kid)
    await start(test, ada)
    narrate(ada, 'Checking the lockfile.')

    const screen = await test.screen()
    expect(screen).toContain('team · 1 teammate · working: Ada · tasks 0/0 done · /team-play')
    expect(screen).toContain(`Ada · ${ROLE} › Checking the lockfile.`)
    expect(screen).toContain('subagents · 1 listed · explorer')
    expect(screen).toMatch(/^\s*\S explorer\s*$/mu)
    expect(screen).not.toContain('generic-listing')
    expect(screen.match(/^\s*\S Ada · /gmu)).toHaveLength(1)
  })

  it('keeps a teammate out of the panel count but lists its own forks and other children', async () => {
    const roster: Roster = { members: [lead, teammate('running')], tasks: [] }
    const test = await bench({
      subagents: listing([
        listed('session-ada', { label: 'generic-listing', mode: 'continuable' }),
        listed('session-fork', { label: 'fork of Ada', depth: 2, parentId: 'session-ada' }),
      ]),
      before(ctx) { provideTeam(ctx, roster) },
    })
    const fork = await test.createChild({ id: 'session-fork', parent: SessionId('session-ada'), depth: 2 })
    await start(test, fork)

    test.terminal.type(KEY.shiftDown)
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain('subagents · 1 listed')
    expect(screen).toMatch(/^\s*fork of Ada · one-shot · resident/mu)
    expect(screen).not.toContain('generic-listing')
  })

  it('leaves the panel and the board alone when the session is not on a team or Agent Teams is absent', async () => {
    const entries = [listed('session-ada', { label: 'generic-listing', mode: 'continuable' }), listed('session-kid', { label: 'explorer' })]
    const outsider = await bench({
      subagents: listing(entries),
      before(ctx) {
        ctx.provide('agentTeams', { tryMembership: () => undefined, listMembers: () => [], listTasks: () => [] })
      },
    })
    const bare = await bench({ subagents: listing(entries) })
    for (const test of [outsider, bare]) {
      const ada = await test.createChild({ id: 'session-ada' })
      await test.createChild({ id: 'session-kid' })
      await start(test, ada)
      const screen = await test.screen()
      expect(screen).toContain('subagents · 2 listed · generic-listing')
      expect(screen).toMatch(/^\s*\S generic-listing\s*$/mu)
      expect(screen).not.toContain('team ·')
    }
  })

  it('moves a member that joins after its row was drawn off the panel and onto its name and role', async () => {
    const roster: Roster = { members: [lead], tasks: [] }
    const test = await bench({
      subagents: listing([
        listed('session-ada', { label: 'generic-listing', mode: 'continuable' }),
        listed('session-bo', { label: 'quiet-listing', mode: 'continuable' }),
        listed('session-kid', { label: 'explorer' }),
      ]),
      before(ctx) { provideTeam(ctx, roster) },
    })
    const ada = await test.createChild({ id: 'session-ada' })
    const bo = await test.createChild({ id: 'session-bo' })
    const kid = await test.createChild({ id: 'session-kid' })
    await start(test, kid)
    await start(test, bo)
    await start(test, ada)
    narrate(ada, 'Checking the lockfile.')
    let screen = await test.screen()
    expect(screen).toContain('subagents · 3 listed · generic-listing')
    expect(screen).toContain('generic-listing › Checking the lockfile.')

    const quiet: TeamMemberRow = { id: 'session-bo', name: 'Bo', role: 'teammate', status: 'inactive', diagnostics: [] }
    roster.members = [lead, teammate('running'), quiet]
    joined(test)
    screen = await test.screen()
    expect(screen).toContain('subagents · 1 listed · explorer')
    expect(screen).not.toContain('generic-listing')
    expect(screen).not.toContain('quiet-listing')
    expect(screen).toContain(`Ada · ${ROLE} › Checking the lockfile.`)
    expect(screen).toMatch(/^\s*\S Bo · teammate\s*$/mu)
    expect(screen).toMatch(/^\s*\S explorer\s*$/mu)
    expect(screen).toContain('team · 2 teammates · working: Ada · tasks 0/0 done · /team-play')
  })

  it('cuts a long role to the label share of the row and keeps the note', async () => {
    const role = 'audits every dependency the lead added since the last release and reports what changed'
    const roster: Roster = { members: [lead, teammate('running', role)], tasks: [] }
    const test = await bench({
      subagents: listing([listed('session-ada', { mode: 'continuable' })]),
      before(ctx) { provideTeam(ctx, roster) },
    })
    const ada = await test.createChild({ id: 'session-ada' })
    await start(test, ada)
    narrate(ada, 'Diffing the lockfile.')
    const screen = await test.screen()
    expect(screen).toMatch(/Ada · audits every dependency[^\n]*… › Diffing the lockfile\./u)
    expect(screen).not.toContain('reports what changed')
  })

  it('keeps one line for a role written over several lines', async () => {
    const roster: Roster = { members: [lead, teammate('running', 'reviews the lockfile.\n\nReports once.')], tasks: [] }
    const test = await bench({
      subagents: listing([listed('session-ada', { mode: 'continuable' })]),
      before(ctx) { provideTeam(ctx, roster) },
    })
    const ada = await test.createChild({ id: 'session-ada' })
    await start(test, ada)
    expect(await test.screen()).toContain('Ada · reviews the lockfile. Reports once.')
  })

  it('names the running teammates, counts the finished tasks, and shortens the list on a narrow terminal', async () => {
    const roster: Roster = {
      members: [
        lead,
        ...['Ada', 'Bartholomew', 'Cy'].map((name): TeamMemberRow => ({ id: `session-${name}`, name, role: 'teammate', status: 'running', diagnostics: [] })),
        { id: 'session-di', name: 'Di', role: 'teammate', status: 'inactive', diagnostics: [] },
      ],
      tasks: [
        { id: 'task-1', revision: 1, subject: 'a', description: 'a', status: 'completed', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] },
        { id: 'task-2', revision: 1, subject: 'b', description: 'b', status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] },
        { id: 'task-3', revision: 1, subject: 'c', description: 'c', status: 'deleted', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] },
      ],
    }
    const test = await bench({ before(ctx) { provideTeam(ctx, roster) } })
    expect(await test.screen()).toContain('team · 4 teammates · working: Ada, Bartholomew, Cy · tasks 1/2 done · /team-play')

    test.terminal.resize(70)
    test.setStatus('idle')
    await test.settle()
    expect(test.terminal.text()).toContain('team · 4 teammates · working: Ada +2 · tasks 1/2 done · /team-play')
  })

  it('follows a teammate that starts and stops running', async () => {
    const roster: Roster = { members: [lead, teammate('inactive')], tasks: [] }
    const test = await bench({
      subagents: listing([listed('session-ada', { mode: 'continuable' })]),
      before(ctx) { provideTeam(ctx, roster) },
    })
    const ada = await test.createChild({ id: 'session-ada' })
    expect(await test.screen()).toContain('team · 1 teammate · tasks 0/0 done · /team-play')

    roster.members = [lead, teammate('running')]
    ada.setStatus('running')
    await test.settle()
    expect(await test.screen()).toContain('team · 1 teammate · working: Ada · tasks 0/0 done · /team-play')

    roster.members = [lead, teammate('inactive')]
    ada.setStatus('idle')
    await test.settle()
    expect(await test.screen()).toContain('team · 1 teammate · tasks 0/0 done · /team-play')
  })
})

describe('a teammate view', () => {
  async function openAda(description: string | undefined = ROLE): Promise<Bench> {
    const roster: Roster = { members: [lead, teammate('inactive', description)], tasks: [] }
    const test = await bench({ before(ctx) { provideTeam(ctx, roster) } })
    await test.createChild({ id: 'session-ada' })
    typeLine(test, '/team')
    await test.settle()
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    return test
  }

  it('names the teammate and its role in the header and the banner', async () => {
    const test = await openAda()
    const screen = await test.screen()
    const lines = screen.split('\n')
    expect(lines.find(line => line.includes('Ctrl+P returns'))).toContain(`◆ teammate Ada · ${ROLE}`)
    const banner = lines.find(line => line.includes('back to main'))
    expect(banner).toContain(`teammate Ada · ${ROLE}`)
    expect(banner).toContain('main › Ada')
    expect(screen).not.toContain('subagent view')

    test.terminal.type('\u0010')
    await test.settle()
    const back = await test.screen()
    expect(back).toContain('Agent Teams on')
    expect(back).not.toContain('◆ teammate')
  })

  it('cuts a long role in the title, and names a teammate that has no description by its role word', async () => {
    const long = await openAda('audits every dependency the lead added since the last release')
    expect(await long.screen()).toContain('◆ teammate Ada · audits every dependency the…')

    const bare = await openAda('')
    expect(await bare.screen()).toContain('◆ teammate Ada · teammate')
  })

  it('keeps the generic title for a subagent that is not on the roster', async () => {
    const roster: Roster = { members: [lead, teammate('inactive')], tasks: [] }
    const test = await bench({
      subagents: listing([listed('session-kid', { label: 'explorer' })]),
      before(ctx) { provideTeam(ctx, roster) },
    })
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    test.tick(0)
    await test.settle()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.right)
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain('◆ subagent view ›')
    expect(screen).not.toContain('◆ teammate')
  })

  it('points the root header at the team room only while Agent Teams is mounted', async () => {
    const bare = await bench()
    const bareScreen = await bare.screen()
    expect(bareScreen).toContain('/help for commands')
    expect(bareScreen).not.toContain('Agent Teams on')

    const mounted = await bench({ before(ctx) { provideTeam(ctx, { members: [lead], tasks: [] }) } })
    expect(await mounted.screen()).toContain('Agent Teams on · /team-play · /help')
  })
})
