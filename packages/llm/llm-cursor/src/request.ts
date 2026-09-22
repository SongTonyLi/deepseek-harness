/**
 * Rebuild one Cursor `AgentRunRequest` from harness history, system prompt, and MCP tools.
 *
 * Cursor's server builds the model prompt from `root_prompt_messages_json` and
 * never renders `conversation_state.turns` back into prompt messages, so this
 * module publishes the system prompt and every prior turn there as prompt
 * messages and keeps the turn structures for the server's own bookkeeping.
 *
 * @module @deepseek-ai/dsh-llm-cursor/request
 */

import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { create, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf'
import { ValueSchema } from '@bufbuild/protobuf/wkt'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { GenerateOptions, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentRunRequestSchema,
  AssistantMessageSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  CursorRuleSchema,
  CursorRuleTypeGlobalSchema,
  CursorRuleTypeSchema,
  McpArgsSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolCallSchema,
  McpToolDefinitionSchema,
  McpToolErrorSchema,
  McpToolResultContentItemSchema,
  McpToolResultSchema,
  McpToolsSchema,
  RequestedModelSchema,
  SelectedContextSchema,
  ThinkingMessageSchema,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  type CursorRule,
  type McpToolDefinition,
} from './native/agent_pb.ts'
import { MCP_PROMPT_TOOL_PREFIX, MCP_PROVIDER_IDENTIFIER } from './protocol.ts'

/** One historical or in-flight assistant/tool step. */
export type CursorTurnStep =
  | { kind: 'assistantText'; text: string }
  | { kind: 'thinking'; text: string }
  | {
    kind: 'toolCall'
    toolName: string
    toolCallId: string
    arguments: Record<string, unknown>
    result?: { content: string; isError: boolean }
  }

/** One user turn plus the assistant steps that answered it. */
export interface CursorTurn {
  /** Human utterance for this turn; Cursor wraps it in `<user_query>`. */
  userText: string
  /**
   * Harness-injected user-role text (skill catalog, runtime snapshot, notices).
   * Replayed as its own user prompt message, never inside `<user_query>`.
   */
  contextText: string
  steps: CursorTurnStep[]
}

/**
 * What the Run's single `userMessageAction` carries. `userMessage` is the
 * human prompt only. `continue` follows tool calls DSH ran locally: the
 * in-flight turn is replayed with its results in the root prompt and the
 * user message is {@link TOOL_RESULT_CONTINUATION_TEXT}.
 */
export type CursorRunAction =
  | { kind: 'userMessage'; text: string }
  | { kind: 'continue' }

/** Harness history split into the turns to replay and the action that drives the Run. */
export interface CursorConversation {
  systemPrompt: string
  /** Turns before the action, oldest first; on `continue`, the last one is the in-flight turn with its tool results. */
  turns: CursorTurn[]
  action: CursorRunAction
  /**
   * Catalog, snapshot, and notice text that arrived with the current human
   * prompt. It is replayed on the root prompt, not joined into `action`.
   */
  actionContext: string
}

/**
 * User message sent after locally executed tool calls. A Run requires one user
 * message; the tool results themselves ride the root prompt as `tool` messages.
 */
export const TOOL_RESULT_CONTINUATION_TEXT = 'The results of your tool calls are in the tool messages above. Continue the task.'

/**
 * Rule that tells the model Cursor's built-in tools answer with a rejection
 * here, so it calls the harness tools by their `mcp_dsh_` names instead.
 */
export const NATIVE_TOOLS_RULE = 'DeepSeek Harness runs this session. '
  + 'Cursor\'s built-in tools (read, write, edit, delete, ls, grep, shell, fetch, diagnostics, and the rest) are not available: '
  + `calling one returns a rejection and does nothing. Use only the tools whose names start with ${MCP_PROMPT_TOOL_PREFIX}, `
  + `for example ${MCP_PROMPT_TOOL_PREFIX}read instead of read.`

/** Rule path Cursor shows beside {@link NATIVE_TOOLS_RULE}. */
const ADAPTER_RULE_PATH = 'dsh/cursor-adapter'

/** Built Run payload plus the blob store Cursor may ask back for. */
export interface CursorRunPayload {
  /** Encoded `AgentClientMessage` carrying the Run. */
  requestBytes: Uint8Array
  /** Content-addressed blobs keyed by sha256 hex. */
  blobStore: Map<string, Uint8Array>
  /** MCP tool definitions sent on the Run. */
  mcpTools: McpToolDefinition[]
  /** Rules answered on `requestContextArgs`: {@link NATIVE_TOOLS_RULE} as one global rule. */
  rules: CursorRule[]
  /**
   * Prompt-side token estimate at one token per four characters of rules,
   * replayed prompt messages, action text, and MCP tool definitions. Cursor
   * reports no prompt usage, so this stands in for `TokenUsage.inputTokens`.
   */
  inputTokenEstimate: number
}

/** One content part of a replayed prompt message. */
export type CursorPromptPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: string; isError?: true }

/** One `root_prompt_messages_json` entry Cursor renders into the model prompt. */
export interface CursorPromptMessage {
  role: 'user' | 'assistant' | 'tool'
  content: CursorPromptPart[]
}

function textOf(message: RequestMessage): string {
  return message.content
    .map(block => block.type === 'text' ? block.text : '')
    .join('')
}

function joinUserTexts(left: string, right: string): string {
  if (left.length === 0) return right
  if (right.length === 0) return left
  return `${left}\n\n${right}`
}

function emptyTurn(): CursorTurn {
  return { userText: '', contextText: '', steps: [] }
}

function isHumanQuery(message: RequestMessage): boolean {
  return message.source?.kind === 'user'
}

function appendUserTurn(turns: CursorTurn[], text: string, asQuery: boolean): void {
  const last = turns[turns.length - 1]
  const open = last !== undefined && last.steps.length === 0 ? last : emptyTurn()
  if (open !== last) turns.push(open)
  if (asQuery) open.userText = joinUserTexts(open.userText, text)
  else open.contextText = joinUserTexts(open.contextText, text)
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (_invalidToolHistoryJson) {
    // Historical tool input that is not JSON becomes an empty object on the wire.
  }
  return {}
}

function encodeMcpArgValue(value: unknown): Uint8Array {
  try {
    return toBinary(ValueSchema, fromJson(ValueSchema, value as never))
  } catch {
    return new TextEncoder().encode(String(value))
  }
}

function encodeMcpArgsMap(args: Record<string, unknown>): Record<string, Uint8Array> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, encodeMcpArgValue(value)]))
}

function storeAsBlob(data: Uint8Array, blobStore: Map<string, Uint8Array>): Uint8Array {
  const id = new Uint8Array(createHash('sha256').update(data).digest())
  blobStore.set(Buffer.from(id).toString('hex'), data)
  return id
}

/**
 * Map harness tool schemas to Cursor MCP definitions.
 * @param tools - GenerateOptions tools.
 * @returns MCP tool definitions.
 */
export function buildMcpToolDefinitions(tools: readonly ToolSchema[] | undefined): McpToolDefinition[] {
  return (tools ?? []).map(tool => create(McpToolDefinitionSchema, {
    name: tool.name,
    toolName: tool.name,
    description: tool.description,
    inputSchema: encodeMcpArgValue(tool.parameters),
    providerIdentifier: MCP_PROVIDER_IDENTIFIER,
  }))
}

function buildTurnStepBytes(step: CursorTurnStep): Uint8Array {
  if (step.kind === 'assistantText') {
    return toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: { case: 'assistantMessage', value: create(AssistantMessageSchema, { text: step.text }) },
    }))
  }
  if (step.kind === 'thinking') {
    return toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: { case: 'thinkingMessage', value: create(ThinkingMessageSchema, { text: step.text }) },
    }))
  }
  const mcpToolCall = create(McpToolCallSchema, {
    args: create(McpArgsSchema, {
      name: step.toolName,
      args: encodeMcpArgsMap(step.arguments),
      toolCallId: step.toolCallId,
      providerIdentifier: MCP_PROVIDER_IDENTIFIER,
      toolName: step.toolName,
    }),
    ...step.result === undefined ? {} : {
      result: create(McpToolResultSchema, {
        result: step.result.isError
          ? { case: 'error', value: create(McpToolErrorSchema, { error: step.result.content }) }
          : {
            case: 'success',
            value: create(McpSuccessSchema, {
              content: [create(McpToolResultContentItemSchema, {
                content: { case: 'text', value: create(McpTextContentSchema, { text: step.result.content }) },
              })],
              isError: false,
            }),
          },
      }),
    },
  })
  return toBinary(ConversationStepSchema, create(ConversationStepSchema, {
    message: {
      case: 'toolCall',
      value: create(ToolCallSchema, { tool: { case: 'mcpToolCall', value: mcpToolCall } }),
    },
  }))
}

function createUserMessage(text: string, selectedContextBlob: Uint8Array) {
  const messageId = randomUUID()
  return create(UserMessageSchema, {
    text,
    messageId,
    selectedContext: create(SelectedContextSchema, { selectedImages: [] }),
    mode: 1,
    selectedContextBlob,
    correlationId: messageId,
  })
}

/**
 * Split harness messages into Cursor turns plus the action for this Run.
 *
 * Consecutive human user-role messages with no assistant steps between them
 * join into one Cursor user query. Plugin catalogs, snapshots, and notices
 * join into `contextText` / `actionContext` instead, because a Run has a
 * single `userMessageAction` and Cursor wraps that action and each
 * historical `userText` in `<user_query>`. History that ends in assistant
 * steps, normally tool calls plus their local results, carries no new user
 * text and becomes a `continue` action.
 * @param options - assembled model request.
 * @returns turns to replay and the Run action.
 */
export function conversationFromOptions(options: GenerateOptions): CursorConversation {
  const messages = [...options.messages]
  let systemPrompt = options.system ?? ''
  if (messages[0]?.role === 'system') {
    if (systemPrompt.length === 0) systemPrompt = textOf(messages[0])
    messages.shift()
  }
  const turns: CursorTurn[] = []
  const pendingResults = new Map<string, { content: string; isError: boolean }>()
  for (const message of messages) {
    if (message.role === 'system') {
      if (textOf(message).length > 0) systemPrompt = textOf(message)
      continue
    }
    if (message.role === 'tool') {
      const result = {
        content: message.content.map(item => item.type === 'text' ? item.text : '').join(''),
        isError: message.isError === true,
      }
      pendingResults.set(message.toolCallId, result)
      const last = turns[turns.length - 1]
      if (last !== undefined) {
        for (const step of last.steps) {
          if (step.kind === 'toolCall' && step.toolCallId === message.toolCallId) {
            step.result = result
          }
        }
      }
      continue
    }
    if (message.role === 'user') {
      appendUserTurn(turns, textOf(message), isHumanQuery(message))
      continue
    }
    if (turns.length === 0) turns.push(emptyTurn())
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the empty-history branch just pushed
    const last = turns[turns.length - 1]!
    for (const block of message.content) {
      if (block.type === 'text' && block.text.length > 0) {
        last.steps.push({ kind: 'assistantText', text: block.text })
      } else if (block.type === 'reasoning' && block.text.length > 0) {
        last.steps.push({ kind: 'thinking', text: block.text })
      } else if (block.type === 'tool-call') {
        const result = pendingResults.get(block.id)
        last.steps.push({
          kind: 'toolCall',
          toolName: block.name,
          toolCallId: block.id,
          arguments: parseArguments(block.arguments),
          ...result === undefined ? {} : { result },
        })
      }
    }
  }
  const last = turns[turns.length - 1]
  if (last === undefined) {
    return { systemPrompt, turns: [], action: { kind: 'userMessage', text: '' }, actionContext: '' }
  }
  if (last.steps.length === 0) {
    return {
      systemPrompt,
      turns: turns.slice(0, -1),
      action: { kind: 'userMessage', text: last.userText },
      actionContext: last.contextText,
    }
  }
  return { systemPrompt, turns, action: { kind: 'continue' }, actionContext: '' }
}

/**
 * Rules Cursor renders inside its own system prompt when the Run asks for the
 * request context. Only {@link NATIVE_TOOLS_RULE} travels here: a rule carrying
 * the harness system prompt lost its always-apply instructions once replayed
 * history was present, while the `<rules>` user prompt message kept them.
 * @returns the adapter's global rule.
 */
export function buildRules(): CursorRule[] {
  return [create(CursorRuleSchema, {
    fullPath: ADAPTER_RULE_PATH,
    content: NATIVE_TOOLS_RULE,
    source: 0,
    type: create(CursorRuleTypeSchema, { type: { case: 'global', value: create(CursorRuleTypeGlobalSchema, {}) } }),
  })]
}

/**
 * Render the system prompt and prior turns as the prompt messages Cursor shows
 * the model. The system prompt becomes a `<rules>` user message because the
 * server discards `system` entries in favour of its own prompt. Each turn
 * becomes a `<user_query>` user message, assistant messages holding text and
 * `tool-call` parts, and `tool` messages holding the results, with MCP tools
 * named `mcp_dsh_<tool>` as Cursor names them. Thinking is not replayed.
 * @param systemPrompt - rendered harness system prompt; `''` adds no rules.
 * @param turns - turns to replay, oldest first.
 * @param actionContext - harness context for the current action; omitted from `<user_query>`.
 * @returns prompt messages in order.
 */
export function buildPromptMessages(
  systemPrompt: string,
  turns: readonly CursorTurn[],
  actionContext = '',
): CursorPromptMessage[] {
  const messages: CursorPromptMessage[] = []
  if (systemPrompt.trim().length > 0) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `<rules>\n${systemPrompt}\n</rules>` }] })
  }
  for (const turn of turns) {
    const query = turn.userText.trim()
    if (query.length > 0) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `<user_query>\n${query}\n</user_query>` }] })
    }
    const context = turn.contextText.trim()
    if (context.length > 0) {
      messages.push({ role: 'user', content: [{ type: 'text', text: context }] })
    }
    let assistant: CursorPromptPart[] = []
    let results: CursorPromptPart[] = []
    const flush = (): void => {
      if (assistant.length > 0) messages.push({ role: 'assistant', content: assistant })
      if (results.length > 0) messages.push({ role: 'tool', content: results })
      assistant = []
      results = []
    }
    for (const step of turn.steps) {
      if (step.kind === 'thinking') continue
      if (step.kind === 'assistantText') {
        if (step.text.length === 0) continue
        if (results.length > 0) flush()
        assistant.push({ type: 'text', text: step.text })
        continue
      }
      const toolName = `${MCP_PROMPT_TOOL_PREFIX}${step.toolName}`
      assistant.push({ type: 'tool-call', toolCallId: step.toolCallId, toolName, args: step.arguments })
      if (step.result !== undefined) {
        results.push({
          type: 'tool-result',
          toolCallId: step.toolCallId,
          toolName,
          result: step.result.content,
          ...step.result.isError ? { isError: true } : {},
        })
      }
    }
    flush()
  }
  const trailing = actionContext.trim()
  if (trailing.length > 0) {
    messages.push({ role: 'user', content: [{ type: 'text', text: trailing }] })
  }
  return messages
}

function estimateInputTokens(
  rules: readonly CursorRule[],
  promptMessages: readonly CursorPromptMessage[],
  actionText: string,
  mcpTools: readonly McpToolDefinition[],
): number {
  let chars = actionText.length
  for (const rule of rules) chars += rule.content.length
  for (const message of promptMessages) chars += JSON.stringify(message).length
  for (const tool of mcpTools) chars += tool.name.length + tool.description.length + tool.inputSchema.byteLength
  return Math.ceil(chars / 4)
}

function actionText(action: CursorRunAction): string {
  switch (action.kind) {
    case 'userMessage': return action.text
    case 'continue': return TOOL_RESULT_CONTINUATION_TEXT
    /* v8 ignore next -- CursorRunAction is closed; the compiler owns exhaustiveness. */
    default: return assertNever(action, 'CursorRunAction')
  }
}

/**
 * Encode one rebuilt Run from a harness request.
 * @param options - assembled model request.
 * @returns protobuf bytes and the blob store.
 */
export function buildCursorRun(options: GenerateOptions): CursorRunPayload {
  const { systemPrompt, turns, action, actionContext } = conversationFromOptions(options)
  const mcpTools = buildMcpToolDefinitions(options.tools)
  const blobStore = new Map<string, Uint8Array>()
  const encoder = new TextEncoder()
  const systemBlobId = storeAsBlob(encoder.encode(JSON.stringify({ role: 'system', content: systemPrompt })), blobStore)
  const rules = buildRules()
  const promptMessages = buildPromptMessages(systemPrompt, turns, actionContext)
  const promptBlobIds = promptMessages.map(message => storeAsBlob(encoder.encode(JSON.stringify(message)), blobStore))
  const selectedCtxBlob = storeAsBlob(new Uint8Array(), blobStore)
  const turnBlobIds: Uint8Array[] = []
  for (const turn of turns) {
    const userMsg = createUserMessage(turn.userText, selectedCtxBlob)
    const userMsgBlobId = storeAsBlob(toBinary(UserMessageSchema, userMsg), blobStore)
    const stepBlobIds = turn.steps.map(step => storeAsBlob(buildTurnStepBytes(step), blobStore))
    const agentTurn = create(AgentConversationTurnStructureSchema, {
      userMessage: userMsgBlobId,
      steps: stepBlobIds,
      requestId: randomUUID(),
    })
    const turnStructure = create(ConversationTurnStructureSchema, {
      turn: { case: 'agentConversationTurn', value: agentTurn },
    })
    turnBlobIds.push(storeAsBlob(toBinary(ConversationTurnStructureSchema, turnStructure), blobStore))
  }
  const conversationState = create(ConversationStateStructureSchema, {
    rootPromptMessagesJson: [systemBlobId, ...promptBlobIds],
    turns: turnBlobIds,
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [pathToFileURL(process.cwd()).href],
    mode: 1,
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
    clientName: 'dsh',
  })
  const text = actionText(action)
  const userMessage = createUserMessage(text, selectedCtxBlob)
  const requestedModel = create(RequestedModelSchema, { modelId: options.model, maxMode: false, parameters: [] })
  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action: create(ConversationActionSchema, {
      action: { case: 'userMessageAction', value: create(UserMessageActionSchema, { userMessage }) },
    }),
    requestedModel,
    conversationId: options.sessionId ?? randomUUID(),
    mcpTools: create(McpToolsSchema, { mcpTools }),
  })
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: 'runRequest', value: runRequest },
  })
  return {
    requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
    blobStore,
    mcpTools,
    rules,
    inputTokenEstimate: estimateInputTokens(rules, promptMessages, text, mcpTools),
  }
}

/**
 * Decode MCP argument protobuf values to JSON.
 * @param args - name to encoded Value bytes.
 * @returns JSON arguments.
 */
export function decodeMcpArgsMap(args: Record<string, Uint8Array> | undefined): Record<string, unknown> {
  const decoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args ?? {})) {
    try {
      decoded[key] = toJson(ValueSchema, fromBinary(ValueSchema, value))
    } catch (_nonJsonMcpArg) {
      decoded[key] = new TextDecoder().decode(value)
    }
  }
  return decoded
}
