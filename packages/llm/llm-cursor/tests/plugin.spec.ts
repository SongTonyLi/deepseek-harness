/** Plugin apply: always-on route, last-good settings, optional authorization. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmCursor from '@deepseek-ai/dsh-llm-cursor'
import http2 from 'node:http2'
import * as harvest from '../src/harvest.ts'
import { CURSOR_RECORD_KEY } from '../src/token.ts'
import { assemble } from './assemble.ts'

const NS = 'llm-cursor'
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cursor-plugin-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(dir: string, config: LlmCursor.Config = { reuseInstalledCursorLogin: false }): Promise<Context> {
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await writeFile(join(dir, 'settings.yaml'), '# personal settings\n')
  await writeFile(join(dir, '.credentials.yaml'), 'version: 1\nrefs: {}\n', { mode: 0o600 })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(LlmCursor, config)
  return ctx
}

describe('llm-cursor plugin', () => {
  it('registers the always-on cursor route and the oauth flow', async () => {
    const ctx = await boot(await home())
    expect(ctx.llm.listProviders()).toEqual([{ id: 'cursor', name: 'Cursor' }])
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      { provider: 'cursor', displayName: 'Cursor', settingsNs: NS, settingsPath: [] },
    ])
    expect(ctx.authorization.list().some(flow => flow.key === CURSOR_RECORD_KEY && flow.methods[0]?.id === 'oauth')).toBe(true)
    const listed = await ctx.llm.listModels('cursor')
    expect(listed.some(model => model.id === 'composer-2')).toBe(true)
  })

  it('fails MISSING_CREDENTIAL before HTTP/2 when harvest is off', async () => {
    vi.stubEnv('CURSOR_ACCESS_TOKEN', '')
    const ctx = await boot(await home())
    const result = await assemble(ctx, { model: 'composer-2', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
  })

  it('keeps the last good retry policy when a settings snapshot fails resolve', async () => {
    const ctx = await boot(await home(), {
      reuseInstalledCursorLogin: false,
      retryPolicy: { mode: 'normal', maxRetries: 3 },
    })
    expect(ctx.llm.providerRetryPolicy('cursor')).toMatchObject({ mode: 'normal', maxRetries: 3 })
    await ctx.settings.update(NS, { retryPolicy: { mode: 'normal', retryableCodes: [] } })
    expect(ctx.llm.providerRetryPolicy('cursor')).toMatchObject({ mode: 'normal', maxRetries: 3 })
    await ctx.settings.update(NS, {
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('cursor')).toMatchObject({ mode: 'always' })
    await ctx.settings.update(NS, {
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('cursor')).toMatchObject({ mode: 'always' })
  })

  it('mounts without authorization and simply offers no sign-in', async () => {
    const dir = await home()
    vi.stubEnv('DSH_HOME', dir)
    vi.stubEnv('CURSOR_ACCESS_TOKEN', '')
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmCursor, { reuseInstalledCursorLogin: false })
    expect(ctx.get('authorization')).toBeUndefined()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['cursor'])
    const result = await assemble(ctx, {
      model: 'composer-2',
      messages: [],
      signal: AbortSignal.timeout(5),
    })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
  })

  it('refuses to mount on an invalid retry policy', async () => {
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmCursor, {
      retryPolicy: { mode: 'normal', retryableCodes: [] },
    })).rejects.toThrow(/retryableCodes/)
  })

  it('harvests with the production source reader when no token is stored', async () => {
    vi.stubEnv('CURSOR_ACCESS_TOKEN', '')
    const real = harvest.createDefaultHarvestSources
    vi.spyOn(harvest, 'createDefaultHarvestSources').mockImplementation(async () => {
      await real()
      return async () => []
    })
    const ctx = await boot(await home(), { reuseInstalledCursorLogin: true })
    const first = await assemble(ctx, { model: 'composer-2', messages: [] })
    const second = await assemble(ctx, { model: 'composer-2', messages: [] })
    expect(first.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(second.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(harvest.createDefaultHarvestSources).toHaveBeenCalledTimes(1)
  })

  it('signs in, refreshes a stored grant, and ignores a failed catalog fetch', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('exchange_user_api_key')) {
        return new Response(JSON.stringify({ accessToken: 'new-at', refreshToken: 'new-rt' }), { status: 200 })
      }
      return new Response(JSON.stringify({ accessToken: 'at', refreshToken: 'rt' }), { status: 200 })
    }))
    const http2Connect = vi.spyOn(http2, 'connect').mockImplementation(() => {
      throw new Error('offline')
    })
    try {
      const dir = await home()
      const ctx = await boot(dir)
      await expect(ctx.authorization.begin({
        key: CURSOR_RECORD_KEY,
        interaction: { notify: () => {}, prompt: () => Promise.resolve('') },
      })).resolves.toEqual({ status: 'authorized' })

      await ctx.credentials.modifyRecord(CURSOR_RECORD_KEY, async (record) => {
        if (record === undefined || record.kind !== 'grant') return undefined
        return {
          kind: 'grant',
          payload: {
            ...(record.payload as Record<string, unknown>),
            expires: 1,
          },
        }
      })
      const refreshed = await assemble(ctx, { model: 'composer-2', messages: [] })
      expect(refreshed.finish.kind).toBe('error')
    } finally {
      http2Connect.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
