/**
 * Plugin configuration for the Cursor adapter.
 *
 * @module @deepseek-ai/dsh-llm-cursor/config
 */

import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_API_KEY_ENV, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from './protocol.ts'

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-cursor` settings-section shape.
 */
export interface Config {
  /** Credential reference resolved per request; defaults to `CURSOR_ACCESS_TOKEN`. */
  apiKeyEnv?: string
  /** Whether a request may reuse a Cursor IDE or CLI login (default true). */
  reuseInstalledCursorLogin?: boolean
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  reuseInstalledCursorLogin: z.boolean().default(true),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** Validated request facts for one adapter generation. */
export interface ResolvedCursorOptions {
  /** Credential reference resolved per request. */
  apiKeyEnv: CredentialRef
  /** Whether harvest is allowed. */
  reuseInstalledCursorLogin: boolean
  /** Positive idle watchdog interval. */
  streamIdleTimeoutMs: number
  /** Immutable retry policy captured at registration. */
  retryPolicy: ResolvedRetryPolicy
}

/**
 * The one explicit resolve step from raw config to validated connection facts.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 */
export function resolveAdapterOptions(config: Config): ResolvedCursorOptions {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-cursor: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    reuseInstalledCursorLogin: config.reuseInstalledCursorLogin !== false,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-cursor: retryPolicy'),
  }
}
