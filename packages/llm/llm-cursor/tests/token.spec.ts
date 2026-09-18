/** Grant parsing and request-time token cascade. */
import { describe, expect, it, vi } from 'vitest'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { cursorGrantRecord, grantExpiryFromAccess, parseCursorGrant } from '../src/grant.ts'
import { CURSOR_RECORD_KEY, resolveCursorAccessToken } from '../src/token.ts'
import type { CursorCredentials } from '../src/token.ts'
import { DEFAULT_API_KEY_ENV } from '../src/protocol.ts'

function jwt(expSeconds: number): string {
  return `a.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.b`
}

function environment(values: Record<string, string>) {
  return createLaunchEnvironmentSnapshot([{ source: 'process', values }])
}

describe('parseCursorGrant', () => {
  it('accepts a complete oauth payload and rejects everything else', () => {
    expect(parseCursorGrant({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })).toEqual({
      type: 'oauth', access: 'a', refresh: 'r', expires: 1,
    })
    expect(parseCursorGrant(null)).toBeUndefined()
    expect(parseCursorGrant({ type: 'api-key' })).toBeUndefined()
    expect(parseCursorGrant({ type: 'oauth', access: '', refresh: 'r', expires: 1 })).toBeUndefined()
    expect(parseCursorGrant({ type: 'oauth', access: 'a', refresh: '', expires: 1 })).toBeUndefined()
    expect(parseCursorGrant({ type: 'oauth', access: 'a', refresh: 'r', expires: Number.NaN })).toBeUndefined()
  })

  it('builds a grant record', () => {
    expect(cursorGrantRecord({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })).toEqual({
      kind: 'grant',
      payload: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
    })
  })

  it('reads JWT exp and falls back for opaque or malformed payloads', () => {
    const now = () => 0
    expect(grantExpiryFromAccess(jwt(100), now)).toBe(100_000 - 5 * 60 * 1000)
    expect(grantExpiryFromAccess('not-a-jwt', now)).toBe(60 * 60 * 1000)
    expect(grantExpiryFromAccess('a.%%% .b', now)).toBe(60 * 60 * 1000)
    expect(grantExpiryFromAccess(`a.${Buffer.from('{"exp":"no"}').toString('base64url')}.b`, now)).toBe(60 * 60 * 1000)
  })
})

function credentialsStub(record: CredentialRecord | undefined, resolveValue?: string): CursorCredentials {
  return {
    resolve: async () => resolveValue === undefined ? undefined : { value: resolveValue, source: 'store' },
    readRecord: async () => record,
    modifyRecord: async (_key, mutate) => mutate(record),
  }
}

describe('resolveCursorAccessToken', () => {
  it('prefers the named env credential over a stored grant', async () => {
    const token = await resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      credentials: credentialsStub(
        { kind: 'grant', payload: { type: 'oauth', access: 'grant', refresh: 'r', expires: Date.now() + 60_000 } },
        'env-token',
      ),
      environment: environment({}),
      reuseInstalledCursorLogin: true,
      refresh: () => Promise.reject(new Error('no')),
      readHarvestSources: () => Promise.resolve([{ accessToken: 'harvest' }]),
    })
    expect(token).toBe('env-token')
  })

  it('reads launch environment when the credentials seam is absent', async () => {
    const token = await resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      environment: environment({ CURSOR_ACCESS_TOKEN: 'launch-token' }),
      reuseInstalledCursorLogin: false,
      refresh: () => Promise.reject(new Error('no')),
      readHarvestSources: () => Promise.resolve([]),
    })
    expect(token).toBe('launch-token')
  })

  it('uses a fresh stored grant and refreshes a stale one inside modifyRecord', async () => {
    const fresh = await resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      credentials: credentialsStub({
        kind: 'grant',
        payload: { type: 'oauth', access: 'stored', refresh: 'r', expires: Date.now() + 60_000 },
      }),
      environment: environment({}),
      reuseInstalledCursorLogin: false,
      refresh: () => Promise.reject(new Error('no')),
      readHarvestSources: () => Promise.resolve([]),
    })
    expect(fresh).toBe('stored')

    const grant: CredentialRecord = {
      kind: 'grant',
      payload: { type: 'oauth', access: 'old', refresh: 'r', expires: 1 },
    }
    const modifyRecord = vi.fn<CursorCredentials['modifyRecord']>(async (_key, mutate) => mutate(grant))
    const refreshed = await resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      credentials: {
        resolve: async () => undefined,
        readRecord: async () => grant,
        modifyRecord,
      },
      environment: environment({}),
      reuseInstalledCursorLogin: false,
      refresh: () => Promise.resolve({ type: 'oauth', access: 'new', refresh: 'r2', expires: Date.now() + 60_000 }),
      readHarvestSources: () => Promise.resolve([]),
      now: () => 10_000,
    })
    expect(refreshed).toBe('new')
    expect(modifyRecord).toHaveBeenCalled()
  })

  it('harvests only when no stored grant exists', async () => {
    const harvested = jwt(Math.floor(Date.now() / 1000) + 3600)
    const token = await resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      credentials: credentialsStub(undefined),
      environment: environment({}),
      reuseInstalledCursorLogin: true,
      refresh: () => Promise.reject(new Error('no')),
      readHarvestSources: () => Promise.resolve([{ accessToken: harvested }]),
    })
    expect(token).toBe(harvested)
  })

  it('fails MISSING_CREDENTIAL and INVALID_CREDENTIAL', async () => {
    await expect(resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      credentials: credentialsStub(undefined),
      environment: environment({}),
      reuseInstalledCursorLogin: false,
      refresh: () => Promise.reject(new Error('no')),
      readHarvestSources: () => Promise.resolve([]),
    })).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })

    await expect(resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      credentials: credentialsStub({ kind: 'grant', payload: { nope: true } }),
      environment: environment({}),
      reuseInstalledCursorLogin: true,
      refresh: () => Promise.reject(new Error('no')),
      readHarvestSources: () => Promise.resolve([{ accessToken: 'harvest' }]),
    })).rejects.toBeInstanceOf(LlmError)
  })

  it('skips an empty launch-environment value and a concurrent still-fresh grant', async () => {
    await expect(resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      environment: environment({ CURSOR_ACCESS_TOKEN: '' }),
      reuseInstalledCursorLogin: false,
      refresh: () => Promise.reject(new Error('no')),
      readHarvestSources: () => Promise.resolve([]),
    })).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })

    const credentials = credentialsStub({
      kind: 'grant',
      payload: { type: 'oauth', access: 'old', refresh: 'r', expires: 1 },
    })
    credentials.modifyRecord = async (_key, mutate) => mutate({
      kind: 'grant',
      payload: { type: 'oauth', access: 'raced', refresh: 'r', expires: Date.now() + 60_000 },
    })
    const raced = await resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      credentials,
      environment: environment({}),
      reuseInstalledCursorLogin: false,
      refresh: () => Promise.reject(new Error('must not refresh')),
      readHarvestSources: () => Promise.resolve([]),
      now: () => 10_000,
    })
    expect(raced).toBe('raced')
  })

  it('harvests a refresh token and ignores a grant that disappears during refresh', async () => {
    const harvested = await resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      credentials: credentialsStub(undefined),
      environment: environment({}),
      reuseInstalledCursorLogin: true,
      refresh: () => Promise.resolve({
        type: 'oauth',
        access: 'harvested',
        refresh: 'rt2',
        expires: Date.now() + 60_000,
      }),
      readHarvestSources: () => Promise.resolve([{ refreshToken: 'rt' }]),
    })
    expect(harvested).toBe('harvested')

    const vanished = credentialsStub({
      kind: 'grant',
      payload: { type: 'oauth', access: 'old', refresh: 'r', expires: 1 },
    })
    vanished.modifyRecord = async (_key, mutate) => mutate({ kind: 'grant', payload: { nope: true } })
    await expect(resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      credentials: vanished,
      environment: environment({}),
      reuseInstalledCursorLogin: false,
      refresh: () => Promise.reject(new Error('must not refresh')),
      readHarvestSources: () => Promise.resolve([]),
      now: () => 10_000,
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })

    const missing = credentialsStub({
      kind: 'grant',
      payload: { type: 'oauth', access: 'old', refresh: 'r', expires: 1 },
    })
    missing.modifyRecord = async (_key, mutate) => mutate(undefined)
    await expect(resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      credentials: missing,
      environment: environment({}),
      reuseInstalledCursorLogin: false,
      refresh: () => Promise.reject(new Error('must not refresh')),
      readHarvestSources: () => Promise.resolve([]),
      now: () => 10_000,
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('fails INVALID_CREDENTIAL when refresh cannot rewrite the record', async () => {
    const credentials = credentialsStub({
      kind: 'grant',
      payload: { type: 'oauth', access: 'old', refresh: 'r', expires: 1 },
    })
    credentials.modifyRecord = async () => undefined
    await expect(resolveCursorAccessToken({
      apiKeyEnv: credentialRef(DEFAULT_API_KEY_ENV),
      credentials,
      environment: environment({}),
      reuseInstalledCursorLogin: false,
      refresh: () => Promise.resolve({ type: 'oauth', access: 'new', refresh: 'r2', expires: Date.now() + 60_000 }),
      readHarvestSources: () => Promise.resolve([]),
      now: () => 10_000,
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })
})

describe('CURSOR_RECORD_KEY', () => {
  it('is llm-cursor/cursor', () => {
    expect(CURSOR_RECORD_KEY).toBe('llm-cursor/cursor')
  })
})
