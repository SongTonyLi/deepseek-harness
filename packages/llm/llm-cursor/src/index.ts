/**
 * Cursor subscription adapter: PKCE sign-in and unofficial Connect/protobuf HTTP/2 streaming.
 *
 * @module @deepseek-ai/dsh-llm-cursor
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { CursorAdapter } from './adapter.ts'
import { CursorCatalog } from './catalog.ts'
import { Config, readAdapterOptions } from './config.ts'
import type { Options, ResolvedCursorOptions } from './config.ts'
import { createDefaultHarvestSources } from './harvest.ts'
import { registerCursorFlow } from './login.ts'
import { createCursorOauthClient } from './oauth.ts'
import { NS, PROVIDER } from './protocol.ts'
import { resolveCursorAccessToken } from './token.ts'

export type { CursorAdapterOptions } from './adapter.ts'
export { Config } from './config.ts'
export type { Options, ResolvedCursorOptions } from './config.ts'
export { CursorOauthError } from './oauth.ts'
export type { CursorOauthClient, CursorOauthDependencies, CursorOauthLoginCallbacks, CursorPkceParams } from './oauth.ts'

/** Plugin id. */
export const name = NS
/** Required services. */
export const inject = ['llm']

/**
 * Register the always-on `cursor` route, live settings form, and authorization flow.
 * Settings edits preserve this adapter and reach the next operation; retry-policy edits refresh its route registration.
 * Invalid options are rejected before persistence; active requests retain their captured options.
 * @param ctx - plugin context.
 * @param config - live composition config references.
 */
export function apply(ctx: Context, config: Config): void {
  const options = (): ResolvedCursorOptions => readAdapterOptions(config)
  options()
  ctx.on('internal/config', (fiber, next) => {
    const raw: unknown = next()
    if (fiber === ctx.fiber) readAdapterOptions(Config(raw as Options))
    return raw
  })
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const settingsNs = ctx.fiber.entry?.options.id ?? NS

  const catalog = new CursorCatalog()
  const oauth = createCursorOauthClient()
  let harvestReader: Awaited<ReturnType<typeof createDefaultHarvestSources>> | undefined
  const readHarvestSources = async () => {
    harvestReader ??= await createDefaultHarvestSources()
    return harvestReader()
  }
  const resolveAccessToken = (signal?: AbortSignal) => {
    const credentials = ctx.get('credentials')
    const current = options()
    return resolveCursorAccessToken({
      apiKeyEnv: current.apiKeyEnv,
      ...credentials === undefined ? {} : { credentials },
      environment: launchEnvironmentOf(ctx),
      reuseInstalledCursorLogin: current.reuseInstalledCursorLogin,
      refresh: (refreshToken, refreshSignal) => oauth.refreshToken(refreshToken, refreshSignal),
      readHarvestSources,
      ...signal === undefined ? {} : { signal },
    })
  }

  const adapter = new CursorAdapter({ options, resolveAccessToken, catalog })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Cursor', settingsNs, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.on('loader/volatile-update', (paths) => {
    if (paths.some(path => path[0] === 'retryPolicy')) registration.replace([PROVIDER])
  })
  ctx.effect(() => () => { adapter.dispose() })
  ctx.inject(['authorization'], (authorized) => {
    registerCursorFlow(authorized, {}, () => resolveAccessToken().then(token => catalog.refresh(token)))
  })
}
