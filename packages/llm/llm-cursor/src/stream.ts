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
  BackgroundShellSpawnResultSchema,
  ComputerUseErrorSchema,
  ComputerUseResultSchema,
  DeleteRejectedSchema,
  DeleteResultSchema,
  DiagnosticsRejectedSchema,
  DiagnosticsResultSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientThrowSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  InteractionResponseSchema,
  KvClientMessageSchema,
  ListMcpResourcesExecResultSchema,
  ListMcpResourcesRejectedSchema,
  LsRejectedSchema,
  LsResultSchema,
  ReadMcpResourceExecResultSchema,
  ReadMcpResourceRejectedSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RecordScreenFailureSchema,
  RecordScreenResultSchema,
  RequestContextEnvSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  ShellStreamSchema,
  WebSearchRequestResponse_ApprovedSchema,
  WebSearchRequestResponseSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  type AgentServerMessage,
  type ExecClientMessage,
  type ExecServerMessage,
  type InteractionQuery,
  type KvServerMessage,
  type McpToolDefinition,
} from './native/agent_pb.ts'
import { CURSOR_RUN_PATH, MCP_PROMPT_TOOL_PREFIX } from './protocol.ts'
import { buildCursorRun, decodeMcpArgsMap } from './request.ts'
import type { CursorRunPayload } from './request.ts'

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

function answerRequestContext(stream: CursorConnectStream, exec: ExecServerMessage, payload: CursorRunPayload): void {
  const env = create(RequestContextEnvSchema, { workspacePaths: [pathToFileURL(process.cwd()).href] })
  const requestContext = create(RequestContextSchema, {
    rules: payload.rules,
    env,
    repositoryInfo: [],
    tools: payload.mcpTools,
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

/** Harness tools that stand in for each Cursor-native exec, in preference order. */
const NATIVE_TOOL_ALTERNATIVES: Readonly<Record<string, readonly string[]>> = {
  readArgs: ['read'],
  lsArgs: ['glob'],
  grepArgs: ['grep'],
  writeArgs: ['write', 'edit'],
  deleteArgs: ['bash', 'pwsh'],
  shellArgs: ['bash', 'pwsh'],
  shellStreamArgs: ['bash', 'pwsh'],
  backgroundShellSpawnArgs: ['bash', 'pwsh'],
  writeShellStdinArgs: ['bash', 'pwsh'],
  fetchArgs: ['web_fetch'],
  diagnosticsArgs: ['lsp'],
  listMcpResourcesExecArgs: ['list_mcp_resources'],
  readMcpResourceExecArgs: ['read_mcp_resource'],
}

function nativeRejectionReason(execCase: string, mcpTools: readonly McpToolDefinition[]): string {
  const offered = new Set(mcpTools.map(tool => tool.name))
  const alternative = (NATIVE_TOOL_ALTERNATIVES[execCase] ?? []).find(name => offered.has(name))
  const refusal = `Cursor's built-in ${execCase.replace(/Args$/, '')} tool is not available in DeepSeek Harness.`
  return alternative === undefined
    ? `${refusal} Use the tools whose names start with ${MCP_PROMPT_TOOL_PREFIX} instead.`
    : `${refusal} Call the ${MCP_PROMPT_TOOL_PREFIX}${alternative} tool instead.`
}

/**
 * The typed rejection one Cursor-native exec expects, so the Run stays alive
 * and the model reads the reason as a tool outcome. Unknown execs, which
 * signal wire drift, get no reply here.
 */
function nativeRejection(exec: ExecServerMessage, reason: string): ExecClientMessage['message'] | undefined {
  const args = exec.message
  const shellRejected = (command: string, workingDirectory: string) =>
    create(ShellRejectedSchema, { command, workingDirectory, reason, isReadonly: false })
  switch (args.case) {
    case 'shellArgs':
      return {
        case: 'shellResult',
        value: create(ShellResultSchema, {
          result: { case: 'rejected', value: shellRejected(args.value.command, args.value.workingDirectory) },
        }),
      }
    case 'shellStreamArgs':
      return {
        case: 'shellStream',
        value: create(ShellStreamSchema, {
          event: { case: 'rejected', value: shellRejected(args.value.command, args.value.workingDirectory) },
        }),
      }
    case 'backgroundShellSpawnArgs':
      return {
        case: 'backgroundShellSpawnResult',
        value: create(BackgroundShellSpawnResultSchema, {
          result: { case: 'rejected', value: shellRejected(args.value.command, args.value.workingDirectory) },
        }),
      }
    case 'writeShellStdinArgs':
      return {
        case: 'writeShellStdinResult',
        value: create(WriteShellStdinResultSchema, {
          result: { case: 'error', value: create(WriteShellStdinErrorSchema, { error: reason }) },
        }),
      }
    case 'writeArgs':
      return {
        case: 'writeResult',
        value: create(WriteResultSchema, {
          result: { case: 'rejected', value: create(WriteRejectedSchema, { path: args.value.path, reason }) },
        }),
      }
    case 'deleteArgs':
      return {
        case: 'deleteResult',
        value: create(DeleteResultSchema, {
          result: { case: 'rejected', value: create(DeleteRejectedSchema, { path: args.value.path, reason }) },
        }),
      }
    case 'grepArgs':
      return {
        case: 'grepResult',
        value: create(GrepResultSchema, { result: { case: 'error', value: create(GrepErrorSchema, { error: reason }) } }),
      }
    case 'readArgs':
      return {
        case: 'readResult',
        value: create(ReadResultSchema, {
          result: { case: 'rejected', value: create(ReadRejectedSchema, { path: args.value.path, reason }) },
        }),
      }
    case 'lsArgs':
      return {
        case: 'lsResult',
        value: create(LsResultSchema, {
          result: { case: 'rejected', value: create(LsRejectedSchema, { path: args.value.path, reason }) },
        }),
      }
    case 'diagnosticsArgs':
      return {
        case: 'diagnosticsResult',
        value: create(DiagnosticsResultSchema, {
          result: { case: 'rejected', value: create(DiagnosticsRejectedSchema, { path: args.value.path, reason }) },
        }),
      }
    case 'listMcpResourcesExecArgs':
      return {
        case: 'listMcpResourcesExecResult',
        value: create(ListMcpResourcesExecResultSchema, {
          result: { case: 'rejected', value: create(ListMcpResourcesRejectedSchema, { reason }) },
        }),
      }
    case 'readMcpResourceExecArgs':
      return {
        case: 'readMcpResourceExecResult',
        value: create(ReadMcpResourceExecResultSchema, {
          result: { case: 'rejected', value: create(ReadMcpResourceRejectedSchema, { uri: args.value.uri, reason }) },
        }),
      }
    case 'fetchArgs':
      return {
        case: 'fetchResult',
        value: create(FetchResultSchema, {
          result: { case: 'error', value: create(FetchErrorSchema, { url: args.value.url, error: reason }) },
        }),
      }
    case 'recordScreenArgs':
      return {
        case: 'recordScreenResult',
        value: create(RecordScreenResultSchema, {
          result: { case: 'failure', value: create(RecordScreenFailureSchema, { error: reason }) },
        }),
      }
    case 'computerUseArgs':
      return {
        case: 'computerUseResult',
        value: create(ComputerUseResultSchema, {
          result: {
            case: 'error',
            value: create(ComputerUseErrorSchema, { error: reason, actionCount: args.value.actions.length, durationMs: 0 }),
          },
        }),
      }
    default:
      // requestContextArgs and mcpArgs are answered before this point; anything else is wire drift.
      return undefined
  }
}

/** Answer a Cursor-native exec with its typed rejection; false when the exec is unknown. */
function answerNativeExec(stream: CursorConnectStream, exec: ExecServerMessage, mcpTools: readonly McpToolDefinition[]): boolean {
  const reply = nativeRejection(exec, nativeRejectionReason(exec.message.case ?? '', mcpTools))
  if (reply === undefined) return false
  sendClient(stream, {
    message: {
      case: 'execClientMessage',
      value: create(ExecClientMessageSchema, { id: exec.id, execId: exec.execId, message: reply }),
    },
  })
  return true
}

function rejectUnknownExec(stream: CursorConnectStream, exec: ExecServerMessage): void {
  sendClient(stream, {
    message: {
      case: 'execClientControlMessage',
      value: create(ExecClientControlMessageSchema, {
        message: {
          case: 'throw',
          value: create(ExecClientThrowSchema, {
            id: exec.id,
            error: 'This Cursor exec is not supported by DeepSeek Harness. Use the MCP tools provided instead.',
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

/** The harness tool name behind one Cursor MCP exec; a model may echo the replayed `mcp_dsh_` form. */
function harnessToolName(mcp: { name: string; toolName: string }): string {
  const name = mcp.toolName.length > 0 ? mcp.toolName : mcp.name
  return name.startsWith(MCP_PROMPT_TOOL_PREFIX) ? name.slice(MCP_PROMPT_TOOL_PREFIX.length) : name
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
      const chunks = handleServerMessage(message, stream, payload, {
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
        const usage: TokenUsage = { inputTokens: payload.inputTokenEstimate, outputTokens }
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
  payload: CursorRunPayload,
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
    answerKv(stream, message.message.value, payload.blobStore)
    return { chunks, nextIndex, open, outputTokens, sawContent }
  }
  if (msgCase === 'execServerMessage') {
    const exec = message.message.value
    const execCase = exec.message.case
    if (execCase === 'requestContextArgs') {
      answerRequestContext(stream, exec, payload)
      return { chunks, nextIndex, open, outputTokens, sawContent }
    }
    if (execCase === 'mcpArgs') {
      const mcp = exec.message.value
      chunks.push(...closeOpen(open))
      open = undefined
      chunks.push(...emitToolCall(nextIndex, mcp.toolCallId || `cursor-${exec.id}`, harnessToolName(mcp), decodeMcpArgsMap(mcp.args)))
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
    if (answerNativeExec(stream, exec, payload.mcpTools)) {
      return { chunks, nextIndex, open, outputTokens, sawContent }
    }
    rejectUnknownExec(stream, exec)
    throw new LlmError(
      `llm-cursor: Cursor exec "${execCase ?? 'unknown'}" is not supported by this adapter`,
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
