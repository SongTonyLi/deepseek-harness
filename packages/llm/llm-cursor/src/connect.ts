/**
 * Connect/protobuf HTTP/2 framing and a trimmed Node client for Cursor RPCs.
 *
 * @module @deepseek-ai/dsh-llm-cursor/connect
 */

import http2 from 'node:http2'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import { CONNECT_END_STREAM, CURSOR_AGENT_URL, CURSOR_CLIENT_VERSION, MAX_CONNECT_MESSAGE_BYTES } from './protocol.ts'

/** Maximum unary response this client will buffer. */
export const MAX_UNARY_RESPONSE_BYTES = 16 * 1024 * 1024

/** One parsed Connect DATA frame. */
export interface ConnectFrame {
  /** True when the EndStream flag is set. */
  endStream: boolean
  /** Frame payload. */
  payload: Uint8Array
}

/**
 * Frame a protobuf message as one Connect DATA frame.
 * @param data - protobuf bytes.
 * @param flags - Connect flags; omit for a regular message.
 * @returns the 5-byte header plus payload.
 */
export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  if (data.byteLength > MAX_CONNECT_MESSAGE_BYTES) {
    throw new LlmError(
      `llm-cursor: Connect message exceeds ${MAX_CONNECT_MESSAGE_BYTES} bytes`,
      'INVALID_REQUEST',
    )
  }
  const frame = Buffer.alloc(5 + data.byteLength)
  frame[0] = flags
  frame.writeUInt32BE(data.byteLength, 1)
  frame.set(data, 5)
  return frame
}

/**
 * Decode a Connect error payload on an EndStream frame.
 * @param data - EndStream payload.
 * @returns an Error when the payload names a Connect error, otherwise `undefined`.
 */
export function parseConnectEndStream(data: Uint8Array): Error | undefined {
  if (data.byteLength === 0) return undefined
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(data))
    if (typeof payload !== 'object' || payload === null) return undefined
    const error = (payload as { error?: { code?: unknown; message?: unknown } }).error
    if (error === undefined) return undefined
    const code = typeof error.code === 'string' || typeof error.code === 'number' ? String(error.code) : 'unknown'
    const message = typeof error.message === 'string' ? error.message : 'Unknown error'
    return new Error(`Connect error ${code}: ${message}`)
  } catch (_invalidEndStreamJson) {
    return new Error('Failed to parse Connect end stream')
  }
}

/**
 * Unwrap a unary Connect-framed body, or return the raw bytes.
 * @param payload - HTTP/2 response body.
 * @returns protobuf bytes.
 */
export function decodeUnaryBody(payload: Uint8Array): Uint8Array {
  if (payload.byteLength < 5) return payload
  let offset = 0
  while (offset + 5 <= payload.byteLength) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- offset is inside the length guard
    const flags = payload[offset]!
    const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset)
    const messageLength = view.getUint32(1, false)
    const frameEnd = offset + 5 + messageLength
    if (frameEnd > payload.byteLength) return payload
    if ((flags & 0b00000010) === 0) return payload.subarray(offset + 5, frameEnd)
    offset = frameEnd
  }
  return payload
}

/**
 * Incremental Connect frame parser.
 * @param onFrame - complete frame callback.
 * @returns a function that accepts the next TCP/HTTP2 DATA chunk.
 */
export function createConnectFrameParser(onFrame: (frame: ConnectFrame) => void): (incoming: Buffer) => void {
  const chunks: Buffer[] = []
  let total = 0
  const peek = (n: number): Buffer => {
    const first = chunks[0]
    if (first !== undefined && first.length >= n) return first.subarray(0, n)
    const merged = Buffer.concat(chunks, total)
    chunks.length = 0
    chunks.push(merged)
    return merged.subarray(0, n)
  }
  const consume = (n: number): Buffer => {
    const front = peek(n)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- peek concatenates so chunks[0] exists
    const first = chunks[0]!
    if (first.length === n) chunks.shift()
    else chunks[0] = first.subarray(n)
    total -= n
    return front
  }
  return (incoming: Buffer) => {
    chunks.push(incoming)
    total += incoming.length
    while (total >= 5) {
      const header = peek(5)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- header is 5 bytes
      const flags = header[0]!
      const msgLen = header.readUInt32BE(1)
      if (msgLen > MAX_CONNECT_MESSAGE_BYTES) {
        throw new LlmError(
          `llm-cursor: Connect message exceeds ${MAX_CONNECT_MESSAGE_BYTES} bytes`,
          'STREAM_CLOSED',
        )
      }
      if (total < 5 + msgLen) return
      consume(5)
      const payload = consume(msgLen)
      onFrame({ endStream: (flags & CONNECT_END_STREAM) !== 0, payload })
    }
  }
}

/** The HTTP/2 session slice this client uses. */
export interface CursorHttp2Session {
  request(headers: http2.OutgoingHttpHeaders): CursorHttp2Stream
  close(): void
  destroy(): void
  on(event: 'error', listener: (err: Error) => void): void
}

/** The HTTP/2 stream slice this client uses. */
export interface CursorHttp2Stream {
  write(chunk: Uint8Array): void
  end(chunk?: Uint8Array): void
  destroy(): void
  on(event: string, listener: (...args: unknown[]) => void): void
}

/** Opens one HTTP/2 session against an origin. */
export type ConnectHttp2 = (origin: string) => CursorHttp2Session

/** Headers and body for one Cursor RPC. */
export interface CursorRpcRequest {
  /** Bearer access token. */
  accessToken: string
  /** RPC path. */
  rpcPath: string
  /** Agent origin; defaults to {@link CURSOR_AGENT_URL}. */
  origin?: string
  /** Caller abort. */
  signal?: AbortSignal
}

/** A live bidirectional Connect stream. */
export interface CursorConnectStream {
  /** Write one Connect-framed protobuf message. */
  write(payload: Uint8Array): void
  /** End the client half. */
  end(): void
  /** Destroy the session. */
  destroy(): void
  /** Parsed incoming frames. */
  frames: AsyncIterable<ConnectFrame>
}

function cursorHeaders(
  rpcPath: string,
  accessToken: string,
  contentType: string,
): http2.OutgoingHttpHeaders {
  return {
    ':method': 'POST',
    ':path': rpcPath,
    'content-type': contentType,
    'connect-protocol-version': '1',
    te: 'trailers',
    authorization: `Bearer ${accessToken}`,
    'x-ghost-mode': 'true',
    'x-cursor-client-version': CURSOR_CLIENT_VERSION,
    'x-cursor-client-type': 'cli',
    'x-request-id': randomUUID(),
    ...attributionHeaders(),
  }
}

function defaultConnect(origin: string): CursorHttp2Session {
  return http2.connect(origin)
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback)
}

/**
 * Unary Connect RPC over HTTP/2 (`application/proto`).
 * @param request - token, path, and abort.
 * @param body - raw protobuf request.
 * @param connect - injectable session opener.
 * @returns HTTP status and response bytes.
 */
export async function callUnary(
  request: CursorRpcRequest,
  body: Uint8Array,
  connect: ConnectHttp2 = defaultConnect,
): Promise<{ status: number; body: Buffer }> {
  const origin = request.origin ?? CURSOR_AGENT_URL
  return await new Promise((resolve, reject) => {
    let settled = false
    let session: CursorHttp2Session | undefined
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      request.signal?.removeEventListener('abort', onAbort)
      try {
        session?.destroy()
      } catch (_alreadyDestroyedSession) {
        // Session may already be torn down by the error that brought us here.
      }
      reject(asError(error, 'Cursor unary RPC failed'))
    }
    const succeed = (result: { status: number; body: Buffer }): void => {
      if (settled) return
      settled = true
      request.signal?.removeEventListener('abort', onAbort)
      try {
        session?.close()
      } catch (_alreadyClosedSession) {
        // Close is best effort after a completed unary.
      }
      resolve(result)
    }
    const onAbort = (): void => {
      fail(request.signal?.reason instanceof Error ? request.signal.reason : new Error('Cursor unary RPC aborted'))
    }
    if (request.signal?.aborted === true) {
      onAbort()
      return
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      session = connect(origin)
    } catch (error) {
      fail(error)
      return
    }
    session.on('error', (err) => { fail(err) })
    const stream = session.request(cursorHeaders(request.rpcPath, request.accessToken, 'application/proto'))
    const chunks: Buffer[] = []
    let responseBytes = 0
    let status = 0
    stream.on('response', (headers) => {
      status = Number((headers as http2.IncomingHttpHeaders)[':status'] ?? 0)
    })
    stream.on('data', (chunk) => {
      const buffer = Buffer.from(chunk as Buffer)
      responseBytes += buffer.byteLength
      if (responseBytes > MAX_UNARY_RESPONSE_BYTES) {
        fail(new LlmError(`llm-cursor: unary response exceeds ${MAX_UNARY_RESPONSE_BYTES} bytes`, 'STREAM_CLOSED'))
        return
      }
      chunks.push(buffer)
    })
    stream.on('error', (err) => { fail(err) })
    stream.on('end', () => { succeed({ status, body: Buffer.concat(chunks) }) })
    stream.end(body)
  })
}

/**
 * Bidirectional Connect stream (`application/connect+proto`).
 * @param request - token, path, and abort.
 * @param connect - injectable session opener.
 * @returns a live stream the adapter writes frames to and reads frames from.
 */
export function openConnectStream(
  request: CursorRpcRequest,
  connect: ConnectHttp2 = defaultConnect,
): CursorConnectStream {
  const origin = request.origin ?? CURSOR_AGENT_URL
  const session = connect(origin)
  const stream = session.request(cursorHeaders(request.rpcPath, request.accessToken, 'application/connect+proto'))
  const pending: ConnectFrame[] = []
  const waiters: Array<(frame: IteratorResult<ConnectFrame>) => void> = []
  let done = false
  let failure: unknown
  const push = (frame: ConnectFrame): void => {
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter({ done: false, value: frame })
    else pending.push(frame)
  }
  const fail = (error: unknown): void => {
    if (done) return
    done = true
    failure = error
    while (waiters.length > 0) waiters.shift()?.({ done: true, value: undefined })
    try {
      session.destroy()
    } catch (_alreadyDestroyedSession) {
      // Destroy is best effort after a transport failure.
    }
  }
  const finish = (): void => {
    if (done) return
    done = true
    while (waiters.length > 0) waiters.shift()?.({ done: true, value: undefined })
    try {
      session.close()
    } catch (_alreadyClosedSession) {
      // Close is best effort after a clean end.
    }
  }
  const onAbort = (): void => {
    fail(request.signal?.reason instanceof Error ? request.signal.reason : new Error('Cursor stream aborted'))
  }
  request.signal?.addEventListener('abort', onAbort, { once: true })
  if (request.signal?.aborted === true) onAbort()
  session.on('error', (err) => { fail(err) })
  const parse = createConnectFrameParser((frame) => {
    if (frame.endStream) {
      const error = parseConnectEndStream(frame.payload)
      if (error !== undefined) fail(error)
      else finish()
      return
    }
    push(frame)
  })
  stream.on('data', (chunk) => {
    try {
      parse(Buffer.from(chunk as Buffer))
    } catch (error) {
      fail(error)
    }
  })
  stream.on('error', (err) => { fail(err) })
  stream.on('end', () => { finish() })
  stream.on('response', (headers) => {
    const status = Number((headers as http2.IncomingHttpHeaders)[':status'] ?? 0)
    if (status !== 0 && (status < 200 || status >= 300)) {
      fail(new LlmError(`llm-cursor: HTTP ${status} from Cursor agent`, 'TRANSPORT', { status }))
    }
  })
  return {
    write: (payload) => { stream.write(frameConnectMessage(payload)) },
    end: () => { stream.end() },
    destroy: () => {
      request.signal?.removeEventListener('abort', onAbort)
      try {
        stream.destroy()
      } catch (_alreadyClosedStream) {
        // Stream may already be closed.
      }
      try {
        session.destroy()
      } catch (_alreadyClosedSession) {
        // Session may already be closed.
      }
    },
    frames: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (pending.length > 0) {
            // oxlint-disable-next-line typescript/no-non-null-assertion -- length was checked
            return Promise.resolve({ done: false, value: pending.shift()! })
          }
          if (failure !== undefined) return Promise.reject(asError(failure, 'Cursor stream failed'))
          if (done) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve, reject) => {
            waiters.push((result) => {
              if (failure !== undefined) reject(asError(failure, 'Cursor stream failed'))
              else resolve(result)
            })
          })
        },
      }),
    },
  }
}
