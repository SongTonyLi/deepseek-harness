/**
 * Models the installed pi-ai catalog has not shipped yet.
 *
 * Entries merge into {@link catalogModels} only when the upstream catalog
 * lacks the same id, so a pi-ai upgrade that adds the model drops the
 * supplement automatically.
 *
 * @module dsh-llm-pi-ai/catalog-supplement
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import { CATALOG_SUPPLEMENT } from './catalog-supplement-data.ts'

/** One provider route's supplemental models, keyed by model id. */
const SUPPLEMENT: Readonly<Record<string, Readonly<Record<string, Model<Api>>>>> = CATALOG_SUPPLEMENT

/**
 * Supplemental catalog models for one pi-ai provider route.
 * @param provider - provider route key.
 * @returns models to merge when the installed catalog omits them.
 */
export function supplementalCatalogModels(provider: string): readonly Model<Api>[] {
  const route = SUPPLEMENT[provider]
  if (route === undefined) return []
  return Object.values(route)
}
