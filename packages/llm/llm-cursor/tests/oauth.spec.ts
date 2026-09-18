/** PKCE login, poll, refresh, and abort. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURSOR_LOGIN_URL, CURSOR_POLL_URL, CURSOR_REFRESH_URL, POLL_MAX_ATTEMPTS } from '../src/protocol.ts'
import { CursorOauthError, createCursorOauthClient } from '../src/oauth.ts'

afterEach(() => {
  vi.useRealTimers()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('Cursor OAuth', () => {
  it('builds a loginDeepControl URL with PKCE and polls until tokens arrive', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'at', refreshToken: 'rt' }))
    const client = createCursorOauthClient({
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
      randomUUID: () => 'login-uuid',
      generatePkce: () => Promise.resolve({ verifier: 'verifier', challenge: 'challenge' }),
      now: () => 1_000,
    })
    const urls: string[] = []
    const grant = await client.login({ onAuth: ({ url }) => { urls.push(url) } })
    expect(urls[0]).toContain(CURSOR_LOGIN_URL)
    expect(urls[0]).toContain('challenge=challenge')
    expect(urls[0]).toContain('uuid=login-uuid')
    expect(urls[0]).toContain('redirectTarget=cli')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${CURSOR_POLL_URL}?uuid=login-uuid&verifier=verifier`)
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(grant).toMatchObject({ type: 'oauth', access: 'at', refresh: 'rt' })
  })

  it('throws POLL_TIMEOUT after the attempt budget without committing', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }))
    const client = createCursorOauthClient({
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
      randomUUID: () => 'u',
      generatePkce: () => Promise.resolve({ verifier: 'v', challenge: 'c' }),
    })
    await expect(client.poll('u', 'v')).rejects.toMatchObject({ code: 'POLL_TIMEOUT' })
    expect(fetchImpl).toHaveBeenCalledTimes(POLL_MAX_ATTEMPTS)
  })

  it('throws POLL_FAILED after three consecutive transport errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    const client = createCursorOauthClient({
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
    })
    await expect(client.poll('u', 'v')).rejects.toMatchObject({ code: 'POLL_FAILED' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('rejects a poll payload without a refresh token', async () => {
    const client = createCursorOauthClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { accessToken: 'at' })),
      sleep: () => Promise.resolve(),
    })
    await expect(client.poll('u', 'v')).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('rejects an empty access token', async () => {
    const client = createCursorOauthClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { accessToken: '  ', refreshToken: 'rt' })),
      sleep: () => Promise.resolve(),
    })
    await expect(client.poll('u', 'v')).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('uses the default sleep between polls', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'at', refreshToken: 'rt' }))
    const client = createCursorOauthClient({
      fetch: fetchImpl,
      randomUUID: () => 'u',
      generatePkce: () => Promise.resolve({ verifier: 'v', challenge: 'c' }),
    })
    const pending = client.poll('u', 'v')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_200)
    await expect(pending).resolves.toEqual({ accessToken: 'at', refreshToken: 'rt' })
  })

  it('aborts polling when the signal reason is not an Error', async () => {
    await expect(createCursorOauthClient({
      fetch: vi.fn<typeof fetch>(),
      sleep: () => Promise.resolve(),
    }).poll('u', 'v', { signal: AbortSignal.abort('cancelled') })).rejects.toThrow(/polling aborted/)
  })

  it('rejects a non-object poll payload', async () => {
    const client = createCursorOauthClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, 'nope')),
      sleep: () => Promise.resolve(),
    })
    await expect(client.poll('u', 'v')).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('recovers from a non-200 poll status before tokens arrive', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(500, { error: 'no' }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'at', refreshToken: 'rt' }))
    const client = createCursorOauthClient({
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
    })
    await expect(client.poll('u', 'v')).resolves.toEqual({ accessToken: 'at', refreshToken: 'rt' })
  })

  it('aborts polling when the login signal fires', async () => {
    const controller = new AbortController()
    const client = createCursorOauthClient({
      fetch: vi.fn<typeof fetch>(),
      sleep: () => {
        controller.abort(new Error('stop'))
        return new Promise(() => {})
      },
    })
    await expect(client.poll('u', 'v', { signal: controller.signal })).rejects.toThrow('stop')
  })

  it('throws immediately when the poll signal is already aborted', async () => {
    const client = createCursorOauthClient({
      fetch: vi.fn<typeof fetch>(),
      sleep: () => Promise.resolve(),
    })
    await expect(client.poll('u', 'v', { signal: AbortSignal.abort(new Error('early')) })).rejects.toThrow('early')
  })

  it('rethrows when fetch fails because the poll signal aborted', async () => {
    const controller = new AbortController()
    const client = createCursorOauthClient({
      fetch: vi.fn(async () => {
        controller.abort(new Error('fetch-stop'))
        throw controller.signal.reason
      }),
      sleep: () => Promise.resolve(),
    })
    await expect(client.poll('u', 'v', { signal: controller.signal })).rejects.toThrow('fetch-stop')
  })

  it('generates a PKCE pair when none is injected', async () => {
    const client = createCursorOauthClient({ randomUUID: () => 'generated-uuid' })
    const params = await client.generateParams()
    expect(params.uuid).toBe('generated-uuid')
    expect(params.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(params.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(params.loginUrl).toContain(`challenge=${params.challenge}`)
    const defaults = await createCursorOauthClient({
      generatePkce: () => Promise.resolve({ verifier: 'v', challenge: 'c' }),
    }).generateParams()
    expect(defaults.uuid.length).toBeGreaterThan(0)
    expect(defaults.loginUrl).toContain('challenge=c')
  })

  it('refreshes through exchange_user_api_key and keeps the old refresh token when none is returned', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { accessToken: 'new-at' }))
    const client = createCursorOauthClient({ fetch: fetchImpl, now: () => 5_000 })
    const grant = await client.refreshToken('old-rt')
    expect(fetchImpl).toHaveBeenCalledWith(CURSOR_REFRESH_URL, expect.objectContaining({
      method: 'POST',
      body: '{}',
    }))
    expect(grant).toMatchObject({ access: 'new-at', refresh: 'old-rt', type: 'oauth' })
  })

  it('aborts a refresh when the signal is already cancelled', async () => {
    const client = createCursorOauthClient({
      fetch: vi.fn<typeof fetch>(),
    })
    await expect(client.refreshToken('rt', AbortSignal.abort('cancelled'))).rejects.toThrow()
  })

  it('names a failed refresh', async () => {
    const client = createCursorOauthClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('no', { status: 401 })),
    })
    await expect(client.refreshToken('rt')).rejects.toMatchObject({ code: 'REFRESH_FAILED' })
  })

  it('rejects a refresh token of the wrong JSON type', async () => {
    const client = createCursorOauthClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { accessToken: 'at', refreshToken: 1 })),
    })
    await expect(client.refreshToken('rt')).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('is CursorOauthError', () => {
    const error = new CursorOauthError('x', 'POLL_TIMEOUT')
    expect(error.name).toBe('CursorOauthError')
  })
})
