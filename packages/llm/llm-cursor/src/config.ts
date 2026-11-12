/**
 * Plugin configuration for the Cursor adapter.
 *
 * @module @deepseek-ai/dsh-llm-cursor/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_API_KEY_ENV, DEFAULT_PARKED_RUN_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_TOOL_CALL_SETTLE_MS,
} from './protocol.ts'

/** Live plugin configuration; each operation reads the current validated field values. */
export interface Config {
  /** Credential reference resolved per request; defaults to `CURSOR_ACCESS_TOKEN`. */
  apiKeyEnv: Volatile<string>
  /** Whether a request may reuse a Cursor IDE or CLI login (default true). */
  reuseInstalledCursorLogin: Volatile<boolean>
  /** Compaction capacity for models without catalog limits (default 200,000 tokens); does not change Cursor's server limit. */
  defaultContextWindow: Volatile<number>
  /** Positive token capacities by exact Cursor model id; override catalog limits and `defaultContextWindow`. */
  modelContextWindows: Volatile<Record<string, number> | undefined>
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs: Volatile<number>
  /**
   * How long a Run parked on MCP tool calls waits for the next request to bring
   * their results before the adapter cancels it (default thirty minutes). A
   * later request then rebuilds the conversation on a new Run.
   */
  parkedRunTimeoutMs: Volatile<number>
  /**
   * How long the adapter waits after an MCP tool call for the model's other
   * parallel calls when Cursor has not yet sent the checkpoint that ends the
   * model message (default one second).
   */
  toolCallSettleMs: Volatile<number>
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy: Volatile<RetryPolicyConfig | undefined>
}

/** Plain YAML options accepted by the resolver before live references are created. */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? Exclude<T, undefined> : never }

const DEFAULT_CONTEXT_WINDOW = 200_000
const contextWindowSchema = z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  reuseInstalledCursorLogin: z.boolean().default(true).volatile(),
  defaultContextWindow: contextWindowSchema.default(DEFAULT_CONTEXT_WINDOW).volatile(),
  modelContextWindows: z.dict(contextWindowSchema).volatile(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
  parkedRunTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_PARKED_RUN_TIMEOUT_MS).volatile(),
  toolCallSettleMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TOOL_CALL_SETTLE_MS).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
})

/** Validated options captured for one adapter operation. */
export interface ResolvedCursorOptions {
  /** Credential reference resolved per request. */
  apiKeyEnv: CredentialRef
  /** Whether harvest is allowed. */
  reuseInstalledCursorLogin: boolean
  /** Capacity used when the catalog has no model limit. */
  defaultContextWindow: number
  /** Validated exact-model capacity overrides. */
  modelContextWindows: Readonly<Record<string, number>>
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
 * @param config - plain YAML options or a current field-value snapshot.
 * @returns validated connection facts.
 */
export function resolveAdapterOptions(config: Options): ResolvedCursorOptions {
  const defaultContextWindow = contextCapacity('defaultContextWindow', config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW)
  const modelContextWindows = Object.fromEntries(Object.entries(config.modelContextWindows ?? {}).map(([model, capacity]) => [
    model, contextCapacity(`modelContextWindows.${model}`, capacity),
  ]))
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    reuseInstalledCursorLogin: config.reuseInstalledCursorLogin !== false,
    defaultContextWindow,
    modelContextWindows,
    streamIdleTimeoutMs: timerDelay('streamIdleTimeoutMs', config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    parkedRunTimeoutMs: timerDelay('parkedRunTimeoutMs', config.parkedRunTimeoutMs ?? DEFAULT_PARKED_RUN_TIMEOUT_MS),
    toolCallSettleMs: timerDelay('toolCallSettleMs', config.toolCallSettleMs ?? DEFAULT_TOOL_CALL_SETTLE_MS),
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-cursor: retryPolicy'),
  }
}

/**
 * Read current live fields and resolve a detached snapshot for one operation.
 * @param config - stable references owned by the running plugin fiber.
 * @returns validated options using every field's current value.
 */
export function readAdapterOptions(config: Config): ResolvedCursorOptions {
  const modelContextWindows = config.modelContextWindows.get()
  const retrySnapshot = config.retryPolicy.get()
  let retryPolicy: RetryPolicyConfig | undefined
  if (retrySnapshot?.mode === 'normal') {
    const { retryableCodes, ...rest } = retrySnapshot
    retryPolicy = { ...rest, ...retryableCodes === undefined ? {} : { retryableCodes: [...retryableCodes] } }
  } else {
    retryPolicy = retrySnapshot
  }
  return resolveAdapterOptions({
    apiKeyEnv: config.apiKeyEnv.get(),
    reuseInstalledCursorLogin: config.reuseInstalledCursorLogin.get(),
    defaultContextWindow: config.defaultContextWindow.get(),
    ...modelContextWindows === undefined ? {} : { modelContextWindows },
    streamIdleTimeoutMs: config.streamIdleTimeoutMs.get(),
    parkedRunTimeoutMs: config.parkedRunTimeoutMs.get(),
    toolCallSettleMs: config.toolCallSettleMs.get(),
    ...retryPolicy === undefined ? {} : { retryPolicy },
  })
}

function contextCapacity(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`llm-cursor: ${field} must be a positive safe integer`)
  }
  return value
}

function timerDelay(field: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-cursor: ${field} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}
