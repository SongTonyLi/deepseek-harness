/**
 * Cursor OAuth grant stored as a credential-record payload.
 *
 * @module @deepseek-ai/dsh-llm-cursor/grant
 */

import { TOKEN_EXPIRY_SKEW_MS, TOKEN_FALLBACK_TTL_MS } from './protocol.ts'

/** JSON payload written at `llm-cursor/cursor`. */
export interface CursorOauthGrant {
  /** Discriminant the adapter uses to recognize its own grant. */
  type: 'oauth'
  /** Bearer access token for agent HTTP/2. */
  access: string
  /** Refresh token for `exchange_user_api_key`. */
  refresh: string
  /** Epoch milliseconds after which this adapter treats `access` as stale. */
  expires: number
}

/**
 * Decode JWT `exp` into a refresh-early millisecond timestamp.
 * @param token - access token, JWT or opaque.
 * @param now - clock; defaults to `Date.now`.
 * @returns milliseconds at which this adapter should refresh.
 */
export function grantExpiryFromAccess(token: string, now: () => number = Date.now): number {
  const parts = token.split('.')
  const payload = parts[1]
  if (parts.length !== 3 || payload === undefined || payload.length === 0) {
    return now() + TOKEN_FALLBACK_TTL_MS
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (
      typeof decoded === 'object'
      && decoded !== null
      && typeof (decoded as { exp?: unknown }).exp === 'number'
    ) {
      return (decoded as { exp: number }).exp * 1000 - TOKEN_EXPIRY_SKEW_MS
    }
  } catch (_malformedJwtPayload) {
    // Opaque or malformed JWT payload: treat as a one-hour bearer.
  }
  return now() + TOKEN_FALLBACK_TTL_MS
}

/**
 * Read a stored grant payload.
 * @param payload - opaque credential-record payload.
 * @returns the grant, or `undefined` when the payload is not this adapter's oauth grant.
 */
export function parseCursorGrant(payload: unknown): CursorOauthGrant | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  if (record.type !== 'oauth') return undefined
  if (typeof record.access !== 'string' || record.access.trim().length === 0) return undefined
  if (typeof record.refresh !== 'string' || record.refresh.trim().length === 0) return undefined
  if (typeof record.expires !== 'number' || !Number.isFinite(record.expires)) return undefined
  return {
    type: 'oauth',
    access: record.access,
    refresh: record.refresh,
    expires: record.expires,
  }
}

/**
 * Build the credential record this adapter commits.
 * @param grant - access, refresh, and expiry.
 * @returns a `grant` record the credential seam stores verbatim.
 */
export function cursorGrantRecord(grant: CursorOauthGrant): { kind: 'grant'; payload: CursorOauthGrant } {
  return { kind: 'grant', payload: { type: 'oauth', access: grant.access, refresh: grant.refresh, expires: grant.expires } }
}
