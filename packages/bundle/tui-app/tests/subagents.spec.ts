/** The live subagent panel in the running terminal: membership, focus, Enter, and the absence cases. */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { BENCH_NOW, KEY, bench, type Bench } from './bench.ts'

/** One descendant listing entry, as the subagent runtime answers with. */
function entry(id: string, extra: Record<string, unknown> = {}): unknown {
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

/** The projection stub a bench accepts in place of the real registry. */
type ProjectionsStub = Exclude<NonNullable<Parameters<typeof bench>[0]>['projections'], 'none' | undefined>

/**
 * A projection registry answering each session with the values the spec keys
 * by session id.
 * @param values - the projection values for one session.
 * @returns the stub to hand the bench.
 */
function childProjections(values: (id: string) => Record<string, unknown>): ProjectionsStub {
  return { snapshot: (session: Session) => ({ asOfSeq: 1, values: values(session.id) }), onChanged: () => () => {} }
}

/**
 * Let the app reconcile a listing the spec just changed: the child's status
 * transition is the live signal that marks it stale, and one tick performs
 * the single listing that follows. The clock stays where it was, so a spec
 * that asserts an elapsed readout controls every millisecond of it.
 * @param test - the running bench.
 * @param child - the child whose transition marks the listing stale.
 */
async function reconcile(test: Bench, child: { setStatus(status: 'idle' | 'running'): void }): Promise<void> {
  child.setStatus('running')
  test.tick(0)
  await test.settle()
}

/**
 * The drawn panel row for one child.
 * @param screen - one complete repaint.
 * @param id - the child session id the row names.
 * @returns the row text without the terminal's padding.
 */
function panelRow(screen: string, id: string): string | undefined {
  return screen.split('\n').find(line => line.includes(id))?.trim()
}

describe('the live subagent panel', () => {
  it('appears when a child starts and goes away when the last one leaves residency', async () => {
    let listed: unknown[] = []
    const test = await bench({ subagents: () => Promise.resolve(listed as never) })
    await test.settle()
    expect(await test.screen()).not.toContain('subagents ·')

    const kid = await test.createChild({ id: 'session-kid' })
    listed = [entry('session-kid')]
    await reconcile(test, kid)
    expect(test.terminal.text()).toContain('subagents · 1 listed')
    expect(test.terminal.text()).toContain('session-kid · one-shot · resident · running')

    // The child settles: its session record is no longer resident, so the
    // listing keeps it and the panel does not.
    listed = [entry('session-kid', { activity: 'inactive' })]
    kid.setStatus('idle')
    test.tick()
    await test.settle()
    expect(await test.screen()).not.toContain('subagents ·')
  })

  it('draws a running child, a resident idle one, and a candidate it could not read', async () => {
    const test = await bench({
      subagents: () => Promise.resolve([
        entry('session-kid'),
        entry('session-grandkid', { depth: 2, mode: 'continuable', label: 'reviewer', parentId: 'session-kid' }),
        { kind: 'diagnostic', id: 'session-broken', reason: 'corrupt', parentId: 'session-tui-test', depth: 1 },
      ] as never),
      projections: childProjections(id => ({
        // The child between turns has a settled total and no open turn.
        subagentTiming: id === 'session-kid'
          ? { settledMs: 8000, active: { since: BENCH_NOW - 72_000, through: BENCH_NOW } }
          : { settledMs: 8000 },
        tokenUsage: { uncachedInputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 300 },
      })),
    })
    const busy = await test.createChild({ id: 'session-kid' })
    const waiting = await test.createChild({ id: 'session-grandkid', depth: 2 })
    busy.setStatus('running')
    waiting.setStatus('idle')
    test.tick(0)
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain('subagents · 3 listed')
    expect(panelRow(screen, 'session-kid')).toBe('session-kid · one-shot · resident · running · 1m12s · ↑1.2k ↓300')
    expect(panelRow(screen, 'reviewer')).toBe('reviewer · continuable · resident · idle · 8s · ↑1.2k ↓300')
    expect(panelRow(screen, 'session-broken')).toBe('session-broken · unreadable: corrupt')
  })

  it('advances the elapsed readouts on a tick that carries no other change', async () => {
    const started = BENCH_NOW - 5000
    const test = await bench({
      subagents: () => Promise.resolve([entry('session-kid')] as never),
      projections: childProjections(() => ({ subagentTiming: { settledMs: 0, active: { since: started, through: started } } })),
    })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    expect(test.terminal.text()).toContain('resident · running · 5s')
    expect(test.tickArmed()).toBe(true)
    test.tick()
    await test.settle()
    expect(await test.screen()).toContain('resident · running · 6s')
  })

  it('walks the docked regions with Shift+Down, Up, and Down, and always returns on Esc', async () => {
    const test = await bench({ subagents: () => Promise.resolve([entry('session-kid')] as never) })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)

    // Shift+Down at the editor reaches the panel, because one is drawn.
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('↑ ↓ select · Enter details · Esc back')
    // Down past the panel's last row reaches the bar, and Up comes back.
    test.terminal.type(KEY.down)
    await test.settle()
    expect(test.terminal.text()).toContain('← → select · ↑ ↓ regions · Enter details · Esc back')
    test.terminal.type(KEY.up)
    await test.settle()
    expect(test.terminal.text()).toContain('↑ ↓ select · Enter details · Esc back')
    // Shift+Down from the panel jumps straight to the bar.
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('← → select · ↑ ↓ regions · Enter details · Esc back')

    // Esc from the bar returns to the editor, and typing lands there.
    test.terminal.type(KEY.escape)
    await test.settle()
    for (const char of 'hello') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'hello' }]])
  })

  it('keeps every other key to itself and gives the keyboard back on Ctrl+C', async () => {
    const test = await bench({ subagents: () => Promise.resolve([entry('session-kid')] as never) })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    test.terminal.type(KEY.shiftDown)
    for (const char of 'zzz') test.terminal.type(char)
    test.terminal.type(KEY.ctrlO)
    await test.settle()
    expect(test.calls.followups).toHaveLength(0)
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.terminal.text()).toContain('press Ctrl+C again to quit')
    expect(await test.screen()).toContain('Shift+↑ transcript')
  })

  it('returns focus to the editor when the panel it held goes away', async () => {
    let listed: unknown[] = [entry('session-kid')]
    const test = await bench({ subagents: () => Promise.resolve(listed as never) })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('↑ ↓ select · Enter details · Esc back')
    listed = []
    kid.setStatus('idle')
    test.tick()
    await test.settle()
    for (const char of 'after') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'after' }]])
  })

  it('moves the selection with Up and Down, opens one session, and comes back to the panel', async () => {
    const test = await bench({
      subagents: () => Promise.resolve([
        entry('session-kid'),
        entry('session-other', { mode: 'continuable', label: 'reviewer' }),
      ] as never),
      before: (ctx) => {
        ctx.provide('sessionQuery', {
          observeSession: (id: string) => Promise.resolve({
            header: { id, createdAt: BENCH_NOW, cwd: `/work/${id}` },
            events: [],
            projections: { asOfSeq: 1, values: { title: `${id} title`, turnOutline: [] } },
            [Symbol.dispose]: () => {},
          }),
        } as never)
      },
    })
    const kid = await test.createChild({ id: 'session-kid' })
    await test.createChild({ id: 'session-other' })
    await reconcile(test, kid)

    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('workspace: /work/session-other')
    expect(test.terminal.text()).toContain('↑ ↓ scroll · Enter, Esc, or ← returns')

    // Leaving the page hands the keyboard back to the panel on the same row.
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.text()).toContain('↑ ↓ select · Enter details · Esc back')
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('workspace: /work/session-kid')
    test.terminal.type(KEY.enter)
    await test.settle()
    // Up from the first row leaves the panel for the transcript instead of
    // wrapping, and this session has nothing navigable in it yet.
    test.terminal.type(KEY.up)
    await test.settle()
    expect(test.terminal.text()).toContain('nothing in the transcript to inspect yet')
  })

  it('opens nothing for a row the listing could not read', async () => {
    const test = await bench({
      subagents: () => Promise.resolve([
        { kind: 'diagnostic', id: 'session-broken', reason: 'corrupt', parentId: 'session-tui-test', depth: 1 },
      ] as never),
    })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).not.toContain('unreadable subagent session')
    expect(test.terminal.text()).toContain('session-broken · unreadable: corrupt')
  })

  it('draws no panel at all without a subagent runtime', async () => {
    const test = await bench()
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    kid.append('turn/start', { turn: 1 })
    await test.settle()
    expect(test.tickArmed()).toBe(false)
    expect(await test.screen()).not.toContain('subagents ·')
  })

  it('draws the rows without elapsed or token facts when no projections are composed', async () => {
    const test = await bench({
      subagents: () => Promise.resolve([entry('session-kid')] as never),
      projections: 'none',
    })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    expect(panelRow(await test.screen(), 'session-kid')).toBe('session-kid · one-shot · resident · running')
  })

  it('keeps the rows and reports a rejected listing once per reason', async () => {
    let listed: unknown[] = [entry('session-kid')]
    /** Set once the listing must start rejecting, with the reason it reports. */
    const failures: string[] = []
    const test = await bench({
      subagents: () => {
        const [failure] = failures
        return failure === undefined ? Promise.resolve(listed as never) : Promise.reject(new Error(failure))
      },
    })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    expect(test.terminal.text()).toContain('subagents · 1 listed')

    failures.push('the query engine is busy')
    listed = []
    kid.append('turn/start', { turn: 1 })
    test.tick()
    await test.settle()
    kid.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    test.tick()
    await test.settle()
    const screen = await test.screen()
    // The rows the last good listing produced stay, with the reason under them.
    expect(screen).toContain('session-kid · one-shot · resident')
    expect(screen).toContain('listing failed: the query engine is busy')
    expect(test.terminal.text().split('subagent listing failed: the query engine is busy')).toHaveLength(2)
  })

  it('arms one interval while something is timing and disarms it when nothing is', async () => {
    const started = BENCH_NOW - 1000
    let listed: unknown[] = [entry('session-kid')]
    const test = await bench({
      liveRefreshMs: 250,
      subagents: () => Promise.resolve(listed as never),
      projections: childProjections(() => ({ subagentTiming: { settledMs: 0, active: { since: started, through: started } } })),

    })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    expect(test.tickArmed()).toBe(true)
    // The live refresh is the only tick a session that is not streaming runs.
    expect(test.tickDelaysMs()).toEqual([250])

    listed = []
    kid.setStatus('idle')
    test.tick()
    await test.settle()
    expect(test.tickArmed()).toBe(false)
  })

  it('re-reads the listing once per tick however many signals arrive', async () => {
    const reads: string[] = []
    const test = await bench({
      subagents: (sessionId) => {
        reads.push(sessionId)
        return Promise.resolve([entry('session-kid')] as never)
      },
    })
    await test.settle()
    // One read seeds the bound session.
    expect(reads).toEqual(['session-tui-test'])
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    kid.append('turn/start', { turn: 1 })
    kid.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await test.settle()
    expect(reads).toHaveLength(1)
    test.tick()
    await test.settle()
    expect(reads).toEqual(['session-tui-test', 'session-tui-test'])
    // Nothing marked it stale since, so the next tick reads nothing.
    test.tick()
    await test.settle()
    expect(reads).toHaveLength(2)
  })

  it('forgets the children of the session it left', async () => {
    const test = await bench({
      // Only the session the bench starts on has a child.
      subagents: sessionId => Promise.resolve((sessionId === 'session-tui-test' ? [entry('session-kid')] : []) as never),
    })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    expect(test.terminal.text()).toContain('subagents · 1 listed')
    for (const char of '/new') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(await test.screen()).not.toContain('subagents ·')
  })

  it('re-reads the listing when a subagent run starts and when one ends', async () => {
    const reads: string[] = []
    const test = await bench({
      subagents: (sessionId) => {
        reads.push(sessionId)
        return Promise.resolve([] as never)
      },
    })
    await test.settle()
    expect(reads).toHaveLength(1)
    // Neither edge names the delegating parent, so both are staleness alone.
    test.ctx.emit('subagent/start', { runId: 'run-1', provider: 'spawn', id: 'session-kid', local: false } as never)
    test.tick()
    await test.settle()
    expect(reads).toHaveLength(2)
    test.ctx.emit('subagent/end', { runId: 'run-1', provider: 'spawn', id: 'session-kid', local: false, stopReason: 'completed' } as never)
    test.tick()
    await test.settle()
    expect(reads).toHaveLength(3)
  })

  it('never lets two listings overlap and reads the session it switched to afterwards', async () => {
    const reads: string[] = []
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await bench({
      subagents: async (sessionId) => {
        reads.push(sessionId)
        if (reads.length === 1) await gate
        return [] as never
      },
    })
    await test.settle()
    expect(reads).toEqual(['session-tui-test'])
    // A second reconcile while the first is in flight reads nothing yet.
    for (const char of '/new') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(reads).toEqual(['session-tui-test'])
    release()
    await test.settle()
    // The result belongs to the session the terminal left, so the next tick
    // reads the one it moved to.
    test.tick()
    await test.settle()
    expect(reads).toEqual(['session-tui-test', 'session-opened-1'])
  })

  it('draws nothing more once a listing settles after the user quit', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await bench({ subagents: async () => { await gate; return [entry('session-kid')] as never } })
    await test.settle()
    test.terminal.type(KEY.ctrlD)
    await test.settle()
    expect(test.quits).toHaveLength(1)
    release()
    await test.settle()
    expect(test.terminal.text()).not.toContain('subagents ·')
  })

  it('leaves the keyboard at the editor when the panel goes away behind an open page', async () => {
    let listed: unknown[] = [entry('session-kid')]
    const test = await bench({
      subagents: () => Promise.resolve(listed as never),
      before: (ctx) => {
        ctx.provide('sessionQuery', {
          observeSession: (id: string) => Promise.resolve({
            header: { id, createdAt: BENCH_NOW, cwd: `/work/${id}` },
            events: [],
            projections: { asOfSeq: 1, values: { turnOutline: [] } },
            [Symbol.dispose]: () => {},
          }),
        } as never)
      },
    })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('workspace: /work/session-kid')
    listed = []
    kid.setStatus('idle')
    test.tick()
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    for (const char of 'after') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'after' }]])
  })

  it('marks the listing stale when the projections of another session change', async () => {
    const listeners = new Set<(session: Session) => void>()
    const reads: string[] = []
    const test = await bench({
      subagents: (sessionId) => {
        reads.push(sessionId)
        return Promise.resolve([entry('session-kid')] as never)
      },
      projections: {
        snapshot: () => ({ asOfSeq: 1, values: {} }),
        onChanged(listener: (session: Session) => void) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    })
    await test.settle()
    expect(reads).toHaveLength(1)
    for (const listener of listeners) listener({ id: 'session-kid' } as Session)
    test.tick()
    await test.settle()
    expect(reads).toHaveLength(2)
  })
})
