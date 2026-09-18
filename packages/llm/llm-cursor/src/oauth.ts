/**
 * Cursor PKCE login, poll, and refresh against the unofficial auth endpoints.
 *
 * @module @deepseek-ai/dsh-llm-cursor/oauth
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { grantExpiryFromAccess } from './grant.ts'
import type { CursorOauthGrant } from './grant.ts'
import {
  AUTH_REQUEST_TIMEOUT_MS,
  CURSOR_LOGIN_URL,
  CURSOR_POLL_URL,
  CURSOR_REFRESH_URL,
  POLL_BACKOFF_MULTIPLIER,
  POLL_BASE_DELAY_MS,
  POLL_MAX_ATTEMPTS,
  POLL_MAX_DELAY_MS,
} from './protocol.ts'

/** Named OAuth failure that did not commit a grant. */
export class CursorOauthError extends Error {
  override name = 'CursorOauthError'

  /**
   * @param message - human-readable failure.
   * @param code - stable machine code (`POLL_TIMEOUT`, `POLL_FAILED`, `REFRESH_FAILED`, `INVALID_TOKEN`).
   * @param options - optional cause.
   */
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** PKCE login URL plus the secrets the poll needs. */
export interface CursorPkceParams {
  /** PKCE verifier sent on every poll. */
  verifier: string
  /** S256 challenge in the login URL. */
  challenge: string
  /** Login attempt id in the URL and poll query. */
  uuid: string
  /** `loginDeepControl` URL the human opens. */
  loginUrl: string
}

/** Injectable clocks and HTTP for tests. */
export interface CursorOauthDependencies {
  /** Fetch implementation; defaults to global `fetch`. */
  fetch?: typeof fetch
  /** Sleep between polls; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
  /** UUID for the login attempt. */
  randomUUID?: () => string
  /** PKCE pair; defaults to 96 random bytes and SHA-256. */
  generatePkce?: () => Promise<{ verifier: string; challenge: string }>
  /** Clock for grant expiry. */
  now?: () => number
  /** Per-request timeout; defaults to {@link AUTH_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number
}

/** Callbacks the login flow uses to talk to the human. */
export interface CursorOauthLoginCallbacks {
  /**
   * Show the PKCE page.
   * @param payload - login URL.
   */
  onAuth(payload: { url: string }): void | Promise<void>
}

function authRequestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function parseTokenResponse(value: unknown, endpoint: string): { accessToken: string; refreshToken?: string } {
  if (typeof value !== 'object' || value === null) {
    throw new CursorOauthError(`${endpoint} returned an invalid token response`, 'INVALID_TOKEN')
  }
  const record = value as Record<string, unknown>
  if (typeof record.accessToken !== 'string' || record.accessToken.trim().length === 0) {
    throw new CursorOauthError(`${endpoint} returned no access token`, 'INVALID_TOKEN')
  }
  if (record.refreshToken !== undefined && typeof record.refreshToken !== 'string') {
    throw new CursorOauthError(`${endpoint} returned an invalid refresh token`, 'INVALID_TOKEN')
  }
  return {
    accessToken: record.accessToken,
    ...typeof record.refreshToken === 'string' ? { refreshToken: record.refreshToken } : {},
  }
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(96)
  crypto.getRandomValues(verifierBytes)
  const verifier = Buffer.from(verifierBytes).toString('base64url')
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: Buffer.from(hashBuffer).toString('base64url') }
}

function abortError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback)
}

function settledOnAbort(signal: AbortSignal, fallback: string): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => {
      reject(abortError(signal, fallback))
    }
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
  })
}

async function sleepForPoll(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) {
    await sleep(ms)
    return
  }
  const aborted = settledOnAbort(signal, 'Cursor authentication polling aborted')
  await Promise.race([aborted, sleep(ms)])
}

/** PKCE helpers plus login, poll, and refresh. */
export interface CursorOauthClient {
  /** PKCE URL and secrets for one attempt. */
  generateParams(): Promise<CursorPkceParams>
  /**
   * Open the login page and poll until a grant exists.
   * @param callbacks - human-facing login URL.
   * @param options - abort.
   * @returns the grant values; the caller commits them to the credential store.
   */
  login(callbacks: CursorOauthLoginCallbacks, options?: { signal?: AbortSignal }): Promise<CursorOauthGrant>
  /**
   * Poll until the PKCE attempt yields tokens.
   * @param uuid - login attempt id.
   * @param verifier - PKCE verifier.
   * @param options - abort.
   * @returns access and refresh tokens.
   */
  poll(uuid: string, verifier: string, options?: { signal?: AbortSignal }): Promise<{ accessToken: string; refreshToken: string }>
  /**
   * Exchange a refresh token for a new grant.
   * @param refresh - refresh token.
   * @param signal - abort.
   * @returns the new grant.
   */
  refreshToken(refresh: string, signal?: AbortSignal): Promise<CursorOauthGrant>
}

/**
 * Build a Cursor OAuth client with injectable HTTP.
 * @param deps - fetch, sleep, clocks; every field is optional.
 * @returns PKCE helpers, login, poll, and refresh.
 */
export function createCursorOauthClient(deps: CursorOauthDependencies = {}): CursorOauthClient {
  const fetchImpl = deps.fetch ?? fetch
  const requestTimeoutMs = deps.requestTimeoutMs ?? AUTH_REQUEST_TIMEOUT_MS
  const sleepImpl = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const generatePkceImpl = deps.generatePkce ?? generatePkce
  const randomUUIDImpl = deps.randomUUID ?? randomUUID
  const now = deps.now ?? Date.now

  async function generateParams(): Promise<CursorPkceParams> {
    const { verifier, challenge } = await generatePkceImpl()
    const uuid = randomUUIDImpl()
    const params = new URLSearchParams({
      challenge,
      uuid,
      mode: 'login',
      redirectTarget: 'cli',
    })
    return { verifier, challenge, uuid, loginUrl: `${CURSOR_LOGIN_URL}?${params.toString()}` }
  }

  async function poll(
    uuid: string,
    verifier: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ accessToken: string; refreshToken: string }> {
    let delay = POLL_BASE_DELAY_MS
    let consecutiveErrors = 0
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await sleepForPoll(sleepImpl, delay, options?.signal)
      try {
        const response = await fetchImpl(`${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`, {
          signal: authRequestSignal(options?.signal, requestTimeoutMs),
        })
        if (response.status === 404) {
          consecutiveErrors = 0
          delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS)
          continue
        }
        if (response.ok) {
          const data = parseTokenResponse(await response.json(), 'Cursor authentication polling')
          if (data.refreshToken === undefined || data.refreshToken.trim().length === 0) {
            throw new CursorOauthError('Cursor authentication polling returned no refresh token', 'INVALID_TOKEN')
          }
          return { accessToken: data.accessToken, refreshToken: data.refreshToken }
        }
        throw new CursorOauthError(`Poll failed: ${response.status}`, 'POLL_FAILED')
      } catch (error) {
        if (options?.signal?.aborted === true) throw error
        if (error instanceof CursorOauthError && error.code === 'INVALID_TOKEN') throw error
        consecutiveErrors += 1
        if (consecutiveErrors >= 3) {
          throw new CursorOauthError('Too many consecutive errors during Cursor auth polling', 'POLL_FAILED', { cause: error })
        }
      }
    }
    throw new CursorOauthError('Cursor authentication polling timeout', 'POLL_TIMEOUT')
  }

  async function refreshToken(
    refresh: string,
    signal?: AbortSignal,
  ): Promise<CursorOauthGrant> {
    const response = await fetchImpl(CURSOR_REFRESH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refresh}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: authRequestSignal(signal, requestTimeoutMs),
    })
    if (!response.ok) {
      throw new CursorOauthError(`Cursor token refresh failed: ${response.status}`, 'REFRESH_FAILED')
    }
    const data = parseTokenResponse(await response.json(), 'Cursor token refresh')
    return {
      type: 'oauth',
      access: data.accessToken,
      refresh: data.refreshToken ?? refresh,
      expires: grantExpiryFromAccess(data.accessToken, now),
    }
  }

  async function login(
    callbacks: CursorOauthLoginCallbacks,
    options?: { signal?: AbortSignal },
  ): Promise<CursorOauthGrant> {
    const { verifier, uuid, loginUrl } = await generateParams()
    await callbacks.onAuth({ url: loginUrl })
    const tokens = await poll(uuid, verifier, options)
    return {
      type: 'oauth',
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: grantExpiryFromAccess(tokens.accessToken, now),
    }
  }

  return { generateParams, login, poll, refreshToken }
}
