/** Connect framing and injectable HTTP/2 client. */
import { EventEmitter } from 'node:events'
import http2 from 'node:http2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  callUnary,
  createConnectFrameParser,
  decodeUnaryBody,
  frameConnectMessage,
  MAX_UNARY_RESPONSE_BYTES,
  openConnectStream,
  parseConnectEndStream,
} from '../src/connect.ts'
import { CONNECT_END_STREAM } from '../src/protocol.ts'
import type { CursorHttp2Session, CursorHttp2Stream } from '../src/connect.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

function fakeStream(): CursorHttp2Stream & EventEmitter {
  const stream = new EventEmitter() as CursorHttp2Stream & EventEmitter
  stream.write = () => {}
  stream.end = (chunk?: Uint8Array) => {
    if (chunk !== undefined) stream.emit('data', Buffer.from(chunk))
    queueMicrotask(() => {
      stream.emit('response', { ':status': 200 })
      stream.emit('end')
    })
  }
  stream.destroy = () => {}
  return stream
}

function fakeSession(stream: CursorHttp2Stream): CursorHttp2Session {
  const session = {
    request: () => stream,
    close: () => {},
    destroy: () => {},
    on: (event: 'error', listener: (err: Error) => void) => {
      void event
      void listener
    },
  }
  return session
}

describe('Connect framing', () => {
  it('frames and parses messages including EndStream errors', () => {
    const payload = Buffer.from('hello')
    const framed = frameConnectMessage(payload)
    expect(framed[0]).toBe(0)
    expect(framed.readUInt32BE(1)).toBe(5)
    const frames: { endStream: boolean; payload: Uint8Array }[] = []
    const parse = createConnectFrameParser(frame => frames.push(frame))
    parse(framed.subarray(0, 3))
    parse(framed.subarray(3))
    expect(new TextDecoder().decode(frames[0]!.payload)).toBe('hello')
    const split = frameConnectMessage(Buffer.from('ab'))
    parse(split.subarray(0, 5))
    parse(split.subarray(5, 6))
    parse(split.subarray(6))
    expect(new TextDecoder().decode(frames[1]!.payload)).toBe('ab')
    const exact = frameConnectMessage(Buffer.from('xy'))
    parse(exact.subarray(0, 5))
    parse(exact.subarray(5))
    expect(new TextDecoder().decode(frames[2]!.payload)).toBe('xy')
    expect(parseConnectEndStream(Buffer.from('{"error":{"code":"internal","message":"x"}}'))?.message)
      .toContain('internal')
    expect(parseConnectEndStream(Buffer.from('{}'))).toBeUndefined()
    expect(parseConnectEndStream(Buffer.from('null'))).toBeUndefined()
    expect(parseConnectEndStream(Buffer.from('{"error":{}}'))?.message).toContain('unknown')
    expect(parseConnectEndStream(Buffer.from('not-json'))?.message).toContain('Failed to parse')
    expect(parseConnectEndStream(new Uint8Array())).toBeUndefined()
    const whole = frameConnectMessage(Buffer.from('hello'))
    parse(whole)
    expect(frames).toHaveLength(4)
  })

  it('unwraps a unary Connect body and returns raw bytes when unframed', () => {
    const inner = Buffer.from('abc')
    const framed = frameConnectMessage(inner)
    expect(Buffer.from(decodeUnaryBody(framed)).toString()).toBe('abc')
    expect(Buffer.from(decodeUnaryBody(inner)).toString()).toBe('abc')
    const ended = frameConnectMessage(Buffer.from('{}'), CONNECT_END_STREAM)
    expect(Buffer.from(decodeUnaryBody(ended)).equals(ended)).toBe(true)
    const skipped = Buffer.concat([
      frameConnectMessage(Buffer.from('{}'), CONNECT_END_STREAM),
      frameConnectMessage(Buffer.from('xyz')),
    ])
    expect(Buffer.from(decodeUnaryBody(skipped)).toString()).toBe('xyz')
    const truncated = frameConnectMessage(Buffer.from('abcdef')).subarray(0, 7)
    expect(Buffer.from(decodeUnaryBody(truncated)).equals(truncated)).toBe(true)
  })

  it('refuses an oversized outgoing frame', () => {
    expect(() => frameConnectMessage(Buffer.alloc(65 * 1024 * 1024))).toThrow(LlmError)
  })

  it('refuses an oversized incoming frame', () => {
    const header = Buffer.alloc(5)
    header.writeUInt32BE(65 * 1024 * 1024, 1)
    expect(() => { createConnectFrameParser(() => {})(header) }).toThrow(LlmError)
  })
})

describe('unary HTTP/2', () => {
  it('writes the body, sends attribution headers, and returns the status', async () => {
    const stream = fakeStream()
    const headers: Record<string, unknown>[] = []
    const session: CursorHttp2Session = {
      request: (h) => {
        headers.push(h)
        return stream
      },
      close: () => {},
      destroy: () => {},
      on: () => {},
    }
    const result = await callUnary(
      { accessToken: 'tok', rpcPath: '/agent.v1.AgentService/GetUsableModels' },
      Buffer.from('req'),
      () => session,
    )
    expect(result.status).toBe(200)
    expect(headers[0]!['user-agent']).toContain('deepseek-harness')
    expect(headers[0]!['authorization']).toBe('Bearer tok')
    expect(headers[0]!['x-ghost-mode']).toBe('true')
  })

  it('wraps a non-Error connect throw', async () => {
    await expect(callUnary(
      { accessToken: 't', rpcPath: '/x' },
      new Uint8Array(),
      () => {
        throw 'offline'
      },
    )).rejects.toThrow('Cursor unary RPC failed')
  })

  it('aborts an already-aborted unary', async () => {
    const signal = AbortSignal.abort(new Error('stop'))
    await expect(callUnary(
      { accessToken: 't', rpcPath: '/x', signal },
      new Uint8Array(),
      () => fakeSession(fakeStream()),
    )).rejects.toThrow('stop')
  })

  it('uses the default HTTP/2 opener and refuses an oversized unary body', async () => {
    const connectSpy = vi.spyOn(http2, 'connect').mockReturnValue(fakeSession(fakeStream()) as never)
    try {
      await callUnary({ accessToken: 't', rpcPath: '/x' }, Buffer.from('req'))
      expect(connectSpy).toHaveBeenCalled()
    } finally {
      connectSpy.mockRestore()
    }

    const stream = new EventEmitter() as CursorHttp2Stream & EventEmitter
    stream.write = () => {}
    stream.end = () => {
      queueMicrotask(() => {
        stream.emit('response', { ':status': 200 })
        stream.emit('data', Buffer.alloc(MAX_UNARY_RESPONSE_BYTES + 1))
      })
    }
    stream.destroy = () => {}
    await expect(callUnary(
      { accessToken: 't', rpcPath: '/x' },
      new Uint8Array(),
      () => fakeSession(stream),
    )).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('fails when connect throws and when the unary session errors', async () => {
    await expect(callUnary(
      { accessToken: 't', rpcPath: '/x' },
      new Uint8Array(),
      () => { throw new Error('no session') },
    )).rejects.toThrow('no session')

    const stream = new EventEmitter() as CursorHttp2Stream & EventEmitter
    stream.write = () => {}
    stream.end = () => {}
    stream.destroy = () => {}
    const session = new EventEmitter() as unknown as CursorHttp2Session & EventEmitter
    session.request = () => stream
    session.close = () => {}
    session.destroy = () => {}
    const pending = callUnary(
      { accessToken: 't', rpcPath: '/x' },
      new Uint8Array(),
      () => session,
    )
    queueMicrotask(() => session.emit('error', new Error('session down')))
    await expect(pending).rejects.toThrow('session down')

    const errStream = new EventEmitter() as CursorHttp2Stream & EventEmitter
    errStream.write = () => {}
    errStream.end = () => {}
    errStream.destroy = () => {}
    const errSession = fakeSession(errStream)
    const streamFail = callUnary(
      { accessToken: 't', rpcPath: '/x' },
      new Uint8Array(),
      () => errSession,
    )
    queueMicrotask(() => {
      errStream.emit('response', {})
      errStream.emit('error', new Error('stream down'))
      errStream.emit('error', new Error('again'))
    })
    await expect(streamFail).rejects.toThrow('stream down')

    const aborting = new AbortController()
    const hanging = new EventEmitter() as CursorHttp2Stream & EventEmitter
    hanging.write = () => {}
    hanging.end = () => {}
    hanging.destroy = () => {}
    const abortSession = new EventEmitter() as unknown as CursorHttp2Session & EventEmitter
    abortSession.request = () => hanging
    abortSession.close = () => { throw new Error('close') }
    abortSession.destroy = () => { throw new Error('destroy') }
    const later = callUnary(
      { accessToken: 't', rpcPath: '/x', signal: aborting.signal },
      new Uint8Array(),
      () => abortSession,
    )
    aborting.abort('later')
    await expect(later).rejects.toThrow(/aborted/)
    hanging.emit('end')
  })
})

describe('streaming HTTP/2', () => {
  it('parses incoming frames and fails a non-2xx status', async () => {
    const emitter = new EventEmitter() as CursorHttp2Stream & EventEmitter
    emitter.write = () => {}
    emitter.end = () => {}
    emitter.destroy = () => {}
    const session = fakeSession(emitter)
    const opened = openConnectStream(
      { accessToken: 't', rpcPath: '/agent.v1.AgentService/Run' },
      () => session,
    )
    const received = opened.frames[Symbol.asyncIterator]()
    const payload = Buffer.from('msg')
    emitter.emit('data', frameConnectMessage(payload))
    await expect(received.next()).resolves.toMatchObject({ done: false })
    emitter.emit('response', { ':status': 401 })
    await expect(received.next()).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('fails on an EndStream Connect error', async () => {
    const emitter = new EventEmitter() as CursorHttp2Stream & EventEmitter
    emitter.write = () => {}
    emitter.end = () => {}
    emitter.destroy = () => {}
    const opened = openConnectStream(
      { accessToken: 't', rpcPath: '/run' },
      () => fakeSession(emitter),
    )
    const received = opened.frames[Symbol.asyncIterator]()
    const errorFrame = frameConnectMessage(
      Buffer.from(JSON.stringify({ error: { code: 'internal', message: 'boom' } })),
      CONNECT_END_STREAM,
    )
    emitter.emit('data', errorFrame)
    await expect(received.next()).rejects.toThrow(/internal/)
  })

  it('finishes on an empty EndStream and aborts an already-aborted stream', async () => {
    const emitter = new EventEmitter() as CursorHttp2Stream & EventEmitter
    emitter.write = () => {}
    emitter.end = () => {}
    emitter.destroy = () => {}
    const opened = openConnectStream(
      { accessToken: 't', rpcPath: '/run' },
      () => fakeSession(emitter),
    )
    const received = opened.frames[Symbol.asyncIterator]()
    emitter.emit('data', frameConnectMessage(new Uint8Array(), CONNECT_END_STREAM))
    await expect(received.next()).resolves.toMatchObject({ done: true })
    opened.destroy()

    const aborted = openConnectStream(
      { accessToken: 't', rpcPath: '/run', signal: AbortSignal.abort(new Error('stop')) },
      () => fakeSession(fakeStream()),
    )
    await expect(aborted.frames[Symbol.asyncIterator]().next()).rejects.toThrow('stop')
    aborted.destroy()
  })

  it('writes, ends, waits for frames, and tears down throwing sessions', async () => {
    const emitter = new EventEmitter() as CursorHttp2Stream & EventEmitter
    emitter.write = () => {}
    emitter.end = () => {}
    emitter.destroy = () => { throw new Error('stream closed') }
    const session = new EventEmitter() as unknown as CursorHttp2Session & EventEmitter
    session.request = () => emitter
    session.close = () => { throw new Error('close') }
    session.destroy = () => { throw new Error('destroy') }
    const opened = openConnectStream(
      { accessToken: 't', rpcPath: '/run', signal: new AbortController().signal },
      () => session,
    )
    opened.write(Buffer.from('x'))
    opened.end()
    const received = opened.frames[Symbol.asyncIterator]()
    const pending = received.next()
    emitter.emit('data', frameConnectMessage(Buffer.from('msg')))
    await expect(pending).resolves.toMatchObject({ done: false })
    emitter.emit('error', new Error('stream down'))
    await expect(received.next()).rejects.toThrow('stream down')
    await expect(received.next()).rejects.toThrow('stream down')
    opened.destroy()

    const ended = new EventEmitter() as CursorHttp2Stream & EventEmitter
    ended.write = () => {}
    ended.end = () => {}
    ended.destroy = () => {}
    const endSession = fakeSession(ended)
    const live = openConnectStream({ accessToken: 't', rpcPath: '/run' }, () => endSession)
    const wait = live.frames[Symbol.asyncIterator]().next()
    ended.emit('end')
    await expect(wait).resolves.toMatchObject({ done: true })
    await expect(live.frames[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true })
    ended.emit('end')
    ended.emit('data', Buffer.alloc(5))
    live.destroy()

    const aborting = new AbortController()
    const hanging = new EventEmitter() as CursorHttp2Stream & EventEmitter
    hanging.write = () => {}
    hanging.end = () => {}
    hanging.destroy = () => {}
    const liveAbort = openConnectStream(
      { accessToken: 't', rpcPath: '/run', signal: aborting.signal },
      () => fakeSession(hanging),
    )
    const abortWait = liveAbort.frames[Symbol.asyncIterator]().next()
    aborting.abort('cancelled')
    await expect(abortWait).rejects.toThrow(/aborted/)
    hanging.emit('response', { ':status': 0 })
    hanging.emit('response', {})
    hanging.emit('error', new Error('again'))
    liveAbort.destroy()

    const sessionFail = new EventEmitter() as unknown as CursorHttp2Session & EventEmitter
    const failStream = new EventEmitter() as CursorHttp2Stream & EventEmitter
    failStream.write = () => {}
    failStream.end = () => {}
    failStream.destroy = () => {}
    sessionFail.request = () => failStream
    sessionFail.close = () => {}
    sessionFail.destroy = () => {}
    const failed = openConnectStream({ accessToken: 't', rpcPath: '/run' }, () => sessionFail)
    const failedWait = failed.frames[Symbol.asyncIterator]().next()
    sessionFail.emit('error', new Error('session down'))
    await expect(failedWait).rejects.toThrow('session down')
    failed.destroy()

    const oversized = new EventEmitter() as CursorHttp2Stream & EventEmitter
    oversized.write = () => {}
    oversized.end = () => {}
    oversized.destroy = () => {}
    const over = openConnectStream({ accessToken: 't', rpcPath: '/run' }, () => fakeSession(oversized))
    const overNext = over.frames[Symbol.asyncIterator]().next()
    const header = Buffer.alloc(5)
    header.writeUInt32BE(65 * 1024 * 1024, 1)
    oversized.emit('data', header)
    await expect(overNext).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    over.destroy()
  })
})

describe('MAX_UNARY_RESPONSE_BYTES', () => {
  it('is 16 MiB', () => {
    expect(MAX_UNARY_RESPONSE_BYTES).toBe(16 * 1024 * 1024)
  })
})
