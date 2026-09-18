/**
 * Rebuild one Cursor `AgentRunRequest` from harness history, system prompt, and MCP tools.
 *
 * @module @deepseek-ai/dsh-llm-cursor/request
 */

import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { create, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf'
import { ValueSchema } from '@bufbuild/protobuf/wkt'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentRunRequestSchema,
  AssistantMessageSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
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
  type McpToolDefinition,
} from './native/agent_pb.ts'

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
  userText: string
  steps: CursorTurnStep[]
}

/** Built Run payload plus the blob store Cursor may ask back for. */
export interface CursorRunPayload {
  /** Encoded `AgentClientMessage` carrying the Run. */
  requestBytes: Uint8Array
  /** Content-addressed blobs keyed by sha256 hex. */
  blobStore: Map<string, Uint8Array>
  /** MCP tool definitions sent on the Run. */
  mcpTools: McpToolDefinition[]
}

function textOf(message: Message): string {
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'reasoning') return ''
      if (block.type === 'tool-call') return ''
      if (block.type === 'tool-result') {
        return block.content
          .map(item => item.type === 'text' ? item.text : '')
          .join('')
      }
      return ''
    })
    .join('')
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
    providerIdentifier: 'dsh',
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
      providerIdentifier: 'dsh',
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
 * Split harness messages into completed Cursor turns plus the current user text.
 * @param options - assembled model request.
 * @returns conversation turns and the new user action text.
 */
export function conversationFromOptions(options: GenerateOptions): { systemPrompt: string; completed: CursorTurn[]; userText: string } {
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
    const toolResult = message.content.find(block => block.type === 'tool-result')
    if (toolResult?.type === 'tool-result') {
      const result = {
        content: toolResult.content.map(item => item.type === 'text' ? item.text : '').join(''),
        isError: toolResult.isError === true,
      }
      pendingResults.set(toolResult.toolCallId, result)
      const last = turns[turns.length - 1]
      if (last !== undefined) {
        for (const step of last.steps) {
          if (step.kind === 'toolCall' && step.toolCallId === toolResult.toolCallId) {
            step.result = result
          }
        }
      }
      continue
    }
    if (message.role === 'user') {
      turns.push({ userText: textOf(message), steps: [] })
      continue
    }
    if (turns.length === 0) turns.push({ userText: '', steps: [] })
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
  if (last === undefined) return { systemPrompt, completed: [], userText: '' }
  if (last.steps.length === 0) {
    return { systemPrompt, completed: turns.slice(0, -1), userText: last.userText }
  }
  return { systemPrompt, completed: turns, userText: '' }
}

/**
 * Encode one rebuilt Run from a harness request.
 * @param options - assembled model request.
 * @returns protobuf bytes and the blob store.
 */
export function buildCursorRun(options: GenerateOptions): CursorRunPayload {
  const { systemPrompt, completed, userText } = conversationFromOptions(options)
  const mcpTools = buildMcpToolDefinitions(options.tools)
  const blobStore = new Map<string, Uint8Array>()
  const systemBytes = new TextEncoder().encode(JSON.stringify({ role: 'system', content: systemPrompt }))
  const systemBlobId = storeAsBlob(systemBytes, blobStore)
  const selectedCtxBlob = storeAsBlob(new Uint8Array(), blobStore)
  const turnBlobIds: Uint8Array[] = []
  for (const turn of completed) {
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
    rootPromptMessagesJson: [systemBlobId],
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
  const userMessage = createUserMessage(userText, selectedCtxBlob)
  const action = create(ConversationActionSchema, {
    action: { case: 'userMessageAction', value: create(UserMessageActionSchema, { userMessage }) },
  })
  const requestedModel = create(RequestedModelSchema, { modelId: options.model, maxMode: false, parameters: [] })
  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
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
