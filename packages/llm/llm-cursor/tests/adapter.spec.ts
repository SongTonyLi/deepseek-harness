/** CursorAdapter routing and stream delegation. */
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CursorAdapter } from '../src/adapter.ts'
import { CursorCatalog } from '../src/catalog.ts'
import { resolveAdapterOptions } from '../src/config.ts'
import { create, toBinary } from '@bufbuild/protobuf'
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from '../src/native/agent_pb.ts'

function catalog(): CursorCatalog {
  return new CursorCatalog(undefined, '/tmp/dsh-cursor-unused-catalog.json')
}

describe('CursorAdapter', () => {
  it('reports Cursor metadata, hydrates the catalog, and rejects stop', async () => {
    const adapter = new CursorAdapter({
      options: () => resolveAdapterOptions({}),
      resolveAccessToken: () => Promise.resolve('tok'),
      catalog: catalog(),
      openStream: () => {
        throw new Error('must not stream')
      },
    })
    expect(adapter.providerInfo('cursor')).toEqual({ id: 'cursor', name: 'Cursor' })
    expect(adapter.providerRetryPolicy('cursor').mode).toBe('normal')
    const listed = await adapter.listModels('cursor')
    expect(listed.some(model => model.id === 'composer-2')).toBe(true)
    expect(await adapter.resolveModel('cursor', 'mystery')).toMatchObject({
      provider: 'cursor',
      id: 'mystery',
      name: 'mystery',
    })
    await expect(Array.fromAsync(adapter.stream({
      provider: 'other',
      model: 'composer-2',
      messages: [],
    }))).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(Array.fromAsync(adapter.stream({
      provider: 'cursor',
      model: 'composer-2',
      messages: [],
      stop: ['END'],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
  })

  it('streams through the injected opener and does not fail when catalog refresh throws', async () => {
    const refresh = vi.fn(() => Promise.reject(new Error('catalog down')))
    const adapter = new CursorAdapter({
      options: () => resolveAdapterOptions({ streamIdleTimeoutMs: 5_000 }),
      resolveAccessToken: () => Promise.resolve('tok'),
      catalog: Object.assign(catalog(), { refresh }),
      openStream: () => ({
        write: () => {},
        end: () => {},
        destroy: () => {},
        frames: (async function* () {
          yield {
            endStream: false,
            payload: toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
              message: {
                case: 'interactionUpdate',
                value: create(InteractionUpdateSchema, {
                  message: { case: 'textDelta', value: create(TextDeltaUpdateSchema, { text: 'hi' }) },
                }),
              },
            })),
          }
          yield {
            endStream: false,
            payload: toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
              message: {
                case: 'interactionUpdate',
                value: create(InteractionUpdateSchema, {
                  message: { case: 'turnEnded', value: create(TurnEndedUpdateSchema, {}) },
                }),
              },
            })),
          }
        })(),
      }),
    })
    const chunks = await Array.fromAsync(adapter.stream({
      provider: 'cursor',
      model: 'composer-2',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(refresh).toHaveBeenCalled()
  })

  it('opens a Connect stream from an injected HTTP/2 opener', async () => {
    const adapter = new CursorAdapter({
      options: () => resolveAdapterOptions({ streamIdleTimeoutMs: 5_000 }),
      resolveAccessToken: () => Promise.resolve('tok'),
      catalog: catalog(),
      connect: () => {
        throw new Error('offline')
      },
    })
    await expect(Array.fromAsync(adapter.stream({
      provider: 'cursor',
      model: 'composer-2',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    }))).rejects.toThrow('offline')
  })
})
