/** Exact root-relative subagent names in terminal browsing and activity. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError, type SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it } from 'vitest'
import { KEY, bench, type Bench } from './bench.ts'

const root = SessionId('session-tui-test')
const parent = SessionId('session-parent')
const child = SessionId('session-child')
const external = SessionId('external')
const broken = SessionId('broken')

function rows(id: SessionId): SubagentDescendantListEntry[] {
  const parentRow: SubagentDescendantListEntry = {
    kind: 'child', id: parent, parentId: root, depth: 1, mode: 'continuable', name: 'reviewer', path: 'reviewer',
    label: 'Review', activity: 'running', hasChildren: true,
  }
  const childRow: SubagentDescendantListEntry = {
    kind: 'child', id: child, parentId: parent, depth: id === root ? 2 : 1, mode: 'continuable', name: 'checker',
    path: id === root ? 'reviewer/checker' : 'checker', label: 'Review', activity: 'running', hasChildren: false,
  }
  if (id !== root && id !== parent) return []
  if (id === parent) return [childRow]
  return [parentRow, childRow,
    { kind: 'child', id: external, parentId: root, depth: 1, mode: 'external', name: 'audit', path: 'audit', label: 'External review', activity: 'inactive', hasChildren: false },
    { kind: 'diagnostic', id: broken, parentId: root, depth: 1, path: 'broken-agent', reason: 'corrupt' },
    { kind: 'child', id: SessionId('old'), parentId: root, depth: 1, mode: 'continuable', label: 'Historical work', activity: 'inactive', hasChildren: false },
  ]
}

async function command(test: Bench, value: string): Promise<void> {
  for (const char of value) test.terminal.type(char)
  test.terminal.type(KEY.enter)
  await test.settle()
}

describe('root-relative subagent addresses', () => {
  it('shows root addresses in the picker and nested panel without Team mode', async () => {
    const test = await bench({ subagents: id => Promise.resolve(rows(id)) })
    const reviewer = await test.createChild({ id: parent, owner: test.agent })
    const checker = await test.createChild({ id: child, depth: 2, parent, owner: reviewer.agent })
    test.session.append('turn/start', { turn: 1 })
    test.ctx.emit('subagent/start', { runId: 'review-run', provider: 'test', id: parent, local: true } as never)
    reviewer.setStatus('running')
    test.tick(0)
    await test.settle()
    expect(await test.screen()).toContain('subagents · 3 listed · reviewer')
    expect(await test.screen()).toContain('reviewer · Review')
    await command(test, '/subagents')
    const listing = await test.screen()
    expect(listing).toContain('reviewer · Review')
    // The picker keeps 30 columns for the row label, so the description stays short enough to remain visible.
    expect(listing).toContain('reviewer/checker · Review')
    expect(listing).toContain('audit · External review')
    expect(listing).toContain('broken-agent')
    expect(listing).toContain('Historical work')
    test.terminal.type(KEY.enter)
    await test.settle()
    checker.setStatus('running')
    test.tick(0)
    await test.settle()
    expect(await test.screen()).toContain('subagents · 1 listed · reviewer/checker')
    await command(test, '/subagents')
    expect(await test.screen()).toContain('reviewer/checker · Review')
  })

  it('discards an address lookup completed after returning to the parent', async () => {
    const test = await bench({ subagents: id => Promise.resolve(rows(id)) })
    const reviewer = await test.createChild({ id: parent, owner: test.agent })
    reviewer.setStatus('running')
    test.tick(0)
    await test.settle()
    await command(test, '/subagents')
    test.terminal.type(KEY.enter)
    await test.settle()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const release = Promise.withResolvers<SubagentDescendantListEntry[]>()
    test.ctx.subagents.listDescendants = (id) => {
      if (id === root) {
        entered.resolve()
        return release.promise
      }
      return Promise.resolve(rows(id))
    }
    const checker = await test.createChild({ id: child, depth: 2, parent, owner: reviewer.agent })
    checker.setStatus('running')
    test.tick(0)
    await entered.promise
    await command(test, '/parent')
    release.resolve([{ kind: 'child', id: child, parentId: root, depth: 1, mode: 'continuable', name: 'wrong', path: 'wrong', label: 'Wrong listing', activity: 'running', hasChildren: false }])
    await test.settle()
    expect(await test.screen()).not.toContain('wrong · Wrong listing')
  })

  it('retains local labels when the live root is unavailable', async () => {
    const test = await bench({ subagents: id => Promise.resolve(rows(id)) })
    const reviewer = await test.createChild({ id: parent, owner: test.agent })
    reviewer.setStatus('running')
    test.tick(0)
    await test.settle()
    await command(test, '/subagents')
    test.terminal.type(KEY.enter)
    await test.settle()
    test.ctx.subagents.rootOf = () => { throw new SubagentError('owner unavailable', 'UNAUTHORIZED') }
    const checker = await test.createChild({ id: child, depth: 2, parent, owner: reviewer.agent })
    checker.setStatus('running')
    test.tick(0)
    await test.settle()
    expect(await test.screen()).toContain('subagents · 1 listed · Review')
    await command(test, '/subagents')
    const listing = await test.screen()
    expect(listing).toContain('Review')
    expect(listing).not.toContain('checker · Review')
    expect(listing).not.toContain('reviewer/checker')
  })
})
