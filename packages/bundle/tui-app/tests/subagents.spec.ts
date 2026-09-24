/** The live subagent panel in the running terminal: membership, focus, Enter, and the absence cases. */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { BENCH_NOW, KEY, bench, type Bench } from './bench.ts'
import { createPalette } from '../src/style.ts'
import { SUBAGENT_PANEL_MAX_ROWS, renderSubagentPanel, subagentPanelView } from '../src/subagent-panel.ts'

/** A terminal wide enough for the heading's widest legend step. */
const WIDE = 100

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
    expect(test.terminal.text()).toContain('session-kid')
    expect(test.terminal.text()).not.toContain('one-shot · resident · running')

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
    const unfocused = await test.screen()
    expect(unfocused).toContain('subagents · 3 listed')
    expect(unfocused.split('\n').find(line => line.includes('subagents ·'))?.trim())
      .toBe('subagents · 3 listed · session-kid')
    expect(unfocused).not.toContain('↑↓ children')
    test.terminal.type(KEY.shiftDown)
    const screen = await test.screen()
    expect(screen).toContain('subagents · 3 listed')
    expect(screen).toContain('↑↓ children · Enter opens · Tab regions · Esc input')
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
    test.terminal.type(KEY.shiftDown)
    await test.settle()
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
    expect(test.terminal.text()).toContain('↑↓ children · Enter opens · Tab regions · Esc input')
    // Down past the panel's last row reaches the bar, and Up comes back.
    test.terminal.type(KEY.down)
    await test.settle()
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    test.terminal.type(KEY.up)
    await test.settle()
    expect(test.terminal.text()).toContain('↑↓ children · Enter opens · Tab regions · Esc input')
    // Tab walks the regions, so the bar is one press away whatever row the
    // panel's selection sits on.
    test.terminal.type(KEY.tab)
    await test.settle()
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')

    // Esc from the bar returns to the editor, and typing lands there.
    test.terminal.type(KEY.escape)
    await test.settle()
    for (const char of 'hello') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'hello' }]])
  })

  it('sends a printable key back to the editor and gives the keyboard back on Ctrl+C', async () => {
    const test = await bench({ subagents: () => Promise.resolve([entry('session-kid')] as never) })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    test.terminal.type(KEY.shiftDown)
    // A printable key hands the keyboard back and lands at the caret, so it is
    // in the editor and still unsent; Ctrl+O stays with the panel.
    for (const char of 'zzz') test.terminal.type(char)
    test.terminal.type(KEY.ctrlO)
    await test.settle()
    expect(test.calls.followups).toHaveLength(0)
    expect(await test.screen()).toContain('Shift+↓')
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.terminal.text()).toContain('press Ctrl+C again to quit')
    expect(await test.screen()).toContain('Shift+↓')
  })

  it('returns focus to the editor when the panel it held goes away', async () => {
    let listed: unknown[] = [entry('session-kid')]
    const test = await bench({ subagents: () => Promise.resolve(listed as never) })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('↑↓ children · Enter opens · Tab regions · Esc input')
    listed = []
    kid.setStatus('idle')
    test.tick()
    await test.settle()
    for (const char of 'after') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'after' }]])
  })

  it('leaves the keyboard with an open reader when the panel it was opened from goes away', async () => {
    let listed: unknown[] = [entry('session-kid')]
    const test = await bench({ subagents: () => Promise.resolve(listed as never) })
    for (const char of 'read the spec') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    expect(test.terminal.text()).toContain(' ● READER ')

    listed = []
    kid.setStatus('idle')
    test.tick()
    await test.settle()
    // The panel handed its keyboard back, but the reader owns the key stream
    // until it closes: a printable key reaches the reader, not the editor.
    for (const char of 'zzz') test.terminal.type(char)
    await test.settle()
    expect(await test.screen()).toContain(' ● READER ')
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    await test.settle()
    for (const char of 'after') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.calls.followups.map(message => message.content).at(-1)).toEqual([{ type: 'text', text: 'after' }])
  })

  it('moves the selection with Up and Down and leaves the panel for the editor above its first row', async () => {
    const test = await bench({
      subagents: () => Promise.resolve([entry('session-kid'), entry('session-other')] as never),
    })
    const kid = await test.createChild({ id: 'session-kid' })
    await test.createChild({ id: 'session-other' })
    await reconcile(test, kid)

    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.up)
    await test.settle()
    expect(test.terminal.text()).toContain('↑↓ children · Enter opens · Tab regions · Esc input')
    // Up from the first row leaves the panel for the editor, which is drawn
    // directly above it, instead of wrapping.
    test.terminal.type(KEY.up)
    await test.settle()
    expect(await test.screen()).not.toContain('↑↓ children · Enter opens · Tab regions · Esc input')
    for (const char of 'typed') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'typed' }]])
  })

  it('opens a row as a live view of that subagent session and returns to the parent with /parent', async () => {
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
    const other = await test.createChild({ id: 'session-other' })
    other.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'review the diff' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await reconcile(test, kid)

    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    const inside = await test.screen()
    expect(inside).toContain('subagent view')
    expect(inside).toContain('review the diff')
    expect(inside).toContain('subagent reviewer · Ctrl+P or /parent returns to session session-tui-test')
    // The listing entry's detail rows follow the entry notice.
    expect(inside).toContain('workspace: /work/session-other')
    expect(test.hostCalls).toContain('observe-resident:session-other')

    // The view is live: what the child logs next is drawn as it lands.
    other.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'second look' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await test.settle()
    expect(await test.screen()).toContain('second look')

    // The parent keeps logging while it is not drawn; returning reads it again.
    test.appendPrompt('parent kept going')
    for (const char of '/parent') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    const back = await test.screen()
    expect(back).toContain('back in session session-tui-test')
    expect(back).toContain('parent kept going')
    expect(back).not.toContain('subagent view')
    expect(back).not.toContain('review the diff')

    for (const char of '/parent') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(await test.screen()).toContain('this is the root session; /parent returns from a subagent view')
  })

  it('refuses to open a row while a session switch is still opening', async () => {
    const gate = { release: () => {} }
    const options: Parameters<typeof bench>[0] & object = { subagents: () => Promise.resolve([entry('session-kid')] as never) }
    const test = await bench(options)
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    options.hostGate = gate
    for (const char of '/new') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(await test.screen()).toContain('wait for the session switch to finish')
    gate.release()
    await test.settle()
  })

  it('enters a row with Right and returns with Ctrl+P', async () => {
    const test = await bench({ subagents: () => Promise.resolve([entry('session-kid', { label: 'explorer' })] as never) })
    const kid = await test.createChild({ id: 'session-kid' })
    await reconcile(test, kid)
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.right)
    await test.settle()
    const inside = await test.screen()
    expect(inside).toContain('◆ subagent view ›')
    // The line above the editor names the view and the way back whatever the transcript scrolled to.
    const banner = inside.split('\n').find(line => line.includes('back to main'))
    expect(banner).toContain('main › explorer')
    expect(inside.indexOf('back to main')).toBeGreaterThan(inside.indexOf('subagent explorer'))
    test.terminal.type('\u0010')
    await test.settle()
    const back = await test.screen()
    expect(back).toContain('back in session session-tui-test')
    expect(back).not.toContain('back to main')
  })

  it('enters a subagent from /subagents, releases every view on a session switch, and quits the root', async () => {
    const test = await bench({
      subagents: () => Promise.resolve([entry('session-kid', { label: 'explorer' })] as never),
    })
    await test.createChild({ id: 'session-kid' })
    for (const char of '/subagents') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(await test.screen()).toContain('subagent explorer')

    for (const char of '/new') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(await test.screen()).toContain('new session: session session-opened-1')
    expect(await test.screen()).not.toContain('subagent view')
    test.terminal.type(KEY.ctrlD)
    await test.settle()
    expect(test.quits.map(bound => bound.agent.session.id)).toEqual(['session-opened-1'])
  })

  it('reaches the first and last row with the Shift arrows, Home, End, and the page keys', async () => {
    const test = await bench({
      color: true,
      subagents: () => Promise.resolve([
        entry('session-kid'),
        entry('session-other'),
        entry('session-third'),
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
    await test.createChild({ id: 'session-third' })
    await reconcile(test, kid)

    /** Read which child the accented panel row names, without leaving the panel. */
    const selected = async (): Promise<string> => {
      const accent = '\u001b[36m'
      await test.screen()
      const row = test.terminal.output.split('\n').find(line => line.includes(accent) && /session-(kid|other|third)/u.test(line))
      const id = /session-(kid|other|third)/u.exec(row ?? '')?.[0] ?? ''
      return `workspace: /work/${id}`
    }

    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.end)
    await test.settle()
    expect(await selected()).toBe('workspace: /work/session-third')
    test.terminal.type(KEY.home)
    await test.settle()
    expect(await selected()).toBe('workspace: /work/session-kid')
    test.terminal.type(KEY.pageDown)
    await test.settle()
    expect(await selected()).toBe('workspace: /work/session-third')
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await selected()).toBe('workspace: /work/session-kid')
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(await selected()).toBe('workspace: /work/session-third')
    test.terminal.type(KEY.pageUp)
    await test.settle()
    expect(await selected()).toBe('workspace: /work/session-kid')

    // Down at the last row reaches the bar, and Up there comes back to the
    // row the bar sits directly under: the panel's last one.
    test.terminal.type(KEY.end)
    test.terminal.type(KEY.down)
    await test.settle()
    expect(await test.screen()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    test.terminal.type(KEY.up)
    await test.settle()
    expect(await selected()).toBe('workspace: /work/session-third')
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
    test.terminal.type(KEY.shiftDown)
    await test.settle()
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
    // The rows the last good listing produced stay, named on the summary until focus.
    expect(screen).toContain('subagents · 1 listed · session-kid')
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

describe('renderSubagentPanel', () => {
  const palette = createPalette(false)

  /** One resident child at the given id, as the listing answers. */
  function listed(id: string, extra: Record<string, unknown> = {}): never {
    return {
      kind: 'child',
      id,
      activity: 'running',
      mode: 'one-shot',
      hasChildren: false,
      parentId: 'session-root',
      depth: 1,
      ...extra,
    } as never
  }

  it('collapses to one summary line while the keyboard is elsewhere', () => {
    const view = subagentPanelView({
      entries: [listed('session-kid'), listed('session-other')],
      facts: new Map(),
      now: BENCH_NOW,
    })
    expect(renderSubagentPanel(view, { palette, width: WIDE })).toBe('subagents · 2 listed · session-kid')
    expect(renderSubagentPanel({ rows: [], hidden: 0, ticking: false }, { palette, width: WIDE })).toBe('subagents · 0 listed')
  })

  it('draws the rows, overflow, hints, and listing failure while it holds the keyboard', () => {
    const entries = Array.from({ length: SUBAGENT_PANEL_MAX_ROWS + 1 }, (_, index) => listed(`session-${String(index)}`))
    const view = subagentPanelView({ entries, facts: new Map(), now: BENCH_NOW })
    const drawn = renderSubagentPanel(view, { palette, selected: 0, width: WIDE, failure: 'the listing timed out' })
    expect(drawn.split('\n')[0]).toContain('↑↓ children · Enter opens · Tab regions · Esc input')
    expect(drawn).toContain('session-0 · one-shot · resident · idle')
    expect(drawn).toContain('+1 more · /subagents lists them all')
    expect(drawn).toContain('listing failed: the listing timed out')
  })
})
