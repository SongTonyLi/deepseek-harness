/** Sign-in controller: the flow join, one attempt's frames, answers, and sign-out. */
import { describe, expect, it, vi } from 'vitest'
import type { AuthorizationFlowView, AuthorizationFrame } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSignInOperations, isSubscriptionMethod, providerOf, SignInController, type SignInOperations,
} from '../src/client/store.ts'

const CODEX: AuthorizationFlowView = {
  key: 'llm-pi-ai/openai-codex',
  scope: 'llm-pi-ai',
  id: 'openai-codex',
  label: 'OpenAI Codex',
  methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }],
  inFlight: false,
  configured: false,
}

const ANTHROPIC: AuthorizationFlowView = {
  ...CODEX,
  key: 'llm-pi-ai/anthropic',
  id: 'anthropic',
  label: 'Anthropic',
  methods: [{ id: 'oauth', label: 'Claude Pro/Max' }, { id: 'api-key', label: 'Anthropic API key' }],
  configured: true,
  kind: 'grant',
}

/** A flow owned by some other plugin, which the Models page must not claim. */
const FOREIGN: AuthorizationFlowView = {
  ...CODEX,
  key: 'some-plugin/webhook',
  scope: 'some-plugin',
  id: 'webhook',
  label: 'Webhook signing key',
}

/**
 * A stream the spec drives frame by frame, standing in for the Remote carrier:
 * each open reads the same queue and ends when its own signal aborts, which is
 * how the real carrier answers a withdrawn attempt.
 */
function scriptedStream() {
  const queue: AuthorizationFrame[] = []
  const waiters = new Set<() => void>()
  let done = false
  let failure: Error | undefined
  const wake = (): void => {
    for (const waiter of [...waiters]) waiter()
    waiters.clear()
  }
  return {
    push: (frame: AuthorizationFrame): void => { queue.push(frame); wake() },
    end: () => { done = true; wake() },
    fail: (error: Error) => { failure = error; done = true; wake() },
    async *iterate(signal: AbortSignal): AsyncGenerator<AuthorizationFrame> {
      while (!signal.aborted) {
        const next = queue.shift()
        if (next !== undefined) { yield next; continue }
        if (done) {
          if (failure !== undefined) throw failure
          return
        }
        await new Promise<void>((resolve) => {
          waiters.add(resolve)
          signal.addEventListener('abort', () => { waiters.delete(resolve); resolve() }, { once: true })
        })
      }
    },
  }
}

function bench(overrides: Partial<SignInOperations> = {}, flows: AuthorizationFlowView[] = [CODEX, ANTHROPIC, FOREIGN]) {
  const stream = scriptedStream()
  const signals: AbortSignal[] = []
  const calls = {
    list: vi.fn<SignInOperations['list']>(() => Promise.resolve(flows)),
    begin: vi.fn<SignInOperations['begin']>((_key, _method, signal) => {
      signals.push(signal)
      return stream.iterate(signal)
    }),
    answer: vi.fn<SignInOperations['answer']>(() => Promise.resolve(undefined)),
    decline: vi.fn<SignInOperations['decline']>(() => Promise.resolve(undefined)),
    signOut: vi.fn<SignInOperations['signOut']>(() => Promise.resolve(undefined)),
  }
  const operations: SignInOperations = { ...calls, ...overrides }
  return { controller: new SignInController(operations), calls: { ...calls, ...overrides }, stream, signals }
}

/** Wait until the snapshot satisfies `until`. */
async function settled(controller: SignInController, until: (state: ReturnType<SignInController['store']['getSnapshot']>) => boolean): Promise<void> {
  await vi.waitFor(() => { expect(until(controller.store.getSnapshot())).toBe(true) })
}

describe('the flow join', () => {
  it('keys flows by provider route and ignores a flow another plugin owns', () => {
    expect(providerOf(CODEX)).toBe('openai-codex')
    expect(providerOf(FOREIGN)).toBeUndefined()
  })

  it('reads every method but the key prompt as a subscription sign-in', () => {
    expect(isSubscriptionMethod({ id: 'oauth', label: 'x' })).toBe(true)
    // A provider adding a second subscription method joins the card without
    // this predicate learning its name; only the key path stays out.
    expect(isSubscriptionMethod({ id: 'oauth-enterprise', label: 'x' })).toBe(true)
    expect(isSubscriptionMethod({ id: 'api-key', label: 'x' })).toBe(false)
  })

  it('loads only the provider flows and keeps the last good set when a read is refused', async () => {
    const list = vi.fn<SignInOperations['list']>()
      .mockResolvedValueOnce([CODEX, ANTHROPIC, FOREIGN])
      .mockResolvedValueOnce(undefined)
    const { controller } = bench({ list })
    await controller.load()
    expect([...controller.store.getSnapshot().flows.keys()]).toEqual(['openai-codex', 'anthropic'])
    expect(controller.store.getSnapshot().loaded).toBe(true)
    await controller.load()
    expect([...controller.store.getSnapshot().flows.keys()]).toEqual(['openai-codex', 'anthropic'])
  })
})

describe('the Host operations', () => {
  /** A context scripted down to the one namespace these operations reach. */
  function ctxWith(answers: Record<string, unknown>) {
    const namespace = {
      list: vi.fn(() => Promise.resolve(answers['list'])),
      begin: vi.fn(() => 'the-stream'),
      answer: vi.fn(() => Promise.resolve(answers['answer'])),
      decline: vi.fn(() => Promise.resolve(answers['decline'])),
      signOut: vi.fn(() => Promise.resolve(answers['signOut'])),
    }
    const ctx = { remote: { authorization: namespace } } as unknown as Parameters<typeof createSignInOperations>[0]
    return { ctx, namespace }
  }

  it('unwraps every success and drops the envelope', async () => {
    const { ctx, namespace } = ctxWith({
      list: { ok: true, value: [CODEX] },
      answer: { ok: true, value: undefined },
      decline: { ok: true, value: undefined },
      signOut: { ok: true, value: undefined },
    })
    const operations = createSignInOperations(ctx)
    await expect(operations.list()).resolves.toEqual([CODEX])
    await expect(operations.answer('llm-pi-ai/openai-codex', 'p1', 'typed')).resolves.toBeUndefined()
    expect(namespace.answer).toHaveBeenCalledWith('llm-pi-ai/openai-codex', 'p1', 'typed')
    await expect(operations.decline('llm-pi-ai/openai-codex', 'p1')).resolves.toBeUndefined()
    expect(namespace.decline).toHaveBeenCalledWith('llm-pi-ai/openai-codex', 'p1')
    await expect(operations.signOut('llm-pi-ai/openai-codex')).resolves.toBeUndefined()
  })

  it('reports a refused read as nothing read, and a refused write by its message', async () => {
    const refused = { ok: false as const, error: { message: 'the seam is absent' } }
    const { ctx } = ctxWith({ list: refused, answer: refused, decline: refused, signOut: refused })
    const operations = createSignInOperations(ctx)
    await expect(operations.list()).resolves.toBeUndefined()
    await expect(operations.answer('k', 'p', 'v')).resolves.toBe('the seam is absent')
    await expect(operations.decline('k', 'p')).resolves.toBe('the seam is absent')
    await expect(operations.signOut('k')).resolves.toBe('the seam is absent')
  })

  it('names the method only when one was chosen', () => {
    const { ctx, namespace } = ctxWith({})
    const operations = createSignInOperations(ctx)
    const signal = new AbortController().signal
    operations.begin('llm-pi-ai/openai-codex', 'oauth', signal)
    expect(namespace.begin).toHaveBeenLastCalledWith({ key: 'llm-pi-ai/openai-codex', method: 'oauth' }, signal)
    operations.begin('llm-pi-ai/openai-codex', undefined, signal)
    expect(namespace.begin).toHaveBeenLastCalledWith({ key: 'llm-pi-ai/openai-codex' }, signal)
  })
})

describe('one attempt', () => {
  it('folds notices, answers the question, and settles authorized', async () => {
    const { controller, calls, stream } = bench()
    const running = controller.begin(CODEX, 'openai-codex', 'oauth')
    await settled(controller, state => state.attempt !== undefined)
    expect(calls.begin).toHaveBeenCalledWith('llm-pi-ai/openai-codex', 'oauth', expect.any(AbortSignal))
    stream.push({
      type: 'notice', message: 'Open this page', url: 'https://auth.example', openInBrowser: true, code: 'AB-12',
    })
    stream.push({ type: 'prompt', promptId: 'p1', kind: 'text', message: 'Paste the code', placeholder: 'code' })
    await settled(controller, state => state.attempt?.question !== undefined)

    const opened = controller.store.getSnapshot().attempt
    expect(opened).toMatchObject({ provider: 'openai-codex', label: 'OpenAI Codex', running: true })
    expect(opened?.directions).toEqual([{
      message: 'Open this page', url: 'https://auth.example', openInBrowser: true, code: 'AB-12',
    }])
    expect(opened?.question).toEqual({ promptId: 'p1', kind: 'text', message: 'Paste the code', placeholder: 'code' })

    await controller.answer('the-code')
    expect(calls.answer).toHaveBeenCalledWith('llm-pi-ai/openai-codex', 'p1', 'the-code')
    stream.push({ type: 'settled', status: 'authorized' })
    stream.end()
    await running
    expect(controller.store.getSnapshot().attempt).toMatchObject({
      running: false, question: undefined, outcome: { kind: 'authorized' },
    })
    // Settling re-reads the directory, which is how a signed-in row appears.
    expect(calls.list).toHaveBeenCalled()
  })

  it('carries a select question with its options', async () => {
    const { controller, stream } = bench()
    const running = controller.begin(CODEX, 'openai-codex')
    await settled(controller, state => state.attempt !== undefined)
    stream.push({
      type: 'prompt',
      promptId: 'p1',
      kind: 'select',
      message: 'Select login method:',
      options: [{ id: 'browser', label: 'Browser login' }, { id: 'device_code', label: 'Device code', description: 'headless' }],
    })
    await settled(controller, state => state.attempt?.question !== undefined)
    expect(controller.store.getSnapshot().attempt?.question?.options).toEqual([
      { id: 'browser', label: 'Browser login' },
      { id: 'device_code', label: 'Device code', description: 'headless' },
    ])
    stream.push({ type: 'settled', status: 'cancelled' })
    stream.end()
    await running
  })

  it('clears a question the flow withdrew and keeps the attempt open', async () => {
    const { controller, stream } = bench()
    const running = controller.begin(CODEX, 'openai-codex')
    await settled(controller, state => state.attempt !== undefined)
    stream.push({ type: 'prompt', promptId: 'p1', kind: 'text', message: 'Paste the code' })
    await settled(controller, state => state.attempt?.question !== undefined)
    // A withdrawal naming another prompt leaves the open question alone.
    stream.push({ type: 'prompt-withdrawn', promptId: 'other' })
    stream.push({ type: 'notice', message: 'still going' })
    await settled(controller, state => state.attempt?.directions.length === 1)
    expect(controller.store.getSnapshot().attempt?.question?.promptId).toBe('p1')
    stream.push({ type: 'prompt-withdrawn', promptId: 'p1' })
    await settled(controller, state => state.attempt?.question === undefined)
    expect(controller.store.getSnapshot().attempt?.running).toBe(true)
    stream.push({ type: 'settled', status: 'authorized' })
    stream.end()
    await running
  })

  it('drops the question when the Host no longer expects the answer', async () => {
    const answer = vi.fn(() => Promise.resolve('no prompt "p1" is waiting'))
    const { controller, stream } = bench({ answer })
    const running = controller.begin(CODEX, 'openai-codex')
    await settled(controller, state => state.attempt !== undefined)
    stream.push({ type: 'prompt', promptId: 'p1', kind: 'secret', message: 'Paste your key' })
    await settled(controller, state => state.attempt?.question !== undefined)
    await controller.answer('late')
    expect(controller.store.getSnapshot().attempt).toMatchObject({ question: undefined, answering: false })
    stream.push({ type: 'settled', status: 'cancelled' })
    stream.end()
    await running
  })

  it('drops a frame the Host had already sent when the surface withdrew', async () => {
    // A double that keeps yielding after its signal aborts, as a carrier with
    // a frame already in flight does.
    const queue: AuthorizationFrame[] = []
    let release: (() => void) | undefined
    const begin = vi.fn<SignInOperations['begin']>(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => { release = resolve })
        for (const frame of queue) yield frame
      },
    }))
    const { controller } = bench({ begin })
    const running = controller.begin(CODEX, 'openai-codex')
    await settled(controller, state => state.attempt !== undefined)
    queue.push({ type: 'notice', message: 'too late' })
    controller.close()
    release?.()
    await running
    expect(controller.store.getSnapshot().attempt).toBeUndefined()
  })

  it('reports a stream failure that is not an Error with its own text', async () => {
    const { controller, stream } = bench()
    const running = controller.begin(CODEX, 'openai-codex')
    await settled(controller, state => state.attempt !== undefined)
    stream.fail('the connection dropped' as unknown as Error)
    await running
    expect(controller.store.getSnapshot().attempt).toMatchObject({
      outcome: { kind: 'failed', message: 'the connection dropped' },
    })
  })

  it('keeps an answer from resurrecting an attempt the surface closed meanwhile', async () => {
    let settleAnswer: ((value: string | undefined) => void) | undefined
    const answer = vi.fn<SignInOperations['answer']>(() =>
      new Promise<string | undefined>((resolve) => { settleAnswer = resolve }))
    const { controller, stream } = bench({ answer })
    const running = controller.begin(CODEX, 'openai-codex')
    await settled(controller, state => state.attempt !== undefined)
    stream.push({ type: 'prompt', promptId: 'p1', kind: 'text', message: 'Paste the code' })
    await settled(controller, state => state.attempt?.question !== undefined)
    const answering = controller.answer('typed')
    controller.close()
    settleAnswer?.(undefined)
    await answering
    expect(controller.store.getSnapshot().attempt).toBeUndefined()
    stream.end()
    await running
  })

  it('reports a failed stream as the outcome without clearing the attempt', async () => {
    const { controller, stream } = bench()
    const running = controller.begin(CODEX, 'openai-codex')
    await settled(controller, state => state.attempt !== undefined)
    stream.fail(new Error('token exchange failed (401)'))
    await running
    expect(controller.store.getSnapshot().attempt).toMatchObject({
      running: false,
      outcome: { kind: 'failed', message: 'token exchange failed (401)' },
    })
  })

  it('treats a stream that ends without settling as a cancellation', async () => {
    const { controller, stream } = bench()
    const running = controller.begin(CODEX, 'openai-codex')
    await settled(controller, state => state.attempt !== undefined)
    stream.end()
    await running
    expect(controller.store.getSnapshot().attempt).toMatchObject({ running: false, outcome: { kind: 'cancelled' } })
  })

  it('declines the open question through the Host', async () => {
    const { controller, calls, stream } = bench()
    const running = controller.begin(CODEX, 'openai-codex')
    await settled(controller, state => state.attempt !== undefined)
    stream.push({ type: 'prompt', promptId: 'p1', kind: 'text', message: 'Paste the code' })
    await settled(controller, state => state.attempt?.question !== undefined)
    await controller.decline()
    expect(calls.decline).toHaveBeenCalledWith('llm-pi-ai/openai-codex', 'p1')
    stream.push({ type: 'settled', status: 'cancelled' })
    stream.end()
    await running
  })

  it('ignores an answer or decline with no question waiting', async () => {
    const { controller, calls } = bench()
    await controller.answer('x')
    await controller.decline()
    expect(calls.answer).not.toHaveBeenCalled()
    expect(calls.decline).not.toHaveBeenCalled()
  })

  it('withdraws the attempt when the surface closes it', async () => {
    const { controller, signals, stream } = bench()
    const running = controller.begin(CODEX, 'openai-codex')
    await settled(controller, state => state.attempt !== undefined)
    controller.close()
    expect(signals[0]?.aborted).toBe(true)
    expect(controller.store.getSnapshot().attempt).toBeUndefined()
    stream.end()
    await running
    // A withdrawn attempt never reappears as a settled one.
    expect(controller.store.getSnapshot().attempt).toBeUndefined()
  })

  it('withdraws a running attempt when a second one starts', async () => {
    const { controller, signals, stream } = bench()
    const first = controller.begin(CODEX, 'openai-codex')
    await settled(controller, state => state.attempt !== undefined)
    const second = controller.begin(ANTHROPIC, 'anthropic')
    await settled(controller, state => state.attempt?.provider === 'anthropic')
    expect(signals[0]?.aborted).toBe(true)
    stream.end()
    await Promise.all([first, second])
  })

  it('withdraws whatever runs when the surface is disposed', async () => {
    const { controller, signals, stream } = bench()
    const running = controller.begin(CODEX, 'openai-codex')
    await settled(controller, state => state.attempt !== undefined)
    controller.dispose()
    expect(signals[0]?.aborted).toBe(true)
    stream.end()
    await running
  })
})

describe('sign-out', () => {
  it('deletes the record and re-reads the directory', async () => {
    const { controller, calls } = bench()
    await expect(controller.signOut(ANTHROPIC)).resolves.toBeUndefined()
    expect(calls.signOut).toHaveBeenCalledWith('llm-pi-ai/anthropic')
    expect(calls.list).toHaveBeenCalled()
  })

  it('reports the Host refusal to its caller', async () => {
    const signOut = vi.fn(() => Promise.resolve('the credentials document is read-only'))
    const { controller } = bench({ signOut })
    await expect(controller.signOut(ANTHROPIC)).resolves.toBe('the credentials document is read-only')
  })
})
