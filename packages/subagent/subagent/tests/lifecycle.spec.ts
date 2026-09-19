import { describe, expect, it } from 'vitest'
import { resolveActivationTerminal } from '../src/lifecycle.ts'

describe('continuable activation terminal', () => {
  it('returns the captured facts when teardown succeeded', () => {
    const captured = {
      stopReason: 'completed' as const,
      output: [{ type: 'text' as const, text: 'ok' }],
    }
    expect(resolveActivationTerminal(captured, undefined)).toBe(captured)
  })

  it('prefers a captured diagnostic over the teardown failure', () => {
    const captured = {
      stopReason: 'error' as const,
      diagnostic: 'ENOSPC: no space left on device',
    }
    expect(resolveActivationTerminal(captured, new Error('scope unwind failed'))).toEqual({
      stopReason: 'error',
      diagnostic: 'ENOSPC: no space left on device',
    })
  })

  it('sanitizes a teardown failure when the child left no diagnostic', () => {
    expect(resolveActivationTerminal({ stopReason: 'completed' }, new Error('scope unwind failed')))
      .toEqual({ stopReason: 'error', diagnostic: 'scope unwind failed' })
  })

  it('omits an empty teardown reason', () => {
    expect(resolveActivationTerminal({ stopReason: 'completed' }, '')).toEqual({ stopReason: 'error' })
  })

  it('falls through an empty captured diagnostic to the teardown failure', () => {
    expect(resolveActivationTerminal(
      { stopReason: 'error', diagnostic: '' },
      new Error('scope unwind failed'),
    )).toEqual({ stopReason: 'error', diagnostic: 'scope unwind failed' })
  })
})
