/**
 * Translate one Cursor Connect Run into harness StreamChunks.
 *
 * @module @deepseek-ai/dsh-llm-cursor/stream
 */

import { pathToFileURL } from 'node:url'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { IdleWatchdog } from '@deepseek-ai/dsh-timeout'
import { openConnectStream } from './connect.ts'
import type { ConnectFrame, ConnectHttp2, CursorConnectStream } from './connect.ts'
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientThrowSchema,
  GetBlobResultSchema,
  InteractionResponseSchema,
  KvClientMessageSchema,
  RequestContextEnvSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  WebSearchRequestResponse_ApprovedSchema,
  WebSearchRequestResponseSchema,
  type AgentServerMessage,
  type ExecServerMessage,
  type InteractionQuery,
  type KvServerMessage,
  type McpToolDefinition,
} from './native/agent_pb.ts'
import { CURSOR_RUN_PATH } from './protocol.ts'
import { buildCursorRun, decodeMcpArgsMap } from './request.ts'

/** Open a Connect stream; tests inject a fake. */
export type OpenCursorStream = (input: {
  accessToken: string
  rpcPath: string
  signal?: AbortSignal
}) => CursorConnectStream

interface OpenBlock {
  index: number
  type: 'text' | 'reasoning'
  text: string
}

function sendClient(stream: CursorConnectStream, message: Parameters<typeof create<typeof AgentClientMessageSchema>>[1]): void {
  stream.write(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, message)))
}

function answerKv(stream: CursorConnectStream, kv: KvServerMessage, blobStore: Map<string, Uint8Array>): void {
  const kvCase = kv.message.case
  if (kvCase === 'getBlobArgs') {
    const blobIdKey = Buffer.from(kv.message.value.blobId).toString('hex')
    const blobData = blobStore.get(blobIdKey)
    if (blobData === undefined) {
      throw new LlmError(`llm-cursor: Cursor asked for blob ${blobIdKey.slice(0, 16)} that is not in the local store`, 'STREAM_CLOSED')
    }
    sendClient(stream, {
      message: {
        case: 'kvClientMessage',
        value: create(KvClientMessageSchema, {
          id: kv.id,
          message: { case: 'getBlobResult', value: create(GetBlobResultSchema, { blobData }) },
        }),
      },
    })
    return
  }
  if (kvCase === 'setBlobArgs') {
    const { blobId, blobData } = kv.message.value
    blobStore.set(Buffer.from(blobId).toString('hex'), blobData)
    sendClient(stream, {
      message: {
        case: 'kvClientMessage',
        value: create(KvClientMessageSchema, {
          id: kv.id,
          message: { case: 'setBlobResult', value: create(SetBlobResultSchema, {}) },
        }),
      },
    })
    return
  }
  throw new LlmError('llm-cursor: unanswered Cursor KV message', 'STREAM_CLOSED')
}

function answerRequestContext(stream: CursorConnectStream, exec: ExecServerMessage, mcpTools: McpToolDefinition[]): void {
  const env = create(RequestContextEnvSchema, { workspacePaths: [pathToFileURL(process.cwd()).href] })
  const requestContext = create(RequestContextSchema, {
    rules: [],
    env,
    repositoryInfo: [],
    tools: mcpTools,
    gitRepos: [],
    projectLayouts: [],
    mcpInstructions: [],
    fileContents: {},
    customSubagents: [],
  })
  sendClient(stream, {
    message: {
      case: 'execClientMessage',
      value: create(ExecClientMessageSchema, {
        id: exec.id,
        execId: exec.execId,
        message: {
          case: 'requestContextResult',
          value: create(RequestContextResultSchema, {
            result: { case: 'success', value: create(RequestContextSuccessSchema, { requestContext }) },
          }),
        },
      }),
    },
  })
}

function rejectNativeExec(stream: CursorConnectStream, exec: ExecServerMessage): void {
  sendClient(stream, {
    message: {
      case: 'execClientControlMessage',
      value: create(ExecClientControlMessageSchema, {
        message: {
          case: 'throw',
          value: create(ExecClientThrowSchema, {
            id: exec.id,
            error: 'This native Cursor tool is not available in DeepSeek Harness. Use the MCP tools provided instead.',
          }),
        },
      }),
    },
  })
}

function approveWebSearch(stream: CursorConnectStream, query: InteractionQuery): void {
  sendClient(stream, {
    message: {
      case: 'interactionResponse',
      value: create(InteractionResponseSchema, {
        id: query.id,
        result: {
          case: 'webSearchRequestResponse',
          value: create(WebSearchRequestResponseSchema, {
            result: { case: 'approved', value: create(WebSearchRequestResponse_ApprovedSchema, {}) },
          }),
        },
      }),
    },
  })
}

function* closeOpen(open: OpenBlock | undefined): Generator<StreamChunk> {
  if (open === undefined) return
  if (open.type === 'text') {
    yield { type: 'block-end', index: open.index, block: { type: 'text', text: open.text } }
  } else {
    yield { type: 'block-end', index: open.index, block: { type: 'reasoning', text: open.text } }
  }
}

function* emitToolCall(index: number, id: string, name: string, args: Record<string, unknown>): Generator<StreamChunk> {
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta: argumentsText }
  yield {
    type: 'block-end',
    index,
    block: { type: 'tool-call', id: ToolCallId(id), name, arguments: argumentsText },
  }
}

function settledOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Cursor stream aborted'))
    }
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
  })
}

async function nextFrame(
  watchdog: IdleWatchdog,
  iterator: AsyncIterator<ConnectFrame>,
): Promise<IteratorResult<ConnectFrame>> {
  return await Promise.race([watchdog.next(iterator), settledOnAbort(watchdog.signal)])
}

/**
 * Stream one rebuilt Cursor Run.
 * @param options - assembled model request.
 * @param accessToken - bearer token.
 * @param idleTimeoutMs - idle watchdog.
 * @param openStream - injectable Connect opener.
 * @returns StreamChunks.
 */
export async function* streamCursorRun(
  options: GenerateOptions,
  accessToken: string,
  idleTimeoutMs: number,
  openStream: OpenCursorStream = input => openConnectStream(input),
): AsyncIterable<StreamChunk> {
  const payload = buildCursorRun(options)
  const consumer = new AbortController()
  const upstream = options.signal === undefined
    ? consumer.signal
    : AbortSignal.any([options.signal, consumer.signal])
  using watchdog = idleWatchdog(upstream, idleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')
  const stream = openStream({
    accessToken,
    rpcPath: CURSOR_RUN_PATH,
    signal: watchdog.signal,
  })
  try {
    stream.write(payload.requestBytes)
    let nextIndex = 0
    let open: OpenBlock | undefined
    let outputTokens = 0
    let sawContent = false
    const iterator = stream.frames[Symbol.asyncIterator]()
    while (true) {
      let item: IteratorResult<ConnectFrame>
      try {
        item = await nextFrame(watchdog, iterator)
      } catch (error) {
        const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
        if (timeout !== undefined) {
          throw new LlmError(`llm-cursor: stream idle for ${timeout.timeoutMs}ms`, 'TIMEOUT', { cause: timeout })
        }
        if (upstream.aborted) {
          throw new LlmError('llm-cursor: request aborted', 'ABORTED', { cause: error })
        }
        throw error
      }
      if (item.done) break
      const message = fromBinary(AgentServerMessageSchema, item.value.payload)
      const chunks = handleServerMessage(message, stream, payload.blobStore, payload.mcpTools, {
        nextIndex,
        open,
        outputTokens,
        sawContent,
      })
      nextIndex = chunks.nextIndex
      open = chunks.open
      outputTokens = chunks.outputTokens
      sawContent = chunks.sawContent
      yield* chunks.chunks
      if (chunks.done !== undefined) {
        yield* closeOpen(open)
        const usage: TokenUsage = { inputTokens: 0, outputTokens }
        yield { type: 'usage', usage }
        yield chunks.done
        return
      }
    }
    throw new LlmError('llm-cursor: Cursor stream ended before turnEnded', 'STREAM_CLOSED')
  } finally {
    consumer.abort()
    stream.destroy()
  }
}

function handleServerMessage(
  message: AgentServerMessage,
  stream: CursorConnectStream,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  state: { nextIndex: number; open: OpenBlock | undefined; outputTokens: number; sawContent: boolean },
): {
  chunks: StreamChunk[]
  nextIndex: number
  open: OpenBlock | undefined
  outputTokens: number
  sawContent: boolean
  done?: Extract<StreamChunk, { type: 'finish' }>
} {
  const chunks: StreamChunk[] = []
  let { nextIndex, open, outputTokens, sawContent } = state
  const msgCase = message.message.case
  if (msgCase === 'interactionUpdate') {
    const updateCase = message.message.value.message.case
    if (updateCase === 'textDelta') {
      const text = message.message.value.message.value.text
      if (text.length > 0) {
        if (open?.type !== 'text') {
          chunks.push(...closeOpen(open))
          open = { index: nextIndex, type: 'text', text: '' }
          chunks.push({ type: 'block-start', index: nextIndex, blockType: 'text' })
          nextIndex += 1
        }
        open.text += text
        chunks.push({ type: 'text-delta', index: open.index, text })
        sawContent = true
      }
    } else if (updateCase === 'thinkingDelta') {
      const text = message.message.value.message.value.text
      if (text.length > 0) {
        if (open?.type !== 'reasoning') {
          chunks.push(...closeOpen(open))
          open = { index: nextIndex, type: 'reasoning', text: '' }
          chunks.push({ type: 'block-start', index: nextIndex, blockType: 'reasoning' })
          nextIndex += 1
        }
        open.text += text
        chunks.push({ type: 'reasoning-delta', index: open.index, text })
        sawContent = true
      }
    } else if (updateCase === 'tokenDelta') {
      outputTokens += message.message.value.message.value.tokens
    } else if (updateCase === 'turnEnded') {
      if (!sawContent && open === undefined) {
        throw new LlmError('llm-cursor: Cursor returned no content', 'EMPTY_RESPONSE')
      }
      return {
        chunks,
        nextIndex,
        open,
        outputTokens,
        sawContent,
        done: { type: 'finish', reason: { kind: 'stop' } },
      }
    }
    return { chunks, nextIndex, open, outputTokens, sawContent }
  }
  if (msgCase === 'kvServerMessage') {
    answerKv(stream, message.message.value, blobStore)
    return { chunks, nextIndex, open, outputTokens, sawContent }
  }
  if (msgCase === 'execServerMessage') {
    const exec = message.message.value
    const execCase = exec.message.case
    if (execCase === 'requestContextArgs') {
      answerRequestContext(stream, exec, mcpTools)
      return { chunks, nextIndex, open, outputTokens, sawContent }
    }
    if (execCase === 'mcpArgs') {
      const mcp = exec.message.value
      const toolName = mcp.toolName.length > 0 ? mcp.toolName : mcp.name
      chunks.push(...closeOpen(open))
      open = undefined
      chunks.push(...emitToolCall(nextIndex, mcp.toolCallId || `cursor-${exec.id}`, toolName, decodeMcpArgsMap(mcp.args)))
      nextIndex += 1
      sawContent = true
      return {
        chunks,
        nextIndex,
        open,
        outputTokens,
        sawContent,
        done: { type: 'finish', reason: { kind: 'tool-calls' } },
      }
    }
    rejectNativeExec(stream, exec)
    throw new LlmError(
      `llm-cursor: native Cursor exec "${execCase ?? 'unknown'}" is not executed by this adapter`,
      'UNSUPPORTED_CONTENT',
    )
  }
  if (msgCase === 'interactionQuery') {
    const query = message.message.value
    if (query.query.case === 'webSearchRequestQuery') {
      approveWebSearch(stream, query)
      return { chunks, nextIndex, open, outputTokens, sawContent }
    }
    throw new LlmError(
      `llm-cursor: unsupported Cursor interaction query ${query.query.case ?? 'unknown'}`,
      'UNSUPPORTED_CONTENT',
    )
  }
  return { chunks, nextIndex, open, outputTokens, sawContent }
}

/**
 * Default Connect opener used by the adapter.
 * @param connect - injectable HTTP/2; Node `http2` when omitted.
 * @returns a function that opens one AgentService/Run stream.
 */
export function createOpenCursorStream(connect?: ConnectHttp2): OpenCursorStream {
  return input => openConnectStream(input, connect)
}
