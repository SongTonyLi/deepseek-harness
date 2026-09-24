/** Cursor Run stream translation. */
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  AfterAgentResponseRequestQuerySchema,
  AfterAgentThoughtRequestQuerySchema,
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  AskQuestionArgsSchema,
  AskQuestionArgs_QuestionSchema,
  AskQuestionInteractionQuerySchema,
  BeforeSubmitPromptRequestQuerySchema,
  BackgroundShellSpawnArgsSchema,
  ComputerUseArgsSchema,
  ConversationSearchArgsSchema,
  CreatePlanRequestQuerySchema,
  DeleteArgsSchema,
  DiagnosticsArgsSchema,
  ExecServerMessageSchema,
  ExecuteHookArgsSchema,
  ExecuteHookRequestSchema,
  FetchArgsSchema,
  GetBlobArgsSchema,
  GrepArgsSchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  ListMcpResourcesExecArgsSchema,
  LsArgsSchema,
  McpArgsSchema,
  McpStateExecArgsSchema,
  PiBashExecArgsSchema,
  PiEditExecArgsSchema,
  PiFindExecArgsSchema,
  PiGrepExecArgsSchema,
  PiLsExecArgsSchema,
  PiReadExecArgsSchema,
  PiWriteExecArgsSchema,
  PostToolUseFailureRequestQuerySchema,
  PostToolUseRequestQuerySchema,
  PreCompactRequestQuerySchema,
  PreToolUseRequestQuerySchema,
  ReadArgsSchema,
  ReadMcpResourceExecArgsSchema,
  RecordScreenArgsSchema,
  RequestContextArgsSchema,
  SetBlobArgsSchema,
  ShellArgsSchema,
  StopRequestQuerySchema,
  SubagentStartRequestQuerySchema,
  SubagentStopRequestQuerySchema,
  TextDeltaUpdateSchema,
  ThinkingDeltaUpdateSchema,
  TokenDeltaUpdateSchema,
  TurnEndedUpdateSchema,
  UserMessageAppendedUpdateSchema,
  WebSearchRequestQuerySchema,
  WriteArgsSchema,
  WriteShellStdinArgsSchema,
} from '../src/native/agent_pb.ts'
import type { AgentClientMessage, ExecServerMessage, ExecuteHookRequest } from '../src/native/agent_pb.ts'
import { createOpenCursorStream, streamCursorRun } from '../src/stream.ts'
import type { OpenCursorStream } from '../src/stream.ts'
import { buildCursorRun } from '../src/request.ts'
import { frameConnectMessage } from '../src/connect.ts'
import type { CursorHttp2Session, CursorHttp2Stream } from '../src/connect.ts'
import { EventEmitter } from 'node:events'
import http2 from 'node:http2'

afterEach(() => {
  vi.restoreAllMocks()
})

function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  return Array.fromAsync(stream)
}

function serverMessage(message: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]) {
  return create(AgentServerMessageSchema, message)
}

function scripted(messages: ReturnType<typeof create<typeof AgentServerMessageSchema>>[]): OpenCursorStream {
  return () => ({
    write: () => {},
    end: () => {},
    destroy: () => {},
    frames: (async function* () {
      for (const message of messages) {
        yield { endStream: false, payload: toBinary(AgentServerMessageSchema, message) }
      }
    })(),
  })
}

/** Like `scripted`, but records every client message the adapter writes. */
function capturing(
  messages: ReturnType<typeof create<typeof AgentServerMessageSchema>>[],
): { open: OpenCursorStream; written: AgentClientMessage[] } {
  return capturingBytes(messages.map(message => toBinary(AgentServerMessageSchema, message)))
}

/** Like `capturing`, for already-encoded AgentServerMessage payloads. */
function capturingBytes(payloads: Uint8Array[]): { open: OpenCursorStream; written: AgentClientMessage[] } {
  const written: AgentClientMessage[] = []
  const open: OpenCursorStream = () => ({
    write: (bytes) => { written.push(fromBinary(AgentClientMessageSchema, bytes)) },
    end: () => {},
    destroy: () => {},
    frames: (async function* () {
      for (const payload of payloads) {
        yield { endStream: false, payload }
      }
    })(),
  })
  return { open, written }
}

function protoVarint(value: number): number[] {
  const bytes: number[] = []
  let rest = value
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  bytes.push(rest)
  return bytes
}

function protoStringField(field: number, value: string): Uint8Array {
  const data = new TextEncoder().encode(value)
  return Uint8Array.from([...protoVarint((field << 3) | 2), ...protoVarint(data.length), ...data])
}

/** AgentServerMessage whose exec oneof carries a length-delimited field this build may not name. */
function agentExecWithLengthDelimitedField(id: number, execId: string, field: number, payload: Uint8Array): Uint8Array {
  const idField = Uint8Array.from([8, id])
  const execIdField = protoStringField(15, execId)
  const unknown = Uint8Array.from([...protoVarint((field << 3) | 2), ...protoVarint(payload.length), ...payload])
  const exec = Uint8Array.from([...idField, ...execIdField, ...unknown])
  return Uint8Array.from([...protoVarint((2 << 3) | 2), ...protoVarint(exec.length), ...exec])
}

function execFrom(message: ExecServerMessage['message']) {
  return serverMessage({
    message: { case: 'execServerMessage', value: create(ExecServerMessageSchema, { id: 7, execId: 'e7', message }) },
  })
}

const textThenEnd = [
  serverMessage({
    message: {
      case: 'interactionUpdate',
      value: create(InteractionUpdateSchema, {
        message: { case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: 'ok' }) },
      }),
    },
  }),
  serverMessage({
    message: {
      case: 'interactionUpdate',
      value: create(InteractionUpdateSchema, {
        message: { case: 'turnEnded', value: create(TurnEndedUpdateSchema, {}) },
      }),
    },
  }),
]

function execReply(written: AgentClientMessage[]) {
  const reply = written.find(message => message.message.case === 'execClientMessage')
  if (reply?.message.case !== 'execClientMessage') throw new Error('expected an exec reply')
  return reply.message.value
}

const TIMING = { streamIdleTimeoutMs: 5_000, parkedRunTimeoutMs: 60_000, toolCallSettleMs: 50 }

const request = {
  provider: 'cursor' as const,
  model: 'composer-2',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
}

describe('streamCursorRun', () => {
  it('emits text, thinking, usage, and stop', async () => {
    const chunks = await collect(streamCursorRun(request, 'tok', TIMING, scripted([
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'thinkingDelta', value: create(ThinkingDeltaUpdateSchema, { text: 'hmm' }) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'thinkingDelta', value: create(ThinkingDeltaUpdateSchema, { text: '…' }) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: 'hello' }) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: '!' }) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'tokenDelta', value: create(TokenDeltaUpdateSchema, { tokens: 3 }) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'turnEnded', value: create(TurnEndedUpdateSchema, {}) },
          }),
        },
      }),
    ])))
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'reasoning-delta', 'reasoning-delta', 'block-end',
      'block-start', 'text-delta', 'text-delta', 'block-end',
      'usage', 'finish',
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({
      usage: { outputTokens: 3, inputTokens: buildCursorRun(request).inputTokenEstimate },
    })
    expect(buildCursorRun(request).inputTokenEstimate).toBeGreaterThan(0)
  })

  it('ignores empty deltas and unknown interaction updates', async () => {
    const chunks = await collect(streamCursorRun(request, 'tok', TIMING, scripted([
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'thinkingDelta', value: create(ThinkingDeltaUpdateSchema, { text: '' }) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: '' }) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'userMessageAppended', value: create(UserMessageAppendedUpdateSchema, {}) },
          }),
        },
      }),
      serverMessage({ message: { case: undefined } }),
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: 'ok' }) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'turnEnded', value: create(TurnEndedUpdateSchema, {}) },
          }),
        },
      }),
    ])))
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
  })

  it('finishes with tool-calls on an MCP exec', async () => {
    const chunks = await collect(streamCursorRun({
      ...request,
      tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object' } }],
    }, 'tok', TIMING, scripted([
      serverMessage({
        message: {
          case: 'execServerMessage',
          value: create(ExecServerMessageSchema, {
            id: 1,
            execId: 'e1',
            message: {
              case: 'mcpArgs',
              value: create(McpArgsSchema, {
                name: 'echo',
                toolName: '',
                toolCallId: '',
                args: {},
              }),
            },
          }),
        },
      }),
    ])))
    expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(true)
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(call).toMatchObject({ block: { name: 'echo', id: 'cursor-1' } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })

    const named = await collect(streamCursorRun(request, 'tok', TIMING, scripted([
      serverMessage({
        message: {
          case: 'execServerMessage',
          value: create(ExecServerMessageSchema, {
            id: 2,
            execId: 'e2',
            message: {
              case: 'mcpArgs',
              value: create(McpArgsSchema, {
                name: 'ignored',
                toolName: 'echo',
                toolCallId: 'call-2',
                args: {},
              }),
            },
          }),
        },
      }),
    ])))
    expect(named.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'))
      .toMatchObject({ block: { name: 'echo', id: 'call-2' } })
  })

  it('strips the replayed mcp_dsh_ prefix from a model-emitted tool name', async () => {
    for (const [name, toolName] of [['mcp_dsh_echo', ''], ['ignored', 'mcp_dsh_echo']] as const) {
      const chunks = await collect(streamCursorRun(request, 'tok', TIMING, scripted([
        serverMessage({
          message: {
            case: 'execServerMessage',
            value: create(ExecServerMessageSchema, {
              id: 3,
              execId: 'e3',
              message: { case: 'mcpArgs', value: create(McpArgsSchema, { name, toolName, toolCallId: 'c3', args: {} }) },
            }),
          },
        }),
      ])))
      expect(chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'))
        .toMatchObject({ block: { name: 'echo', id: 'c3' } })
    }
  })

  it('answers KV get/set, request context, and web search, and rejects native execs', async () => {
    const payload = buildCursorRun(request)
    const blobId = Buffer.from([...payload.blobStore.keys()][0]!, 'hex')
    await collect(streamCursorRun(request, 'tok', TIMING, scripted([
      serverMessage({
        message: {
          case: 'kvServerMessage',
          value: create(KvServerMessageSchema, {
            id: 1,
            message: { case: 'getBlobArgs', value: create(GetBlobArgsSchema, { blobId }) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'kvServerMessage',
          value: create(KvServerMessageSchema, {
            id: 2,
            message: {
              case: 'setBlobArgs',
              value: create(SetBlobArgsSchema, { blobId: new Uint8Array([1, 2]), blobData: new Uint8Array([9]) }),
            },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'execServerMessage',
          value: create(ExecServerMessageSchema, {
            id: 4,
            execId: 'ctx',
            message: { case: 'requestContextArgs', value: create(RequestContextArgsSchema, {}) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'interactionQuery',
          value: create(InteractionQuerySchema, {
            id: 3,
            query: { case: 'webSearchRequestQuery', value: create(WebSearchRequestQuerySchema, {}) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: 'ok' }) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'turnEnded', value: create(TurnEndedUpdateSchema, {}) },
          }),
        },
      }),
    ])))

  })

  it('answers the request context with the harness rules and the MCP tool definitions', async () => {
    const { open, written } = capturing([
      execFrom({ case: 'requestContextArgs', value: create(RequestContextArgsSchema, {}) }),
      ...textThenEnd,
    ])
    await collect(streamCursorRun({
      ...request,
      system: 'be brief',
      tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object' } }],
    }, 'tok', TIMING, open))
    const reply = execReply(written)
    expect(reply.id).toBe(7)
    expect(reply.execId).toBe('e7')
    if (reply.message.case !== 'requestContextResult' || reply.message.value.result.case !== 'success') {
      throw new Error('expected a successful request context result')
    }
    const requestContext = reply.message.value.result.value.requestContext
    expect(requestContext?.rules.map(rule => rule.content)).toEqual([expect.stringContaining('CallDynamicTool')])
    expect(requestContext?.tools.map(tool => tool.name)).toEqual(['echo'])
  })

  it('answers every native exec with a rejection naming the harness tool and keeps the Run alive', async () => {
    const tools = ['bash', 'read', 'grep', 'glob', 'write', 'web_fetch', 'lsp', 'list_mcp_resources', 'read_mcp_resource']
      .map(name => ({ name, description: name, parameters: { type: 'object' } }))
    const shell = create(ShellArgsSchema, { command: 'ls -la', workingDirectory: '/w' })
    const cases: {
      exec: ExecServerMessage['message']
      result: string
      variant: string
      alternative: string
      echo?: Record<string, unknown>
    }[] = [
      { exec: { case: 'shellArgs', value: shell }, result: 'shellResult', variant: 'rejected', alternative: 'toolName "bash"', echo: { command: 'ls -la', workingDirectory: '/w' } },
      { exec: { case: 'shellStreamArgs', value: shell }, result: 'shellStream', variant: 'rejected', alternative: 'toolName "bash"', echo: { command: 'ls -la' } },
      { exec: { case: 'backgroundShellSpawnArgs', value: create(BackgroundShellSpawnArgsSchema, { command: 'sleep 9', workingDirectory: '/w' }) }, result: 'backgroundShellSpawnResult', variant: 'rejected', alternative: 'toolName "bash"', echo: { command: 'sleep 9' } },
      { exec: { case: 'writeShellStdinArgs', value: create(WriteShellStdinArgsSchema, { shellId: 1, chars: 'y' }) }, result: 'writeShellStdinResult', variant: 'error', alternative: 'toolName "bash"' },
      { exec: { case: 'writeArgs', value: create(WriteArgsSchema, { path: '/w/a.txt' }) }, result: 'writeResult', variant: 'rejected', alternative: 'toolName "write"', echo: { path: '/w/a.txt' } },
      { exec: { case: 'deleteArgs', value: create(DeleteArgsSchema, { path: '/w/a.txt' }) }, result: 'deleteResult', variant: 'rejected', alternative: 'toolName "bash"', echo: { path: '/w/a.txt' } },
      { exec: { case: 'grepArgs', value: create(GrepArgsSchema, { pattern: 'x' }) }, result: 'grepResult', variant: 'error', alternative: 'toolName "grep"' },
      { exec: { case: 'readArgs', value: create(ReadArgsSchema, { path: '/w/a.txt' }) }, result: 'readResult', variant: 'rejected', alternative: 'toolName "read"', echo: { path: '/w/a.txt' } },
      { exec: { case: 'lsArgs', value: create(LsArgsSchema, { path: '/w' }) }, result: 'lsResult', variant: 'rejected', alternative: 'toolName "glob"', echo: { path: '/w' } },
      { exec: { case: 'diagnosticsArgs', value: create(DiagnosticsArgsSchema, { path: '/w/a.ts' }) }, result: 'diagnosticsResult', variant: 'rejected', alternative: 'toolName "lsp"', echo: { path: '/w/a.ts' } },
      { exec: { case: 'listMcpResourcesExecArgs', value: create(ListMcpResourcesExecArgsSchema, {}) }, result: 'listMcpResourcesExecResult', variant: 'rejected', alternative: 'toolName "list_mcp_resources"' },
      { exec: { case: 'readMcpResourceExecArgs', value: create(ReadMcpResourceExecArgsSchema, { uri: 'res://x' }) }, result: 'readMcpResourceExecResult', variant: 'rejected', alternative: 'toolName "read_mcp_resource"', echo: { uri: 'res://x' } },
      { exec: { case: 'fetchArgs', value: create(FetchArgsSchema, { url: 'https://x' }) }, result: 'fetchResult', variant: 'error', alternative: 'toolName "web_fetch"', echo: { url: 'https://x' } },
      { exec: { case: 'recordScreenArgs', value: create(RecordScreenArgsSchema, {}) }, result: 'recordScreenResult', variant: 'failure', alternative: 'CallDynamicTool' },
      { exec: { case: 'computerUseArgs', value: create(ComputerUseArgsSchema, {}) }, result: 'computerUseResult', variant: 'error', alternative: 'CallDynamicTool' },
      { exec: { case: 'redactedReadArgs', value: create(ReadArgsSchema, { path: '/w/secret.txt' }) }, result: 'redactedReadResult', variant: 'rejected', alternative: 'toolName "read"', echo: { path: '/w/secret.txt' } },
      { exec: { case: 'miniSweAgentBashArgs', value: create(ShellArgsSchema, { command: 'pwd', workingDirectory: '/w' }) }, result: 'miniSweAgentBashResult', variant: 'rejected', alternative: 'toolName "bash"', echo: { command: 'pwd', workingDirectory: '/w' } },
      { exec: { case: 'piReadArgs', value: create(PiReadExecArgsSchema, { path: '/w/README.md' }) }, result: 'piReadResult', variant: 'error', alternative: 'toolName "read"' },
      { exec: { case: 'piBashArgs', value: create(PiBashExecArgsSchema, { command: 'ls' }) }, result: 'piBashResult', variant: 'error', alternative: 'toolName "bash"' },
      { exec: { case: 'piEditArgs', value: create(PiEditExecArgsSchema, { path: '/w/a.txt' }) }, result: 'piEditResult', variant: 'rejected', alternative: 'toolName "write"' },
      { exec: { case: 'piWriteArgs', value: create(PiWriteExecArgsSchema, { path: '/w/a.txt', content: 'x' }) }, result: 'piWriteResult', variant: 'rejected', alternative: 'toolName "write"' },
      { exec: { case: 'piGrepArgs', value: create(PiGrepExecArgsSchema, { pattern: 'x' }) }, result: 'piGrepResult', variant: 'error', alternative: 'toolName "grep"' },
      { exec: { case: 'piFindArgs', value: create(PiFindExecArgsSchema, { pattern: '*.ts' }) }, result: 'piFindResult', variant: 'error', alternative: 'toolName "glob"' },
      { exec: { case: 'piLsArgs', value: create(PiLsExecArgsSchema, { path: '/w' }) }, result: 'piLsResult', variant: 'error', alternative: 'toolName "glob"' },
    ]
    for (const entry of cases) {
      const { open, written } = capturing([execFrom(entry.exec), ...textThenEnd])
      const chunks = await collect(streamCursorRun({ ...request, tools }, 'tok', TIMING, open))
      expect(chunks.at(-1), entry.exec.case).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'), entry.exec.case).toBe(false)
      const reply = execReply(written)
      expect(reply.id, entry.exec.case).toBe(7)
      expect(reply.message.case, entry.exec.case).toBe(entry.result)
      type Outcome = { case?: string; value?: Record<string, unknown> }
      const payload = reply.message.value as { result?: Outcome; event?: Outcome }
      const outcome = payload.result ?? payload.event
      expect(outcome?.case, entry.exec.case).toBe(entry.variant)
      const detail = outcome?.value ?? {}
      const reason = String(detail['reason'] ?? detail['error'])
      expect(reason, entry.exec.case).toContain(entry.alternative)
      expect(detail, entry.exec.case).toMatchObject(entry.echo ?? {})
    }
  })

  it('names only the dsh namespace when no harness tool replaces the native one', async () => {
    const { open, written } = capturing([
      execFrom({ case: 'readArgs', value: create(ReadArgsSchema, { path: '/w/a.txt' }) }),
      ...textThenEnd,
    ])
    await collect(streamCursorRun(request, 'tok', TIMING, open))
    const reply = execReply(written)
    if (reply.message.case !== 'readResult' || reply.message.value.result.case !== 'rejected') throw new Error('expected a read rejection')
    expect(reply.message.value.result.value.reason).toContain('namespace "dsh"')
    expect(reply.message.value.result.value.reason).not.toContain('toolName')
  })

  it('ends the open text block at a refused exec so later text starts a new block', async () => {
    const text = (value: string) => serverMessage({
      message: {
        case: 'interactionUpdate',
        value: create(InteractionUpdateSchema, {
          message: { case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: value }) },
        }),
      },
    })
    const { open } = capturing([
      text('Reading the file.'),
      execFrom({ case: 'readArgs', value: create(ReadArgsSchema, { path: '/w/a.txt' }) }),
      ...textThenEnd,
    ])
    const chunks = await collect(streamCursorRun(request, 'tok', TIMING, open))
    const texts = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : [])
    expect(texts).toEqual(['Reading the file.', 'ok'])
  })

  it('fails an unanswered blob get, an unknown KV, and an unknown interaction query', async () => {
    await expect(collect(streamCursorRun(request, 'tok', TIMING, scripted([
      serverMessage({
        message: {
          case: 'kvServerMessage',
          value: create(KvServerMessageSchema, {
            id: 1,
            message: { case: 'getBlobArgs', value: create(GetBlobArgsSchema, { blobId: new Uint8Array(32) }) },
          }),
        },
      }),
    ])))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })

    await expect(collect(streamCursorRun(request, 'tok', TIMING, scripted([
      serverMessage({
        message: {
          case: 'kvServerMessage',
          value: create(KvServerMessageSchema, { id: 1, message: { case: undefined } }),
        },
      }),
    ])))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })

    await expect(collect(streamCursorRun(request, 'tok', TIMING, scripted([
      serverMessage({
        message: {
          case: 'interactionQuery',
          value: create(InteractionQuerySchema, {
            id: 1,
            query: { case: 'createPlanRequestQuery', value: create(CreatePlanRequestQuerySchema, {}) },
          }),
        },
      }),
    ])))).rejects.toBeInstanceOf(LlmError)

    await expect(collect(streamCursorRun(request, 'tok', TIMING, scripted([
      serverMessage({
        message: {
          case: 'interactionQuery',
          value: create(InteractionQuerySchema, { id: 2, query: { case: undefined } }),
        },
      }),
    ])))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('fails EMPTY_RESPONSE on a content-less turnEnded', async () => {
    await expect(collect(streamCursorRun(request, 'tok', TIMING, scripted([
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'turnEnded', value: create(TurnEndedUpdateSchema, {}) },
          }),
        },
      }),
    ])))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it('rejects a native Cursor question and keeps the Run alive for the harness question tool', async () => {
    const { open, written } = capturing([
      ...textThenEnd.slice(0, 1),
      serverMessage({
        message: {
          case: 'interactionQuery',
          value: create(InteractionQuerySchema, {
            id: 12,
            query: {
              case: 'askQuestionInteractionQuery',
              value: create(AskQuestionInteractionQuerySchema, {
                args: create(AskQuestionArgsSchema, {
                  questions: [create(AskQuestionArgs_QuestionSchema, { id: 'release', prompt: 'Publish this version?' })],
                }),
              }),
            },
          }),
        },
      }),
      ...textThenEnd,
    ])
    const chunks = await collect(streamCursorRun({
      ...request,
      tools: [{ name: 'ask_user_question', description: 'Ask the user', parameters: { type: 'object' } }],
    }, 'tok', TIMING, open))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)
    expect(chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')).toHaveLength(2)
    const reply = written.find(message => message.message.case === 'interactionResponse')
    if (reply?.message.case !== 'interactionResponse') throw new Error('expected an interaction response')
    expect(reply.message.value.id).toBe(12)
    const result = reply.message.value.result
    if (result.case !== 'askQuestionInteractionResponse' || result.value.result?.result.case !== 'rejected') {
      throw new Error('expected a rejected Cursor question')
    }
    expect(result.value.result.result.value.reason).toBe(
      'Cursor\'s built-in AskQuestion is not available in DeepSeek Harness. '
      + 'Call CallDynamicTool with namespace "dsh" and toolName "ask_user_question" instead.',
    )
  })

  it('asks for a reply when the harness question tool is unavailable', async () => {
    const { open, written } = capturing([
      serverMessage({
        message: {
          case: 'interactionQuery',
          value: create(InteractionQuerySchema, {
            id: 13,
            query: { case: 'askQuestionInteractionQuery', value: create(AskQuestionInteractionQuerySchema, {}) },
          }),
        },
      }),
      ...textThenEnd,
    ])
    await collect(streamCursorRun(request, 'tok', TIMING, open))
    const reply = written.find(message => message.message.case === 'interactionResponse')
    if (reply?.message.case !== 'interactionResponse') throw new Error('expected an interaction response')
    const result = reply.message.value.result
    if (result.case !== 'askQuestionInteractionResponse' || result.value.result?.result.case !== 'rejected') {
      throw new Error('expected a rejected Cursor question')
    }
    expect(result.value.result.result.value.reason).toBe(
      'Cursor\'s built-in AskQuestion is not available in DeepSeek Harness. Ask the user in a reply before continuing.',
    )
  })

  it('fails STREAM_CLOSED when the transport ends early', async () => {
    await expect(collect(streamCursorRun(request, 'tok', TIMING, () => ({
      write: () => {},
      end: () => {},
      destroy: () => {},
      frames: (async function* () {})(),
    })))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('rethrows a non-abort transport failure', async () => {
    await expect(collect(streamCursorRun(request, 'tok', TIMING, () => ({
      write: () => {},
      end: () => {},
      destroy: () => {},
      frames: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('boom')),
        }),
      },
    })))).rejects.toThrow('boom')

    await expect(collect(streamCursorRun(request, 'tok', TIMING, () => ({
      write: () => {},
      end: () => {},
      destroy: () => {},
      frames: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('nope')),
        }),
      },
    })))).rejects.toThrow('nope')
  })

  it('rejects an exec with no native case as unknown', async () => {
    await expect(collect(streamCursorRun(request, 'tok', TIMING, scripted([
      serverMessage({
        message: {
          case: 'execServerMessage',
          value: create(ExecServerMessageSchema, { id: 1, execId: 'e', message: { case: undefined } }),
        },
      }),
    ])))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('keeps the Run alive when Cursor sends a CLI Pi read exec', async () => {
    const tools = [{ name: 'read', description: 'read', parameters: { type: 'object' } }]
    const { open, written } = capturing([
      execFrom({ case: 'piReadArgs', value: create(PiReadExecArgsSchema, { path: '/w/README.md' }) }),
      ...textThenEnd,
    ])
    const chunks = await collect(streamCursorRun({ ...request, tools }, 'tok', TIMING, open))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)
    const reply = execReply(written)
    if (reply.message.case !== 'piReadResult' || reply.message.value.result.case !== 'error') {
      throw new Error('expected a Pi read error')
    }
    expect(reply.message.value.result.value.error).toContain('toolName "read"')
  })

  it('answers every CLI hook with an empty matching response', async () => {
    const hooks: ExecuteHookRequest[] = [
      create(ExecuteHookRequestSchema, { request: { case: 'preCompact', value: create(PreCompactRequestQuerySchema, {}) } }),
      create(ExecuteHookRequestSchema, { request: { case: 'subagentStart', value: create(SubagentStartRequestQuerySchema, {}) } }),
      create(ExecuteHookRequestSchema, { request: { case: 'subagentStop', value: create(SubagentStopRequestQuerySchema, {}) } }),
      create(ExecuteHookRequestSchema, { request: { case: 'preToolUse', value: create(PreToolUseRequestQuerySchema, {}) } }),
      create(ExecuteHookRequestSchema, { request: { case: 'postToolUse', value: create(PostToolUseRequestQuerySchema, {}) } }),
      create(ExecuteHookRequestSchema, { request: { case: 'postToolUseFailure', value: create(PostToolUseFailureRequestQuerySchema, {}) } }),
      create(ExecuteHookRequestSchema, { request: { case: 'beforeSubmitPrompt', value: create(BeforeSubmitPromptRequestQuerySchema, {}) } }),
      create(ExecuteHookRequestSchema, { request: { case: 'afterAgentResponse', value: create(AfterAgentResponseRequestQuerySchema, {}) } }),
      create(ExecuteHookRequestSchema, { request: { case: 'afterAgentThought', value: create(AfterAgentThoughtRequestQuerySchema, {}) } }),
      create(ExecuteHookRequestSchema, { request: { case: 'stop', value: create(StopRequestQuerySchema, {}) } }),
    ]
    for (const hook of hooks) {
      const { open, written } = capturing([
        execFrom({
          case: 'executeHookArgs',
          value: create(ExecuteHookArgsSchema, { request: hook }),
        }),
        ...textThenEnd,
      ])
      const chunks = await collect(streamCursorRun(request, 'tok', TIMING, open))
      expect(chunks.at(-1), hook.request.case).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      const reply = execReply(written)
      if (reply.message.case !== 'executeHookResult') throw new Error(`expected a hook result for ${hook.request.case}`)
      expect(reply.message.value.response?.response.case, hook.request.case).toBe(hook.request.case)
    }
  })

  it('throws on the wire and keeps the Run alive for a hook with no request', async () => {
    const { open, written } = capturing([
      execFrom({ case: 'executeHookArgs', value: create(ExecuteHookArgsSchema, {}) }),
      ...textThenEnd,
    ])
    const chunks = await collect(streamCursorRun(request, 'tok', TIMING, open))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(written.some(message => message.message.case === 'execClientControlMessage')).toBe(true)
  })

  it('answers MCP state with the advertised harness tools', async () => {
    const { open, written } = capturing([
      execFrom({ case: 'mcpStateExecArgs', value: create(McpStateExecArgsSchema, {}) }),
      ...textThenEnd,
    ])
    const chunks = await collect(streamCursorRun({
      ...request,
      tools: [
        { name: 'echo', description: 'echo', parameters: { type: 'object' } },
        { name: 'read', description: 'read', parameters: { type: 'object' } },
      ],
    }, 'tok', TIMING, open))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const reply = execReply(written)
    if (reply.message.case !== 'mcpStateExecResult' || reply.message.value.result.case !== 'success') {
      throw new Error('expected MCP state success')
    }
    const servers = reply.message.value.result.value.servers
    expect(servers).toHaveLength(1)
    expect(servers[0]?.serverIdentifier).toBe('dsh')
    expect(servers[0]?.tools.map(tool => tool.name)).toEqual(['echo', 'read'])
  })

  it('filters MCP state servers when Cursor names identifiers', async () => {
    const tools = [{ name: 'echo', description: 'echo', parameters: { type: 'object' } }]
    for (const [identifiers, expected] of [
      [['other'], []],
      [['dsh'], ['echo']],
    ] as const) {
      const { open, written } = capturing([
        execFrom({
          case: 'mcpStateExecArgs',
          value: create(McpStateExecArgsSchema, { serverIdentifiers: [...identifiers] }),
        }),
        ...textThenEnd,
      ])
      await collect(streamCursorRun({ ...request, tools }, 'tok', TIMING, open))
      const reply = execReply(written)
      if (reply.message.case !== 'mcpStateExecResult' || reply.message.value.result.case !== 'success') {
        throw new Error('expected MCP state success')
      }
      expect(reply.message.value.result.value.servers.map(server => server.serverIdentifier), identifiers.join(',')).toEqual(
        expected.length === 0 ? [] : ['dsh'],
      )
      expect(reply.message.value.result.value.servers[0]?.tools.map(tool => tool.name) ?? [], identifiers.join(',')).toEqual(expected)
    }
  })

  it('throws on the wire and keeps the Run alive for an unknown exec field', async () => {
    const { open, written } = capturingBytes([
      agentExecWithLengthDelimitedField(7, 'e7', 99, protoStringField(1, 'x')),
      ...textThenEnd.map(message => toBinary(AgentServerMessageSchema, message)),
    ])
    const chunks = await collect(streamCursorRun(request, 'tok', TIMING, open))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(written.some(message => message.message.case === 'execClientControlMessage')).toBe(true)
  })

  it('throws on the wire and keeps the Run alive for a typed control exec', async () => {
    const { open, written } = capturing([
      execFrom({
        case: 'conversationSearchArgs',
        value: create(ConversationSearchArgsSchema, { query: 'q', toolCallId: 't1' }),
      }),
      ...textThenEnd,
    ])
    const chunks = await collect(streamCursorRun(request, 'tok', TIMING, open))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(written.some(message => message.message.case === 'execClientControlMessage')).toBe(true)
  })

  it('closes an open text block before MCP tool-calls', async () => {
    const chunks = await collect(streamCursorRun(request, 'tok', TIMING, scripted([
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: 'hi' }) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'interactionUpdate',
          value: create(InteractionUpdateSchema, {
            message: { case: 'thinkingDelta', value: create(ThinkingDeltaUpdateSchema, { text: 'hmm' }) },
          }),
        },
      }),
      serverMessage({
        message: {
          case: 'execServerMessage',
          value: create(ExecServerMessageSchema, {
            id: 8,
            execId: 'e8',
            message: {
              case: 'mcpArgs',
              value: create(McpArgsSchema, {
                name: 'echo',
                toolName: 'echo',
                toolCallId: 'c8',
                args: {},
              }),
            },
          }),
        },
      }),
    ])))
    expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.type))
      .toEqual(['text', 'reasoning', 'tool-call'])
  })

  it('fails ABORTED when the caller signal fires mid-read', async () => {
    const controller = new AbortController()
    await expect(collect(streamCursorRun({ ...request, signal: controller.signal }, 'tok', TIMING, () => ({
      write: () => {},
      end: () => {},
      destroy: () => {},
      frames: {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            controller.abort(new Error('stop'))
            return new Promise<IteratorResult<{ endStream: boolean; payload: Uint8Array }>>(() => {})
          },
        }),
      },
    })))).rejects.toMatchObject({ code: 'ABORTED' })

    const cancelled = new AbortController()
    await expect(collect(streamCursorRun({ ...request, signal: cancelled.signal }, 'tok', TIMING, () => ({
      write: () => {},
      end: () => {},
      destroy: () => {},
      frames: {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            cancelled.abort('cancelled')
            return new Promise<IteratorResult<{ endStream: boolean; payload: Uint8Array }>>(() => {})
          },
        }),
      },
    })))).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('fails TIMEOUT when the idle watchdog fires', async () => {
    await expect(collect(streamCursorRun(request, 'tok', { ...TIMING, streamIdleTimeoutMs: 20 }, () => ({
      write: () => {},
      end: () => {},
      destroy: () => {},
      frames: {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<{ endStream: boolean; payload: Uint8Array }>>(() => {}),
        }),
      },
    })))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('opens a Connect stream through createOpenCursorStream', async () => {
    const emitter = new EventEmitter() as CursorHttp2Stream & EventEmitter
    emitter.write = () => {}
    emitter.end = () => {}
    emitter.destroy = () => {}
    const session: CursorHttp2Session = {
      request: () => emitter,
      close: () => {},
      destroy: () => {},
      on: () => {},
    }
    const open = createOpenCursorStream(() => session)
    const opened = open({ accessToken: 'tok', rpcPath: '/agent.v1.AgentService/Run' })
    const iterator = opened.frames[Symbol.asyncIterator]()
    const payload = toBinary(AgentServerMessageSchema, serverMessage({
      message: {
        case: 'interactionUpdate',
        value: create(InteractionUpdateSchema, {
          message: { case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: 'x' }) },
        }),
      },
    }))
    emitter.emit('data', frameConnectMessage(payload))
    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    opened.destroy()
  })

  it('uses the default openConnectStream opener', async () => {
    const connect = vi.spyOn(http2, 'connect').mockImplementation(() => {
      throw new Error('offline')
    })
    try {
      const open = createOpenCursorStream()
      expect(() => open({ accessToken: 'tok', rpcPath: '/agent.v1.AgentService/Run' })).toThrow('offline')
      await expect(collect(streamCursorRun(request, 'tok', TIMING))).rejects.toThrow('offline')
    } finally {
      connect.mockRestore()
    }
  })
})
