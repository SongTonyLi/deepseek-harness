/** Plugin config resolve. */
import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Config, resolveAdapterOptions } from '../src/config.ts'
import { DEFAULT_API_KEY_ENV, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/protocol.ts'

describe('resolveAdapterOptions', () => {
  it('applies defaults including harvest-on and CURSOR_ACCESS_TOKEN', () => {
    const resolved = resolveAdapterOptions({})
    expect(resolved.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV)
    expect(resolved.reuseInstalledCursorLogin).toBe(true)
    expect(resolved.streamIdleTimeoutMs).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    expect(resolved.retryPolicy.mode).toBe('normal')
  })

  it('treats reuseInstalledCursorLogin false as opt-out', () => {
    expect(resolveAdapterOptions({ reuseInstalledCursorLogin: false }).reuseInstalledCursorLogin).toBe(false)
  })

  it('rejects a non-positive idle timeout beyond the schema', () => {
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: 0 })).toThrow(/streamIdleTimeoutMs/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow(/streamIdleTimeoutMs/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: Number.NaN })).toThrow(/streamIdleTimeoutMs/)
  })

  it('materializes Config defaults', () => {
    const materialized = Config({})
    expect(materialized.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV)
    expect(materialized.reuseInstalledCursorLogin).toBe(true)
    expect(materialized.streamIdleTimeoutMs).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
  })
})
