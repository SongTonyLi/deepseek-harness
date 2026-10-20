/**
 * Descendant tracking for the POSIX process-group fallback owner. A detached
 * command's descendants can leave its process group (`setsid`, a detached
 * spawn) while they are still its children, and a signal to the group misses
 * them. Termination therefore reads the process table when it starts, records
 * the leader's descendants as pid plus start identity, and signals each
 * recorded identity with the group; the owner's range stays alive while any
 * recorded identity still runs. A descendant that was already reparented away
 * from the leader's tree at the read, such as a double-forked daemon, is not
 * found. A command that is never signalled is never inspected.
 * @module dsh-subprocess-local/descendant-sweep
 */

import type { ProcessIdentity, ProcessInspector, ProcessSnapshot } from './process-inspector.ts'

/**
 * What a sweep failure means for the command, shared by every report: the
 * provider warning and the stderr line of a bare caller.
 */
export const SWEEP_FAILURE_IMPACT = 'cannot read the process table (/bin/ps on macOS, /proc on Linux), so terminating a command signals only its process group and descendants that left that group can outlive it; make the process table readable to restore descendant termination'

/**
 * Receives the failure that stops one sweep; that handle's termination then
 * reaches its process group only.
 * @param error - the inspector creation or process-table read failure.
 */
export type SweepFailureReporter = (error: unknown) => void

/** Inputs of one {@link DescendantSweep}. */
export interface DescendantSweepOptions {
  /** Pid of the detached process-group leader. */
  readonly leaderPid: number
  /**
   * Whether Node has not yet reaped the leader. While it holds, `leaderPid`
   * cannot name another process, so the leader's tree may be adopted.
   */
  readonly leaderHeld: () => boolean
  /** Creates the inspector at the first table read; a throw is a sweep failure. */
  readonly inspector: () => ProcessInspector
  /** Receives the first failure; a reporter that throws is contained and its failure written to stderr. */
  readonly onFailure: SweepFailureReporter
}

/**
 * The recorded descendants of one fallback process-group leader. Every method
 * is synchronous and never throws: inspector failures stop the sweep and are
 * reported once, and signal delivery failures are contained per target.
 */
export class DescendantSweep {
  /** Descendants the latest table read showed running, by exact start identity. */
  private recorded: readonly ProcessIdentity[] = []
  private inspector: ProcessInspector | undefined
  /** Set by the first failure; the sweep then never reads again and tracks nothing. */
  private failed = false

  /** @param options - leader identity guard, inspector factory, and failure reporter. */
  constructor(private readonly options: DescendantSweepOptions) {}

  /**
   * Signal the leader's descendants as termination reaches its process group.
   * Reads the table once when there is something to find: recorded
   * descendants, or a live group whose leader is still held. The read adopts
   * the held leader's current descendants and those of recorded survivors, and
   * drops recorded identities it no longer shows running; every remaining
   * identity then receives `signal`. The read is the fence against pid reuse,
   * so it is taken before the caller signals the group, while the leader's
   * tree is still intact.
   * @param signal - termination signal for every recorded descendant.
   * @param groupAlive - whether the leader's process group still has members.
   * @returns whether any recorded descendant was running at the read.
   */
  signal(signal: 'SIGTERM' | 'SIGKILL', groupAlive: boolean): boolean {
    if (this.recorded.length === 0 && !(groupAlive && this.options.leaderHeld())) return false
    this.read()
    for (const member of this.recorded) {
      try {
        process.kill(member.pid, signal)
      } catch (_deliveryFailed) {
        // The next read decides: ESRCH means it exited after this read, and EPERM
        // means another user's process holds the pid or the descendant changed credentials.
      }
    }
    return this.recorded.length > 0
  }

  /**
   * Report whether a recorded descendant still runs, from one table read; no
   * read happens when nothing is recorded.
   * @returns whether the read showed a recorded descendant running.
   */
  running(): boolean {
    if (this.recorded.length === 0) return false
    this.read()
    return this.recorded.length > 0
  }

  private read(): void {
    if (this.failed) return
    try {
      this.inspector ??= this.options.inspector()
      this.adopt(this.inspector.snapshot())
    } catch (error) {
      this.fail(error)
    }
  }

  private adopt(snapshot: ProcessSnapshot): void {
    const { leaderPid } = this.options
    const survivors = this.recorded.filter(member => snapshot.alive(member))
    const roots = [...this.options.leaderHeld() ? [leaderPid] : [], ...survivors.map(member => member.pid)]
    const found = roots.flatMap(root => snapshot.tree(root))
    const seen = new Set<string>()
    this.recorded = [...survivors, ...found].filter((member) => {
      const key = `${member.pid}:${member.started}`
      if (member.pid === leaderPid || seen.has(key) || !snapshot.alive(member)) return false
      seen.add(key)
      return true
    })
  }

  private fail(error: unknown): void {
    this.failed = true
    this.recorded = []
    try {
      this.options.onFailure(error)
    } catch (reporterFailure) {
      // The reporter runs inside signal() and the exit-time sweep, which must never throw.
      process.stderr.write(`dsh-subprocess-local: descendant sweep failure reporter threw: ${String(reporterFailure)}\n`)
    }
  }
}
