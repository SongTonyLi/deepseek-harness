/**
 * Always-on `cursor` route: PKCE grant, unofficial Connect/protobuf HTTP/2 streaming.
 *
 * @module @deepseek-ai/dsh-llm-cursor/adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { CursorCatalog } from './catalog.ts'
import type { ResolvedCursorOptions } from './config.ts'
import type { ConnectHttp2 } from './connect.ts'
import { CursorRunRegistry } from './park.ts'
import { PROVIDER } from './protocol.ts'
import { createOpenCursorStream, streamCursorRun } from './stream.ts'
import type { OpenCursorStream } from './stream.ts'

/** Construction seams the plugin fills. */
export interface CursorAdapterOptions {
  /** Current resolved config. */
  options: () => ResolvedCursorOptions
  /** Request-time access token. */
  resolveAccessToken: (signal?: AbortSignal) => Promise<string>
  /** Advisory catalog. */
  catalog: CursorCatalog
  /** Injectable HTTP/2 opener. */
  connect?: ConnectHttp2
  /** Injectable Connect stream opener. */
  openStream?: OpenCursorStream
}

/**
 * Adapter instance registered for the `cursor` route.
 */
export class CursorAdapter extends LlmAdapter {
  private readonly openStream: OpenCursorStream
  /** Runs parked on tool calls, resumed by the request that carries their results. */
  private readonly runs = new CursorRunRegistry()

  /**
   * @param config - resolved options, token resolver, catalog, and transport.
   */
  constructor(private readonly config: CursorAdapterOptions) {
    super()
    this.openStream = config.openStream ?? createOpenCursorStream(config.connect)
  }

  /**
   * @param provider - registered route.
   * @returns display metadata.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Cursor' }
  }

  /**
   * @param _provider - registered route.
   * @returns the retry policy captured with the current config.
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  /**
   * @param _provider - registered route.
   * @returns advisory models.
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    await this.config.catalog.hydrate()
    return this.config.catalog.list()
  }

  /**
   * @param provider - registered route.
   * @param model - exact model id.
   * @returns resolved metadata.
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.config.catalog.hydrate()
    const resolved = this.config.catalog.resolve(model)
    return { ...resolved, provider }
  }

  /**
   * @param options - assembled request.
   * @returns StreamChunks.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== PROVIDER) {
      throw new LlmError(`llm-cursor: unknown provider route "${options.provider}"`, 'NO_ADAPTER')
    }
    if (options.stop !== undefined) {
      throw new LlmError('llm-cursor does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    const connection = this.config.options()
    const accessToken = await this.config.resolveAccessToken(options.signal)
    void this.config.catalog.refresh(accessToken, options.signal).catch((_catalogRefreshFailed: unknown) => {
      // Best-effort: a failed fetch must not fail the request.
    })
    yield* streamCursorRun(options, accessToken, connection, this.openStream, this.runs)
  }

  /** Close every parked Run; the plugin calls this when it is disposed. */
  dispose(): void {
    this.runs.closeAll()
  }
}
