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
import {
  DEFAULT_API_KEY_ENV, DEFAULT_PARKED_RUN_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_TOOL_CALL_SETTLE_MS,
} from './protocol.ts'

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
  /**
   * How long a Run parked on MCP tool calls waits for the next request to bring
   * their results before the adapter cancels it (default thirty minutes). A
   * later request then rebuilds the conversation on a new Run.
   */
  parkedRunTimeoutMs?: number
  /**
   * How long the adapter waits after an MCP tool call for the model's other
   * parallel calls when Cursor has not yet sent the checkpoint that ends the
   * model message (default one second).
   */
  toolCallSettleMs?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  reuseInstalledCursorLogin: z.boolean().default(true),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  parkedRunTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_PARKED_RUN_TIMEOUT_MS),
  toolCallSettleMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TOOL_CALL_SETTLE_MS),
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
  /** Positive lifetime of a Run parked on tool calls. */
  parkedRunTimeoutMs: number
  /** Positive wait for further parallel tool calls. */
  toolCallSettleMs: number
  /** Immutable retry policy captured at registration. */
  retryPolicy: ResolvedRetryPolicy
}

/**
 * The one explicit resolve step from raw config to validated connection facts.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 */
export function resolveAdapterOptions(config: Config): ResolvedCursorOptions {
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    reuseInstalledCursorLogin: config.reuseInstalledCursorLogin !== false,
    streamIdleTimeoutMs: timerDelay('streamIdleTimeoutMs', config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    parkedRunTimeoutMs: timerDelay('parkedRunTimeoutMs', config.parkedRunTimeoutMs ?? DEFAULT_PARKED_RUN_TIMEOUT_MS),
    toolCallSettleMs: timerDelay('toolCallSettleMs', config.toolCallSettleMs ?? DEFAULT_TOOL_CALL_SETTLE_MS),
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-cursor: retryPolicy'),
  }
}

function timerDelay(field: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-cursor: ${field} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}
