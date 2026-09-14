/** Sign-in registration: the two Models seats, the pushed invalidations, and teardown. */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { SignInCard } from '../src/client/SignInCard.tsx'
import { SignInFooter } from '../src/client/SignInFooter.tsx'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const FLOW = {
  key: 'llm-pi-ai/openai-codex',
  scope: 'llm-pi-ai',
  id: 'openai-codex',
  label: 'OpenAI Codex',
  methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }],
  inFlight: false,
  configured: false,
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const subscriptions = new Map<string, Set<(...args: never[]) => void>>()
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }

    $on(event: string, listener: (...args: never[]) => void): () => void {
      const listeners = subscriptions.get(event) ?? new Set()
      subscriptions.set(event, listeners)
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
  new RemoteService(ctx)
  const list = vi.fn(() => Promise.resolve({ ok: true as const, value: [FLOW] }))
  // An attempt that stays open until its signal aborts, as the carrier does.
  const begin = vi.fn((_request: unknown, signal: AbortSignal) => ({
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return }
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    },
  }))
  const answer = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
  const decline = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
  const signOut = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
  ctx.provide('remote.authorization', { list, begin, answer, decline, signOut })
  const emit = (event: string): void => {
    for (const listener of subscriptions.get(event) ?? []) listener()
  }
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, begin, answer, decline, signOut, emit, subscriptions }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
      'settings.models.footer': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-settings-signin browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services the sign-in seats use', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.authorization'])
  })

  it('registers the card under the adapter namespace and the dialog in the footer', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const card = b.slots.entries('settings.models.provider-card')[0]!
    expect(card.component).toBe(SignInCard)
    expect(card.options).toMatchObject({ key: 'llm-pi-ai' })
    expect(card.locale).toBe(NS)
    const footer = b.slots.entries('settings.models.footer')[0]!
    expect(footer.component).toBe(SignInFooter)
    expect(footer.options).toMatchObject({ id: 'signin-dialog', order: 0 })
    expect(footer.locale).toBe(NS)
    await b.ctx.fiber.dispose()
  })

  it('reads the directory once at mount and again on every pushed invalidation', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(1) })

    b.emit('authorization/settled')
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(2) })
    b.emit('credentials/record-updated')
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(3) })
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(4) })

    await fiber.dispose()
    expect(b.subscriptions.get('authorization/settled')?.size ?? 0).toBe(0)
    expect(b.subscriptions.get('credentials/record-updated')?.size ?? 0).toBe(0)
    expect(b.slots.entries('settings.models.provider-card')).toHaveLength(0)
    expect(b.slots.entries('settings.models.footer')).toHaveLength(0)
  })

  it('follows a late declaration and recovers after the declarer reloads', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.models.footer')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.models.footer')).toHaveLength(1) })
    stop()
    expect(b.slots.entries('settings.models.footer')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.models.provider-card')).toHaveLength(1) })
    await fiber.dispose()
  })

  it('routes every injected action to the controller', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalled() })

    const card = (b.slots.entries('settings.models.provider-card')[0]!.inject as unknown as () => {
      signIn: (flow: typeof FLOW, provider: string, method?: string) => void
      signOut: (flow: typeof FLOW) => Promise<string | undefined>
    })()
    const footer = (b.slots.entries('settings.models.footer')[0]!.inject as unknown as () => {
      hooks: { signIn: { getSnapshot: () => { attempt: { question?: unknown } | undefined } } }
      answer: (value: string) => void
      decline: () => void
      close: () => void
    })()

    card.signIn(FLOW, 'openai-codex', 'oauth')
    await vi.waitFor(() => {
      expect(b.begin).toHaveBeenCalledWith({ key: FLOW.key, method: 'oauth' }, expect.any(AbortSignal))
    })
    await vi.waitFor(() => {
      expect(footer.hooks.signIn.getSnapshot().attempt).toBeDefined()
    })

    // An answer and a decline with no question waiting stay in the controller.
    footer.answer('typed')
    footer.decline()
    expect(b.answer).not.toHaveBeenCalled()
    expect(b.decline).not.toHaveBeenCalled()

    footer.close()
    expect(footer.hooks.signIn.getSnapshot().attempt).toBeUndefined()

    await expect(card.signOut(FLOW)).resolves.toBeUndefined()
    expect(b.signOut).toHaveBeenCalledWith(FLOW.key)
    await b.ctx.fiber.dispose()
  })

  it('binds the seats to one shared sign-in snapshot', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalled() })

    const card = (b.slots.entries('settings.models.provider-card')[0]!.inject as unknown as () => {
      hooks: { signIn: { getSnapshot: () => { flows: ReadonlyMap<string, unknown> } } }
    })()
    const footer = (b.slots.entries('settings.models.footer')[0]!.inject as unknown as () => {
      hooks: { signIn: { getSnapshot: () => { flows: ReadonlyMap<string, unknown> } } }
    })()
    expect(card.hooks.signIn).toBe(footer.hooks.signIn)
    await vi.waitFor(() => {
      expect([...card.hooks.signIn.getSnapshot().flows.keys()]).toEqual(['openai-codex'])
    })
    await b.ctx.fiber.dispose()
  })
})
