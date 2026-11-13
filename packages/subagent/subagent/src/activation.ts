/** Execution-period records, capacity slots, child serialization, and local output capture.
 * @module @deepseek-ai/dsh-subagent/activation
 */

import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { finalAssistantOutput } from './assistant-output.ts'
import { epochStopReason } from './lifecycle.ts'
import { childFailureDiagnostic, type ChildFailureRoute } from './local-failure.ts'
import { SubagentError } from './error.ts'
import type { StructuredAttachment } from './structured.ts'
import type { SubagentResult, SubagentRun, SubagentRunId } from './types.ts'

/** Process-local capacity shared by every member of a subagent tree. */
export class ActivationPool {
  private readonly slots = new Set<symbol>()

  /**
   * Reserve before reconstruction; release also tolerates unpublished rollback.
   * @param capacity - the maximum simultaneous activations in this pool.
   * @returns an idempotent slot release.
   */
  reserve(capacity: number): () => void {
    if (this.slots.size >= capacity) {
      throw new SubagentError(
        `subagent limit reached (active child limit: ${capacity}); wait for an existing child to finish `
        + 'or complete this work with the current agents',
        'ACTIVATION_LIMIT_REACHED',
      )
    }
    const slot = Symbol()
    this.slots.add(slot)
    return () => { this.slots.delete(slot) }
  }
}

/**
 * One residency epoch for a local child or an external execution.
 * The manager owns admission, execution handles, and resource release.
 */
interface ActivationBase {
  /** Return this epoch's slot after its handle has finished disposal. */
  readonly releaseSlot: () => void
  /** The durable child this Activation is an epoch of. */
  readonly childId: SessionId
  /** Unique identity shared by this residency epoch's start/end event pair. */
  readonly runId: SubagentRunId
  /** Provider recorded at creation, retained across cold resumes. */
  readonly provider: string
  /** Exact live subagent tree root owning this instance and its shared capacity. */
  readonly root: Agent
  /** Verified creation ancestors, from subagent tree root to direct creator. */
  readonly ancestors: readonly SessionId[]
  /** Slash-separated names from the root; undefined when this child or a creator below the root has no name. */
  readonly path: string | undefined
  readonly delivery: 'parent' | 'caller'
  readonly result: PromiseWithResolvers<SubagentResult>
  /** Published synchronously before teardown; subsequent callers share this transaction. */
  closing: Promise<void> | undefined
  /**
   * Whether local input was accepted or external startup completed, including
   * any required catalog publication. Until then, teardown owes the parent no
   * settlement notice, even if this epoch's start event was already published.
   */
  accepted: boolean
}

/** Resources retained only for the selected execution kind. */
export type ActivationResource =
  | {
    readonly kind: 'local'
    readonly handle: AgentHandle
    readonly outputStart: SessionLogOffset
    readonly structured: StructuredAttachment | undefined
    /** Latest live failure not superseded by a later committed turn ending. */
    failureAt: SessionLogOffset | undefined
    /**
     * Own message and code of {@link failureAt}. Cleared with that offset when
     * a later committed turn ending supersedes the live failure.
     */
    failure: { readonly code: string; readonly message: string } | undefined
    /** Renewed when local settlement must recheck input. */
    poke: PromiseWithResolvers<void>
    /**
     * Whether this child's settlement notice omits its closing text: true while
     * the child's last logged tool call was a message to its direct parent and
     * no input was claimed since.
     */
    omitClosingText: boolean
  }
  | {
    readonly kind: 'external'
    readonly run: SubagentRun
    readonly controller: AbortController
  }

/** One managed execution period with its provider-specific resources. */
export type Activation = ActivationBase & ActivationResource

/** Local residency with input admission and Session-backed result capture. */
export type LocalActivation = Extract<Activation, { kind: 'local' }>

/**
 * Read the live Agent retained by local execution.
 * @param activation - the managed local or external execution.
 * @returns the local Agent, absent for an external run.
 */
export function activationAgent(activation: Activation): Agent | undefined {
  return activation.kind === 'local' ? activation.handle.agent : undefined
}

/**
 * Require local residency before accepting further input.
 * @param activation - execution targeted by message delivery.
 * @returns the local activation.
 * @throws when the external backend cannot accept another message.
 */
export function requireLocalActivation(activation: Activation): LocalActivation {
  switch (activation.kind) {
    case 'local': return activation
    case 'external':
      throw new SubagentError(`subagent "${activation.childId}" does not accept follow-up input`, 'NOT_CONTINUABLE')
    /* v8 ignore next 2 -- Both execution kinds are handled above. */
    default: return assertNever(activation)
  }
}

/** Own message and code of one live error, without its cause chain. */
function failureFacts(error: unknown): { code: string; message: string } {
  if (error instanceof HarnessError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'UNKNOWN', message: error.message }
  return { code: 'UNKNOWN', message: 'unknown failure' }
}

/**
 * Retain local failures whose turn ending could not be committed.
 * @param activation - exact local Agent and epoch receiving the scoped observers.
 * @param wake - notify its settlement watcher when failure changes readiness.
 */
export function observeLocalFailure(activation: LocalActivation, wake: () => void): void {
  const child = activation.handle.agent
  child.ctx.on('agent/error', ({ agent, error }) => {
    if (agent !== child) return
    activation.failureAt = child.session.seq
    activation.failure = failureFacts(error)
    wake()
  })
  child.ctx.on('session/event', (session, event) => {
    if (session === child.session && event.type === 'turn/end'
      && activation.failureAt !== undefined && event.seq >= activation.failureAt) {
      activation.failureAt = undefined
      activation.failure = undefined
    }
  })
}

/** Last request route in the epoch, else the child's current selection. */
function failureRoute(events: readonly SessionEvent[], agent: Agent): ChildFailureRoute | undefined {
  let route: ChildFailureRoute | undefined
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const { provider, model } = event.data.header.config
    route = { provider, model }
  }
  if (route !== undefined) return route
  const current = agent.model.current()
  return current === undefined ? undefined : { provider: current.provider, model: current.model }
}

/**
 * Failure facts of the accounting turn. An error epoch's turn carries an
 * `error` reason; an extension variant has only its kind.
 */
function committedFailure(events: readonly SessionEvent[]): { code: string; message: string } {
  const reason = foldConsumedWork(events).end?.data.reason
  switch (reason?.kind) {
    case 'error':
      return { code: reason.error.code, message: reason.error.message }
    /* v8 ignore next 3 -- error epochs reach this only for an extension variant or a missing accounting turn */
    default:
      return { code: 'UNKNOWN', message: `the turn ended with reason "${reason?.kind ?? 'unrecorded'}"` }
  }
}

/**
 * Capture local output and retain failures without a later committed turn ending.
 * @param activation - the settled local execution and any structured result.
 * @returns final output, stop reason, and committed structured value.
 */
export function captureLocalResult(activation: LocalActivation): SubagentResult {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const events = activation.handle.agent.session.snapshotEvents(activation.outputStart)
  const output = finalAssistantOutput(events) ?? []
  const pending = activation.failureAt !== undefined
  const stopReason = pending ? 'error' : epochStopReason(events)
  const structured = activation.structured
  const withDiagnostic = (result: SubagentResult): SubagentResult => {
    if (result.stopReason !== 'error') return result
    const facts = activation.failure ?? committedFailure(events)
    return {
      ...result,
      diagnostic: childFailureDiagnostic(
        failureRoute(events, activation.handle.agent),
        facts.code,
        facts.message,
      ),
    }
  }
  if (structured !== undefined) {
    const captured = structured.captured()
    if (captured !== undefined) return withDiagnostic({ output, stopReason, structured: captured.value })
    if (stopReason === 'completed') {
      return {
        output,
        stopReason: 'error',
        diagnostic: childFailureDiagnostic(
          failureRoute(events, activation.handle.agent),
          'STRUCTURED_OUTPUT_MISSING',
          'the child finished without recording structured output.',
        ),
      }
    }
  }
  return withDiagnostic({ output, stopReason })
}

/** Serialize each durable child's delivery, release, and disposal. */
export class ChildLock {
  private tails = new Map<SessionId, Promise<unknown>>()

  /**
   * Run `operation` after every previously queued operation for `childId`.
   * @param childId - the durable child whose operations are linearized.
   * @param operation - the critical section to run in order.
   * @returns the operation's own settlement.
   */
  run<T>(childId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(childId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    // Absorb rejections in the chaining tail so one failed critical section
    // cannot reject an unrelated later caller.
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(childId, tail)
    void tail.then(() => {
      if (this.tails.get(childId) === tail) this.tails.delete(childId)
    })
    return result
  }
}
