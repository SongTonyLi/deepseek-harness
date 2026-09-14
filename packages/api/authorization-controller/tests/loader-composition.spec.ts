/**
 * Real-composition guard for the sign-in surface: the authorization seam, the
 * credential store, a bare `llm-pi-ai` row, and this controller boot from a
 * test-only cordis.yml through the actual Loader + Include path. The pi-ai
 * adapter registers one flow per installed provider on mount, so what this
 * proves is the thing a hand-mounted `ctx.plugin` cannot — that the shipped
 * rows reach each other, and that the Models page's `authorization/list` finds
 * the Codex subscription login without any provider being configured first.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import AuthorizationController from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the sign-in-capable composition the web bundle composes. */
async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-signin-composition-'))
  await writeFile(join(root, '.credentials.yaml'), 'version: 1\n', { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    watch: false',
    '- id: authorization',
    "  name: '@deepseek-ai/dsh-authorization'",
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '- id: authorization-controller',
    "  name: '@deepseek-ai/dsh-api-authorization-controller'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-authorization', AuthorizationService],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-api-authorization-controller', AuthorizationController],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('the sign-in surface in a real composition', () => {
  it('offers the Codex subscription login with no provider configured', async () => {
    const ctx = await loadComposition()

    // The shipped posture: the adapter is dormant, and signing in is still offered.
    expect(ctx.llm.listProviders()).toEqual([])
    const flows = await ctx.authorizationController.list()
    const codex = flows.find(flow => flow.id === 'openai-codex')
    expect(codex).toMatchObject({
      key: 'llm-pi-ai/openai-codex',
      scope: 'llm-pi-ai',
      id: 'openai-codex',
      label: 'OpenAI Codex',
      inFlight: false,
      configured: false,
    })
    expect(codex?.methods).toEqual([{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }])
    // Every flow this surface lists addresses a provider route of one adapter family.
    expect(flows.every(flow => flow.scope === 'llm-pi-ai')).toBe(true)
    expect(flows.length).toBeGreaterThan(30)
  })

  it('reports a provider signed in once its record is stored, and forgets it on sign-out', async () => {
    const ctx = await loadComposition()
    const key = 'llm-pi-ai/openai-codex'
    await ctx.credentials.modifyRecord(
      credentialKey('llm-pi-ai', 'openai-codex'),
      () => Promise.resolve({ kind: 'grant', payload: { type: 'oauth', access: 'at', refresh: 'rt', expires: 1 } }),
    )
    const signedIn = (await ctx.authorizationController.list()).find(flow => flow.id === 'openai-codex')
    expect(signedIn).toMatchObject({ configured: true, kind: 'grant' })

    await ctx.authorizationController.signOut(key)
    const signedOut = (await ctx.authorizationController.list()).find(flow => flow.id === 'openai-codex')
    expect(signedOut).toMatchObject({ configured: false })
  })
})
