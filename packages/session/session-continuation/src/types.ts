/** Shared retry identity and continuation projection types. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'

/** Client-minted prompt identity used to reconcile optimistic and durable messages. */
export type SessionRequestId = Branded<'session-request-id'>

/** Durable empty retry source, retaining caller attribution. */
export type RetrySource = { kind: 'retry'; rpcId: SessionRequestId; clientTimeZone?: string; principal?: Principal }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Empty retry user message with prompt correlation and caller metadata. */
    'retry-rpc': RetrySource
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Eligible latest failed turn/end for an empty prompt, or null. */
    conversationContinuation: SessionSeq | null
  }
}
