/**
 * Web-search routes for `/search`: DeepSeek's own endpoint, or the user's
 * OpenRouter DeepSeek model through OpenRouter's Anthropic-compatible
 * Messages API. A route is a write to the `web-search-deepseek` settings
 * namespace, which the provider reads at each search.
 * @module @deepseek-ai/dsh-tui-app/search-route
 */

import type { Context } from '@deepseek-ai/cordis'
import { resetSetting, setSetting, settingValue } from './catalog.ts'
import type { PickItem } from './prompts.ts'

/** Settings namespace the DeepSeek search provider registers. */
const SEARCH_NAMESPACE = 'web-search-deepseek'

/** Anthropic-compatible Messages base of OpenRouter; the provider appends `/messages`. */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/** Credential reference the shipped `openrouter` chat provider also resolves. */
const OPENROUTER_KEY_REF = 'OPENROUTER_API_KEY'

/** OpenRouter model `/search openrouter` uses when no model is typed and `/model` does not select an OpenRouter model. */
export const OPENROUTER_SEARCH_MODEL = 'deepseek/deepseek-v4-flash-0731'

/** A search route the `/search` command can select. */
export type SearchRoute = 'deepseek' | 'openrouter'

/** Picker rows for `/search`. */
export const SEARCH_ROUTE_ITEMS: readonly PickItem[] = [
  { value: 'deepseek', label: 'DeepSeek', description: 'DeepSeek native search with DEEPSEEK_API_KEY or the DeepSeek account (default)' },
  { value: 'openrouter', label: 'OpenRouter DeepSeek', description: `Search through OpenRouter with ${OPENROUTER_KEY_REF} and ${OPENROUTER_SEARCH_MODEL}` },
]

/**
 * The route the stored search settings resolve to.
 * @param ctx - plugin context carrying the optional settings service.
 * @returns `openrouter` when the resolved endpoint is OpenRouter's, otherwise `deepseek`.
 * @throws {Error} when no settings service is mounted or the namespace is not registered.
 */
export function currentSearchRoute(ctx: Context): SearchRoute {
  const { baseURL } = settingValue(ctx, SEARCH_NAMESPACE) as { baseURL?: string }
  return baseURL?.startsWith(OPENROUTER_BASE_URL) === true ? 'openrouter' : 'deepseek'
}

/**
 * Select a search route by writing the provider's settings.
 * @param ctx - plugin context carrying the optional settings service.
 * @param route - the route to select; `deepseek` clears the namespace's user overrides.
 * @param model - the OpenRouter model for `openrouter`; defaults to {@link OPENROUTER_SEARCH_MODEL}.
 * @returns a confirmation row.
 * @throws {Error} when no settings service is mounted or the namespace is not registered.
 */
export async function applySearchRoute(ctx: Context, route: SearchRoute, model?: string): Promise<string> {
  if (route === 'deepseek') {
    await resetSetting(ctx, SEARCH_NAMESPACE)
    return 'web search: DeepSeek'
  }
  const chosen = model ?? OPENROUTER_SEARCH_MODEL
  await setSetting(ctx, SEARCH_NAMESPACE, 'baseURL', OPENROUTER_BASE_URL)
  await setSetting(ctx, SEARCH_NAMESPACE, 'apiKeyEnv', OPENROUTER_KEY_REF)
  await setSetting(ctx, SEARCH_NAMESPACE, 'model', chosen)
  return `web search: OpenRouter ${chosen}`
}
