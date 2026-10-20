/**
 * The terminal's quit sequence: the census of what quitting stops, the order
 * and bound of the stop, and the report the runner turns into stderr lines and
 * an exit code. It touches no process facility: the runner supplies the output
 * sink, the force signal and the budget, and the timers are the global ones.
 * @module @deepseek-ai/dsh-tui-app/quit
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { describeFailure } from './transcript.ts'

/**
 * What a quit stops, counted when it is asked. The counts are of work running
 * now, not of work that ever ran.
 */
export interface QuitWork {
  /** Shell commands: the model's foreground calls of the quitting session tree plus the user's running `!` command. */
  readonly commands: number
  /** Other live jobs of the session tree: `run_in_background` commands, moved calls, workflow runs. */
  readonly jobs: number
  /** Descendant Agents of the root that are running a turn. */
  readonly subagents: number
}

/** The census of a terminal with nothing running. */
export const NO_WORK: QuitWork = { commands: 0, jobs: 0, subagents: 0 }

/** Why the terminal is quitting: the user asked, or the terminal went away (SIGHUP). */
export type QuitCause = 'user' | 'hangup'

/** What the application hands the runner when it quits. */
export interface QuitRequest {
  /** The census taken before anything was stopped. */
  readonly work: QuitWork
  /** Why the terminal is quitting. */
  readonly cause: QuitCause
}

/**
 * Period of the "still stopping" notices. A presentation choice of this
 * terminal surface, not a deployment setting.
 */
export const QUIT_NOTICE_MS = 2000

/**
 * Whether a census names no work.
 * @param work - the census.
 * @returns true when every count is zero.
 */
export function workIsIdle(work: QuitWork): boolean {
  return work.commands === 0 && work.jobs === 0 && work.subagents === 0
}

/**
 * Read a census that only words a notice: a registry already torn down counts
 * as nothing running.
 * @param read - the census source.
 * @returns the census, or {@link NO_WORK} when reading it throws.
 */
export function safeWork(read: () => QuitWork): QuitWork {
  try {
    return read()
  } catch (_censusFailed) {
    // The census is advisory; a service the composition already disposed must not stop the quit.
    return NO_WORK
  }
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * Word a census for a notice: commands, background jobs, then subagents, the
 * non-zero parts joined by `, `.
 * @param work - the census.
 * @returns the wording, or an empty string when nothing runs.
 */
export function describeWork(work: QuitWork): string {
  const parts: string[] = []
  if (work.commands > 0) parts.push(count(work.commands, 'command'))
  if (work.jobs > 0) parts.push(count(work.jobs, 'background job'))
  if (work.subagents > 0) parts.push(count(work.subagents, 'subagent'))
  return parts.join(', ')
}

/** The step of the quit sequence that failed. */
export interface QuitFailure {
  /** Which step threw. */
  readonly step: 'cancel' | 'idle' | 'flush' | 'dispose'
  /** What it threw. */
  readonly cause: unknown
}

/**
 * How the quit sequence ended. The four facts are independent: a sequence can
 * time out after its flush succeeded, fail a step and still be saved, or be
 * forced while a step was failing.
 */
export interface QuitReport {
  /** The budget ran out before dispose finished. */
  readonly timedOut: boolean
  /** The user forced the quit before dispose finished. */
  readonly interrupted: boolean
  /** Steps that threw, in the order they ran. */
  readonly failures: readonly QuitFailure[]
  /** The session log flush completed. */
  readonly saved: boolean
  /** The census when the sequence ended. */
  readonly remaining: QuitWork
}

/** The part of a bound session the quit sequence drives; `BoundSession` satisfies it. */
export interface QuitBinding {
  /** The Agent whose turn is cancelled and awaited. */
  readonly agent: Pick<Agent, 'cancel' | 'whenIdle'>
  /** Release the Agent, which stops the jobs and subagents it owns. */
  dispose(): Promise<void>
}

/** What the sequence needs from the process around it. */
export interface QuitEnvironment {
  /** The root binding being released. */
  readonly bound: QuitBinding
  /** The census now. */
  work(): QuitWork
  /** Persist the session log. */
  flush(): Promise<void>
  /** Write one line for the user; may throw when the sink is gone. */
  say(line: string): void
  /** How long the sequence runs before the runner gives up waiting, in milliseconds. */
  readonly graceMs: number
  /** Period of the "still stopping" notices, in milliseconds. */
  readonly noticeMs: number
  /**
   * Settles with the census taken at the moment the user forces the quit, and
   * never rejects. The census is taken in the signal handler itself because
   * the launcher begins disposing the composition on the same signal, after
   * which a later census reads nothing.
   */
  readonly forced: Promise<QuitWork>
}

/**
 * Stop the session tree and report how it went. The order is cancel the
 * turn, wait for the Agent to go idle, flush the log, dispose the binding
 * (which stops owned jobs and subagents); each step is contained, so a failed
 * flush never skips dispose. The sequence is bounded by `graceMs` and ends
 * early when `forced` settles; whatever is still running then is left to the
 * caller's exit, and its late results are ignored.
 * @param env - the process facilities and budget.
 * @param initial - the census taken before anything stopped.
 * @returns the report; it never rejects.
 */
export async function runQuit(env: QuitEnvironment, initial: QuitWork): Promise<QuitReport> {
  const say = (line: string): void => {
    try {
      env.say(line)
    } catch (_sinkClosed) {
      // The sink is stderr, which a hangup or a closed pipe can take away; the exit code still carries the outcome.
    }
  }
  const census = (): QuitWork => safeWork(() => env.work())
  if (!workIsIdle(initial)) say(`dsh: stopping ${describeWork(initial)} (Ctrl+C to force)`)

  const failures: QuitFailure[] = []
  let saved = false
  const attempt = async (step: QuitFailure['step'], run: () => Promise<void>): Promise<boolean> => {
    try {
      await run()
      return true
    } catch (cause) {
      failures.push({ step, cause })
      return false
    }
  }
  const { agent } = env.bound
  const sequence = (async (): Promise<void> => {
    await attempt('cancel', () => { agent.cancel({ kind: 'user' }); return Promise.resolve() })
    await attempt('idle', () => agent.whenIdle())
    saved = await attempt('flush', () => env.flush())
    await attempt('dispose', () => env.bound.dispose())
  })()

  let budget: ReturnType<typeof setTimeout> | undefined
  let notices: ReturnType<typeof setInterval> | undefined
  let winner: 'done' | 'timeout' | QuitWork
  try {
    const timedOut = new Promise<'timeout'>((resolve) => {
      budget = setTimeout(() => { resolve('timeout') }, env.graceMs)
    })
    notices = setInterval(() => {
      const work = census()
      if (!workIsIdle(work)) say(`dsh: still stopping ${describeWork(work)} (Ctrl+C to force)`)
    }, env.noticeMs)
    winner = await Promise.race([
      sequence.then(() => 'done' as const),
      timedOut,
      env.forced,
    ])
  } finally {
    clearTimeout(budget)
    clearInterval(notices)
  }
  const forcedWork = typeof winner === 'object' ? winner : undefined
  return {
    timedOut: winner === 'timeout',
    interrupted: forcedWork !== undefined,
    failures: [...failures],
    saved,
    remaining: forcedWork ?? census(),
  }
}

/** The lines to print and the exit code a report maps to. */
export interface QuitOutcome {
  /** Lines for stderr, in order; the resume hint is last. */
  readonly lines: readonly string[]
  /** The process exit code. */
  readonly code: number
}

/**
 * Map a report to what the user is told and how the process exits.
 * @param report - how the sequence ended.
 * @param details - the session to name in the hint, the budget the sequence ran under, and why the terminal quit.
 * @returns the stderr lines and the exit code: 130 when forced, 129 for a hangup, 1 for a timeout or a failed step, else 0.
 */
export function quitOutcome(
  report: QuitReport,
  details: { readonly sessionId: string; readonly graceMs: number; readonly cause: QuitCause },
): QuitOutcome {
  const lines: string[] = []
  for (const failure of report.failures) {
    const what = failure.step === 'flush' ? 'saving the session failed' : 'stopping failed'
    lines.push(`dsh: ${what}: ${describeFailure(failure.cause)}`)
  }
  const left = workIsIdle(report.remaining) ? '' : `; ${describeWork(report.remaining)} may still be running`
  if (report.timedOut) lines.push(`dsh: gave up waiting after ${String(Math.round(details.graceMs / 1000))}s${left}`)
  if (report.interrupted) lines.push(`dsh: forcing exit${left}`)
  if (report.saved) {
    lines.push(`dsh: session ${details.sessionId} saved; resume with: dsh --profile tui --resume ${details.sessionId}`)
  }
  let code = 0
  if (report.interrupted) code = 130
  else if (details.cause === 'hangup') code = 129
  else if (report.timedOut || report.failures.length > 0) code = 1
  return { lines, code }
}
