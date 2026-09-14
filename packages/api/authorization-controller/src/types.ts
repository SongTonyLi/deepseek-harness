/**
 * Browser-safe vocabulary of the `authorization` Remote namespace: the flow
 * view a configuration surface lists, the request that starts one attempt,
 * the frames a running attempt streams to the surface, and the failure codes
 * the namespace raises. Types only — no runtime code, and nothing here reaches
 * a Host-only symbol, so a Client compilation face reads exactly the
 * declarations the Host emits.
 *
 * @module @deepseek-ai/dsh-api-authorization-controller/types
 */

import type { AuthorizationMethod, AuthorizationPromptOption, AuthorizationStatus } from '@deepseek-ai/dsh-authorization/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * The authorization seam or the flow refused the operation: no flow claims
     * the key, the method is not offered, an attempt is already running, the
     * flow failed or resolved without committing, or the store refused a
     * sign-out. `reason` carries the seam's own code when it had one. The
     * details name only the key, never a prompt answer.
     */
    'authorization/rejected': { readonly key: string; readonly reason?: string }
    /**
     * No prompt with that id is waiting for the key: it was never asked, it
     * was already answered or declined, or its flow withdrew it.
     */
    'authorization/no-prompt': { readonly key: string; readonly promptId: string }
  }
}

/**
 * One registered authorization flow as a configuration surface sees it: what
 * it authorizes, how, whether an attempt is running, and whether a credential
 * record is currently stored for it.
 */
export interface AuthorizationFlowView {
  /** The credential record the flow writes, in its joined `<scope>/<id>` form. */
  readonly key: string
  /** The owning plugin's registered name — the `<scope>` half of {@link key}. */
  readonly scope: string
  /** The owning plugin's own addressing unit — the `<id>` half of {@link key}; an LLM adapter uses its provider route. */
  readonly id: string
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** The sign-in methods the flow offers, most preferred first. */
  readonly methods: readonly AuthorizationMethod[]
  /** Whether an attempt for this key is running right now, on any surface. */
  readonly inFlight: boolean
  /** Whether a credential record is stored for this key — signed in, as far as the store can tell. */
  readonly configured: boolean
  /** Discriminant of the stored record; absent while none is stored. */
  readonly kind?: 'api-key' | 'grant'
}

/** One request to start an authorization attempt. */
export interface AuthorizationBeginRequest {
  /** The credential record to authorize, in its joined `<scope>/<id>` form. */
  readonly key: string
  /** Which of the flow's methods to run; the flow's first when absent. */
  readonly method?: string
}

/** A running flow's report to the surface. Never carries a secret. */
export interface AuthorizationNoticeFrame {
  readonly type: 'notice'
  /** What is happening, or what the human must do next. */
  readonly message: string
  /** A page the human must open to continue. */
  readonly url?: string
  /** A short code the human must enter on that page. */
  readonly code?: string
}

/**
 * A question the flow needs answered before it continues. The surface answers
 * through `answer(key, promptId, value)` or `decline(key, promptId)`; a
 * `select` prompt answers with the chosen option's `id`, and `secret` differs
 * from `text` only in presentation.
 */
export interface AuthorizationPromptFrame {
  readonly type: 'prompt'
  /** Attempt-unique id the answer names. */
  readonly promptId: string
  readonly kind: 'text' | 'secret' | 'select'
  readonly message: string
  /** Example or hint for a `text` or `secret` prompt. */
  readonly placeholder?: string
  /** The choices of a `select` prompt. */
  readonly options?: readonly AuthorizationPromptOption[]
}

/** The flow withdrew a prompt it had asked (a browser callback won the race against a typed code); the attempt continues. */
export interface AuthorizationPromptWithdrawnFrame {
  readonly type: 'prompt-withdrawn'
  readonly promptId: string
}

/** The attempt ended; this is always the last frame of a stream that ends normally. */
export interface AuthorizationSettledFrame {
  readonly type: 'settled'
  /** `authorized` once the record is committed and observed; `cancelled` when the human or the surface withdrew. */
  readonly status: AuthorizationStatus
}

/** One item of the `authorization/begin` stream. */
export type AuthorizationFrame =
  | AuthorizationNoticeFrame
  | AuthorizationPromptFrame
  | AuthorizationPromptWithdrawnFrame
  | AuthorizationSettledFrame
