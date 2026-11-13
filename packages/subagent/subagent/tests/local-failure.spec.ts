import { describe, expect, it } from 'vitest'
import { childFailureDiagnostic } from '../src/local-failure.ts'

describe('childFailureDiagnostic', () => {
  it('names the route, code, and message', () => {
    expect(childFailureDiagnostic(
      { provider: 'anthropic', model: 'claude-haiku-5-5' },
      'NO_ADAPTER',
      'no adapter registered for provider "anthropic"',
    )).toBe(
      'Child route anthropic/claude-haiku-5-5 failed (NO_ADAPTER): no adapter registered for provider "anthropic"',
    )
  })

  it('omits the route when the child has none', () => {
    expect(childFailureDiagnostic(undefined, 'UNKNOWN', 'agent has no provider/model')).toBe(
      'Child turn failed (UNKNOWN): agent has no provider/model',
    )
  })

  it('omits an empty message', () => {
    expect(childFailureDiagnostic({ provider: 'mock', model: 'mock' }, 'UNKNOWN', '')).toBe(
      'Child route mock/mock failed (UNKNOWN).',
    )
  })

  it('redacts bearer tokens, sk- keys, and credential assignments', () => {
    expect(childFailureDiagnostic(undefined, 'AUTH',
      'Bearer secret-token sk-testsecretvalue api_key=supersecret access_token: tok secret=hideme but not a secret word',
    )).toBe(
      'Child turn failed (AUTH): [redacted] [redacted] [redacted] [redacted] [redacted] but not a secret word',
    )
  })

  it('truncates on a UTF-8 boundary and marks the cut', () => {
    const suffix = '\n[diagnostic truncated]'
    const budget = 4096 - new TextEncoder().encode(suffix).length
    const head = 'Child turn failed (UNKNOWN): '
    const headBytes = new TextEncoder().encode(head).length
    const overflow = 'tail'.repeat(20)
    const ascii = 'a'.repeat(budget - headBytes)
    const asciiDiagnostic = childFailureDiagnostic(undefined, 'UNKNOWN', ascii + overflow)
    expect(new TextEncoder().encode(asciiDiagnostic).byteLength).toBe(4096)
    expect(asciiDiagnostic.endsWith(suffix)).toBe(true)
    expect(asciiDiagnostic).not.toContain('tail')

    const straddling = 'a'.repeat(budget - headBytes - 1) + '你' + overflow
    const cut = childFailureDiagnostic(undefined, 'UNKNOWN', straddling)
    expect(new TextEncoder().encode(cut).byteLength).toBeLessThanOrEqual(4096)
    expect(cut.endsWith(suffix)).toBe(true)
    expect(cut).not.toContain('你')
    expect(cut).not.toContain('tail')
  })
})
