/**
 * Sign-in state for the Models page: the flow directory joined by provider
 * route, and the one attempt this browser is running. The Host stays the
 * single fact source — the directory is re-read after every settlement, and
 * the running attempt is exactly what the `authorization/begin` stream says.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  AuthorizationFlowView, AuthorizationFrame, AuthorizationMethod, AuthorizationPromptFrame,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * The record scope of the pi-ai adapter family, which is the scope whose
 * record ids are provider route keys. A flow from another scope addresses
 * something other than a provider, so the Models page does not claim it.
 */
const PROVIDER_SCOPE = 'llm-pi-ai'

/** What the human is being asked right now, if anything. */
export interface SignInQuestion {
  /** Attempt-unique id the answer names. */
  readonly promptId: string
  readonly kind: 'text' | 'secret' | 'select'
  readonly message: string
  readonly placeholder?: string
  readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[]
}

/** The page the human must open, and any code to type there. */
export interface SignInDirection {
  readonly message: string
  readonly url?: string
  /** Whether a desktop surface may hand the page to its default browser. */
  readonly openInBrowser?: true
  readonly code?: string
}

/** How the attempt ended, for the line the card shows afterwards. */
export type SignInOutcome =
  | { readonly kind: 'authorized' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string }

/** One running or just-finished sign-in attempt. */
export interface SignInAttempt {
  /** The credential record being authorized. */
  readonly key: string
  /** The provider route the record belongs to, for the card that shows it. */
  readonly provider: string
  /** The flow's label, for the dialog title. */
  readonly label: string
  /** Whether the stream is still open. */
  readonly running: boolean
  /** Everything the flow has said so far, oldest first. */
  readonly directions: readonly SignInDirection[]
  /** The question awaiting an answer, if any. */
  readonly question: SignInQuestion | undefined
  /** Whether an answer is in flight, so the dialog can hold its controls. */
  readonly answering: boolean
  /** How it ended; absent while it runs. */
  readonly outcome: SignInOutcome | undefined
}

/** Sign-in snapshot the Models cards and the dialog render from. */
export interface SignInState {
  /** Whether the flow directory has been read at least once. */
  loaded: boolean
  /** Every flow this scope owns, by provider route key. */
  flows: ReadonlyMap<string, AuthorizationFlowView>
  /** The attempt this browser started, if any. */
  attempt: SignInAttempt | undefined
}

/** The Host operations the sign-in surface invokes. */
export interface SignInOperations {
  /**
   * Read every registered flow.
   * @returns the flows, or undefined when the read was refused.
   */
  list(): Promise<readonly AuthorizationFlowView[] | undefined>
  /**
   * Run one attempt.
   * @param key - the credential record to authorize.
   * @param method - which of the flow's methods to run.
   * @param signal - withdraws the attempt when the surface closes it.
   * @returns the attempt's frames, in order.
   */
  begin(key: string, method: string | undefined, signal: AbortSignal): AsyncIterable<AuthorizationFrame>
  /**
   * Answer one prompt.
   * @param key - the key of the attempt that asked.
   * @param promptId - the prompt's id.
   * @param value - what the human typed, or the chosen option's id.
   * @returns the refusal message, or undefined once accepted.
   */
  answer(key: string, promptId: string, value: string): Promise<string | undefined>
  /**
   * Decline one prompt, which cancels the attempt.
   * @param key - the key of the attempt that asked.
   * @param promptId - the prompt's id.
   * @returns the refusal message, or undefined once accepted.
   */
  decline(key: string, promptId: string): Promise<string | undefined>
  /**
   * Forget the stored credential record.
   * @param key - the record to delete.
   * @returns the refusal message, or undefined once removed.
   */
  signOut(key: string): Promise<string | undefined>
}

/**
 * Bind the sign-in operations to the plugin's own Remote namespace.
 * @param ctx - the plugin context, which declares `remote.authorization` in its `inject`.
 * @returns the callbacks the controller is built with.
 */
export function createSignInOperations(ctx: ClientContext): SignInOperations {
  return {
    list: async () => {
      const response = await ctx.remote.authorization.list()
      return response.ok ? response.value : undefined
    },
    begin: (key, method, signal) =>
      ctx.remote.authorization.begin({ key, ...method === undefined ? {} : { method } }, signal),
    answer: async (key, promptId, value) => {
      const response = await ctx.remote.authorization.answer(key, promptId, value)
      return response.ok ? undefined : response.error.message
    },
    decline: async (key, promptId) => {
      const response = await ctx.remote.authorization.decline(key, promptId)
      return response.ok ? undefined : response.error.message
    },
    signOut: async (key) => {
      const response = await ctx.remote.authorization.signOut(key)
      return response.ok ? undefined : response.error.message
    },
  }
}

/**
 * The provider route one flow authorizes.
 * @param flow - one registered flow as the Host reports it.
 * @returns the provider route key, or undefined when the flow authorizes something that is not a provider.
 */
export function providerOf(flow: AuthorizationFlowView): string | undefined {
  return flow.scope === PROVIDER_SCOPE ? flow.id : undefined
}

/**
 * Whether one method signs in with a provider subscription rather than by
 * collecting a key. This is what the Models card offers: a key already has the
 * card's own field, and a second path storing the same secret as a record
 * instead of a reference would leave two answers to "where is my key".
 *
 * The seam's method ids are flow-owned. `api-key` is the id a key-collecting
 * login registers under, so every other id is read as a subscription sign-in:
 * a provider adding a second subscription method appears here without this
 * predicate learning its name, while a second key path never does.
 * @param method - one method the flow offers.
 * @returns whether the card should offer it.
 */
export function isSubscriptionMethod(method: AuthorizationMethod): boolean {
  return method.id !== 'api-key'
}

/** The sign-in controller (one per Models surface). */
export class SignInController {
  /** The snapshot the cards and the dialog render from. */
  readonly store: SnapshotStore<SignInState> = createSnapshotStore<SignInState>({
    loaded: false,
    flows: new Map(),
    attempt: undefined,
  })

  /** Latest read wins; an older directory never overwrites a newer one. */
  private generation = 0
  /** Withdraws the running attempt; closing it is what cancels the Host side. */
  private running: AbortController | undefined

  /** @param operations - the Host operations this controller drives. */
  constructor(private readonly operations: SignInOperations) {}

  /**
   * Re-read the flow directory. A refused read keeps the last good flows, so a
   * transient failure never empties the sign-in controls mid-attempt.
   * @returns once the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    const flows = await this.operations.list()
    if (generation !== this.generation || flows === undefined) return
    const byProvider = new Map<string, AuthorizationFlowView>()
    for (const flow of flows) {
      const provider = providerOf(flow)
      if (provider !== undefined) byProvider.set(provider, flow)
    }
    this.store.update((state) => {
      state.loaded = true
      state.flows = byProvider
    })
  }

  /**
   * Start one attempt and follow it to its end. One attempt at a time in this
   * browser: a second start withdraws the first, which is what the seam would
   * refuse anyway.
   * @param flow - the flow to run.
   * @param provider - the provider route it authorizes.
   * @param method - which method to run; the flow's first when absent.
   * @returns once the attempt has settled and the directory has been re-read.
   */
  async begin(flow: AuthorizationFlowView, provider: string, method?: string): Promise<void> {
    this.close()
    const controller = new AbortController()
    this.running = controller
    this.store.update((state) => {
      state.attempt = {
        key: flow.key,
        provider,
        label: flow.label,
        running: true,
        directions: [],
        question: undefined,
        answering: false,
        outcome: undefined,
      }
    })
    try {
      for await (const frame of this.operations.begin(flow.key, method, controller.signal)) {
        if (this.running !== controller) return
        this.accept(frame)
      }
      // A stream that ends without a settlement frame is a Host that went away
      // mid-attempt; the human is told it stopped rather than left watching a
      // spinner.
      this.settle(controller, { kind: 'cancelled' })
    } catch (error: unknown) {
      this.settle(controller, { kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (this.running === controller) this.running = undefined
      await this.load()
    }
  }

  /**
   * Answer the question the attempt is waiting on.
   * @param value - what the human typed, or the chosen option's id.
   * @returns once the answer has been accepted or its refusal recorded.
   */
  async answer(value: string): Promise<void> {
    const attempt = this.store.getSnapshot().attempt
    const question = attempt?.question
    if (attempt === undefined || question === undefined || attempt.answering) return
    this.store.update((state) => {
      /* v8 ignore next -- nothing awaits between reading the snapshot above
         and this write, so the attempt cannot have been withdrawn in between. */
      if (state.attempt !== undefined) state.attempt = { ...state.attempt, answering: true }
    })
    const failure = await this.operations.answer(attempt.key, question.promptId, value)
    this.store.update((state) => {
      if (state.attempt === undefined) return
      state.attempt = {
        ...state.attempt,
        answering: false,
        // The Host refuses an answer only when the question is no longer
        // waiting, so the question goes with the refusal rather than staying
        // on screen unanswerable.
        ...failure === undefined ? {} : { question: undefined },
      }
    })
  }

  /**
   * Decline the question the attempt is waiting on, which cancels the attempt.
   * @returns once the decline has reached the Host.
   */
  async decline(): Promise<void> {
    const attempt = this.store.getSnapshot().attempt
    const question = attempt?.question
    if (attempt === undefined || question === undefined) return
    await this.operations.decline(attempt.key, question.promptId)
  }

  /**
   * Withdraw the running attempt, or dismiss a settled one.
   * @returns nothing; the snapshot carries the dismissal.
   */
  close(): void {
    this.running?.abort()
    this.running = undefined
    this.store.update((state) => { state.attempt = undefined })
  }

  /**
   * Forget one provider's stored credential.
   * @param flow - the flow whose record to delete.
   * @returns the refusal message, or undefined once removed.
   */
  async signOut(flow: AuthorizationFlowView): Promise<string | undefined> {
    const failure = await this.operations.signOut(flow.key)
    await this.load()
    return failure
  }

  /** Withdraw whatever is running; the surface is going away. */
  dispose(): void {
    this.running?.abort()
    this.running = undefined
  }

  /** Fold one frame into the running attempt. */
  private accept(frame: AuthorizationFrame): void {
    this.store.update((state) => {
      const attempt = state.attempt
      /* v8 ignore next -- only close() clears the attempt, and it clears
         `running` with it, so the caller's own check returns first. */
      if (attempt === undefined) return
      switch (frame.type) {
        case 'notice':
          state.attempt = {
            ...attempt,
            directions: [...attempt.directions, {
              message: frame.message,
              ...frame.url === undefined ? {} : { url: frame.url },
              ...frame.openInBrowser === undefined ? {} : { openInBrowser: frame.openInBrowser },
              ...frame.code === undefined ? {} : { code: frame.code },
            }],
          }
          return
        case 'prompt':
          state.attempt = { ...attempt, question: questionOf(frame), answering: false }
          return
        case 'prompt-withdrawn':
          if (attempt.question?.promptId !== frame.promptId) return
          state.attempt = { ...attempt, question: undefined, answering: false }
          return
        default:
          state.attempt = {
            ...attempt,
            running: false,
            question: undefined,
            answering: false,
            outcome: { kind: frame.status === 'authorized' ? 'authorized' : 'cancelled' },
          }
      }
    })
  }

  /** Record how an attempt ended, unless a newer one already replaced it. */
  private settle(controller: AbortController, outcome: SignInOutcome): void {
    if (this.running !== controller) return
    this.store.update((state) => {
      if (state.attempt === undefined || state.attempt.outcome !== undefined) return
      state.attempt = { ...state.attempt, running: false, question: undefined, answering: false, outcome }
    })
  }
}

/** The question one prompt frame asks. */
function questionOf(frame: AuthorizationPromptFrame): SignInQuestion {
  return {
    promptId: frame.promptId,
    kind: frame.kind,
    message: frame.message,
    ...frame.placeholder === undefined ? {} : { placeholder: frame.placeholder },
    ...frame.options === undefined ? {} : { options: frame.options.map(option => ({ ...option })) },
  }
}
