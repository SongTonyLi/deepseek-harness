/**
 * Cursor Runs that stay open across DSH steps. A Run that stops on MCP tool
 * calls parks here; the next request of the same Session that carries exactly
 * those tool results resumes it by answering the calls on the same stream, so
 * the model continues its turn with its own reasoning instead of starting a
 * new one from replayed history.
 *
 * @module @deepseek-ai/dsh-llm-cursor/park
 */

import { createHash } from 'node:crypto'
import { create, toBinary } from '@bufbuild/protobuf'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ConnectFrame, CursorConnectStream } from './connect.ts'
import {
  AgentClientMessageSchema,
  CancelActionSchema,
  ClientHeartbeatSchema,
  ConversationActionSchema,
  ExecClientMessageSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolResultContentItemSchema,
} from './native/agent_pb.ts'
import { CLIENT_HEARTBEAT_INTERVAL_MS } from './protocol.ts'
import { textOf } from './request.ts'
import type { CursorRunPayload } from './request.ts'

/** One MCP exec the Run waits on, addressed as Cursor sent it. */
export interface PendingMcpExec {
  /** Exec message id. */
  id: number
  /** Exec id. */
  execId: string
}

/** The result one pending exec receives when its Run resumes. */
export interface McpAnswer {
  /** The exec being answered. */
  exec: PendingMcpExec
  /** Result text, including any harness context appended to the last answer. */
  text: string
  /** Whether the harness tool reported an error. */
  isError: boolean
}

/**
 * One open `AgentService/Run`: the Connect stream, the payload whose blobs and
 * tools the server may ask for, and the MCP execs awaiting results. At most
 * one frame read is outstanding; a read a step abandons is handed to the next
 * step so no frame is lost.
 */
export class CursorRun {
  /** Tool-call id to the exec awaiting its result. */
  readonly pending = new Map<string, PendingMcpExec>()
  private readonly iterator: AsyncIterator<ConnectFrame>
  private inflight: Promise<IteratorResult<ConnectFrame>> | undefined
  private closed = false

  /**
   * @param stream - opened Connect stream; the Run owns its teardown.
   * @param payload - the payload the Run was opened with.
   */
  constructor(readonly stream: CursorConnectStream, readonly payload: CursorRunPayload) {
    this.iterator = stream.frames[Symbol.asyncIterator]()
  }

  /**
   * The next server frame, sharing one outstanding read across callers.
   * @returns the iterator result.
   */
  next(): Promise<IteratorResult<ConnectFrame>> {
    if (this.inflight !== undefined) return this.inflight
    const read = this.iterator.next()
    this.inflight = read
    const settle = (): void => { this.inflight = undefined }
    read.then(settle, settle)
    return read
  }

  /**
   * Answer the pending MCP execs and clear the pending set.
   * @param answers - one answer per pending exec, from {@link CursorRunRegistry.take}.
   */
  sendResults(answers: readonly McpAnswer[]): void {
    for (const answer of answers) {
      this.stream.write(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
        message: {
          case: 'execClientMessage',
          value: create(ExecClientMessageSchema, {
            id: answer.exec.id,
            execId: answer.exec.execId,
            message: {
              case: 'mcpResult',
              value: create(McpResultSchema, {
                result: {
                  case: 'success',
                  value: create(McpSuccessSchema, {
                    content: [create(McpToolResultContentItemSchema, {
                      content: { case: 'text', value: create(McpTextContentSchema, { text: answer.text }) },
                    })],
                    isError: answer.isError,
                  }),
                },
              }),
            },
          }),
        },
      })))
    }
    this.pending.clear()
  }

  /** Send the `clientHeartbeat` the Cursor CLI sends while a Run is open. */
  heartbeat(): void {
    this.stream.write(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
      message: { case: 'clientHeartbeat', value: create(ClientHeartbeatSchema, {}) },
    })))
  }

  /**
   * Cancel the Cursor turn and tear the stream down. Idempotent.
   * @param cancelTurn - send `cancelAction` first; false after the turn already ended.
   */
  close(cancelTurn = true): void {
    if (this.closed) return
    this.closed = true
    if (cancelTurn) {
      try {
        this.stream.write(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
          message: {
            case: 'conversationAction',
            value: create(ConversationActionSchema, { action: { case: 'cancelAction', value: create(CancelActionSchema, {}) } }),
          },
        })))
      } catch (_streamAlreadyGone) {
        // A stream that already failed cannot carry the cancel; destroy still releases it.
      }
    }
    this.stream.destroy()
  }
}

/** Identity of the request a Run parked after, projected to what the model saw. */
function requestFingerprint(model: string, system: string | undefined, tools: GenerateOptions['tools'], messages: readonly RequestMessage[]): string {
  const projected = messages.map(message => ({
    role: message.role,
    toolCallId: message.role === 'tool' ? message.toolCallId : undefined,
    isError: message.role === 'tool' ? message.isError === true : undefined,
    content: message.content.map(block => JSON.stringify(block)),
  }))
  return createHash('sha256')
    .update(JSON.stringify({ model, system, tools, projected }))
    .digest('hex')
}

/**
 * Fingerprint of the request a Run stops after.
 * @param options - the request whose step ended on tool calls.
 * @returns a digest a resuming request's prefix must match.
 */
export function parkFingerprint(options: GenerateOptions): string {
  return requestFingerprint(options.model, options.system, options.tools, options.messages)
}

/**
 * Split a resuming request into the fingerprint of everything before its last
 * assistant message, the tool results after it, and harness-injected
 * user-role context that follows those results (nested workspace
 * instructions, notices). Returns `undefined` when the assistant message is
 * followed by anything else, such as a human message or a tool result after
 * injected context.
 * @param options - the candidate resuming request.
 * @returns the prefix fingerprint, the assistant's tool-call ids, results by id, and trailing context.
 */
export function resumeShape(options: GenerateOptions): {
  fingerprint: string
  toolCallIds: string[]
  results: Map<string, { text: string; isError: boolean }>
  context: string[]
} | undefined {
  const messages = options.messages
  let assistantIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      assistantIndex = index
      break
    }
  }
  if (assistantIndex < 0) return undefined
  const results = new Map<string, { text: string; isError: boolean }>()
  const context: string[] = []
  for (const message of messages.slice(assistantIndex + 1)) {
    const text = textOf(message)
    if (message.role === 'tool' && context.length === 0) {
      results.set(message.toolCallId, { text, isError: message.isError === true })
    } else if (message.role === 'user' && message.source !== undefined && message.source.kind !== 'user') {
      context.push(text)
    } else {
      return undefined
    }
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- assistantIndex was found above
  const assistant = messages[assistantIndex]!
  const toolCallIds = assistant.content.flatMap(block => block.type === 'tool-call' ? [String(block.id)] : [])
  return {
    fingerprint: requestFingerprint(options.model, options.system, options.tools, messages.slice(0, assistantIndex)),
    toolCallIds,
    results,
    context,
  }
}

function answersFor(
  pending: ReadonlyMap<string, PendingMcpExec>,
  shape: NonNullable<ReturnType<typeof resumeShape>>,
): McpAnswer[] | undefined {
  const answers: McpAnswer[] = []
  for (const [toolCallId, exec] of pending) {
    const result = shape.results.get(toolCallId)
    if (result === undefined || !shape.toolCallIds.includes(toolCallId)) return undefined
    answers.push({ exec, ...result })
  }
  const last = answers.at(-1)
  if (last !== undefined && shape.context.length > 0) last.text = [last.text, ...shape.context].join('\n\n')
  return answers
}

interface ParkedRun {
  run: CursorRun
  fingerprint: string
  heartbeat: ReturnType<typeof setInterval>
  expiry: ReturnType<typeof setTimeout>
}

/**
 * Parked Runs, at most one per Session. The adapter owns one registry and
 * closes it when the plugin is disposed.
 */
export class CursorRunRegistry {
  private readonly parked = new Map<string, ParkedRun>()

  /**
   * Park a Run whose step ended on tool calls. Replaces and closes any Run the Session already parked.
   * @param sessionId - Session the Run belongs to.
   * @param run - Run with a non-empty pending set.
   * @param fingerprint - {@link parkFingerprint} of the request that step answered.
   * @param timeoutMs - how long the Run waits for its tool results.
   */
  park(sessionId: string, run: CursorRun, fingerprint: string, timeoutMs: number): void {
    this.discard(sessionId)
    const heartbeat = setInterval(() => { run.heartbeat() }, CLIENT_HEARTBEAT_INTERVAL_MS)
    const expiry = setTimeout(() => { this.discard(sessionId) }, timeoutMs)
    heartbeat.unref()
    expiry.unref()
    this.parked.set(sessionId, { run, fingerprint, heartbeat, expiry })
  }

  /**
   * Take the Session's parked Run when the request carries exactly its tool
   * results after an unchanged prefix. Any other request from the Session
   * closes the parked Run, because the conversation moved on without it.
   * Harness context that followed the results is appended to the last answer,
   * because a parked Run cannot take a new user message.
   * @param sessionId - requesting Session.
   * @param options - the request.
   * @returns the Run and the answers to send, or `undefined` to open a new Run.
   */
  take(sessionId: string, options: GenerateOptions): { run: CursorRun; answers: McpAnswer[] } | undefined {
    const entry = this.parked.get(sessionId)
    if (entry === undefined) return undefined
    this.release(sessionId, entry)
    const shape = resumeShape(options)
    const answers = shape !== undefined
      && shape.fingerprint === entry.fingerprint
      && shape.toolCallIds.length === entry.run.pending.size
      ? answersFor(entry.run.pending, shape)
      : undefined
    if (answers === undefined) {
      entry.run.close()
      return undefined
    }
    return { run: entry.run, answers }
  }

  /**
   * Close and forget the Session's parked Run, if any.
   * @param sessionId - Session to clear.
   */
  discard(sessionId: string): void {
    const entry = this.parked.get(sessionId)
    if (entry === undefined) return
    this.release(sessionId, entry)
    entry.run.close()
  }

  /** Close every parked Run. */
  closeAll(): void {
    for (const sessionId of [...this.parked.keys()]) this.discard(sessionId)
  }

  private release(sessionId: string, entry: ParkedRun): void {
    clearInterval(entry.heartbeat)
    clearTimeout(entry.expiry)
    this.parked.delete(sessionId)
  }
}
