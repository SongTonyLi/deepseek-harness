/**
 * Translate Cursor Connect Runs into harness StreamChunks, one DSH step at a time.
 *
 * @module @deepseek-ai/dsh-llm-cursor/stream
 */

import { pathToFileURL } from 'node:url'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { openConnectStream } from './connect.ts'
import type { ConnectFrame, ConnectHttp2, CursorConnectStream } from './connect.ts'
import {
  AfterAgentResponseRequestResponseSchema,
  AfterAgentThoughtRequestResponseSchema,
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionRejectedSchema,
  AskQuestionResultSchema,
  BackgroundShellSpawnResultSchema,
  BeforeSubmitPromptRequestResponseSchema,
  ComputerUseErrorSchema,
  ComputerUseResultSchema,
  DeleteRejectedSchema,
  DeleteResultSchema,
  DiagnosticsRejectedSchema,
  DiagnosticsResultSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientThrowSchema,
  ExecuteHookResponseSchema,
  ExecuteHookResultSchema,
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
  McpStateExecResultSchema,
  McpStateServerSchema,
  McpStateSuccessSchema,
  PiBashExecErrorSchema,
  PiBashExecResultSchema,
  PiEditExecRejectedSchema,
  PiEditExecResultSchema,
  PiFindExecErrorSchema,
  PiFindExecResultSchema,
  PiGrepExecErrorSchema,
  PiGrepExecResultSchema,
  PiLsExecErrorSchema,
  PiLsExecResultSchema,
  PiReadExecErrorSchema,
  PiReadExecResultSchema,
  PiWriteExecRejectedSchema,
  PiWriteExecResultSchema,
  PostToolUseFailureRequestResponseSchema,
  PostToolUseRequestResponseSchema,
  PreCompactRequestResponseSchema,
  PreToolUseRequestResponseSchema,
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
  StopRequestResponseSchema,
  SubagentStartRequestResponseSchema,
  SubagentStopRequestResponseSchema,
  WebSearchRequestResponse_ApprovedSchema,
  WebSearchRequestResponseSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  type AgentServerMessage,
  type ExecClientMessage,
  type ExecServerMessage,
  type ExecuteHookRequest,
  type InteractionQuery,
  type KvServerMessage,
  type McpStateExecArgs,
  type McpToolDefinition,
} from './native/agent_pb.ts'
import { CursorRun, parkFingerprint } from './park.ts'
import type { CursorRunRegistry } from './park.ts'
import { CURSOR_RUN_PATH, DYNAMIC_TOOL_CALL, MCP_PROMPT_TOOL_PREFIX, MCP_PROVIDER_IDENTIFIER } from './protocol.ts'
import { buildCursorRun, decodeMcpArgsMap, estimateRequestInputTokens } from './request.ts'
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

function answerMcpState(
  stream: CursorConnectStream,
  exec: ExecServerMessage,
  args: McpStateExecArgs,
  mcpTools: readonly McpToolDefinition[],
): void {
  const wanted = args.serverIdentifiers.length > 0 ? new Set(args.serverIdentifiers) : undefined
  const byProvider = new Map<string, McpToolDefinition[]>()
  for (const tool of mcpTools) {
    const existing = byProvider.get(tool.providerIdentifier)
    if (existing) existing.push(tool)
    else byProvider.set(tool.providerIdentifier, [tool])
  }
  const servers = [...byProvider]
    .filter(([identifier]) => wanted === undefined || wanted.has(identifier))
    .map(([identifier, tools]) => create(McpStateServerSchema, {
      serverName: identifier,
      serverIdentifier: identifier,
      tools,
      status: 'connected',
    }))
  sendClient(stream, {
    message: {
      case: 'execClientMessage',
      value: create(ExecClientMessageSchema, {
        id: exec.id,
        execId: exec.execId,
        message: {
          case: 'mcpStateExecResult',
          value: create(McpStateExecResultSchema, {
            result: { case: 'success', value: create(McpStateSuccessSchema, { servers }) },
          }),
        },
      }),
    },
  })
}

type HookResponseCase = Exclude<
  NonNullable<Parameters<typeof create<typeof ExecuteHookResponseSchema>>[1]>['response'],
  undefined
>

function hookResult(response: HookResponseCase): ReturnType<typeof create<typeof ExecuteHookResultSchema>> {
  return create(ExecuteHookResultSchema, {
    response: create(ExecuteHookResponseSchema, { response }),
  })
}

function neutralHookResponse(
  request: ExecuteHookRequest | undefined,
): ReturnType<typeof create<typeof ExecuteHookResultSchema>> | undefined {
  switch (request?.request.case) {
    case 'preCompact':
      return hookResult({ case: 'preCompact', value: create(PreCompactRequestResponseSchema, {}) })
    case 'subagentStart':
      return hookResult({ case: 'subagentStart', value: create(SubagentStartRequestResponseSchema, {}) })
    case 'subagentStop':
      return hookResult({ case: 'subagentStop', value: create(SubagentStopRequestResponseSchema, {}) })
    case 'preToolUse':
      return hookResult({ case: 'preToolUse', value: create(PreToolUseRequestResponseSchema, {}) })
    case 'postToolUse':
      return hookResult({ case: 'postToolUse', value: create(PostToolUseRequestResponseSchema, {}) })
    case 'postToolUseFailure':
      return hookResult({ case: 'postToolUseFailure', value: create(PostToolUseFailureRequestResponseSchema, {}) })
    case 'beforeSubmitPrompt':
      return hookResult({ case: 'beforeSubmitPrompt', value: create(BeforeSubmitPromptRequestResponseSchema, {}) })
    case 'afterAgentResponse':
      return hookResult({ case: 'afterAgentResponse', value: create(AfterAgentResponseRequestResponseSchema, {}) })
    case 'afterAgentThought':
      return hookResult({ case: 'afterAgentThought', value: create(AfterAgentThoughtRequestResponseSchema, {}) })
    case 'stop':
      return hookResult({ case: 'stop', value: create(StopRequestResponseSchema, {}) })
    default:
      return undefined
  }
}

function answerHook(stream: CursorConnectStream, exec: ExecServerMessage, request: ExecuteHookRequest | undefined): boolean {
  const result = neutralHookResponse(request)
  if (result === undefined) return false
  sendClient(stream, {
    message: {
      case: 'execClientMessage',
      value: create(ExecClientMessageSchema, {
        id: exec.id,
        execId: exec.execId,
        message: { case: 'executeHookResult', value: result },
      }),
    },
  })
  return true
}

/** Harness tools that stand in for each Cursor-native exec, in preference order. */
const NATIVE_TOOL_ALTERNATIVES: Readonly<Record<string, readonly string[]>> = {
  readArgs: ['read'],
  redactedReadArgs: ['read'],
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
  piReadArgs: ['read'],
  piBashArgs: ['bash', 'pwsh'],
  piEditArgs: ['write', 'edit'],
  piWriteArgs: ['write', 'edit'],
  piGrepArgs: ['grep'],
  piFindArgs: ['glob'],
  piLsArgs: ['glob'],
  miniSweAgentBashArgs: ['bash', 'pwsh'],
}

function nativeRejectionReason(execCase: string, mcpTools: readonly McpToolDefinition[]): string {
  const offered = new Set(mcpTools.map(tool => tool.name))
  const alternative = (NATIVE_TOOL_ALTERNATIVES[execCase] ?? []).find(name => offered.has(name))
  const refusal = `Cursor's built-in ${execCase.replace(/Args$/, '')} tool is not available in DeepSeek Harness.`
  return alternative === undefined
    ? `${refusal} Call a tool in namespace "${MCP_PROVIDER_IDENTIFIER}" with ${DYNAMIC_TOOL_CALL} instead.`
    : `${refusal} Call ${DYNAMIC_TOOL_CALL} with namespace "${MCP_PROVIDER_IDENTIFIER}" and toolName "${alternative}" instead.`
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
    case 'redactedReadArgs':
      return {
        case: 'redactedReadResult',
        value: create(ReadResultSchema, {
          result: { case: 'rejected', value: create(ReadRejectedSchema, { path: args.value.path, reason }) },
        }),
      }
    case 'miniSweAgentBashArgs':
      return {
        case: 'miniSweAgentBashResult',
        value: create(ShellResultSchema, {
          result: { case: 'rejected', value: shellRejected(args.value.command, args.value.workingDirectory) },
        }),
      }
    case 'piReadArgs':
      return {
        case: 'piReadResult',
        value: create(PiReadExecResultSchema, {
          result: { case: 'error', value: create(PiReadExecErrorSchema, { error: reason }) },
        }),
      }
    case 'piBashArgs':
      return {
        case: 'piBashResult',
        value: create(PiBashExecResultSchema, {
          result: { case: 'error', value: create(PiBashExecErrorSchema, { error: reason }) },
        }),
      }
    case 'piEditArgs':
      return {
        case: 'piEditResult',
        value: create(PiEditExecResultSchema, {
          result: { case: 'rejected', value: create(PiEditExecRejectedSchema, { reason }) },
        }),
      }
    case 'piWriteArgs':
      return {
        case: 'piWriteResult',
        value: create(PiWriteExecResultSchema, {
          result: { case: 'rejected', value: create(PiWriteExecRejectedSchema, { reason }) },
        }),
      }
    case 'piGrepArgs':
      return {
        case: 'piGrepResult',
        value: create(PiGrepExecResultSchema, {
          result: { case: 'error', value: create(PiGrepExecErrorSchema, { error: reason }) },
        }),
      }
    case 'piFindArgs':
      return {
        case: 'piFindResult',
        value: create(PiFindExecResultSchema, {
          result: { case: 'error', value: create(PiFindExecErrorSchema, { error: reason }) },
        }),
      }
    case 'piLsArgs':
      return {
        case: 'piLsResult',
        value: create(PiLsExecResultSchema, {
          result: { case: 'error', value: create(PiLsExecErrorSchema, { error: reason }) },
        }),
      }
    default:
      // requestContextArgs, mcpArgs, mcpStateExecArgs, and executeHookArgs are
      // answered before this point; anything else is an exec this build cannot
      // type, answered with ExecClientThrow so the Run can continue.
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

/** A human answer must return through a logged harness tool result or later user message. */
function rejectNativeQuestion(stream: CursorConnectStream, query: InteractionQuery, mcpTools: readonly McpToolDefinition[]): void {
  const questionTool = mcpTools.some(tool => tool.name === 'ask_user_question')
  const refusal = 'Cursor\'s built-in AskQuestion is not available in DeepSeek Harness.'
  const reason = questionTool
    ? `${refusal} Call ${DYNAMIC_TOOL_CALL} with namespace "${MCP_PROVIDER_IDENTIFIER}" and toolName "ask_user_question" instead.`
    : `${refusal} Ask the user in a reply before continuing.`
  sendClient(stream, {
    message: {
      case: 'interactionResponse',
      value: create(InteractionResponseSchema, {
        id: query.id,
        result: {
          case: 'askQuestionInteractionResponse',
          value: create(AskQuestionInteractionResponseSchema, {
            result: create(AskQuestionResultSchema, {
              result: { case: 'rejected', value: create(AskQuestionRejectedSchema, { reason }) },
            }),
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

/** Resolves `undefined` after `ms`; the timer is cleared by the returned disposer. */
function settleTimer(ms: number): { elapsed: Promise<undefined>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const elapsed = new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined) }, ms) })
  return { elapsed, clear: () => { clearTimeout(timer) } }
}

/** Streaming knobs {@link streamCursorRun} reads from the resolved adapter options. */
export interface CursorStreamTiming {
  /** Idle watchdog interval for one outstanding read. */
  streamIdleTimeoutMs: number
  /** Lifetime of a Run parked on tool calls. */
  parkedRunTimeoutMs: number
  /** Wait for further parallel tool calls after one arrives. */
  toolCallSettleMs: number
}

/** Mutable per-step translation state. */
interface StepState {
  nextIndex: number
  open: OpenBlock | undefined
  outputTokens: number
  sawContent: boolean
  /** Harness tool-call ids emitted this step. */
  toolCallIds: string[]
}

/**
 * Stream one DSH step on a Cursor Run. A request that carries the results of
 * the Session's parked Run resumes that Run; any other request opens a new Run
 * rebuilt from history. A step that ends on MCP tool calls parks its Run
 * instead of closing it when the request names a Session and is not a
 * compaction or title request.
 * @param options - assembled model request.
 * @param accessToken - bearer token for a new Run.
 * @param timing - idle, park, and settle intervals.
 * @param openStream - injectable Connect opener.
 * @param registry - parked Runs; omit to close every Run when its step ends.
 * @returns StreamChunks.
 */
export async function* streamCursorRun(
  options: GenerateOptions,
  accessToken: string,
  timing: CursorStreamTiming,
  openStream: OpenCursorStream = input => openConnectStream(input),
  registry?: CursorRunRegistry,
): AsyncIterable<StreamChunk> {
  const sessionId = options.purpose === undefined ? options.sessionId : undefined
  const resumed = sessionId === undefined ? undefined : registry?.take(sessionId, options)
  if (resumed !== undefined) {
    const produced = { chunks: false }
    try {
      resumed.run.sendResults(resumed.answers)
      yield* stepOnRun(resumed.run, options, estimateRequestInputTokens(options), timing, produced, sessionId, registry)
      return
    } catch (error) {
      // A Run that died while parked fails its first read. When nothing reached
      // the caller and the caller neither cancelled nor timed out, the step
      // continues on a new Run rebuilt from history.
      const cancelled = options.signal?.aborted === true || (error instanceof LlmError && error.code === 'TIMEOUT')
      if (produced.chunks || cancelled) throw error
    }
  }
  const payload = buildCursorRun(options)
  const run = new CursorRun(openStream({ accessToken, rpcPath: CURSOR_RUN_PATH }), payload)
  run.stream.write(payload.requestBytes)
  yield* stepOnRun(run, options, payload.inputTokenEstimate, timing, { chunks: false }, sessionId, registry)
}

async function* stepOnRun(
  run: CursorRun,
  options: GenerateOptions,
  inputTokens: number,
  timing: CursorStreamTiming,
  produced: { chunks: boolean },
  sessionId: string | undefined,
  registry: CursorRunRegistry | undefined,
): AsyncIterable<StreamChunk> {
  using watchdog = idleWatchdog(options.signal, timing.streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')
  let parked = false
  // The caller may abort a finished step's signal; a parked Run outlives it.
  const onAbort = (): void => { if (!parked) run.close() }
  watchdog.signal.addEventListener('abort', onAbort, { once: true })
  const reader: AsyncIterator<ConnectFrame> = { next: () => run.next() }
  const state: StepState = { nextIndex: 0, open: undefined, outputTokens: 0, sawContent: false, toolCallIds: [] }
  const finish = function* (reason: Extract<StreamChunk, { type: 'finish' }>['reason']): Generator<StreamChunk> {
    yield* closeOpen(state.open)
    state.open = undefined
    const usage: TokenUsage = { inputTokens, outputTokens: state.outputTokens }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason }
  }
  try {
    while (true) {
      const settle = state.toolCallIds.length > 0 ? settleTimer(timing.toolCallSettleMs) : undefined
      let item: IteratorResult<ConnectFrame> | undefined
      try {
        const read = Promise.race([watchdog.next(reader), settledOnAbort(watchdog.signal)])
        item = settle === undefined ? await read : await Promise.race([read, settle.elapsed])
      } catch (error) {
        const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
        if (timeout !== undefined) {
          throw new LlmError(`llm-cursor: stream idle for ${timeout.timeoutMs}ms`, 'TIMEOUT', { cause: timeout })
        }
        if (options.signal?.aborted === true) {
          throw new LlmError('llm-cursor: request aborted', 'ABORTED', { cause: error })
        }
        throw error
      } finally {
        settle?.clear()
      }
      if (item?.done === true) {
        // A stream that closes after tool calls leaves nothing to park; the
        // next step rebuilds the Run from history.
        if (state.toolCallIds.length === 0) {
          throw new LlmError('llm-cursor: Cursor stream ended before turnEnded', 'STREAM_CLOSED')
        }
        yield* finish({ kind: 'tool-calls' })
        return
      }
      const endsToolBatch = item === undefined
      const message = item === undefined ? undefined : fromBinary(AgentServerMessageSchema, item.value.payload)
      const outcome = message === undefined ? {} : handleServerMessage(message, run, state)
      if (outcome.chunks !== undefined && outcome.chunks.length > 0) {
        produced.chunks = true
        yield* outcome.chunks
      }
      if (outcome.turnEnded === true) {
        run.close(false)
        yield* finish({ kind: 'stop' })
        return
      }
      if (endsToolBatch || (outcome.checkpoint === true && state.toolCallIds.length > 0)) {
        if (sessionId !== undefined && registry !== undefined) {
          registry.park(sessionId, run, parkFingerprint(options), timing.parkedRunTimeoutMs)
          parked = true
        }
        yield* finish({ kind: 'tool-calls' })
        return
      }
    }
  } finally {
    watchdog.signal.removeEventListener('abort', onAbort)
    if (!parked) run.close()
  }
}

function handleServerMessage(
  message: AgentServerMessage,
  run: CursorRun,
  state: StepState,
): { chunks?: StreamChunk[]; turnEnded?: true; checkpoint?: true } {
  const chunks: StreamChunk[] = []
  const stream = run.stream
  const payload = run.payload
  const msgCase = message.message.case
  if (msgCase === 'interactionUpdate') {
    const updateCase = message.message.value.message.case
    if (updateCase === 'textDelta' || updateCase === 'thinkingDelta') {
      const text = message.message.value.message.value.text
      if (text.length > 0) {
        const type = updateCase === 'textDelta' ? 'text' : 'reasoning'
        if (state.open?.type !== type) {
          chunks.push(...closeOpen(state.open))
          state.open = { index: state.nextIndex, type, text: '' }
          chunks.push({ type: 'block-start', index: state.nextIndex, blockType: type })
          state.nextIndex += 1
        }
        state.open.text += text
        chunks.push(type === 'text'
          ? { type: 'text-delta', index: state.open.index, text }
          : { type: 'reasoning-delta', index: state.open.index, text })
        state.sawContent = true
      }
    } else if (updateCase === 'tokenDelta') {
      state.outputTokens += message.message.value.message.value.tokens
    } else if (updateCase === 'turnEnded') {
      if (!state.sawContent && state.open === undefined) {
        throw new LlmError('llm-cursor: Cursor returned no content', 'EMPTY_RESPONSE')
      }
      return { chunks, turnEnded: true }
    }
    return { chunks }
  }
  if (msgCase === 'conversationCheckpointUpdate') {
    return { checkpoint: true }
  }
  if (msgCase === 'kvServerMessage') {
    answerKv(stream, message.message.value, payload.blobStore)
    return {}
  }
  if (msgCase === 'execServerMessage') {
    const exec = message.message.value
    const execCase = exec.message.case
    if (execCase === 'requestContextArgs') {
      answerRequestContext(stream, exec, payload)
      return {}
    }
    if (execCase === 'mcpArgs') {
      const mcp = exec.message.value
      const toolCallId = mcp.toolCallId || `cursor-${exec.id}`
      chunks.push(...closeOpen(state.open))
      state.open = undefined
      chunks.push(...emitToolCall(state.nextIndex, toolCallId, harnessToolName(mcp), decodeMcpArgsMap(mcp.args)))
      state.nextIndex += 1
      state.sawContent = true
      state.toolCallIds.push(toolCallId)
      run.pending.set(toolCallId, { id: exec.id, execId: exec.execId })
      return { chunks }
    }
    if (execCase === 'mcpStateExecArgs') {
      answerMcpState(stream, exec, exec.message.value, payload.mcpTools)
      return {}
    }
    if (execCase === 'executeHookArgs' && answerHook(stream, exec, exec.message.value.request)) {
      return {}
    }
    // A refused exec is a tool call the model made between two stretches of
    // output, so text written after the refusal starts its own block.
    chunks.push(...closeOpen(state.open))
    state.open = undefined
    if (answerNativeExec(stream, exec, payload.mcpTools)) {
      return { chunks }
    }
    rejectUnknownExec(stream, exec)
    // A named exec or an unknown oneof field is answered with ExecClientThrow so
    // the Run can continue. An exec with no payload is a malformed frame and
    // still fails the turn.
    if (execCase !== undefined || (exec.$unknown !== undefined && exec.$unknown.length > 0)) {
      return { chunks }
    }
    throw new LlmError(
      'llm-cursor: Cursor exec "unknown" is not supported by this adapter',
      'UNSUPPORTED_CONTENT',
    )
  }
  if (msgCase === 'interactionQuery') {
    const query = message.message.value
    if (query.query.case === 'webSearchRequestQuery') {
      approveWebSearch(stream, query)
      return {}
    }
    if (query.query.case === 'askQuestionInteractionQuery') {
      chunks.push(...closeOpen(state.open))
      state.open = undefined
      rejectNativeQuestion(stream, query, payload.mcpTools)
      return { chunks }
    }
    throw new LlmError(
      `llm-cursor: unsupported Cursor interaction query ${query.query.case ?? 'unknown'}`,
      'UNSUPPORTED_CONTENT',
    )
  }
  return {}
}

/**
 * Default Connect opener used by the adapter.
 * @param connect - injectable HTTP/2; Node `http2` when omitted.
 * @returns a function that opens one AgentService/Run stream.
 */
export function createOpenCursorStream(connect?: ConnectHttp2): OpenCursorStream {
  return input => openConnectStream(input, connect)
}
