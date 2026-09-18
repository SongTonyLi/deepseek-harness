/** History rebuild into a Cursor Run. */
import { describe, expect, it } from 'vitest'
import { fromBinary, fromJson, toBinary } from '@bufbuild/protobuf'
import { ValueSchema } from '@bufbuild/protobuf/wkt'
import { createMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  buildCursorRun,
  buildMcpToolDefinitions,
  buildPromptMessages,
  conversationFromOptions,
  decodeMcpArgsMap,
  TOOL_RESULT_CONTINUATION_TEXT,
} from '../src/request.ts'
import type { CursorRunPayload } from '../src/request.ts'
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
} from '../src/native/agent_pb.ts'
import type { AgentRunRequest } from '../src/native/agent_pb.ts'

function decodeRun(payload: CursorRunPayload): AgentRunRequest {
  const message = fromBinary(AgentClientMessageSchema, payload.requestBytes)
  if (message.message.case !== 'runRequest') throw new Error('expected run')
  return message.message.value
}

function blobOf(payload: CursorRunPayload, id: Uint8Array): Uint8Array {
  const blob = payload.blobStore.get(Buffer.from(id).toString('hex'))
  if (blob === undefined) throw new Error('blob missing from the local store')
  return blob
}

function rootPromptOf(payload: CursorRunPayload): unknown[] {
  return (decodeRun(payload).conversationState?.rootPromptMessagesJson ?? [])
    .map(id => JSON.parse(new TextDecoder().decode(blobOf(payload, id))) as unknown)
}

function userActionText(payload: CursorRunPayload): string | undefined {
  const action = decodeRun(payload).action?.action
  if (action?.case !== 'userMessageAction') throw new Error(`expected userMessageAction, got ${action?.case}`)
  return action.value.userMessage?.text
}

const toolCallHistory = [
  createUserMessage({ content: [{ type: 'text', text: 'use echo' }], source: { kind: 'user' } }),
  createMessage({
    role: 'assistant',
    source: { kind: 'model', provider: 'cursor', model: 'composer-2' },
    content: [
      { type: 'text', text: 'calling' },
      { type: 'reasoning', text: 'think' },
      { type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: '{"text":"hi"}' },
    ],
  }),
  createMessage({
    role: 'user',
    source: { kind: 'tool', callId: ToolCallId('c1') },
    content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'hi' }] }],
  }),
]

describe('conversationFromOptions', () => {
  it('uses options.system or a leading system message', () => {
    const fromOption = conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      system: 'sys',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
    })
    expect(fromOption.systemPrompt).toBe('sys')
    expect(fromOption.action).toEqual({ kind: 'userMessage', text: 'hi' })
    expect(fromOption.turns).toEqual([])

    const fromMessage = conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      messages: [
        createMessage({ role: 'system', content: [{ type: 'text', text: 'be brief' }], source: { kind: 'plugin', plugin: 'x' } }),
        createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } }),
      ],
    })
    expect(fromMessage.systemPrompt).toBe('be brief')
    expect(fromMessage.action).toEqual({ kind: 'userMessage', text: 'hi' })
    const fromBoth = conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      system: 'sys',
      messages: [
        createMessage({ role: 'system', content: [{ type: 'text', text: 'ignored' }], source: { kind: 'plugin', plugin: 'x' } }),
        createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } }),
      ],
    })
    expect(fromBoth.systemPrompt).toBe('sys')
  })

  it('continues the in-flight turn when history ends in a tool result', () => {
    const parsed = conversationFromOptions({ provider: 'cursor', model: 'composer-2', messages: toolCallHistory })
    expect(parsed.action).toEqual({ kind: 'continue' })
    expect(parsed.turns).toHaveLength(1)
    expect(parsed.turns[0]?.userText).toBe('use echo')
    expect(parsed.turns[0]?.steps).toEqual([
      { kind: 'assistantText', text: 'calling' },
      { kind: 'thinking', text: 'think' },
      {
        kind: 'toolCall',
        toolName: 'echo',
        toolCallId: 'c1',
        arguments: { text: 'hi' },
        result: { content: 'hi', isError: false },
      },
    ])
  })

  it('keeps a trailing user message as the current action', () => {
    const parsed = conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'plugin', plugin: 'test' } }),
        createMessage({
          role: 'assistant',
          source: { kind: 'model', provider: 'cursor', model: 'composer-2' },
          content: [{ type: 'text', text: 'ok' }],
        }),
        createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'plugin', plugin: 'test' } }),
      ],
    })
    expect(parsed.turns).toHaveLength(1)
    expect(parsed.action).toEqual({ kind: 'userMessage', text: 'second' })
  })

  it('starts a new user action after a completed tool step when the human speaks again', () => {
    const parsed = conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      messages: [
        ...toolCallHistory,
        createMessage({
          role: 'assistant',
          source: { kind: 'model', provider: 'cursor', model: 'composer-2' },
          content: [{ type: 'text', text: 'echoed hi' }],
        }),
        createUserMessage({ content: [{ type: 'text', text: 'thanks, now stop' }], source: { kind: 'user' } }),
      ],
    })
    expect(parsed.turns).toHaveLength(1)
    expect(parsed.turns[0]?.steps.at(-1)).toEqual({ kind: 'assistantText', text: 'echoed hi' })
    expect(parsed.action).toEqual({ kind: 'userMessage', text: 'thanks, now stop' })
  })

  it('joins trailing runtime-context and skill-catalog user messages into the current action', () => {
    const parsed = conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'what does @AuditZoo-spring26/ do' }],
          source: { kind: 'user' },
        }),
        createUserMessage({
          content: [{
            type: 'text',
            text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nsandbox:policy',
          }],
          source: {
            kind: 'plugin',
            plugin: '@deepseek-ai/dsh-system-prompt',
            form: 'snapshot',
            sections: [{ name: 'sandbox:policy', text: 'sandbox:policy' }],
          },
        }),
        createUserMessage({
          content: [{
            type: 'text',
            text: '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>',
          }],
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-tool-skill', form: 'catalog' },
        }),
      ],
    })
    expect(parsed.turns).toEqual([])
    expect(parsed.action).toEqual({
      kind: 'userMessage',
      text: [
        'what does @AuditZoo-spring26/ do',
        'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nsandbox:policy',
        '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>',
      ].join('\n\n'),
    })
  })

  it('joins consecutive user-role messages in completed history and skips empty fragments', () => {
    const parsed = conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
        createUserMessage({ content: [{ type: 'text', text: '' }], source: { kind: 'plugin', plugin: 'pad' } }),
        createUserMessage({
          content: [{ type: 'text', text: 'snapshot-v1' }],
          source: {
            kind: 'plugin',
            plugin: '@deepseek-ai/dsh-system-prompt',
            form: 'snapshot',
            sections: [{ name: 'sandbox:policy', text: 'snapshot-v1' }],
          },
        }),
        createMessage({
          role: 'assistant',
          source: { kind: 'model', provider: 'cursor', model: 'composer-2' },
          content: [{ type: 'text', text: 'hi' }],
        }),
        createUserMessage({ content: [{ type: 'text', text: '' }], source: { kind: 'plugin', plugin: 'pad' } }),
        createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }),
        createUserMessage({
          content: [{ type: 'text', text: 'snapshot-v2' }],
          source: {
            kind: 'plugin',
            plugin: '@deepseek-ai/dsh-system-prompt',
            form: 'snapshot',
            sections: [{ name: 'sandbox:policy', text: 'snapshot-v2' }],
          },
        }),
      ],
    })
    expect(parsed.turns).toEqual([
      { userText: 'hello\n\nsnapshot-v1', steps: [{ kind: 'assistantText', text: 'hi' }] },
    ])
    expect(parsed.action).toEqual({ kind: 'userMessage', text: 'next\n\nsnapshot-v2' })
  })
})

describe('buildPromptMessages', () => {
  it('renders rules, user queries, grouped assistant text and tool calls, and tool results; skips thinking', () => {
    expect(buildPromptMessages('sys', [{
      userText: 'use echo',
      steps: [
        { kind: 'thinking', text: 'private' },
        { kind: 'assistantText', text: 'calling' },
        { kind: 'toolCall', toolName: 'echo', toolCallId: 'c1', arguments: { text: 'hi' }, result: { content: 'hi', isError: false } },
        { kind: 'toolCall', toolName: 'echo', toolCallId: 'c2', arguments: {}, result: { content: 'boom', isError: true } },
        { kind: 'assistantText', text: 'done' },
      ],
    }])).toEqual([
      { role: 'user', content: [{ type: 'text', text: '<rules>\nsys\n</rules>' }] },
      { role: 'user', content: [{ type: 'text', text: '<user_query>\nuse echo\n</user_query>' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'mcp_dsh_echo', args: { text: 'hi' } },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'mcp_dsh_echo', args: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'mcp_dsh_echo', result: 'hi' },
          { type: 'tool-result', toolCallId: 'c2', toolName: 'mcp_dsh_echo', result: 'boom', isError: true },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ])
  })

  it('omits rules for an empty system prompt, blank user queries, and empty assistant text', () => {
    expect(buildPromptMessages('', [{
      userText: '  ',
      steps: [
        { kind: 'assistantText', text: '' },
        { kind: 'toolCall', toolName: 'echo', toolCallId: 'c3', arguments: {} },
      ],
    }])).toEqual([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c3', toolName: 'mcp_dsh_echo', args: {} }] },
    ])
    expect(buildPromptMessages('', [])).toEqual([])
  })

  it('replays only the query for a turn whose steps are all thinking', () => {
    expect(buildPromptMessages('', [{ userText: 'q', steps: [{ kind: 'thinking', text: 'private' }] }])).toEqual([
      { role: 'user', content: [{ type: 'text', text: '<user_query>\nq\n</user_query>' }] },
    ])
  })
})

describe('buildCursorRun', () => {
  it('encodes clientName dsh, MCP tools, the user action text, and the root prompt', () => {
    const payload = buildCursorRun({
      provider: 'cursor',
      model: 'composer-2',
      system: 'sys',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
      tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } }],
    })
    const run = decodeRun(payload)
    expect(run.conversationState?.clientName).toBe('dsh')
    expect(run.conversationState?.turns).toEqual([])
    expect(run.requestedModel?.modelId).toBe('composer-2')
    expect(userActionText(payload)).toBe('hi')
    expect(rootPromptOf(payload)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: '<rules>\nsys\n</rules>' }] },
    ])
    expect(payload.mcpTools[0]?.providerIdentifier).toBe('dsh')
  })

  it('replays the in-flight turn with its tool results and sends the continuation notice after local tool results', () => {
    const payload = buildCursorRun({
      provider: 'cursor',
      model: 'composer-2',
      messages: toolCallHistory,
      tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } }],
    })
    const run = decodeRun(payload)
    expect(userActionText(payload)).toBe(TOOL_RESULT_CONTINUATION_TEXT)
    expect(run.conversationState?.pendingToolCalls).toEqual([])
    expect(rootPromptOf(payload)).toEqual([
      { role: 'system', content: '' },
      { role: 'user', content: [{ type: 'text', text: '<user_query>\nuse echo\n</user_query>' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'mcp_dsh_echo', args: { text: 'hi' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'mcp_dsh_echo', result: 'hi' }] },
    ])
    const turnIds = run.conversationState?.turns ?? []
    expect(turnIds).toHaveLength(1)
    const turn = fromBinary(ConversationTurnStructureSchema, blobOf(payload, turnIds[0]!))
    if (turn.turn.case !== 'agentConversationTurn') throw new Error('expected agent turn')
    const steps = turn.turn.value.steps.map(id => fromBinary(ConversationStepSchema, blobOf(payload, id)))
    expect(steps.map(step => step.message.case)).toEqual(['assistantMessage', 'thinkingMessage', 'toolCall'])
    const call = steps[2]?.message
    if (call?.case !== 'toolCall' || call.value.tool.case !== 'mcpToolCall') throw new Error('expected MCP tool call')
    expect(call.value.tool.value.args?.toolCallId).toBe('c1')
    expect(call.value.tool.value.result?.result.case).toBe('success')
  })
})

describe('MCP args', () => {
  it('round-trips JSON values and falls back to UTF-8', () => {
    expect(buildMcpToolDefinitions(undefined)).toEqual([])
    const encoded = toBinary(ValueSchema, fromJson(ValueSchema, { n: 1 }))
    expect(decodeMcpArgsMap({ n: encoded })).toEqual({ n: { n: 1 } })
    expect(decodeMcpArgsMap({ t: Buffer.from('plain') })).toEqual({ t: 'plain' })
    expect(decodeMcpArgsMap(undefined)).toEqual({})
  })
})

describe('conversation edge cases', () => {
  it('starts an assistant-only history, folds later system text, and treats bad tool JSON as {}', () => {
    const parsed = conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      messages: [
        createMessage({
          role: 'assistant',
          source: { kind: 'model', provider: 'cursor', model: 'composer-2' },
          content: [
            { type: 'text', text: '' },
            { type: 'reasoning', text: '' },
            { type: 'text', text: 'hello' },
            { type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: 'not-json' },
          ],
        }),
        createMessage({
          role: 'user',
          source: { kind: 'tool', callId: ToolCallId('c1') },
          content: [{
            type: 'tool-result',
            toolCallId: ToolCallId('c1'),
            isError: true,
            content: [{ type: 'image', attachment: { id: 'img' } as never }],
          }],
        }),
        createMessage({
          role: 'system',
          content: [{ type: 'text', text: 'later' }],
          source: { kind: 'plugin', plugin: 'x' },
        }),
        createMessage({
          role: 'system',
          content: [{ type: 'text', text: '' }],
          source: { kind: 'plugin', plugin: 'x' },
        }),
      ],
    })
    expect(parsed.systemPrompt).toBe('later')
    expect(parsed.action).toEqual({ kind: 'continue' })
    expect(parsed.turns[0]?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'toolCall', arguments: {}, result: { content: '', isError: true } }),
    ]))
  })

  it('encodes completed turns including thinking, tools, and error results', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(buildMcpToolDefinitions([
      { name: 'circ', description: 'circ', parameters: circular },
    ])[0]?.name).toBe('circ')

    const payload = buildCursorRun({
      provider: 'cursor',
      model: 'composer-2',
      messages: [
        createMessage({
          role: 'system',
          source: { kind: 'plugin', plugin: 'x' },
          content: [
            { type: 'text', text: 'sys' },
            { type: 'reasoning', text: 'r' },
            { type: 'tool-call', id: ToolCallId('ignored'), name: 'n', arguments: '{}' },
            {
              type: 'tool-result',
              toolCallId: ToolCallId('ignored'),
              content: [
                { type: 'text', text: 't' },
                { type: 'image', attachment: { id: 'img' } as never },
              ],
            },
            { type: 'image', attachment: { id: 'img' } as never },
            { type: 'file', attachment: { id: 'file' } as never },
          ],
        }),
        createMessage({
          role: 'user',
          source: { kind: 'tool', callId: ToolCallId('early') },
          content: [{ type: 'tool-result', toolCallId: ToolCallId('early'), content: [{ type: 'text', text: 'early' }] }],
        }),
        createUserMessage({ content: [{ type: 'text', text: 'use echo' }], source: { kind: 'plugin', plugin: 'test' } }),
        createMessage({
          role: 'assistant',
          source: { kind: 'model', provider: 'cursor', model: 'composer-2' },
          content: [
            { type: 'text', text: 'calling' },
            { type: 'reasoning', text: 'think' },
            { type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: '{"text":"hi"}' },
            { type: 'tool-call', id: ToolCallId('open'), name: 'echo', arguments: '{}' },
            { type: 'tool-call', id: ToolCallId('early'), name: 'echo', arguments: '{}' },
          ],
        }),
        createMessage({
          role: 'user',
          source: { kind: 'tool', callId: ToolCallId('c1') },
          content: [{
            type: 'tool-result',
            toolCallId: ToolCallId('c1'),
            isError: true,
            content: [{ type: 'text', text: 'boom' }],
          }],
        }),
      ],
    })
    const run = decodeRun(payload)
    expect(run.conversationState?.turns.length).toBeGreaterThan(0)
    expect(userActionText(payload)).toBe(TOOL_RESULT_CONTINUATION_TEXT)
    expect(rootPromptOf(payload).at(-1)).toEqual({
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'c1', toolName: 'mcp_dsh_echo', result: 'boom', isError: true },
        { type: 'tool-result', toolCallId: 'early', toolName: 'mcp_dsh_echo', result: 'early' },
      ],
    })
  })

  it('returns an empty user action when there are no turns', () => {
    expect(conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      messages: [],
    })).toEqual({ systemPrompt: '', turns: [], action: { kind: 'userMessage', text: '' } })
    expect(conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      messages: [
        createMessage({
          role: 'system',
          content: [{ type: 'text', text: '' }],
          source: { kind: 'plugin', plugin: 'x' },
        }),
        createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } }),
      ],
    }).systemPrompt).toBe('')
  })

  it('passes sessionId through to the Run', () => {
    const payload = buildCursorRun({
      provider: 'cursor',
      model: 'composer-2',
      sessionId: 'sess-1' as never,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
    })
    expect(decodeRun(payload).conversationId).toBe('sess-1')
  })
})
