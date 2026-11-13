/** The todos page through the app: shared tasks with their owners and subtasks, live repaints, the keys that leave it, and teardown. */
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { describe, expect, it } from 'vitest'
import type { TeamTaskRow } from '../src/team-panel.ts'
import { BENCH_SPINNER_MS, KEY, bench, type Bench } from './bench.ts'
import { listed, provideTeam } from './team-bench.ts'

const ENTER_ALT = '\u001b[?1049h'
const LEAVE_ALT = '\u001b[?1049l'
const LEAD = 'session-tui-test'
const ADA = 'session-ada'

function typeLine(test: Bench, text: string): void {
  for (const char of text) test.terminal.type(char)
  test.terminal.type(KEY.enter)
}

/** What the alternate screen drew since the page last opened, escape sequences removed. */
function page(test: Bench): string {
  const written = test.terminal.written
  return written.slice(written.lastIndexOf(ENTER_ALT)).replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '')
}

/** Whether the main screen is the one the terminal shows. */
function closed(test: Bench): boolean {
  return test.terminal.written.lastIndexOf(LEAVE_ALT) > test.terminal.written.lastIndexOf(ENTER_ALT)
}

/** A projection registry that serves each session its own todo list. */
function todosBySession(lists: Map<string, TodoItem[]>): NonNullable<Exclude<Parameters<typeof bench>[0], undefined>['projections']> {
  return {
    snapshot: (session: Session) => ({ asOfSeq: 1, values: { todos: lists.get(session.id) ?? null } }),
    onChanged: () => () => {},
  }
}

/** One shared task. */
function task(id: string, subject: string, status: TeamTaskRow['status'], extra: Partial<TeamTaskRow> = {}): TeamTaskRow {
  return { id, revision: 1, subject, description: `${subject} in full`, status, blockedBy: [], writeScopes: [], ready: status === 'pending', writeScopeWarnings: [], ...extra }
}

/** A team with Ada as the one teammate and three shared tasks: Ada's, one blocked on it, and one nobody owns. */
async function teamBench(
  options: { live: boolean; lists?: Map<string, TodoItem[]>; clickableKeys?: boolean },
): Promise<{ test: Bench; tasks: TeamTaskRow[]; lists: Map<string, TodoItem[]> }> {
  const lists = options.lists ?? new Map<string, TodoItem[]>([
    [ADA, [{ content: 'parse rows', status: 'completed' }, { content: 'stream to disk', status: 'in_progress' }]],
    [LEAD, [{ content: 'plan the work', status: 'completed' }]],
  ])
  const tasks = [
    task('1', 'Write exporter', 'in_progress', { ownerId: ADA, ownerName: 'Ada' } as Partial<TeamTaskRow>),
    task('2', 'Add tests', 'pending', { blockedBy: ['1'], ready: false }),
    task('3', 'Docs', 'pending'),
  ]
  const test = await bench({
    ...options.clickableKeys === true ? { clickableKeys: true } : {},
    projections: todosBySession(lists),
    before(ctx) { provideTeam(ctx, () => [listed(ADA, 'Ada')], () => tasks) },
  })
  if (options.live) {
    const ada = await test.createChild({ id: ADA })
    ada.setStatus('running')
  }
  test.tick()
  await test.settle()
  return { test, tasks, lists }
}

describe('todos page', () => {
  it('divides the shared tasks among their owners, with a live teammate\'s todo list beneath its task', async () => {
    const { test } = await teamBench({ live: true })
    typeLine(test, '/todos')
    await test.settle()
    const drawn = page(test)
    expect(drawn).toContain('todos · 1/4 delivered · 1 in progress · 1 stuck')
    expect(drawn).toContain('#1 Write exporter')
    expect(drawn).toContain('stream to disk')
    expect(drawn).toContain('#2 Add tests')
    expect(drawn).toContain('#3 Docs')
    expect(drawn).toContain('lead · 1/1')
    expect(drawn).toContain('owner  Ada · teammate · running')
    expect(drawn).toContain('Subtasks 1/2')
    expect(drawn).toContain('Blocks')
    // Down past #1's two subtasks reaches the task that waits on it.
    for (let step = 0; step < 3; step += 1) test.terminal.type(KEY.down)
    await test.settle()
    expect(page(test)).toContain('state  stuck · waits on #1')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(closed(test)).toBe(true)
  })

  it('reads a cold teammate\'s in-progress task as stuck with no subtasks', async () => {
    const { test } = await teamBench({ live: false })
    typeLine(test, '/todos')
    await test.settle()
    const drawn = page(test)
    expect(drawn).toContain('2 stuck')
    expect(drawn).toContain('state  stuck · owner idle')
    expect(drawn).not.toContain('stream to disk')
  })

  it('repaints while open when a teammate writes its todos and when a task is released', async () => {
    const { test, tasks, lists } = await teamBench({ live: true })
    typeLine(test, '/todos')
    await test.settle()
    expect(page(test)).not.toContain('retry failures')

    const next: TodoItem[] = [...lists.get(ADA) ?? [], { content: 'retry failures', status: 'pending' }]
    lists.set(ADA, next)
    const ada = test.ctx.agents.get(SessionId(ADA))
    ada?.session.append('todo/write', { todos: next })
    await test.settle()
    expect(page(test)).toContain('retry failures')
    expect(page(test)).toContain('Subtasks 1/3')

    // The lead claims #3 and hands it back, which the page reads as deferred.
    const teamId = 'team-1' as never
    test.session.append('team/task', { version: 2, teamId, task: { ...tasks[2], status: 'in_progress', ownerId: SessionId(LEAD) } as never })
    test.session.append('team/task', { version: 2, teamId, task: { ...tasks[2], status: 'pending' } as never })
    await test.settle()
    expect(page(test)).toContain('1 deferred')
  })

  it('opens the owning teammate on Enter and says why an unowned task opens nothing', async () => {
    const { test } = await teamBench({ live: true })
    typeLine(test, '/todos')
    await test.settle()
    // #1, its two subtasks, #2, then #3.
    for (let step = 0; step < 4; step += 1) test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(page(test)).toContain('#3 has no owner yet')
    expect(closed(test)).toBe(false)

    test.terminal.type('g')
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(closed(test)).toBe(true)
    expect(test.hostCalls).toContain(`observe-resident:${ADA}`)
  })

  it('closes on Ctrl+C, ignores the wheel, and stacks the panes after a resize below 72 columns', async () => {
    const { test } = await teamBench({ live: true, clickableKeys: true })
    typeLine(test, '/todos')
    await test.settle()
    test.terminal.type('\u001b[<64;10;10M')
    await test.settle()
    expect(closed(test)).toBe(false)
    expect(page(test)).not.toContain('─'.repeat(60))

    test.terminal.resize(60)
    await test.settle()
    expect(page(test)).toContain('─'.repeat(60))

    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(closed(test)).toBe(true)
    typeLine(test, 'back to typing')
    await test.settle()
    expect(test.calls.followups).toHaveLength(1)
  })

  it('spins the worked task on the spinner tick when color is on, and a live teammate without a todo list has no subtasks', async () => {
    const lists = new Map<string, TodoItem[]>([[LEAD, [{ content: 'plan the work', status: 'completed' }]]])
    const tasks = [task('1', 'Write exporter', 'in_progress', { ownerId: ADA, ownerName: 'Ada' } as Partial<TeamTaskRow>)]
    const test = await bench({
      color: true,
      projections: todosBySession(lists),
      before(ctx) { provideTeam(ctx, () => [listed(ADA, 'Ada')], () => tasks) },
    })
    const ada = await test.createChild({ id: ADA })
    ada.setStatus('running')
    test.tick()
    await test.settle()
    typeLine(test, '/todos')
    await test.settle()
    for (let step = 0; step < 16; step += 1) test.runTick(BENCH_SPINNER_MS)
    await test.settle()
    // The settled reveal leaves the spinner as the one motion, so the tick stays armed.
    expect(test.tickArmed(BENCH_SPINNER_MS)).toBe(true)
    expect(page(test)).toContain('#1 Write exporter')
    expect(page(test)).not.toContain('Subtasks')
  })

  it('takes the page down when the app quits', async () => {
    const { test } = await teamBench({ live: true })
    typeLine(test, '/todos')
    await test.settle()
    test.app.hangup()
    expect(closed(test)).toBe(true)
  })
})
