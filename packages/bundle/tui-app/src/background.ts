/**
 * `Ctrl+B`: move the bound Agent's running tool calls to the background.
 *
 * A `tools/execute` around-wrapper tracks every root call an Agent dispatches
 * while a job registry is composed. Moving a call registers a `tool` job in
 * `ctx.jobs` whose settlement is the tool body's own outcome, and answers the
 * call at once with a result that names the job, so the turn continues while
 * the body keeps running. The registry and `dsh-tool-jobs` then own the rest:
 * the completion notice reaches the owning Agent, `job_output` reads the
 * result, and `job_kill` stops the body through the wrapper's own signal.
 *
 * The registry fuses the caller's signal into every body, so stopping the
 * turn that dispatched a moved call still stops that call. {@link
 * ToolBackgrounder.holdStopped} keeps such a settlement from waking the Agent
 * the user just stopped.
 * @module @deepseek-ai/dsh-tui-app/background
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobEvent, JobHandle, JobId, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describeFailure } from './transcript.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** A tool call the terminal user moved to the background with `Ctrl+B`. */
    tool: 'tool'
  }
}

/** The text a moved call's result opens with; the job id follows it. */
const MOVED_PREFIX = 'The user moved this call to the background. It keeps running as job '

/** Matches a moved call's result text and captures the job id. */
const MOVED_PATTERN = /^The user moved this call to the background\. It keeps running as job (\S+?)\./u

/** Detail of a moved call that stopped because the turn that dispatched it was stopped. */
export const STOPPED_WITH_TURN = 'stopped with the turn that called it'

/**
 * Bound of the registry wait that holds a stopped call's job: the longest
 * delay a Node timer takes (2^31 - 1 ms, about 24.8 days). The wait ends when
 * the job settles, which the abort that stopped the turn brings about; the
 * bound only has to outlast that.
 */
const HOLD_WAIT_MS = 2_147_483_647

/**
 * The model-facing result of a call the user moved to the background.
 * @param id - the job that took the call over.
 * @returns the result text: the job id, how its outcome arrives, and how to stop it.
 */
export function movedResultText(id: JobId): string {
  return `${MOVED_PREFIX}${id}. You are notified when it finishes; read its result with job_output, or stop it with job_kill. Continue with steps that do not depend on it.`
}

/**
 * The job a moved call's logged result names, so a replayed log draws the
 * card the live session drew.
 * @param content - the logged result content.
 * @returns the job id, or undefined for every other result.
 */
export function movedJobId(content: readonly ContentBlock[]): string | undefined {
  const first = content[0]
  if (content.length !== 1 || first?.type !== 'text') return undefined
  return MOVED_PATTERN.exec(first.text)?.[1]
}

/**
 * The text of a tool result as a job result: text blocks as they are, and a
 * placeholder naming each other block, which a string result cannot carry.
 * @param content - the result content.
 * @returns the joined text.
 */
export function resultText(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : `[${block.type} omitted]`).join('\n')
}

/** One root call running in the foreground right now. */
export interface ForegroundCall {
  readonly callId: ToolCallId
  /** The tool the model called. */
  readonly name: string
  /** The Agent the call runs for. */
  readonly agent: Agent
}

/** One call {@link ToolBackgrounder.moveAll} handed to the registry. */
export interface MovedCall {
  readonly callId: ToolCallId
  readonly name: string
  /** The job that took the call over. */
  readonly id: JobId
}

/** What one {@link ToolBackgrounder.moveAll} did. */
export interface MoveReport {
  /** The calls now running as jobs, in dispatch order. */
  moved: MovedCall[]
  /** One line per call the registry refused, naming the tool and the reason. */
  refused: string[]
}

/** Everything the wrapper keeps about one tracked call. */
interface TrackedCall extends ForegroundCall {
  readonly arguments: unknown
  /** The caller's signal the registry fuses into the body. */
  readonly outer: AbortSignal
  /** Stops the body on the job's account: a `job_kill`, the user's stop, or owner teardown. */
  readonly stop: AbortController
  /** The body's normalized outcome; never rejects past {@link ToolBackgrounder.around}. */
  readonly body: Promise<ToolExecutionResult>
  /** Answer the call now with the moved result. */
  readonly answer: (result: ToolExecutionResult) => void
  /** The job that took the call over, once moved. */
  job?: JobId
  /** A job the body itself registered, such as a shell tool's own foreground process job. */
  inner?: JobId
}

/** What the backgrounder reads from its host. */
export interface ToolBackgrounderOptions {
  /** The composed job registry, read at each use; undefined leaves every call untracked. */
  jobs(): JobRegistry | undefined
  /** Called after the set of foreground calls changes. */
  changed(): void
}

/**
 * Tracks root tool calls and moves them to the job registry on request.
 * One instance serves one terminal application.
 */
export class ToolBackgrounder {
  /** Tracked calls whose body has not settled, in dispatch order. */
  private readonly calls = new Map<ToolCallId, TrackedCall>()
  /** Jobs a body registered for itself while it ran, for as long as the body runs. */
  private readonly innerJobs = new Set<JobId>()
  /** The job a moved call's body registered for itself, by the moved call's job. */
  private outputs = new Map<JobId, JobId>()

  constructor(private readonly options: ToolBackgrounderOptions) {}

  /**
   * The `tools/execute` listener body. A nested call, a call without an
   * Agent, and every call while no registry is composed pass straight
   * through. A tracked call returns the body's own outcome, or the moved
   * result as soon as {@link moveAll} hands it to the registry.
   * @param exec - the call about to dispatch.
   * @param next - the rest of the around-dispatch chain and the body.
   * @returns the call's outcome.
   */
  async around(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    const agent = exec.agent
    if (agent === undefined || exec.parent !== undefined || this.options.jobs() === undefined) return next()
    keepSignalWritable(exec)
    const outer = exec.signal
    const stop = new AbortController()
    exec.signal = AbortSignal.any([outer, stop.signal])
    const moved = Promise.withResolvers<ToolExecutionResult>()
    const settled = Promise.withResolvers<ToolExecutionResult>()
    const body = settled.promise
    const call: TrackedCall = {
      callId: exec.callId,
      name: exec.name,
      agent,
      arguments: exec.arguments,
      outer,
      stop,
      body,
      answer: moved.resolve,
    }
    // Tracked before the body starts: a body can register its own job before
    // its first await, and {@link observe} matches that job to this call.
    this.calls.set(call.callId, call)
    this.options.changed()
    void (async () => next())().then(settled.resolve, settled.reject)
    const restore = (): void => {
      exec.signal = outer
      this.calls.delete(call.callId)
      if (call.inner !== undefined) this.innerJobs.delete(call.inner)
      this.options.changed()
    }
    // A moved body outlives this listener, and the registry freezes the
    // execution once the moved result commits; the accessor installed above
    // keeps this restore, and the registry's own, legal after that.
    body.then(restore, restore)
    return Promise.race([body, moved.promise])
  }

  /**
   * The calls of one Agent still running in the foreground.
   * @param agent - the Agent whose calls to list.
   * @returns the calls in dispatch order.
   */
  running(agent: Agent): ForegroundCall[] {
    return this.foreground(agent)
  }

  /**
   * Move every foreground call of one Agent to the registry. A call the
   * registry refuses keeps running in the foreground.
   * @param jobs - the composed job registry.
   * @param agent - the Agent whose calls to move.
   * @param label - the one-line job label for a call.
   * @returns the moved calls and the refusals.
   */
  moveAll(jobs: JobRegistry, agent: Agent, label: (call: ForegroundCall) => string): MoveReport {
    const report: MoveReport = { moved: [], refused: [] }
    for (const call of this.foreground(agent)) {
      let id: JobId
      try {
        id = jobs.start({
          kind: 'tool',
          label: label(call),
          owner: agent.id,
          run: handle => ({
            cancel: (reason) => { call.stop.abort(reason) },
            done: call.body.then(
              result => this.outcome(call, handle, result),
              (error: unknown): JobOutcome => ({ status: 'failed', detail: describeFailure(error) }),
            ),
          }),
        })
      } catch (error: unknown) {
        report.refused.push(`${call.name}: ${describeFailure(error)}`)
        continue
      }
      call.job = id
      if (call.inner !== undefined) this.outputs.set(id, call.inner)
      const text = movedResultText(id)
      call.answer({ isError: true, error: { message: text }, content: [{ type: 'text', text }] })
      report.moved.push({ callId: call.callId, name: call.name, id })
    }
    if (report.moved.length > 0) this.options.changed()
    return report
  }

  /**
   * Keep the jobs of moved calls whose dispatching turn was just stopped from
   * waking their Agent: a live registry wait makes their settlement count as
   * delivered, so `dsh-tool-jobs` sends no completion notice. Call it right
   * after cancelling the Agent, before the bodies observe the abort.
   * @param jobs - the composed job registry.
   * @param agent - the Agent whose turn was stopped.
   * @returns how many moved calls stop with the turn.
   */
  holdStopped(jobs: JobRegistry, agent: Agent): number {
    let held = 0
    for (const call of this.calls.values()) {
      if (call.agent !== agent || call.job === undefined || !call.outer.aborted) continue
      held += 1
      void jobs.wait(call.job, HOLD_WAIT_MS, agent.id).catch(ignoreGone)
    }
    return held
  }

  /**
   * Follow one registry event. A job registered while a tracked body of the
   * same owner runs, of the body's own tool kind and with its command as the
   * label when it has one, is that body's own job, which is not background
   * work of its own. A removed job is no longer anyone's output.
   * @param event - the registry event.
   */
  observe(event: JobEvent): void {
    if (event.type === 'removed') {
      const removed = event.job.id
      this.outputs = new Map([...this.outputs].filter(([, inner]) => inner !== removed))
      return
    }
    if (event.type !== 'registered') return
    const { job } = event
    const call = [...this.calls.values()].find(candidate => candidate.inner === undefined
      && candidate.agent.id === job.owner
      && candidate.name === job.kind
      && (commandOf(candidate.arguments) ?? job.label) === job.label)
    if (call === undefined) return
    call.inner = job.id
    this.innerJobs.add(job.id)
    if (call.job !== undefined) this.outputs.set(call.job, job.id)
  }

  /**
   * Whether a job is a tracked body's own, which the terminal does not list
   * as background work while that body runs.
   * @param id - the job to test.
   * @returns true while the body that registered it runs.
   */
  isInner(id: JobId): boolean {
    return this.innerJobs.has(id)
  }

  /**
   * The job whose output ring shows a job's live output: the job its moved
   * body registered for itself while that job is still registered, else the
   * job itself.
   * @param id - the job the user opened.
   * @returns the job to read output from.
   */
  outputOf(id: JobId): JobId {
    return this.outputs.get(id) ?? id
  }

  /**
   * The tracked calls of one Agent not yet moved.
   * @param agent - the Agent whose calls to list.
   * @returns the calls in dispatch order.
   */
  private foreground(agent: Agent): TrackedCall[] {
    return [...this.calls.values()].filter(call => call.agent === agent && call.job === undefined)
  }

  /**
   * The terminal outcome of a moved call. The result text also goes on the
   * ring's `log` channel, which observers read and the model's own read skips.
   * @param call - the moved call.
   * @param handle - the job's producer face.
   * @param result - the body's normalized outcome.
   * @returns the job outcome.
   */
  private outcome(call: TrackedCall, handle: JobHandle, result: ToolExecutionResult): JobOutcome {
    const text = resultText(result.content)
    if (text !== '') handle.append(text, { channel: 'log' })
    if (!result.isError) return { status: 'completed', ...text === '' ? {} : { result: text } }
    if (call.stop.signal.aborted) return { status: 'killed' }
    if (call.outer.aborted) return { status: 'killed', detail: STOPPED_WITH_TURN }
    return { status: 'failed', detail: result.error.message.replace(/\n[\s\S]*$/u, ''), result: text }
  }
}

/**
 * Replace the execution's `signal` data property with an accessor pair over
 * the same value. The registry freezes the execution when the call's result
 * commits, which makes a data property read-only; a moved body is still
 * running then, and both this wrapper and the registry restore the signal
 * when it settles. An accessor keeps those writes legal after the freeze.
 * @param exec - the call about to dispatch.
 */
function keepSignalWritable(exec: ToolDispatchExecution): void {
  let current = exec.signal
  Object.defineProperty(exec, 'signal', {
    get: () => current,
    set: (signal: AbortSignal) => { current = signal },
    enumerable: true,
  })
}

/**
 * The `command` argument of a shell-style call.
 * @param args - the call's parsed arguments.
 * @returns the command, or undefined when the arguments carry none.
 */
function commandOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || !('command' in args)) return undefined
  return typeof args.command === 'string' ? args.command : undefined
}

/**
 * Drop the rejection of a hold's registry wait. A wait on a live job its
 * owner holds rejects only once the job left the registry, and then nothing
 * is left to hold.
 * @param _gone - the rejection.
 */
/* v8 ignore next -- a live owned job settles before it can leave the registry */
function ignoreGone(_gone: unknown): void {}
