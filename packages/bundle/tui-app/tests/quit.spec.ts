/** The quit census wording, the stop sequence, and the report's mapping to lines and an exit code. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NO_WORK,
  QUIT_NOTICE_MS,
  describeWork,
  quitOutcome,
  runQuit,
  safeWork,
  workIsIdle,
  type QuitBinding,
  type QuitCause,
  type QuitEnvironment,
  type QuitReport,
  type QuitWork,
} from '../src/quit.ts'

afterEach(() => { vi.useRealTimers() })

describe('quit census', () => {
  it('words each non-zero count in a fixed order with singular and plural nouns', () => {
    expect(describeWork({ commands: 1, jobs: 0, subagents: 0 })).toBe('1 command')
    expect(describeWork({ commands: 2, jobs: 1, subagents: 3 })).toBe('2 commands, 1 background job, 3 subagents')
    expect(describeWork({ commands: 0, jobs: 2, subagents: 1 })).toBe('2 background jobs, 1 subagent')
  })

  it('words nothing when nothing runs', () => {
    expect(describeWork(NO_WORK)).toBe('')
    expect(workIsIdle(NO_WORK)).toBe(true)
  })

  it('is idle only when every count is zero', () => {
    expect(workIsIdle({ commands: 1, jobs: 0, subagents: 0 })).toBe(false)
    expect(workIsIdle({ commands: 0, jobs: 1, subagents: 0 })).toBe(false)
    expect(workIsIdle({ commands: 0, jobs: 0, subagents: 1 })).toBe(false)
  })
})

const BUSY: QuitWork = { commands: 1, jobs: 2, subagents: 0 }

interface Rig {
  readonly env: QuitEnvironment
  readonly order: string[]
  readonly said: string[]
  readonly idle: PromiseWithResolvers<void>
  readonly forced: PromiseWithResolvers<QuitWork>
  readonly census: { current: QuitWork }
}

/** A scripted binding whose `whenIdle` the test settles; the steps record the order they ran in. */
function rig(overrides: {
  flush?: () => Promise<void>
  dispose?: () => Promise<void>
  say?: (line: string) => void
  work?: () => QuitWork
} = {}): Rig {
  const order: string[] = []
  const said: string[] = []
  // Annotated bindings: the tests lint layer rejects an explicit `void` type argument in call position.
  const idle: PromiseWithResolvers<void> = Promise.withResolvers()
  const forced: PromiseWithResolvers<QuitWork> = Promise.withResolvers()
  const census = { current: BUSY }
  const bound: QuitBinding = {
    agent: {
      cancel: () => { order.push('cancel') },
      whenIdle: () => { order.push('idle'); return idle.promise },
    },
    dispose: overrides.dispose ?? (() => { order.push('dispose'); return Promise.resolve() }),
  }
  const env: QuitEnvironment = {
    bound,
    work: overrides.work ?? (() => census.current),
    flush: overrides.flush ?? (() => { order.push('flush'); return Promise.resolve() }),
    say: overrides.say ?? ((line) => { said.push(line) }),
    graceMs: 10_000,
    noticeMs: QUIT_NOTICE_MS,
    forced: forced.promise,
  }
  return { env, order, said, idle, forced, census }
}

describe('runQuit', () => {
  it('cancels, waits for idle, flushes, then disposes, and says nothing when nothing runs', async () => {
    const test = rig()
    test.census.current = NO_WORK
    test.idle.resolve()
    const report = await runQuit(test.env, NO_WORK)
    expect(test.order).toEqual(['cancel', 'idle', 'flush', 'dispose'])
    expect(test.said).toEqual([])
    expect(report).toEqual({ timedOut: false, interrupted: false, failures: [], saved: true, remaining: NO_WORK })
  })

  it('names the work it stops before it stops anything', async () => {
    const test = rig()
    test.idle.resolve()
    await runQuit(test.env, BUSY)
    expect(test.said).toEqual(['dsh: stopping 1 command, 2 background jobs (Ctrl+C to force)'])
  })

  it('reports the work still running at each notice period from the current census', async () => {
    vi.useFakeTimers()
    const test = rig()
    const pending = runQuit(test.env, BUSY)
    test.said.length = 0
    await vi.advanceTimersByTimeAsync(QUIT_NOTICE_MS)
    expect(test.said).toEqual(['dsh: still stopping 1 command, 2 background jobs (Ctrl+C to force)'])
    test.census.current = { commands: 0, jobs: 1, subagents: 0 }
    await vi.advanceTimersByTimeAsync(QUIT_NOTICE_MS)
    expect(test.said.at(-1)).toBe('dsh: still stopping 1 background job (Ctrl+C to force)')
    test.census.current = NO_WORK
    const before = test.said.length
    await vi.advanceTimersByTimeAsync(QUIT_NOTICE_MS)
    expect(test.said).toHaveLength(before)
    test.idle.resolve()
    await pending
  })

  it('gives up waiting at the budget, reports what is left, and leaves no timer behind', async () => {
    vi.useFakeTimers()
    const test = rig()
    const pending = runQuit(test.env, BUSY)
    await vi.advanceTimersByTimeAsync(10_000)
    const report = await pending
    expect(report).toEqual({ timedOut: true, interrupted: false, failures: [], saved: false, remaining: BUSY })
    expect(vi.getTimerCount()).toBe(0)
    // The sequence that was left running settles later without disturbing anything.
    test.idle.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(test.order).toEqual(['cancel', 'idle', 'flush', 'dispose'])
  })

  it('ends early, as interrupted, when the user forces the quit, reporting the census taken at the force', async () => {
    vi.useFakeTimers()
    const test = rig()
    const pending = runQuit(test.env, BUSY)
    // The launcher starts tearing the composition down on the same signal, so the census at the end reads nothing.
    test.census.current = NO_WORK
    test.forced.resolve({ commands: 2, jobs: 0, subagents: 1 })
    const report = await pending
    expect(report).toMatchObject({ timedOut: false, interrupted: true, saved: false, remaining: { commands: 2, jobs: 0, subagents: 1 } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('finishes before the budget when the sequence completes first', async () => {
    vi.useFakeTimers()
    const test = rig()
    const pending = runQuit(test.env, BUSY)
    test.idle.resolve()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(await pending).toMatchObject({ timedOut: false, interrupted: false, saved: true })
  })

  it('records a failed idle wait and still flushes and disposes', async () => {
    const test = rig()
    const failure = new Error('idle broke')
    test.idle.reject(failure)
    const report = await runQuit(test.env, NO_WORK)
    expect(report.failures).toEqual([{ step: 'idle', cause: failure }])
    expect(report.saved).toBe(true)
    expect(test.order).toEqual(['cancel', 'idle', 'flush', 'dispose'])
  })

  it('records a failed flush as unsaved and still disposes, which is what stops jobs and subagents', async () => {
    const failure = new Error('disk full')
    const test = rig({ flush: () => Promise.reject(failure) })
    test.idle.resolve()
    const report = await runQuit(test.env, NO_WORK)
    expect(report.failures).toEqual([{ step: 'flush', cause: failure }])
    expect(report.saved).toBe(false)
    expect(test.order).toEqual(['cancel', 'idle', 'dispose'])
  })

  it('records a failed dispose', async () => {
    const failure = new Error('dispose broke')
    const test = rig({ dispose: () => Promise.reject(failure) })
    test.idle.resolve()
    const report = await runQuit(test.env, NO_WORK)
    expect(report.failures).toEqual([{ step: 'dispose', cause: failure }])
    expect(report.saved).toBe(true)
  })

  it('records a cancel that throws and carries on', async () => {
    const failure = new Error('cancel broke')
    const test = rig()
    const throwing: QuitEnvironment = {
      ...test.env,
      bound: { ...test.env.bound, agent: { cancel: () => { throw failure }, whenIdle: () => Promise.resolve() } },
    }
    const report = await runQuit(throwing, NO_WORK)
    expect(report.failures).toEqual([{ step: 'cancel', cause: failure }])
    expect(report.saved).toBe(true)
  })

  it('contains a sink that throws and a census that throws', async () => {
    vi.useFakeTimers()
    const test = rig({
      say: () => { throw new Error('stderr closed') },
      work: () => { throw new Error('registry gone') },
    })
    const pending = runQuit(test.env, BUSY)
    await vi.advanceTimersByTimeAsync(QUIT_NOTICE_MS)
    test.idle.resolve()
    const report = await pending
    expect(report).toMatchObject({ timedOut: false, saved: true, remaining: NO_WORK })
  })
})

describe('safeWork', () => {
  it('reads the census, and counts a census that throws as nothing running', () => {
    expect(safeWork(() => BUSY)).toBe(BUSY)
    expect(safeWork(() => { throw new Error('registry gone') })).toBe(NO_WORK)
  })
})

describe('quitOutcome', () => {
  const hint = 'dsh: session session-1 saved; resume with: dsh --profile tui --resume session-1'
  const clean: QuitReport = { timedOut: false, interrupted: false, failures: [], saved: true, remaining: NO_WORK }
  const outcome = (report: QuitReport, cause: QuitCause = 'user'): ReturnType<typeof quitOutcome> =>
    quitOutcome(report, { sessionId: 'session-1', graceMs: 10_000, cause })

  it('ends a clean quit with the resume hint and exit code 0', () => {
    expect(outcome(clean)).toEqual({ lines: [hint], code: 0 })
  })

  it('says it gave up waiting, naming what may still run, and exits 1', () => {
    expect(outcome({ ...clean, timedOut: true })).toEqual({ lines: ['dsh: gave up waiting after 10s', hint], code: 1 })
    expect(outcome({ ...clean, timedOut: true, remaining: { commands: 1, jobs: 0, subagents: 0 } })).toEqual({
      lines: ['dsh: gave up waiting after 10s; 1 command may still be running', hint],
      code: 1,
    })
  })

  it('says it forced the exit, and exits 130 whatever else happened', () => {
    const remaining = { commands: 0, jobs: 2, subagents: 0 }
    expect(outcome({ ...clean, interrupted: true, remaining })).toEqual({
      lines: ['dsh: forcing exit; 2 background jobs may still be running', hint],
      code: 130,
    })
    expect(outcome({ ...clean, interrupted: true, timedOut: true }).code).toBe(130)
    expect(outcome({ ...clean, interrupted: true }, 'hangup').code).toBe(130)
    expect(outcome({ ...clean, interrupted: true }).lines).toEqual(['dsh: forcing exit', hint])
  })

  it('reports each failed step and omits the hint when the session was not saved', () => {
    const flush = new Error('disk full')
    expect(outcome({ ...clean, saved: false, failures: [{ step: 'flush', cause: flush }] })).toEqual({
      lines: ['dsh: saving the session failed: disk full'],
      code: 1,
    })
    const failures = [{ step: 'idle', cause: new Error('a') }, { step: 'dispose', cause: 'b' }] as const
    expect(outcome({ ...clean, failures })).toEqual({
      lines: ['dsh: stopping failed: a', 'dsh: stopping failed: b', hint],
      code: 1,
    })
  })

  it('exits 129 for a hangup that went cleanly or not', () => {
    expect(outcome(clean, 'hangup')).toEqual({ lines: [hint], code: 129 })
    expect(outcome({ ...clean, timedOut: true }, 'hangup').code).toBe(129)
  })
})
