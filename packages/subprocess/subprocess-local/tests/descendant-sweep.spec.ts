/**
 * The POSIX fallback owner's descendant sweep, driven through spawnSubprocess
 * with a fake process table injected as the inspector. Leaders are real
 * processes, so the process-group half of each range is real; the fake table
 * adds descendants at pids above every kernel's pid ceiling (Linux allows at
 * most 2^22, macOS 99,999), and a process.kill spy delivers their signals, so
 * a missed intercept can never reach a real process.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ProcessIdentity, ProcessInspector, ProcessSnapshot } from '../src/process-inspector.ts'
import { spawnSubprocess, type SpawnInternals } from '../src/spawn.ts'

const POSIX = process.platform !== 'win32'
const FAKE_PID = 5_000_000

interface FakeRow {
  readonly pid: number
  readonly parent: number
  readonly started: string
  /** Present in the table but not running. */
  readonly zombie?: boolean
}

/** Fake descendant number `n`, a child of `parent`. */
function row(n: number, parent: number, started = 'first'): FakeRow {
  return { pid: FAKE_PID + n, parent, started }
}

/** The real leader's row; its start identity is never compared by the sweep. */
function leaderRow(pid: number): FakeRow {
  return { pid, parent: 1, started: 'leader' }
}

/** A process table the test edits between reads; it records every read and inspector creation. */
class FakeProcessTable {
  rows: FakeRow[] = []
  /** `Date.now()` of every successful read. */
  readonly reads: number[] = []
  /** Inspectors created through {@link factory}. */
  created = 0
  /** Thrown by every read while set. */
  failure: Error | undefined

  /** The `SpawnInternals.processInspector` factory; per-identity reads fail the test. */
  readonly factory = (): ProcessInspector => {
    this.created += 1
    const unexpected = (): never => { throw new Error('the sweep must read the table through snapshot() only') }
    return {
      foregroundPgid: unexpected,
      isStdinWaiting: unexpected,
      isAlive: unexpected,
      signalGroup: unexpected,
      signalProcess: unexpected,
      snapshot: () => this.read(),
    }
  }

  private read(): ProcessSnapshot {
    if (this.failure !== undefined) throw this.failure
    this.reads.push(Date.now())
    const rows = [...this.rows]
    const tree = (rootPid: number): ProcessIdentity[] => {
      const root = rows.find(candidate => candidate.pid === rootPid)
      if (root === undefined) return []
      return [
        ...rows.filter(candidate => candidate.parent === rootPid).flatMap(child => tree(child.pid)),
        { pid: root.pid, started: root.started },
      ]
    }
    return {
      complete: true,
      tree,
      session: () => [],
      alive: identity => rows.some(candidate =>
        candidate.pid === identity.pid && candidate.started === identity.started && candidate.zombie !== true),
    }
  }
}

interface Delivery {
  readonly pid: number
  readonly signal: string | number | undefined
  /** Table reads completed when the signal was sent. */
  readonly reads: number
}

type Fate = 'exit' | 'survive' | 'deny'

/**
 * Deliver signals for fake pids against the table and pass every other target
 * to the kernel; signal-0 probes are not recorded.
 * @param table - the table whose rows receive fake deliveries.
 * @param fate - whether a fake row exits, survives, or refuses (EPERM) one signal.
 * @returns every recorded delivery, in order.
 */
function deliverFakeSignals(table: FakeProcessTable, fate: (row: FakeRow, signal: string | number | undefined) => Fate): Delivery[] {
  const realKill = process.kill.bind(process)
  const deliveries: Delivery[] = []
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal !== 0) deliveries.push({ pid, signal, reads: table.reads.length })
    if (pid < FAKE_PID) return realKill(pid, signal)
    const target = table.rows.find(candidate => candidate.pid === pid)
    if (target === undefined) throw Object.assign(new Error(`kill ${pid} ESRCH`), { code: 'ESRCH' })
    const outcome = fate(target, signal)
    if (outcome === 'deny') throw Object.assign(new Error(`kill ${pid} EPERM`), { code: 'EPERM' })
    if (outcome === 'exit') table.rows = table.rows.filter(candidate => candidate !== target)
    return true
  })
  return deliveries
}

/** Real leaders spawned through {@link sweepInternals}, killed after each test. */
const leaders: number[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const pid of leaders.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (_groupAlreadyGone) {
      // The test's own termination already emptied this detached group.
    }
  }
})

/**
 * Spawn internals that inject the fake table and remember the real leader's pid.
 * @param table - the fake process table.
 * @param failures - receives every sweep failure report.
 * @returns the internals and the leader-pid accessor.
 */
function sweepInternals(table: FakeProcessTable, failures: unknown[] = []): { internals: SpawnInternals; leader: () => number } {
  let leaderPid: number | undefined
  return {
    internals: {
      spawn: (program, args, options) => {
        const child = nodeSpawn(program, args, options)
        leaderPid = child.pid
        if (leaderPid !== undefined) leaders.push(leaderPid)
        return child
      },
      processInspector: table.factory,
      onSweepFailure: (error) => { failures.push(error) },
    },
    leader: () => {
      if (leaderPid === undefined) throw new Error('the leader published no pid')
      return leaderPid
    },
  }
}

function spec(argv: string[], graceMs = 60_000): SubprocessSpawnSpec {
  return {
    argv,
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs,
  }
}

/** A leader whose whole group ignores SIGTERM once it prints `ready` (see {@link untilReady}). */
const TERM_IGNORING_LEADER = ['bash', '-c', 'trap "" TERM; echo ready; sleep 60']

/** Wait until the TERM-ignoring leader installed its trap; a TERM sent earlier kills it. */
async function untilReady(handle: SubprocessHandle): Promise<void> {
  await vi.waitFor(() => { expect(handle.collected.stdout?.readFrom(0).text).toBe('ready\n') }, { timeout: 5_000, interval: 10 })
}

/** The provider's own stderr lines among captured `process.stderr.write` calls. */
function providerLines(calls: readonly (readonly unknown[])[]): string[] {
  return calls.map(call => String(call[0])).filter(line => line.startsWith('dsh-subprocess-local:'))
}

function signalled(deliveries: Delivery[], signal: string): number[] {
  return deliveries.filter(delivery => delivery.signal === signal).map(delivery => delivery.pid).sort((a, b) => a - b)
}

describe.skipIf(!POSIX)('POSIX fallback descendant sweep', () => {
  it('reads the table once at the first signal and signals the group and every running descendant of the leader', async () => {
    const table = new FakeProcessTable()
    const { internals, leader } = sweepInternals(table)
    const handle = spawnSubprocess(spec(['sleep', '60']), internals)
    const pid = leader()
    table.rows = [
      leaderRow(pid),
      row(1, pid),
      row(2, FAKE_PID + 1),
      { ...row(3, pid), zombie: true },
      row(4, 1),
    ]
    const deliveries = deliverFakeSignals(table, () => 'exit')

    handle.terminate()

    expect(table.reads).toHaveLength(1)
    expect(signalled(deliveries, 'SIGTERM')).toEqual([-pid, FAKE_PID + 1, FAKE_PID + 2])
    expect(deliveries.every(delivery => delivery.reads === 1)).toBe(true)
    await expect(handle.done).resolves.toMatchObject({ signal: 'SIGTERM' })
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('escalates at grace expiry from one fresh read: the group, recorded survivors, and descendants found since', async () => {
    const table = new FakeProcessTable()
    const { internals, leader } = sweepInternals(table)
    const handle = spawnSubprocess(spec(TERM_IGNORING_LEADER, 300), internals)
    const pid = leader()
    table.rows = [leaderRow(pid), row(1, pid), row(2, pid), row(3, pid)]
    const deliveries = deliverFakeSignals(table, (target, signal) =>
      signal === 'SIGKILL' || target.pid === FAKE_PID + 2 ? 'exit' : 'survive')
    await untilReady(handle)

    handle.terminate()
    // Before the grace expires: descendant 2 exited on TERM, descendant 3's pid
    // now names an unrelated process, descendant 1 started a child, and the
    // leader started another.
    table.rows = [
      leaderRow(pid),
      row(1, pid),
      { pid: FAKE_PID + 3, parent: 1, started: 'recycled' },
      row(4, FAKE_PID + 1),
      row(5, pid),
    ]

    await expect(handle.done).resolves.toMatchObject({ signal: 'SIGKILL' })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(signalled(deliveries, 'SIGKILL')).toEqual([-pid, FAKE_PID + 1, FAKE_PID + 4, FAKE_PID + 5])
    // The process group lived until the escalation, so no read happened between the two signals.
    expect(deliveries.filter(delivery => delivery.signal === 'SIGKILL').every(delivery => delivery.reads === 2)).toBe(true)
  })

  it('escalates to SIGKILL for a recorded descendant that outlives the process group', async () => {
    const table = new FakeProcessTable()
    const { internals, leader } = sweepInternals(table)
    const handle = spawnSubprocess(spec(['sleep', '60'], 200), internals)
    const pid = leader()
    table.rows = [leaderRow(pid), row(1, pid)]
    const deliveries = deliverFakeSignals(table, (_target, signal) => signal === 'SIGKILL' ? 'exit' : 'survive')

    handle.terminate()

    await expect(handle.done).resolves.toMatchObject({ signal: 'SIGTERM' })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(signalled(deliveries, 'SIGKILL')).toEqual([FAKE_PID + 1])
  })

  it('keeps waitForExit pending on recorded descendants after the group exits, with at most one table read per 50 ms poll', async () => {
    const table = new FakeProcessTable()
    const { internals, leader } = sweepInternals(table)
    const handle = spawnSubprocess(spec(['sleep', '60']), internals)
    const pid = leader()
    table.rows = [leaderRow(pid), row(1, pid), row(2, pid), row(3, FAKE_PID + 1)]
    deliverFakeSignals(table, () => 'survive')

    handle.terminate()
    await expect(handle.done).resolves.toMatchObject({ signal: 'SIGTERM' })
    let settled = false
    const waiting = handle.waitForExit().then((exited) => {
      settled = true
      return exited
    })
    await vi.waitFor(() => { expect(table.reads.length).toBeGreaterThanOrEqual(6) }, { timeout: 10_000, interval: 20 })
    expect(settled).toBe(false)
    table.rows = [leaderRow(pid)]

    await expect(waiting).resolves.toBe(true)
    // Averaged so one late tick cannot shorten the next: a read per descendant,
    // or a poll at the 15 ms process-group cadence, averages far below 50 ms.
    const polls = table.reads.slice(1)
    const averageGap = (polls[polls.length - 1]! - polls[0]!) / (polls.length - 1)
    expect(averageGap).toBeGreaterThanOrEqual(45)
  })

  it('sends no signal to a pid whose start identity changed since it was recorded', async () => {
    const table = new FakeProcessTable()
    const { internals, leader } = sweepInternals(table)
    const handle = spawnSubprocess(spec(['sleep', '60'], 200), internals)
    const pid = leader()
    table.rows = [leaderRow(pid), row(1, pid)]
    const deliveries = deliverFakeSignals(table, () => 'survive')

    handle.terminate()
    table.rows = [leaderRow(pid), { pid: FAKE_PID + 1, parent: 1, started: 'recycled' }]

    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(deliveries.filter(delivery => delivery.pid === FAKE_PID + 1).map(delivery => delivery.signal)).toEqual(['SIGTERM'])
  })

  it('keeps signalling the remaining descendants when one delivery is refused', async () => {
    const table = new FakeProcessTable()
    const { internals, leader } = sweepInternals(table)
    const handle = spawnSubprocess(spec(['sleep', '60'], 200), internals)
    const pid = leader()
    table.rows = [leaderRow(pid), row(1, pid), row(2, pid)]
    const deliveries = deliverFakeSignals(table, (target, signal) =>
      signal === 'SIGTERM' && target.pid === FAKE_PID + 1 ? 'deny' : 'exit')

    expect(() => { handle.terminate() }).not.toThrow()

    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(signalled(deliveries, 'SIGTERM')).toEqual([-pid, FAKE_PID + 1, FAKE_PID + 2])
    expect(signalled(deliveries, 'SIGKILL')).toEqual([FAKE_PID + 1])
  })

  it('force-kills the group and its descendants synchronously from one read at host exit', async () => {
    const table = new FakeProcessTable()
    const { internals, leader } = sweepInternals(table)
    const handle = spawnSubprocess(spec(['sleep', '60']), internals)
    const pid = leader()
    table.rows = [leaderRow(pid), row(1, pid), row(2, FAKE_PID + 1)]
    const deliveries = deliverFakeSignals(table, () => 'exit')

    handle.terminateForHostExit()

    expect(table.reads).toHaveLength(1)
    expect(signalled(deliveries, 'SIGKILL')).toEqual([-pid, FAKE_PID + 1, FAKE_PID + 2])
    await expect(handle.done).resolves.toMatchObject({ signal: 'SIGKILL' })
  })

  it('never reads the table or signals for a command that exits on its own', async () => {
    const table = new FakeProcessTable()
    const { internals, leader } = sweepInternals(table)
    const handle = spawnSubprocess(spec(['true']), internals)
    // A daemon the command started on purpose.
    table.rows = [leaderRow(leader()), row(1, leader())]
    const deliveries = deliverFakeSignals(table, () => 'exit')

    await expect(handle.done).resolves.toMatchObject({ exitCode: 0 })
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    handle.terminateForHostExit()

    expect(table.created).toBe(0)
    expect(deliveries).toEqual([])
  })

  it('ignores host-exit termination of a spawn that published no pid', async () => {
    const table = new FakeProcessTable()
    const { internals } = sweepInternals(table)
    const handle = spawnSubprocess({ ...spec(['true']), cwd: '/nonexistent-dsh-descendant-sweep' }, internals)

    expect(() => { handle.terminateForHostExit() }).not.toThrow()

    await expect(handle.done).rejects.toThrow(/ENOENT/)
    expect(table.created).toBe(0)
  })
})

describe.skipIf(!POSIX)('descendant sweep failures', () => {
  it('reports an unreadable table once and escalates through the process group alone', async () => {
    const table = new FakeProcessTable()
    table.failure = Object.assign(new Error('ps: operation not permitted'), { code: 'EPERM' })
    const failures: unknown[] = []
    const { internals, leader } = sweepInternals(table, failures)
    const handle = spawnSubprocess(spec(TERM_IGNORING_LEADER, 200), internals)
    const pid = leader()
    const deliveries = deliverFakeSignals(table, () => 'exit')
    await untilReady(handle)

    expect(() => { handle.terminate() }).not.toThrow()

    await expect(handle.done).resolves.toMatchObject({ signal: 'SIGKILL' })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(failures).toEqual([table.failure])
    expect(deliveries.map(delivery => [delivery.pid, delivery.signal])).toEqual([[-pid, 'SIGTERM'], [-pid, 'SIGKILL']])
  })

  it('stops waiting on recorded descendants when a later read fails', async () => {
    const table = new FakeProcessTable()
    const failures: unknown[] = []
    const { internals, leader } = sweepInternals(table, failures)
    const handle = spawnSubprocess(spec(['sleep', '60']), internals)
    table.rows = [leaderRow(leader()), row(1, leader())]
    deliverFakeSignals(table, () => 'survive')

    handle.terminate()
    table.failure = new Error('process table unavailable')

    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(table.reads).toHaveLength(1)
    expect(failures).toEqual([table.failure])
  })

  it('writes one stderr line for a bare caller whose inspector cannot be created', async () => {
    const failure = new Error('subprocess-local: terminal inspection is unsupported on platform freebsd')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    let leaderPid: number | undefined
    const handle = spawnSubprocess(spec(TERM_IGNORING_LEADER, 200), {
      spawn: (program, args, options) => {
        const child = nodeSpawn(program, args, options)
        leaderPid = child.pid
        if (leaderPid !== undefined) leaders.push(leaderPid)
        return child
      },
      processInspector: () => { throw failure },
    })
    await untilReady(handle)

    handle.terminate()

    await expect(handle.done).resolves.toMatchObject({ signal: 'SIGKILL' })
    expect(leaderPid).toBeDefined()
    const written = providerLines(stderr.mock.calls)
    expect(written).toEqual([expect.stringContaining('cannot read the process table')])
    expect(written[0]).toContain(failure.message)
  })

  it('contains a failure reporter that throws', async () => {
    const table = new FakeProcessTable()
    table.failure = new Error('process table unavailable')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { internals } = sweepInternals(table)
    const handle = spawnSubprocess(spec(['sleep', '60']), {
      ...internals,
      onSweepFailure: () => { throw new Error('logger closed') },
    })

    expect(() => { handle.terminate() }).not.toThrow()

    await expect(handle.done).resolves.toMatchObject({ signal: 'SIGTERM' })
    expect(providerLines(stderr.mock.calls)).toEqual([expect.stringContaining('logger closed')])
  })
})

describe.skipIf(!POSIX)('LocalSubprocessRuntime descendant sweep reporting', () => {
  it('warns once per provider through the plugin logger', async () => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const runtime = ctx.subprocess as LocalSubprocessRuntime
    const failure = new Error('ps: operation not permitted')
    runtime.internals = { platform: 'darwin', processInspector: () => { throw failure } }
    try {
      const handles = [runtime.spawn(spec(['sleep', '60'])), runtime.spawn(spec(['sleep', '60']))]
      for (const handle of handles) handle.terminate()
      await Promise.all(handles.map(handle => handle.waitForExit()))

      const sweepWarnings = warn.mock.calls.filter(([message]) => String(message).includes('cannot read the process table'))
      expect(sweepWarnings).toEqual([[expect.stringContaining('signals only its process group'), failure]])
    } finally {
      await fiber.dispose()
    }
  })
})

describe('Windows fallback termination', () => {
  it('terminates through taskkill without reading the process table', async () => {
    const table = new FakeProcessTable()
    const taskkill = vi.fn((pid: number) => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (_alreadyGone) {
        // taskkill tolerates an absent tree the same way.
      }
    })
    const handle = spawnSubprocess(spec([process.execPath, '-e', 'setInterval(() => {}, 1000)']), {
      platform: 'win32',
      taskkill,
      processInspector: table.factory,
      onSweepFailure: () => { throw new Error('unexpected sweep failure') },
    })
    try {
      handle.terminate()
      await handle.done
      await expect(handle.waitForExit()).resolves.toBe(true)
      handle.terminateForHostExit()

      expect(taskkill).toHaveBeenCalled()
      expect(table.created).toBe(0)
    } finally {
      handle.terminateForHostExit()
    }
  })
})
