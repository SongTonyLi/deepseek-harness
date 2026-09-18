/**
 * Advisory Cursor model catalog: bundled fallback, then GetUsableModels plus disk cache.
 *
 * @module @deepseek-ai/dsh-llm-cursor/catalog
 */

import { readFile } from 'node:fs/promises'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { callUnary, decodeUnaryBody } from './connect.ts'
import type { ConnectHttp2 } from './connect.ts'
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from './native/agent_pb.ts'
import { CURSOR_USABLE_MODELS_PATH, PROVIDER } from './protocol.ts'

/** One advisory catalog entry. */
export interface CursorCatalogModel {
  /** Model id passed to GenerateOptions.model. */
  id: string
  /** Selector label. */
  name: string
  /** Context capacity when known. */
  contextWindow?: number
  /** Output cap when known. */
  maxTokens?: number
}

/** Bundled models advertised before the account list is fetched. */
export const FALLBACK_MODELS: readonly CursorCatalogModel[] = [
  { id: 'composer-2', name: 'Composer 2', contextWindow: 200_000, maxTokens: 8_192 },
  { id: 'composer-2-fast', name: 'Composer 2 Fast', contextWindow: 200_000, maxTokens: 8_192 },
  { id: 'composer-1.5', name: 'Composer 1.5', contextWindow: 200_000, maxTokens: 8_192 },
  { id: 'claude-4.5-sonnet', name: 'Claude 4.5 Sonnet', contextWindow: 1_000_000, maxTokens: 64_000 },
  { id: 'claude-4.6-opus-high', name: 'Claude 4.6 Opus', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'gpt-5.1', name: 'GPT-5.1', contextWindow: 272_000, maxTokens: 16_384 },
]

const CACHE_NAME = 'usable-models.json'

function cachePath(): string {
  return dshCachePath('llm-cursor', CACHE_NAME)
}

function toInfo(model: CursorCatalogModel): LlmModelInfo {
  return { provider: PROVIDER, id: model.id, name: model.name, inputModalities: ['text'] }
}

function toResolved(model: CursorCatalogModel): LlmResolvedModelInfo {
  return {
    ...toInfo(model),
    ...model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } },
    ...model.maxTokens === undefined ? {} : { defaultMaxTokens: model.maxTokens },
  }
}

function parseCached(raw: string): CursorCatalogModel[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { models?: unknown }).models)) {
      return undefined
    }
    const models: CursorCatalogModel[] = []
    for (const entry of (parsed as { models: unknown[] }).models) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      if (typeof record.id !== 'string' || record.id.length === 0) continue
      if (typeof record.name !== 'string' || record.name.length === 0) continue
      models.push({
        id: record.id,
        name: record.name,
        ...typeof record.contextWindow === 'number' ? { contextWindow: record.contextWindow } : {},
        ...typeof record.maxTokens === 'number' ? { maxTokens: record.maxTokens } : {},
      })
    }
    return models.length > 0 ? models : undefined
  } catch {
    return undefined
  }
}

/**
 * Live catalog with fallback, disk cache, and optional GetUsableModels refresh.
 */
export class CursorCatalog {
  private models: CursorCatalogModel[] = [...FALLBACK_MODELS]
  private loaded = false

  /**
   * @param connect - injectable HTTP/2 opener for GetUsableModels.
   * @param path - cache file; defaults to `$DSH_HOME/cache/llm-cursor/usable-models.json`.
   */
  constructor(
    private readonly connect?: ConnectHttp2,
    private readonly path: string = cachePath(),
  ) {}

  /**
   * Advisory models for the `cursor` route.
   * @returns current catalog, fallback until a fetch or cache lands.
   */
  list(): LlmModelInfo[] {
    return this.models.map(toInfo)
  }

  /**
   * Exact-model metadata. Unlisted ids still resolve as text-only routes.
   * @param model - GenerateOptions.model.
   * @returns resolved metadata.
   */
  resolve(model: string): LlmResolvedModelInfo {
    const found = this.models.find(entry => entry.id === model)
    if (found !== undefined) return toResolved(found)
    return { provider: PROVIDER, id: model, name: model, inputModalities: ['text'] }
  }

  /**
   * Load the disk cache if this process has not yet.
   * @returns once the in-memory catalog reflects disk or fallback.
   */
  async hydrate(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const cached = parseCached(await readFile(this.path, 'utf8'))
      if (cached !== undefined) this.models = cached
    } catch (_missingCache) {
      // Missing cache keeps the bundled fallback.
    }
  }

  /**
   * Replace the catalog from GetUsableModels. Failures keep the previous list.
   * @param accessToken - bearer token.
   * @param signal - caller abort.
   * @returns once the attempt has settled.
   */
  async refresh(accessToken: string, signal?: AbortSignal): Promise<void> {
    try {
      const requestBytes = toBinary(GetUsableModelsRequestSchema, create(GetUsableModelsRequestSchema, {}))
      const response = await callUnary({
        accessToken,
        rpcPath: CURSOR_USABLE_MODELS_PATH,
        ...signal === undefined ? {} : { signal },
      }, requestBytes, this.connect)
      if (response.status < 200 || response.status >= 300 || response.body.length === 0) return
      const payload = decodeUnaryBody(response.body)
      let decoded
      try {
        decoded = fromBinary(GetUsableModelsResponseSchema, payload)
      } catch (_unframedBody) {
        decoded = fromBinary(GetUsableModelsResponseSchema, response.body)
      }
      const models = decoded.models
        .map(entry => ({
          id: entry.modelId,
          name: entry.displayName || entry.displayModelId || entry.modelId,
        }))
        .filter(entry => entry.id.length > 0)
      if (models.length === 0) return
      this.models = models
      this.loaded = true
      await writeFileAtomic(this.path, `${JSON.stringify({ models })}\n`, { mode: 0o600, dirMode: 0o700 })
    } catch (_catalogRefreshFailed) {
      // Best-effort: a failed fetch must not fail login or the request.
    }
  }
}
