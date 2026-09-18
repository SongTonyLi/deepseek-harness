/**
 * Cursor subscription adapter: PKCE sign-in and unofficial Connect/protobuf HTTP/2 streaming.
 *
 * @module @deepseek-ai/dsh-llm-cursor
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { CursorAdapter } from './adapter.ts'
import { CursorCatalog } from './catalog.ts'
import { Config, resolveAdapterOptions } from './config.ts'
import type { ResolvedCursorOptions } from './config.ts'
import { createDefaultHarvestSources } from './harvest.ts'
import { registerCursorFlow } from './login.ts'
import { createCursorOauthClient } from './oauth.ts'
import { NS, PROVIDER } from './protocol.ts'
import { resolveCursorAccessToken } from './token.ts'

export { CursorAdapter } from './adapter.ts'
export type { CursorAdapterOptions } from './adapter.ts'
export { Config, resolveAdapterOptions } from './config.ts'
export type { ResolvedCursorOptions } from './config.ts'
export { FALLBACK_MODELS } from './catalog.ts'
export { CursorOauthError, createCursorOauthClient } from './oauth.ts'
export type { CursorOauthClient, CursorOauthDependencies, CursorOauthLoginCallbacks, CursorPkceParams } from './oauth.ts'
export { harvestInstalledCursorLogin, readInstalledCursorSources, windowsUsernameFromEnv } from './harvest.ts'
export { conversationFromOptions, buildCursorRun, buildMcpToolDefinitions } from './request.ts'
export { frameConnectMessage, parseConnectEndStream, decodeUnaryBody, createConnectFrameParser } from './connect.ts'
export { CURSOR_RECORD_KEY } from './token.ts'
export { NS, PROVIDER, DEFAULT_API_KEY_ENV } from './protocol.ts'

/** Plugin id. */
export const name = NS
/** Required services. */
export const inject = ['llm']

/**
 * Register the always-on `cursor` route, settings section, and authorization flow.
 * @param ctx - plugin context.
 * @param config - composition config.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedCursorOptions | undefined
  const options = (): ResolvedCursorOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-cursor: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const catalog = new CursorCatalog()
  const oauth = createCursorOauthClient()
  let harvestReader: Awaited<ReturnType<typeof createDefaultHarvestSources>> | undefined
  const readHarvestSources = async () => {
    harvestReader ??= await createDefaultHarvestSources()
    return harvestReader()
  }
  const resolveAccessToken = (signal?: AbortSignal) => {
    const credentials = ctx.get('credentials')
    return resolveCursorAccessToken({
      apiKeyEnv: options().apiKeyEnv,
      ...credentials === undefined ? {} : { credentials },
      environment: launchEnvironmentOf(ctx),
      reuseInstalledCursorLogin: options().reuseInstalledCursorLogin,
      refresh: (refreshToken, refreshSignal) => oauth.refreshToken(refreshToken, refreshSignal),
      readHarvestSources,
      ...signal === undefined ? {} : { signal },
    })
  }

  const adapter = new CursorAdapter({ options, resolveAccessToken, catalog })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Cursor', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  ctx.inject(['authorization'], (authorized) => {
    registerCursorFlow(authorized, {}, () => resolveAccessToken().then(token => catalog.refresh(token)))
  })

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: ensureRegistrationFacts,
    })
  })
}
