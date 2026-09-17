/**
 * Host owner of the `authorization` Remote namespace: the authorization seam
 * (`ctx.authorization`) as a browser configuration surface drives it. A
 * surface lists the registered flows with their stored-record state, starts
 * one attempt as a stream that carries the flow's notices and prompts to the
 * page, answers or declines a prompt with a second call, withdraws an attempt,
 * and signs out by deleting the stored record.
 *
 * The seam owns the conversation and the one-attempt-per-key lifecycle; this
 * package owns only the wire obligations around it — request validation, the
 * frame vocabulary, the pending-prompt table, and the refusal mapping. Prompt
 * answers cross the wire in one direction only: no method here returns one.
 *
 * @module @deepseek-ai/dsh-api-authorization-controller
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { AuthorizationPrompt, AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { AuthorizationDeclinedError, AuthorizationError } from '@deepseek-ai/dsh-authorization'
import { credentialKeyId, credentialKeyScope, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type {
  AuthorizationBeginRequest, AuthorizationFlowView, AuthorizationFrame, AuthorizationPromptFrame,
} from './types.ts'

export type * from './types.ts'

const keySchema = z.string().min(1)
const beginRequestSchema = z.object({ key: keySchema, method: z.string().min(1).optional() })
const promptRequestSchema = z.object({ key: keySchema, promptId: z.string().min(1) })
const answerRequestSchema = promptRequestSchema.extend({ value: z.string() })

/** Parse the domain constraints that are more specific than generated TypeScript codecs. */
function parseRequest<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
  }
  return parsed.data
}

/**
 * Brand one wire key, reporting a string outside the `<scope>/<id>` grammar as
 * a malformed request rather than as a seam refusal.
 * @param method - the endpoint, for the diagnostic.
 * @param key - the joined key as the wire carried it.
 * @returns the branded key.
 */
function keyOf(method: string, key: string): CredentialKey {
  try {
    return parseCredentialKey(key)
  } catch (error: unknown) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}: ${messageOf(error)}`, {}, { cause: error })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Classify one seam or flow refusal. The seam's own codes (`NO_FLOW`,
 * `UNKNOWN_METHOD`, `ALREADY_IN_FLIGHT`, `NOT_COMMITTED`) ride as `reason`; a
 * flow failure with no code carries only its message.
 * @param key - the key the operation addressed.
 * @param error - whatever the seam or the store threw.
 * @returns the failure to raise for that refusal.
 */
function rejected(key: string, error: unknown): RemoteError {
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  return new RemoteError(
    'authorization/rejected',
    messageOf(error),
    { key, ...typeof code === 'string' ? { reason: code } : {} },
    { cause: error },
  )
}

/**
 * Run one synchronous second-call operation as a promise, so a refusal reaches
 * the caller as a rejection rather than as a throw out of a method whose
 * declared return type is a promise.
 * @param run - the operation to perform.
 * @returns once it completed, or rejected with whatever it threw.
 */
function settled(run: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    run()
    resolve()
  })
}

/**
 * One prompt the flow is waiting on: the answer path and the decline path,
 * both of which also retire the entry.
 */
interface PendingPrompt {
  answer(value: string): void
  decline(): void
  withdraw(): void
}

/**
 * The items one attempt streams, in order, with a single consumer. The seam
 * pushes from callbacks while the Remote carrier pulls; `end()` and `fail()`
 * settle the stream after everything already queued has been read.
 */
class FrameQueue implements AsyncIterable<AuthorizationFrame> {
  private readonly items: AuthorizationFrame[] = []
  private waiter: (() => void) | undefined
  private done = false
  private failure: Error | undefined

  push(frame: AuthorizationFrame): void {
    this.items.push(frame)
    this.wake()
  }

  end(): void {
    this.done = true
    this.wake()
  }

  fail(error: Error): void {
    this.failure = error
    this.done = true
    this.wake()
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AuthorizationFrame> {
    while (true) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.done) {
        if (this.failure !== undefined) throw this.failure
        return
      }
      await new Promise<void>((resolve) => { this.waiter = resolve })
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationController: AuthorizationController
  }
}

/**
 * Host service backing the generated `ctx.remote.authorization` namespace.
 *
 * A running attempt is one stream: the surface opens `begin()`, reads the
 * flow's notices and prompts as frames, answers a prompt through `answer()`
 * or `decline()` naming the frame's `promptId`, and reads the settlement as
 * the last frame. Closing the stream withdraws the attempt; `cancel()` does
 * the same from a second call, for a surface that no longer holds the
 * stream. One attempt per key at a time is the seam's rule, so the pending
 * prompts of one key belong to exactly one stream.
 */
export class AuthorizationController extends TypertRemoteService {
  /** Prompts awaiting an answer, by the key of the attempt that asked them. */
  private readonly pending = new Map<CredentialKey, Map<string, PendingPrompt>>()

  /** @param ctx - Host context where the authorization seam and a credential provider may be mounted. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
  }

  /**
   * Every registered flow with its stored-record state, for a surface listing
   * what can be signed into. A composition without the authorization seam
   * offers nothing to sign into, so the list is empty rather than an error.
   * @returns one view per flow, in registration order.
   * @throws RemoteError when the seam is mounted but no credential provider is.
   */
  @Remote
  async list(): Promise<AuthorizationFlowView[]> {
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined) return []
    const credentials = this.provider()
    return Promise.all(authorization.list().map(async (entry): Promise<AuthorizationFlowView> => {
      const record = await credentials.describeRecord(entry.key)
      return {
        key: entry.key,
        scope: credentialKeyScope(entry.key),
        id: credentialKeyId(entry.key),
        label: entry.label,
        methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
        inFlight: entry.inFlight,
        configured: record.configured,
        ...record.kind === undefined ? {} : { kind: record.kind },
      }
    }))
  }

  /**
   * Run one attempt and stream what the flow says. The stream ends with a
   * `settled` frame, or fails with `authorization/rejected` when the seam
   * refuses the request or the flow fails. Aborting `signal` — closing the
   * stream — withdraws the attempt.
   *
   * The attempt starts when the carrier pulls the first frame, not when this
   * method returns: a stream nobody consumes must not hold the key for the
   * life of the process.
   * @param request - the key to authorize and, optionally, the method.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns the attempt's frames, in order.
   */
  @Remote({ mode: 'stream' })
  begin(request: AuthorizationBeginRequest, signal: AbortSignal): AsyncIterable<AuthorizationFrame> {
    return this.attempt(request, signal)
  }

  /**
   * Answer one prompt of the running attempt. The value crosses the wire in
   * this direction only: no read path returns it.
   * @param key - the key of the attempt that asked.
   * @param promptId - the prompt frame's id.
   * @param value - what the human typed, or the chosen option's id.
   * @throws RemoteError `authorization/no-prompt` when nothing with that id is waiting.
   */
  @Remote
  answer(key: string, promptId: string, value: string): Promise<void> {
    return settled(() => {
      const parsed = parseRequest('authorization.answer', answerRequestSchema, { key, promptId, value })
      this.waiting('authorization.answer', parsed).answer(parsed.value)
      // The flow resumes on its own microtask; the attempt's stream is what
      // reports what came of the answer.
    })
  }

  /**
   * Decline one prompt of the running attempt; the attempt settles `cancelled`.
   * @param key - the key of the attempt that asked.
   * @param promptId - the prompt frame's id.
   * @throws RemoteError `authorization/no-prompt` when nothing with that id is waiting.
   */
  @Remote
  decline(key: string, promptId: string): Promise<void> {
    return settled(() => {
      const parsed = parseRequest('authorization.decline', promptRequestSchema, { key, promptId })
      this.waiting('authorization.decline', parsed).decline()
    })
  }

  /**
   * Withdraw the attempt running for a key, if any, from a call that does not
   * hold the attempt's stream.
   * @param key - the key whose attempt should stop.
   */
  @Remote
  cancel(key: string): Promise<void> {
    return settled(() => {
      const parsed = parseRequest('authorization.cancel', keySchema, key)
      this.seam().cancel(keyOf('authorization.cancel', parsed))
    })
  }

  /**
   * Forget the stored credential record for a key. Removing an absent record
   * is a no-op; the issuer is not told.
   * @param key - the record to delete.
   * @throws RemoteError `authorization/rejected` when the store refuses the delete.
   */
  @Remote
  async signOut(key: string): Promise<void> {
    const parsed = parseRequest('authorization.signOut', keySchema, key)
    const branded = keyOf('authorization.signOut', parsed)
    const credentials = this.provider()
    try {
      await credentials.deleteRecord(branded)
    } catch (error: unknown) {
      throw rejected(parsed, error)
    }
  }

  /**
   * Stream one attempt: the seam's outcome becomes the last frame, and every
   * refusal — a malformed request, an absent seam, a seam or flow failure —
   * fails the stream, so a surface reads one failure path instead of two.
   */
  private async *attempt(
    request: AuthorizationBeginRequest,
    signal: AbortSignal,
  ): AsyncGenerator<AuthorizationFrame> {
    const parsed = parseRequest('authorization.begin', beginRequestSchema, request)
    const key = keyOf('authorization.begin', parsed.key)
    const method = parsed.method
    const authorization = this.seam()
    const queue = new FrameQueue()
    const prompts = new Map<string, PendingPrompt>()
    this.pending.set(key, prompts)
    authorization.begin({
      key,
      ...method === undefined ? {} : { method },
      signal,
      interaction: {
        notify: (notice) => {
          queue.push({
            type: 'notice',
            message: notice.message,
            ...notice.url === undefined ? {} : { url: notice.url },
            ...notice.openInBrowser === undefined ? {} : { openInBrowser: notice.openInBrowser },
            ...notice.code === undefined ? {} : { code: notice.code },
          })
        },
        prompt: prompt => this.ask(prompts, prompt, queue),
      },
    }).then(
      (outcome) => {
        queue.push({ type: 'settled', status: outcome.status })
        queue.end()
      },
      (error: unknown) => { queue.fail(rejected(key, error)) },
    )
    try {
      yield* queue
    } finally {
      // The stream is the attempt's surface: once it closes, nothing can
      // answer, so every question still open is withdrawn and the flow's
      // await settles instead of holding the key.
      for (const prompt of [...prompts.values()]) prompt.withdraw()
      if (this.pending.get(key) === prompts) this.pending.delete(key)
    }
  }

  /**
   * Put one of the flow's questions to the surface and wait for a second call
   * to answer it. The flow's own `signal` withdraws the question alone — the
   * losing side of a race against a browser callback — and the attempt goes
   * on; that rejection is deliberately not a decline, so the seam does not
   * misread it as the human saying no.
   */
  private ask(prompts: Map<string, PendingPrompt>, prompt: AuthorizationPrompt, queue: FrameQueue): Promise<string> {
    const promptId = randomUUID()
    const frame: AuthorizationPromptFrame = {
      type: 'prompt',
      promptId,
      kind: prompt.kind,
      message: prompt.message,
      ...prompt.kind !== 'select' && prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {},
      ...prompt.kind === 'select'
        ? {
          options: prompt.options.map(option => ({
            id: option.id,
            label: option.label,
            ...option.description === undefined ? {} : { description: option.description },
          })),
        }
        : {},
    }
    return new Promise<string>((resolve, reject) => {
      const retire = (): void => {
        prompts.delete(promptId)
        prompt.signal?.removeEventListener('abort', withdraw)
      }
      const withdraw = (): void => {
        retire()
        queue.push({ type: 'prompt-withdrawn', promptId })
        reject(new AuthorizationError(`prompt "${promptId}" was withdrawn before it was answered`, 'PROMPT_WITHDRAWN'))
      }
      if (prompt.signal?.aborted === true) {
        withdraw()
        return
      }
      prompts.set(promptId, {
        answer: (value) => {
          retire()
          resolve(value)
        },
        decline: () => {
          retire()
          reject(new AuthorizationDeclinedError())
        },
        withdraw,
      })
      prompt.signal?.addEventListener('abort', withdraw, { once: true })
      queue.push(frame)
    })
  }

  /** The prompt a second call names, or the refusal that nothing waits under that id. */
  private waiting(method: string, request: { key: string; promptId: string }): PendingPrompt {
    const key = keyOf(method, request.key)
    const prompt = this.pending.get(key)?.get(request.promptId)
    if (prompt === undefined) {
      throw new RemoteError(
        'authorization/no-prompt',
        `no prompt "${request.promptId}" is waiting for "${request.key}"`,
        { key: request.key, promptId: request.promptId },
      )
    }
    return prompt
  }

  /** Resolve the optional seam or report how to supply it. */
  private seam(): AuthorizationService {
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'authorization service is absent: this deployment does not mount @deepseek-ai/dsh-authorization in its composition',
        {},
      )
    }
    return authorization
  }

  /** Resolve the optional credential provider or report how to supply it. */
  private provider(): CredentialProvider {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
        {},
      )
    }
    return credentials
  }
}

export default AuthorizationController
