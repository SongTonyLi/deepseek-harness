/** Advisory catalog: fallback, disk cache, and GetUsableModels refresh. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { create, toBinary } from '@bufbuild/protobuf'
import { CursorCatalog, FALLBACK_MODELS } from '../src/catalog.ts'
import { frameConnectMessage } from '../src/connect.ts'
import type { ConnectHttp2, CursorHttp2Session, CursorHttp2Stream } from '../src/connect.ts'
import { EventEmitter } from 'node:events'
import {
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from '../src/native/agent_pb.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function cacheFile(contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cursor-catalog-'))
  dirs.push(dir)
  const path = join(dir, 'usable-models.json')
  if (contents !== undefined) await writeFile(path, contents)
  return path
}

function unaryConnect(status: number, body: Uint8Array): ConnectHttp2 {
  return () => {
    const stream = new EventEmitter() as CursorHttp2Stream & EventEmitter
    stream.write = () => {}
    stream.end = () => {
      queueMicrotask(() => {
        stream.emit('response', { ':status': status })
        if (body.byteLength > 0) stream.emit('data', Buffer.from(body))
        stream.emit('end')
      })
    }
    stream.destroy = () => {}
    const session: CursorHttp2Session = {
      request: () => stream,
      close: () => {},
      destroy: () => {},
      on: () => {},
    }
    return session
  }
}

describe('CursorCatalog', () => {
  it('lists fallback models and resolves unlisted ids as text-only routes', async () => {
    const catalog = new CursorCatalog(undefined, await cacheFile())
    expect(catalog.list()).toEqual(FALLBACK_MODELS.map(model => ({
      provider: 'cursor',
      id: model.id,
      name: model.name,
      inputModalities: ['text'],
    })))
    expect(catalog.resolve('composer-2')).toMatchObject({
      id: 'composer-2',
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 8_192,
    })
    expect(catalog.resolve('mystery')).toEqual({
      provider: 'cursor',
      id: 'mystery',
      name: 'mystery',
      inputModalities: ['text'],
    })
  })

  it('hydrates from disk once and ignores a missing or invalid cache', async () => {
    const path = await cacheFile(JSON.stringify({
      models: [
        { id: 'cached', name: 'Cached', contextWindow: 10, maxTokens: 2 },
        { id: '', name: 'skip' },
        { nope: true },
      ],
    }))
    const catalog = new CursorCatalog(undefined, path)
    await catalog.hydrate()
    expect(catalog.list().map(model => model.id)).toEqual(['cached'])
    await writeFile(path, JSON.stringify({ models: [{ id: 'later', name: 'Later' }] }))
    await catalog.hydrate()
    expect(catalog.list().map(model => model.id)).toEqual(['cached'])

    const missing = new CursorCatalog(undefined, join(path, 'nope.json'))
    await missing.hydrate()
    expect(missing.list()[0]?.id).toBe('composer-2')

    const invalid = new CursorCatalog(undefined, await cacheFile('{'))
    await invalid.hydrate()
    expect(invalid.list()[0]?.id).toBe('composer-2')

    const notArray = new CursorCatalog(undefined, await cacheFile(JSON.stringify({ models: 1 })))
    await notArray.hydrate()
    expect(notArray.list()[0]?.id).toBe('composer-2')

    const skipped = new CursorCatalog(undefined, await cacheFile(JSON.stringify({
      models: [null, 'x', { id: 'keep', name: 'Keep' }, { id: 'noname', name: '' }],
    })))
    await skipped.hydrate()
    expect(skipped.list().map(model => model.id)).toEqual(['keep'])

    const empty = new CursorCatalog(undefined, await cacheFile(JSON.stringify({ models: [] })))
    await empty.hydrate()
    expect(empty.list()[0]?.id).toBe('composer-2')
  })

  it('refreshes from GetUsableModels and keeps the previous list on failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cursor-catalog-write-'))
    dirs.push(dir)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'usable-models.json')
    const proto = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
      models: [
        create(ModelDetailsSchema, { modelId: 'live', displayName: 'Live', displayModelId: 'live-id' }),
        create(ModelDetailsSchema, { modelId: 'alias', displayName: '', displayModelId: 'Alias' }),
        create(ModelDetailsSchema, { modelId: 'raw', displayName: '', displayModelId: '' }),
        create(ModelDetailsSchema, { modelId: '', displayName: 'skip' }),
      ],
    }))
    const catalog = new CursorCatalog(unaryConnect(200, proto), path)
    await catalog.refresh('tok')
    expect(catalog.list().map(model => model.id)).toEqual(['live', 'alias', 'raw'])
    expect(catalog.resolve('live').name).toBe('Live')
    expect(catalog.resolve('alias').name).toBe('Alias')
    expect(catalog.resolve('raw').name).toBe('raw')
    await catalog.refresh('tok', AbortSignal.abort())
    expect(catalog.list().map(model => model.id)).toEqual(['live', 'alias', 'raw'])

    const framed = new CursorCatalog(unaryConnect(200, frameConnectMessage(proto)), await cacheFile())
    await framed.refresh('tok')
    expect(framed.list().map(model => model.id)).toEqual(['live', 'alias', 'raw'])

    const failed = new CursorCatalog(unaryConnect(500, new Uint8Array()), await cacheFile())
    await failed.refresh('tok')
    expect(failed.list()[0]?.id).toBe('composer-2')

    const skipped = new CursorCatalog(
      unaryConnect(200, toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
        models: [create(ModelDetailsSchema, { modelId: '', displayName: 'skip' })],
      }))),
      await cacheFile(),
    )
    await skipped.refresh('tok')
    expect(skipped.list()[0]?.id).toBe('composer-2')

    const garbage = new CursorCatalog(
      unaryConnect(200, frameConnectMessage(Buffer.from('not-proto'))),
      await cacheFile(),
    )
    await garbage.refresh('tok')
    expect(garbage.list()[0]?.id).toBe('composer-2')

    const throwing: ConnectHttp2 = () => {
      throw new Error('offline')
    }
    const down = new CursorCatalog(throwing, await cacheFile())
    await down.refresh('tok')
    expect(down.list()[0]?.id).toBe('composer-2')

    const nested = new CursorCatalog(unaryConnect(200, proto), join(path, 'nested.json'))
    await nested.refresh('tok')
    expect(nested.list().map(model => model.id)).toEqual(['live', 'alias', 'raw'])
  })
})
