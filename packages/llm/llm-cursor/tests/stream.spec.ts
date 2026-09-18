/** Cursor Run stream translation. */
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  BackgroundShellSpawnArgsSchema,
  ComputerUseArgsSchema,
  CreatePlanRequestQuerySchema,
  DeleteArgsSchema,
  DiagnosticsArgsSchema,
  ExecServerMessageSchema,
  FetchArgsSchema,
  GetBlobArgsSchema,
  GrepArgsSchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  ListMcpResourcesExecArgsSchema,
  LsArgsSchema,
  McpArgsSchema,
  ReadArgsSchema,
  ReadMcpResourceExecArgsSchema,
  RecordScreenArgsSchema,
  RequestContextArgsSchema,
  SetBlobArgsSchema,
  ShellArgsSchema,
  TextDeltaUpdateSchema,
  ThinkingDeltaUpdateSchema,
  TokenDeltaUpdateSchema,
  TurnEndedUpdateSchema,
  UserMessageAppendedUpdateSchema,
  WebSearchRequestQuerySchema,
  WriteArgsSchema,
  WriteShellStdinArgsSchema,
} from '../src/native/agent_pb.ts'
import type { AgentClientMessage, ExecServerMessage } from '../src/native/agent_pb.ts'
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
  const written: AgentClientMessage[] = []
  const open: OpenCursorStream = () => ({
    write: (bytes) => { written.push(fromBinary(AgentClientMessageSchema, bytes)) },
    end: () => {},
    destroy: () => {},
    frames: (async function* () {
      for (const message of messages) {
        yield { endStream: false, payload: toBinary(AgentServerMessageSchema, message) }
      }
    })(),
  })
  return { open, written }
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

const request = {
  provider: 'cursor' as const,
  model: 'composer-2',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
}

describe('streamCursorRun', () => {
  it('emits text, thinking, usage, and stop', async () => {
    const chunks = await collect(streamCursorRun(request, 'tok', 5_000, scripted([
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
    const chunks = await collect(streamCursorRun(request, 'tok', 5_000, scripted([
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
    }, 'tok', 5_000, scripted([
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

    const named = await collect(streamCursorRun(request, 'tok', 5_000, scripted([
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
      const chunks = await collect(streamCursorRun(request, 'tok', 5_000, scripted([
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
    await collect(streamCursorRun(request, 'tok', 5_000, scripted([
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
    }, 'tok', 5_000, open))
    const reply = execReply(written)
    expect(reply.id).toBe(7)
    expect(reply.execId).toBe('e7')
    if (reply.message.case !== 'requestContextResult' || reply.message.value.result.case !== 'success') {
      throw new Error('expected a successful request context result')
    }
    const requestContext = reply.message.value.result.value.requestContext
    expect(requestContext?.rules.map(rule => rule.content)).toEqual([expect.stringContaining('mcp_dsh_')])
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
      { exec: { case: 'shellArgs', value: shell }, result: 'shellResult', variant: 'rejected', alternative: 'mcp_dsh_bash', echo: { command: 'ls -la', workingDirectory: '/w' } },
      { exec: { case: 'shellStreamArgs', value: shell }, result: 'shellStream', variant: 'rejected', alternative: 'mcp_dsh_bash', echo: { command: 'ls -la' } },
      { exec: { case: 'backgroundShellSpawnArgs', value: create(BackgroundShellSpawnArgsSchema, { command: 'sleep 9', workingDirectory: '/w' }) }, result: 'backgroundShellSpawnResult', variant: 'rejected', alternative: 'mcp_dsh_bash', echo: { command: 'sleep 9' } },
      { exec: { case: 'writeShellStdinArgs', value: create(WriteShellStdinArgsSchema, { shellId: 1, chars: 'y' }) }, result: 'writeShellStdinResult', variant: 'error', alternative: 'mcp_dsh_bash' },
      { exec: { case: 'writeArgs', value: create(WriteArgsSchema, { path: '/w/a.txt' }) }, result: 'writeResult', variant: 'rejected', alternative: 'mcp_dsh_write', echo: { path: '/w/a.txt' } },
      { exec: { case: 'deleteArgs', value: create(DeleteArgsSchema, { path: '/w/a.txt' }) }, result: 'deleteResult', variant: 'rejected', alternative: 'mcp_dsh_bash', echo: { path: '/w/a.txt' } },
      { exec: { case: 'grepArgs', value: create(GrepArgsSchema, { pattern: 'x' }) }, result: 'grepResult', variant: 'error', alternative: 'mcp_dsh_grep' },
      { exec: { case: 'readArgs', value: create(ReadArgsSchema, { path: '/w/a.txt' }) }, result: 'readResult', variant: 'rejected', alternative: 'mcp_dsh_read', echo: { path: '/w/a.txt' } },
      { exec: { case: 'lsArgs', value: create(LsArgsSchema, { path: '/w' }) }, result: 'lsResult', variant: 'rejected', alternative: 'mcp_dsh_glob', echo: { path: '/w' } },
      { exec: { case: 'diagnosticsArgs', value: create(DiagnosticsArgsSchema, { path: '/w/a.ts' }) }, result: 'diagnosticsResult', variant: 'rejected', alternative: 'mcp_dsh_lsp', echo: { path: '/w/a.ts' } },
      { exec: { case: 'listMcpResourcesExecArgs', value: create(ListMcpResourcesExecArgsSchema, {}) }, result: 'listMcpResourcesExecResult', variant: 'rejected', alternative: 'mcp_dsh_list_mcp_resources' },
      { exec: { case: 'readMcpResourceExecArgs', value: create(ReadMcpResourceExecArgsSchema, { uri: 'res://x' }) }, result: 'readMcpResourceExecResult', variant: 'rejected', alternative: 'mcp_dsh_read_mcp_resource', echo: { uri: 'res://x' } },
      { exec: { case: 'fetchArgs', value: create(FetchArgsSchema, { url: 'https://x' }) }, result: 'fetchResult', variant: 'error', alternative: 'mcp_dsh_web_fetch', echo: { url: 'https://x' } },
      { exec: { case: 'recordScreenArgs', value: create(RecordScreenArgsSchema, {}) }, result: 'recordScreenResult', variant: 'failure', alternative: 'mcp_dsh_' },
      { exec: { case: 'computerUseArgs', value: create(ComputerUseArgsSchema, {}) }, result: 'computerUseResult', variant: 'error', alternative: 'mcp_dsh_' },
    ]
    for (const entry of cases) {
      const { open, written } = capturing([execFrom(entry.exec), ...textThenEnd])
      const chunks = await collect(streamCursorRun({ ...request, tools }, 'tok', 5_000, open))
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

  it('names only the mcp_dsh_ prefix when no harness tool replaces the native one', async () => {
    const { open, written } = capturing([
      execFrom({ case: 'readArgs', value: create(ReadArgsSchema, { path: '/w/a.txt' }) }),
      ...textThenEnd,
    ])
    await collect(streamCursorRun(request, 'tok', 5_000, open))
    const reply = execReply(written)
    if (reply.message.case !== 'readResult' || reply.message.value.result.case !== 'rejected') throw new Error('expected a read rejection')
    expect(reply.message.value.result.value.reason).toContain('mcp_dsh_')
    expect(reply.message.value.result.value.reason).not.toContain('mcp_dsh_read')
  })

  it('fails an unanswered blob get, an unknown KV, and an unknown interaction query', async () => {
    await expect(collect(streamCursorRun(request, 'tok', 5_000, scripted([
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

    await expect(collect(streamCursorRun(request, 'tok', 5_000, scripted([
      serverMessage({
        message: {
          case: 'kvServerMessage',
          value: create(KvServerMessageSchema, { id: 1, message: { case: undefined } }),
        },
      }),
    ])))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })

    await expect(collect(streamCursorRun(request, 'tok', 5_000, scripted([
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

    await expect(collect(streamCursorRun(request, 'tok', 5_000, scripted([
      serverMessage({
        message: {
          case: 'interactionQuery',
          value: create(InteractionQuerySchema, { id: 2, query: { case: undefined } }),
        },
      }),
    ])))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('fails EMPTY_RESPONSE on a content-less turnEnded', async () => {
    await expect(collect(streamCursorRun(request, 'tok', 5_000, scripted([
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

  it('fails STREAM_CLOSED when the transport ends early', async () => {
    await expect(collect(streamCursorRun(request, 'tok', 5_000, () => ({
      write: () => {},
      end: () => {},
      destroy: () => {},
      frames: (async function* () {})(),
    })))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('rethrows a non-abort transport failure', async () => {
    await expect(collect(streamCursorRun(request, 'tok', 5_000, () => ({
      write: () => {},
      end: () => {},
      destroy: () => {},
      frames: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('boom')),
        }),
      },
    })))).rejects.toThrow('boom')

    await expect(collect(streamCursorRun(request, 'tok', 5_000, () => ({
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
    await expect(collect(streamCursorRun(request, 'tok', 5_000, scripted([
      serverMessage({
        message: {
          case: 'execServerMessage',
          value: create(ExecServerMessageSchema, { id: 1, execId: 'e', message: { case: undefined } }),
        },
      }),
    ])))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('closes an open text block before MCP tool-calls', async () => {
    const chunks = await collect(streamCursorRun(request, 'tok', 5_000, scripted([
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
    await expect(collect(streamCursorRun({ ...request, signal: controller.signal }, 'tok', 5_000, () => ({
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
    await expect(collect(streamCursorRun({ ...request, signal: cancelled.signal }, 'tok', 5_000, () => ({
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
    await expect(collect(streamCursorRun(request, 'tok', 20, () => ({
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
      await expect(collect(streamCursorRun(request, 'tok', 5_000))).rejects.toThrow('offline')
    } finally {
      connect.mockRestore()
    }
  })
})
