/** Profile-backed Loader composition for Cursor settings, subscription authorization, and request-time options. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { initProfile, mountRootInclude, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import * as LlmCursor from '@deepseek-ai/dsh-llm-cursor'
import * as harvest from '../src/harvest.ts'
import { CURSOR_RECORD_KEY } from '../src/token.ts'
import { assemble } from './assemble.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function loadComposition(extraConfig: readonly string[] = [], entryId = 'llm-cursor'): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-cursor-composition-'))
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('CURSOR_ACCESS_TOKEN', '')
  await writeFile(join(root, '.credentials.yaml'), 'version: 1\nrefs: {}\n', { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '- id: authorization',
    "  name: '@deepseek-ai/dsh-authorization'",
    `- id: ${entryId}`,
    "  name: '@deepseek-ai/dsh-llm-cursor'",
    '  config:',
    '    reuseInstalledCursorLogin: false',
    ...extraConfig,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-authorization', AuthorizationService],
    ['@deepseek-ai/dsh-llm-cursor', LlmCursor],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register: () => { throw new Error('the composition test loads modules through import only') },
    getOrCreateModuleJob: () => { throw new Error('the composition test loads modules through import only') },
    resolveSync: () => { throw new Error('the composition test loads modules through import only') },
    load: () => { throw new Error('the composition test loads modules through import only') },
  }
  ctx.loader.internal = internal
  const dir = join(root, 'profile')
  initProfile(dir, ['test-cursor-bundle'])
  const bundle = join(dir, 'node_modules', 'test-cursor-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(root, 'package.json'), '{"name":"test-cursor-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-cursor-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  const rows = await readFile(configPath, 'utf8')
  await writeFile(join(bundle, 'cordis.patch.yml'), `- insert:\n${rows.split('\n').filter(Boolean).map(line => `    ${line}`).join('\n')}\n`)
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-cursor-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(root, 'package.json'), cwd: root, home: root, overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx.provide('profileContext', profile)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(Settings)
  await mountRootInclude(ctx, join(dir, 'cordis.yml'), readProfilePatches('test', profile))
  await ctx.loader.await()
  return ctx
}

describe('llm-cursor real composition', () => {
  it('exposes its live settings form beside the subscription sign-in flow', async () => {
    const ctx = await loadComposition()
    expect(ctx.settings.describe().find(row => row.ns === 'llm-cursor')).toMatchObject({
      autoGenerate: false,
      applies: 'live',
      value: {
        apiKeyEnv: 'CURSOR_ACCESS_TOKEN', reuseInstalledCursorLogin: false,
        defaultContextWindow: 200_000, modelContextWindows: {}, streamIdleTimeoutMs: 300_000,
        parkedRunTimeoutMs: 1_800_000, toolCallSettleMs: 1_000,
      },
    })
    expect(ctx.authorization.list().find(flow => flow.key === CURSOR_RECORD_KEY)?.methods.map(method => method.id)).toEqual(['oauth'])
    await ctx.configEditor.entries().find(row => row.options.id === 'llm-cursor')!.fiber!.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    expect(ctx.authorization.list().some(flow => flow.key === CURSOR_RECORD_KEY)).toBe(false)
    expect(ctx.settings.describe().some(row => row.ns === 'llm-cursor')).toBe(false)
  })

  it('addresses a custom Loader entry id from the configurable-provider directory', async () => {
    const ctx = await loadComposition([], 'cursor-subscription')
    expect(ctx.settings.describe().some(row => row.ns === 'cursor-subscription')).toBe(true)
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      { provider: 'cursor', displayName: 'Cursor', settingsNs: 'cursor-subscription', settingsPath: [] },
    ])
  })

  it('uses live context budgets on the next operation without restarting the subscription plugin', async () => {
    const ctx = await loadComposition()
    const entry = ctx.configEditor.entries().find(row => row.options.id === 'llm-cursor')!
    const fiber = entry.fiber
    await expect(ctx.llm.resolveModelInfo('cursor', 'unlisted')).resolves.toMatchObject({ context: { contextWindow: 200_000 } })
    await ctx.settings.update('llm-cursor', {
      defaultContextWindow: 160_000, modelContextWindows: { 'composer-2': 100_000 },
    })
    expect(entry.fiber === fiber).toBe(true)
    await expect(ctx.llm.resolveModelInfo('cursor', 'unlisted')).resolves.toMatchObject({ context: { contextWindow: 160_000 } })
    await expect(ctx.llm.resolveModelInfo('cursor', 'composer-2')).resolves.toMatchObject({ context: { contextWindow: 100_000 } })
    expect(ctx.authorization.list().some(flow => flow.key === CURSOR_RECORD_KEY)).toBe(true)
  })

  it('reads the current credential reference and installed-login policy on the next request', async () => {
    const readSources = vi.fn(async () => [])
    vi.spyOn(harvest, 'createDefaultHarvestSources').mockResolvedValue(readSources)
    const ctx = await loadComposition()
    const first = await assemble(ctx, { model: 'composer-2', messages: [] })
    expect(first.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(readSources).not.toHaveBeenCalled()
    await ctx.settings.update('llm-cursor', { apiKeyEnv: 'CURSOR_LIVE_TOKEN', reuseInstalledCursorLogin: true })
    const second = await assemble(ctx, { model: 'composer-2', messages: [] })
    expect(second.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    if (second.finish.kind !== 'error') throw new Error('expected a missing credential failure')
    expect(second.finish.failure.message).toContain('CURSOR_LIVE_TOKEN')
    expect(readSources).toHaveBeenCalledOnce()
    await ctx.settings.update('llm-cursor', { reuseInstalledCursorLogin: false })
    await assemble(ctx, { model: 'composer-2', messages: [] })
    expect(readSources).toHaveBeenCalledOnce()
  })

  it('updates the runtime-captured retry policy after a live edit', async () => {
    const ctx = await loadComposition()
    expect(ctx.llm.providerRetryPolicy('cursor')).toMatchObject({ mode: 'normal', maxRetries: 5 })
    await ctx.settings.update('llm-cursor', { retryPolicy: { mode: 'always' } })
    expect(ctx.llm.providerRetryPolicy('cursor')).toMatchObject({ mode: 'always' })
  })

  it('rejects invalid live retry options before changing the stored or serving configuration', async () => {
    const ctx = await loadComposition()
    const before = await readFile(ctx.settings.documentPath, 'utf8')
    await expect(ctx.settings.update('llm-cursor', {
      retryPolicy: { mode: 'normal', backoff: { initialDelayMs: 20, maxDelayMs: 10 } },
    })).rejects.toThrow(/initialDelayMs.*maxDelayMs/)
    expect(await readFile(ctx.settings.documentPath, 'utf8')).toBe(before)
    expect(ctx.llm.providerRetryPolicy('cursor')).toMatchObject({ mode: 'normal', initialDelayMs: 500, maxDelayMs: 10_000 })
    await expect(ctx.llm.resolveModelInfo('cursor', 'unlisted')).resolves.toMatchObject({ context: { contextWindow: 200_000 } })
  })

  it('resolves destination compaction budgets from profile configuration', async () => {
    const ctx = await loadComposition([
      '    defaultContextWindow: 160000',
      '    modelContextWindows:',
      '      grok-4.7-high-fast: 256000',
    ])
    await expect(ctx.llm.resolveModelInfo('cursor', 'grok-4.7-high-fast')).resolves.toMatchObject({
      context: { contextWindow: 256_000 },
    })
    await expect(ctx.llm.resolveModelInfo('cursor', 'new-live-model')).resolves.toMatchObject({
      context: { contextWindow: 160_000 },
    })
  })

  it('boots the always-on cursor route and lists the oauth flow', async () => {
    const ctx = await loadComposition()
    expect(ctx.llm.listProviders()).toEqual([{ id: 'cursor', name: 'Cursor' }])
    expect(ctx.authorization.list().some(flow => flow.key === CURSOR_RECORD_KEY)).toBe(true)
    const result = await assemble(ctx, { model: 'composer-2', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
  })
})
