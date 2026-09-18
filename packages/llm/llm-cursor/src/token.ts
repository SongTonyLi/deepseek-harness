/**
 * Request-time access-token cascade: env, stored grant, then optional harvest.
 *
 * @module @deepseek-ai/dsh-llm-cursor/token
 */

import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import type { CredentialRef, CredentialKey, CredentialRecord, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { cursorGrantRecord, parseCursorGrant } from './grant.ts'
import type { CursorOauthGrant } from './grant.ts'
import { harvestInstalledCursorLogin } from './harvest.ts'
import type { InstalledCursorTokens } from './harvest.ts'
import { NS, PROVIDER } from './protocol.ts'

/** Record address this adapter writes. */
export const CURSOR_RECORD_KEY = credentialKey(NS, PROVIDER)

/** Credential-store methods this cascade uses. */
export interface CursorCredentials {
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>
  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>
}

/** Inputs the cascade needs besides a stored grant. */
export interface CursorTokenContext {
  /** Credential reference from config (`CURSOR_ACCESS_TOKEN` by default). */
  apiKeyEnv: CredentialRef
  /** Optional credentials seam. */
  credentials?: CursorCredentials
  /** Launch environment layers. */
  environment: LaunchEnvironmentSnapshot
  /** Whether Keychain / `state.vscdb` may satisfy a missing grant. */
  reuseInstalledCursorLogin: boolean
  /** Refresh the stored grant or a harvested refresh token. */
  refresh: (refreshToken: string, signal?: AbortSignal) => Promise<CursorOauthGrant>
  /** Installed-login reader. */
  readHarvestSources: () => Promise<InstalledCursorTokens[]>
  /** Clock. */
  now?: () => number
  /** Caller abort. */
  signal?: AbortSignal
}

/**
 * Resolve a Cursor access token without harvesting a stored DSH grant away.
 * @param context - env, store, harvest, and refresh.
 * @returns a usable bearer token.
 */
export async function resolveCursorAccessToken(context: CursorTokenContext): Promise<string> {
  const now = context.now ?? Date.now
  const fromEnv = await resolveEnvToken(context)
  if (fromEnv !== undefined) return fromEnv

  const stored = await resolveStoredGrant(context, now)
  if (stored !== undefined) return stored

  const harvested = await harvestInstalledCursorLogin({
    enabled: context.reuseInstalledCursorLogin,
    readSources: context.readHarvestSources,
    refresh: refresh => context.refresh(refresh, context.signal),
    now,
  })
  if (harvested !== undefined) return assertUsableApiKey(harvested, 'llm-cursor', 'harvested Cursor login')

  throw new LlmError(
    `llm-cursor: no access token for provider route "${PROVIDER}"; sign in through Settings → Models`
    + ` or /login ${NS}/${PROVIDER}, store ${context.apiKeyEnv} through the credentials service,`
    + ` or export ${context.apiKeyEnv} in the launching environment`,
    'MISSING_CREDENTIAL',
  )
}

async function resolveEnvToken(context: CursorTokenContext): Promise<string | undefined> {
  const ref = context.apiKeyEnv
  if (context.credentials !== undefined) {
    const hit = await context.credentials.resolve(ref)
    if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-cursor', ref)
    return undefined
  }
  const ambient = context.environment.get(ref)
  if (ambient !== undefined && ambient.value.length > 0) {
    return assertUsableApiKey(ambient.value, 'llm-cursor', ref)
  }
  return undefined
}

async function resolveStoredGrant(context: CursorTokenContext, now: () => number): Promise<string | undefined> {
  const credentials = context.credentials
  if (credentials === undefined) return undefined
  const current = await credentials.readRecord(CURSOR_RECORD_KEY)
  const grant = parseCursorGrant(grantPayload(current))
  if (current !== undefined && grant === undefined) {
    throw new LlmError(
      `llm-cursor: stored grant at ${CURSOR_RECORD_KEY} is not a Cursor OAuth payload`,
      'INVALID_CREDENTIAL',
    )
  }
  if (grant === undefined) return undefined
  if (now() < grant.expires) return assertUsableApiKey(grant.access, 'llm-cursor', CURSOR_RECORD_KEY)
  const updated = await credentials.modifyRecord(CURSOR_RECORD_KEY, async (record) => {
    const existing = parseCursorGrant(grantPayload(record))
    if (existing === undefined) return undefined
    if (now() < existing.expires) return record
    const next = await context.refresh(existing.refresh, context.signal)
    return cursorGrantRecord(next)
  })
  const next = parseCursorGrant(grantPayload(updated))
  if (next === undefined) {
    throw new LlmError(
      `llm-cursor: stored grant at ${CURSOR_RECORD_KEY} could not be refreshed`,
      'INVALID_CREDENTIAL',
    )
  }
  return assertUsableApiKey(next.access, 'llm-cursor', CURSOR_RECORD_KEY)
}

function grantPayload(record: CredentialRecord | undefined): unknown {
  return record?.kind === 'grant' ? record.payload : undefined
}
