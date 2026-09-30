/** Models the installed pi-ai catalog has not shipped yet; see catalog-supplement.ts. */
import type { Api, Model } from '@earendil-works/pi-ai'

/** Supplemental catalog models keyed by provider route, then model id; empty while pi-ai ships every listed model. */
export const CATALOG_SUPPLEMENT: Readonly<Record<string, Readonly<Record<string, Model<Api>>>>> = {}
