import { describe, expect, it } from 'vitest'
import {
  limitSubagentDiagnostic,
  optionalSubagentDiagnostic,
} from '../src/diagnostic.ts'

const MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096

describe('subagent diagnostic budget', () => {
  it('returns a short diagnostic unchanged', () => {
    expect(limitSubagentDiagnostic('scope unwind failed')).toBe('scope unwind failed')
    expect(optionalSubagentDiagnostic('scope unwind failed')).toBe('scope unwind failed')
  })

  it('drops an absent or empty diagnostic', () => {
    expect(optionalSubagentDiagnostic(undefined)).toBeUndefined()
    expect(optionalSubagentDiagnostic('')).toBeUndefined()
  })

  it('bounds multibyte diagnostics and marks truncation', () => {
    const exact = 'x'.repeat(MAX_SUBAGENT_DIAGNOSTIC_BYTES)
    expect(limitSubagentDiagnostic(exact)).toBe(exact)

    const oversized = '权限'.repeat(MAX_SUBAGENT_DIAGNOSTIC_BYTES)
    const limited = optionalSubagentDiagnostic(oversized) ?? ''
    expect(Buffer.byteLength(limited, 'utf8')).toBeLessThanOrEqual(MAX_SUBAGENT_DIAGNOSTIC_BYTES)
    expect(limited.endsWith('[diagnostic truncated]')).toBe(true)
  })
})
