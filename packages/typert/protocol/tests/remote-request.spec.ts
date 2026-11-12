import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RemoteError, parseRemoteRequest, remoteErrorOf, type RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'

const beginRequest = z.object({ key: z.string().min(1), method: z.string().min(1).optional() })

/** Run one parse that must refuse, and return the Remote failure it throws. */
function refusalOf(run: () => unknown): RemoteFailure {
  try {
    run()
  } catch (error: unknown) {
    const failure = remoteErrorOf(error)
    if (failure !== undefined) return failure
    throw error
  }
  throw new Error('expected parseRemoteRequest to refuse the payload')
}

describe('parseRemoteRequest', () => {
  it('returns the schema output for a valid payload', () => {
    expect(parseRemoteRequest('authorization.begin', beginRequest, { key: 'deepseek/api-key' }))
      .toEqual({ key: 'deepseek/api-key' })
  })

  it('refuses an invalid payload as gateway/bad-request carrying the schema issues', () => {
    const refusal = refusalOf(() => parseRemoteRequest('authorization.begin', beginRequest, { key: '' }))
    expect(refusal).toBeInstanceOf(RemoteError)
    expect(refusal).toMatchObject({
      code: 'gateway/bad-request',
      message: 'invalid payload for authorization.begin',
      details: { issues: [{ path: ['key'] }] },
    })
  })

  it('accepts any object with a safeParse method, not only a Zod schema', () => {
    const numeric = {
      safeParse: (value: unknown) => typeof value === 'number'
        ? { success: true as const, data: value }
        : { success: false as const, error: { issues: [{ message: 'expected a number' }] } },
    }
    expect(parseRemoteRequest('test.number', numeric, 3)).toBe(3)
    expect(refusalOf(() => parseRemoteRequest('test.number', numeric, 'three')).details)
      .toEqual({ issues: [{ message: 'expected a number' }] })
  })
})
