/** History rebuild into a Cursor Run. */
import { describe, expect, it } from 'vitest'
import { fromBinary } from '@bufbuild/protobuf'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { buildCursorRun, buildMcpToolDefinitions, conversationFromOptions, decodeMcpArgsMap } from '../src/request.ts'
import { AgentClientMessageSchema } from '../src/native/agent_pb.ts'
import { fromJson, toBinary } from '@bufbuild/protobuf'
import { ValueSchema } from '@bufbuild/protobuf/wkt'

describe('conversationFromOptions', () => {
  it('uses options.system or a leading system message', () => {
    const fromOption = conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      system: 'sys',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
    })
    expect(fromOption.systemPrompt).toBe('sys')
    expect(fromOption.userText).toBe('hi')
    expect(fromOption.completed).toEqual([])

    const fromMessage = conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      messages: [
        createMessage({ role: 'system', content: [{ type: 'text', text: 'be brief' }], source: { kind: 'plugin', plugin: 'x' } }),
        createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } }),
      ],
    })
    expect(fromMessage.systemPrompt).toBe('be brief')
    expect(fromMessage.userText).toBe('hi')
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

  it('folds assistant steps and tool results into completed turns', () => {
    const parsed = conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'use echo' }], source: { kind: 'plugin', plugin: 'test' } }),
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
      ],
    })
    expect(parsed.userText).toBe('')
    expect(parsed.completed[0]?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'assistantText', text: 'calling' }),
      expect.objectContaining({ kind: 'thinking', text: 'think' }),
      expect.objectContaining({ kind: 'toolCall', toolName: 'echo', result: { content: 'hi', isError: false } }),
    ]))
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
    expect(parsed.completed).toHaveLength(1)
    expect(parsed.userText).toBe('second')
  })
})

describe('buildCursorRun', () => {
  it('encodes an AgentClientMessage with clientName dsh and MCP tools', () => {
    const payload = buildCursorRun({
      provider: 'cursor',
      model: 'composer-2',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
      tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } }],
    })
    const message = fromBinary(AgentClientMessageSchema, payload.requestBytes)
    expect(message.message.case).toBe('runRequest')
    if (message.message.case !== 'runRequest') throw new Error('expected run')
    expect(message.message.value.conversationState?.clientName).toBe('dsh')
    expect(message.message.value.requestedModel?.modelId).toBe('composer-2')
    expect(payload.mcpTools[0]?.providerIdentifier).toBe('dsh')
    expect(payload.blobStore.size).toBeGreaterThan(0)
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
    expect(parsed.userText).toBe('')
    expect(parsed.completed[0]?.steps).toEqual(expect.arrayContaining([
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
    const message = fromBinary(AgentClientMessageSchema, payload.requestBytes)
    expect(message.message.case).toBe('runRequest')
    if (message.message.case !== 'runRequest') throw new Error('expected run')
    expect(message.message.value.conversationState?.turns.length).toBeGreaterThan(0)
  })

  it('returns empty user text when there are no turns', () => {
    expect(conversationFromOptions({
      provider: 'cursor',
      model: 'composer-2',
      messages: [],
    })).toEqual({ systemPrompt: '', completed: [], userText: '' })
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
    const message = fromBinary(AgentClientMessageSchema, payload.requestBytes)
    if (message.message.case !== 'runRequest') throw new Error('expected run')
    expect(message.message.value.conversationId).toBe('sess-1')
  })
})
