import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService, { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationFlow, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import AuthorizationController from '../src/index.ts'
import type { AuthorizationFrame } from '../src/index.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')

/** A store whose record delete refuses the way a read-only document would. */
class RefusingCredentials extends MemoryCredentials {
  override deleteRecord(): Promise<void> {
    return Promise.reject(new Error('the credentials document is read-only'))
  }
}

/** A store whose delete rejects with a bare string, the way some clients do. */
class LiteralRejectingCredentials extends MemoryCredentials {
  override async deleteRecord(): Promise<void> {
    throw 'the store refused'
  }
}

interface Harness {
  ctx: Context
  controller: AuthorizationController
}

/** A context with the record store, the seam, and the controller. */
async function harness(provider: typeof MemoryCredentials = MemoryCredentials): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(provider)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(AuthorizationController)
  return { ctx, controller: ctx.authorizationController }
}

/** A flow whose `run` the test scripts; it commits the record unless told not to. */
function flow(
  ctx: Context,
  run: (session: AuthorizationSession) => Promise<void>,
  options: { commit?: boolean; key?: ReturnType<typeof credentialKey> } = {},
): AuthorizationFlow {
  const key = options.key ?? KEY
  return {
    key,
    label: 'OpenAI Codex',
    methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }, { id: 'api-key', label: 'API key' }],
    async run(session) {
      await run(session)
      if (options.commit === false) return
      await ctx.credentials.modifyRecord(key, () =>
        Promise.resolve({ kind: 'grant', payload: { access: 'at', refresh: 'rt' } }))
    },
  }
}

/** Open one attempt and hand back its iterator plus a reader for the next frame. */
function open(controller: AuthorizationController, request: { key: string; method?: string }, signal?: AbortSignal) {
  const abort = new AbortController()
  const iterator = controller.begin(request, signal ?? abort.signal)[Symbol.asyncIterator]()
  const next = async (): Promise<AuthorizationFrame> => {
    const step = await iterator.next()
    if (step.done === true) throw new Error('the stream ended early')
    return step.value
  }
  const done = async (): Promise<void> => {
    const step = await iterator.next()
    expect(step.done).toBe(true)
  }
  return { iterator, next, done, abort }
}

/** Read frames until the stream fails, returning the failure. */
async function failure(controller: AuthorizationController, request: { key: string; method?: string }): Promise<unknown> {
  try {
    const { iterator } = open(controller, request)
    while (true) {
      const step = await iterator.next()
      if (step.done === true) return undefined
    }
  } catch (error: unknown) {
    return error
  }
}

/** The prompt frame a stream just yielded, asserting its type. */
function promptOf(frame: AuthorizationFrame): Extract<AuthorizationFrame, { type: 'prompt' }> {
  expect(frame.type).toBe('prompt')
  return frame as Extract<AuthorizationFrame, { type: 'prompt' }>
}

describe('the authorization Remote namespace a configuration surface calls', () => {
  it('publishes the authorization namespace from its own service key', async () => {
    const { controller } = await harness()
    expect(controller.typertRemote.serviceKey).toBe('authorizationController')
    expect(controller.typertRemote.namespace).toBe('authorization')
    expect(remoteMethods(controller)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'begin', mode: 'stream', invocation: { kind: 'direct' } },
      { method: 'answer', invocation: { kind: 'direct' } },
      { method: 'decline', invocation: { kind: 'direct' } },
      { method: 'cancel', invocation: { kind: 'direct' } },
      { method: 'signOut', invocation: { kind: 'direct' } },
    ])
  })

  it('lists nothing to sign into while the authorization seam is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationController)
    await expect(ctx.authorizationController.list()).resolves.toEqual([])
    const opened = await failure(ctx.authorizationController, { key: KEY })
    expect(remoteErrorOf(opened)).toMatchObject({
      code: 'gateway/internal',
      message: 'authorization service is absent: this deployment does not mount @deepseek-ai/dsh-authorization in its composition',
    })
    const cancelled = await ctx.authorizationController.cancel(KEY).catch((error: unknown) => error)
    expect(remoteErrorOf(cancelled)).toMatchObject({ code: 'gateway/internal' })
  })

  it('reports the actionable configuration error while no credential provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthorizationController)
    const refused = await ctx.authorizationController.signOut(KEY).catch((error: unknown) => error)
    expect(remoteErrorOf(refused)).toMatchObject({
      code: 'gateway/internal',
      message: 'credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
    })
  })

  it('lists each flow with its split key, methods, and stored-record state', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(flow(ctx, () => Promise.resolve()))
    await expect(controller.list()).resolves.toEqual([{
      key: KEY,
      scope: 'llm-pi-ai',
      id: 'openai-codex',
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }, { id: 'api-key', label: 'API key' }],
      inFlight: false,
      configured: false,
    }])
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { access: 'at' } }))
    await expect(controller.list()).resolves.toMatchObject([{ configured: true, kind: 'grant' }])
    expect(JSON.stringify(await controller.list())).not.toContain('at"')
  })

  it('reports a malformed key or payload as bad-request before reaching the seam', async () => {
    const { controller } = await harness()
    for (const call of [
      () => failure(controller, { key: 'not a key' }),
      () => failure(controller, { key: '' }),
      () => controller.answer('not a key', 'p', 'v').catch((error: unknown) => error),
      () => controller.answer(KEY, '', 'v').catch((error: unknown) => error),
      () => controller.decline('nope', 'p').catch((error: unknown) => error),
      () => controller.cancel('nope').catch((error: unknown) => error),
      () => controller.signOut('nope/too/many').catch((error: unknown) => error),
    ]) {
      expect(remoteErrorOf(await call())).toMatchObject({ code: 'gateway/bad-request' })
    }
  })

  it('fails the stream with the seam refusal when no flow claims the key or the method is not offered', async () => {
    const { ctx, controller } = await harness()
    expect(remoteErrorOf(await failure(controller, { key: KEY }))).toMatchObject({
      code: 'authorization/rejected',
      details: { key: KEY, reason: 'NO_FLOW' },
    })
    ctx.authorization.registerFlow(flow(ctx, () => Promise.resolve()))
    expect(remoteErrorOf(await failure(controller, { key: KEY, method: 'sso' }))).toMatchObject({
      code: 'authorization/rejected',
      details: { key: KEY, reason: 'UNKNOWN_METHOD' },
    })
  })

  it('streams notices and a text prompt, takes the answer through a second call, and settles authorized', async () => {
    const { ctx, controller } = await harness()
    const answered = vi.fn<(value: string) => void>()
    ctx.authorization.registerFlow(flow(ctx, async (session) => {
      session.notify({
        message: 'Open this page',
        url: 'https://auth.example/start',
        openInBrowser: true,
        code: 'ABCD-1234',
      })
      session.notify({ message: 'Waiting…' })
      answered(await session.prompt({ kind: 'text', message: 'Paste the code', placeholder: 'http://localhost:1455/auth/callback' }))
    }))
    const stream = open(controller, { key: KEY, method: 'oauth' })
    expect(await stream.next()).toEqual({
      type: 'notice', message: 'Open this page', url: 'https://auth.example/start', openInBrowser: true, code: 'ABCD-1234',
    })
    expect(await stream.next()).toEqual({ type: 'notice', message: 'Waiting…' })
    const prompt = promptOf(await stream.next())
    expect(prompt).toMatchObject({ kind: 'text', message: 'Paste the code', placeholder: 'http://localhost:1455/auth/callback' })
    expect(prompt).not.toHaveProperty('options')
    await controller.answer(KEY, prompt.promptId, 'the-code')
    expect(await stream.next()).toEqual({ type: 'settled', status: 'authorized' })
    expect(answered).toHaveBeenCalledWith('the-code')
    await stream.done()
    await expect(controller.list()).resolves.toMatchObject([{ configured: true, inFlight: false }])
    const stale = await controller.answer(KEY, prompt.promptId, 'again').catch((error: unknown) => error)
    expect(remoteErrorOf(stale)).toMatchObject({
      code: 'authorization/no-prompt',
      details: { key: KEY, promptId: prompt.promptId },
    })
  })

  it('carries a select prompt with its options and answers with the chosen id', async () => {
    const { ctx, controller } = await harness()
    const chosen = vi.fn<(value: string) => void>()
    ctx.authorization.registerFlow(flow(ctx, async (session) => {
      chosen(await session.prompt({
        kind: 'select',
        message: 'Select login method:',
        options: [
          { id: 'browser', label: 'Browser login (default)' },
          { id: 'device_code', label: 'Device code login', description: 'for a headless host' },
        ],
      }))
    }))
    const stream = open(controller, { key: KEY })
    const prompt = promptOf(await stream.next())
    expect(prompt).toMatchObject({
      kind: 'select',
      message: 'Select login method:',
      options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'device_code', label: 'Device code login', description: 'for a headless host' },
      ],
    })
    expect(prompt).not.toHaveProperty('placeholder')
    await controller.answer(KEY, prompt.promptId, 'device_code')
    expect(await stream.next()).toEqual({ type: 'settled', status: 'authorized' })
    expect(chosen).toHaveBeenCalledWith('device_code')
  })

  it('settles cancelled when the human declines a secret prompt', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(flow(ctx, async (session) => {
      await session.prompt({ kind: 'secret', message: 'Paste your key' })
    }))
    const stream = open(controller, { key: KEY, method: 'api-key' })
    const prompt = promptOf(await stream.next())
    expect(prompt.kind).toBe('secret')
    await controller.decline(KEY, prompt.promptId)
    expect(await stream.next()).toEqual({ type: 'settled', status: 'cancelled' })
    await stream.done()
    await expect(controller.list()).resolves.toMatchObject([{ configured: false }])
    const stale = await controller.decline(KEY, prompt.promptId).catch((error: unknown) => error)
    expect(remoteErrorOf(stale)).toMatchObject({ code: 'authorization/no-prompt' })
  })

  it('reports a prompt the flow withdrew by its own signal and keeps the attempt going', async () => {
    const { ctx, controller } = await harness()
    const withdrawal = new AbortController()
    const seen = vi.fn<(outcome: string) => void>()
    ctx.authorization.registerFlow(flow(ctx, async (session) => {
      const racing = session.prompt({ kind: 'text', message: 'Paste the code', signal: withdrawal.signal })
        .then(() => 'answered', (error: unknown) => (error as { code?: string }).code ?? 'unknown')
      // The browser callback wins: the flow retires the typed-code question.
      withdrawal.abort()
      seen(await racing)
      // A question asked with an already-withdrawn signal is never shown.
      await session.prompt({ kind: 'text', message: 'never shown', signal: AbortSignal.abort() })
        .catch(() => undefined)
    }))
    const stream = open(controller, { key: KEY })
    const prompt = promptOf(await stream.next())
    expect(await stream.next()).toEqual({ type: 'prompt-withdrawn', promptId: prompt.promptId })
    const unseen = await stream.next()
    expect(unseen.type).toBe('prompt-withdrawn')
    expect(await stream.next()).toEqual({ type: 'settled', status: 'authorized' })
    expect(seen).toHaveBeenCalledWith('PROMPT_WITHDRAWN')
    const stale = await controller.answer(KEY, prompt.promptId, 'late').catch((error: unknown) => error)
    expect(remoteErrorOf(stale)).toMatchObject({ code: 'authorization/no-prompt' })
  })

  it('withdraws the attempt and its open prompt when the surface closes the stream', async () => {
    const { ctx, controller } = await harness()
    const outcome = vi.fn<(code: string) => void>()
    const settled = new Promise<void>((resolve) => {
      ctx.on('authorization/settled', (_key, settlement) => { outcome(settlement); resolve() })
    })
    ctx.authorization.registerFlow(flow(ctx, async (session) => {
      await session.prompt({ kind: 'text', message: 'Paste the code' })
    }))
    const stream = open(controller, { key: KEY })
    const prompt = promptOf(await stream.next())
    await expect(controller.list()).resolves.toMatchObject([{ inFlight: true }])
    stream.abort.abort()
    await stream.iterator.return?.(undefined)
    await settled
    expect(outcome).toHaveBeenCalledWith('cancelled')
    const stale = await controller.answer(KEY, prompt.promptId, 'late').catch((error: unknown) => error)
    expect(remoteErrorOf(stale)).toMatchObject({ code: 'authorization/no-prompt' })
    await expect(controller.list()).resolves.toMatchObject([{ inFlight: false, configured: false }])
  })

  it('lets a second call cancel the attempt the stream still follows', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(flow(ctx, async (session) => {
      session.notify({ message: 'Continue in your browser', url: 'https://auth.example/start' })
      await new Promise<void>((resolve) => { session.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      session.signal.throwIfAborted()
    }))
    const stream = open(controller, { key: KEY })
    // The attempt starts when the carrier pulls the first frame, so reading
    // the flow's opening notice is what puts an attempt there to cancel.
    expect((await stream.next()).type).toBe('notice')
    await controller.cancel(KEY)
    expect(await stream.next()).toEqual({ type: 'settled', status: 'cancelled' })
    await stream.done()
  })

  it('keeps a newer attempt\'s prompts when an older stream finishes late', async () => {
    const { ctx, controller } = await harness()
    let attempts = 0
    const answered = vi.fn<(value: string) => void>()
    ctx.authorization.registerFlow(flow(ctx, async (session) => {
      attempts += 1
      if (attempts === 1) return
      answered(await session.prompt({ kind: 'text', message: 'second attempt' }))
    }))
    const first = open(controller, { key: KEY })
    expect(await first.next()).toEqual({ type: 'settled', status: 'authorized' })
    // The seam released the key before the settled frame, so a second attempt
    // may start while the first stream has not yet been read to its end.
    const second = open(controller, { key: KEY })
    const prompt = promptOf(await second.next())
    await first.done()
    await controller.answer(KEY, prompt.promptId, 'still-mine')
    expect(await second.next()).toEqual({ type: 'settled', status: 'authorized' })
    expect(answered).toHaveBeenCalledWith('still-mine')
  })

  it('fails the stream with the flow\'s own message when the flow breaks', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(flow(ctx, () => Promise.reject(new Error('token exchange failed (401)'))))
    const broken = await failure(controller, { key: KEY })
    expect(remoteErrorOf(broken)).toMatchObject({
      code: 'authorization/rejected',
      message: 'token exchange failed (401)',
      details: { key: KEY },
    })
    expect(remoteErrorOf(broken)?.details).not.toHaveProperty('reason')
  })

  it('reports a flow that resolved without committing as the seam does', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(flow(ctx, () => Promise.resolve(), { commit: false }))
    expect(remoteErrorOf(await failure(controller, { key: KEY }))).toMatchObject({
      code: 'authorization/rejected',
      details: { key: KEY, reason: 'NOT_COMMITTED' },
    })
  })

  it('forgets the stored record on sign-out and reports a refused delete naming the key', async () => {
    const { ctx, controller } = await harness()
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { access: 'at' } }))
    ctx.authorization.registerFlow(flow(ctx, () => Promise.resolve()))
    await controller.signOut(KEY)
    await expect(controller.list()).resolves.toMatchObject([{ configured: false }])
    await controller.signOut(KEY)

    const refusing = await harness(RefusingCredentials)
    const refused = await refusing.controller.signOut(KEY).catch((error: unknown) => error)
    expect(remoteErrorOf(refused)).toMatchObject({
      code: 'authorization/rejected',
      message: 'the credentials document is read-only',
      details: { key: KEY },
    })
  })

  it('reports a refusal that is not an Error with its own text', async () => {
    const { ctx, controller } = await harness()
    // Some client libraries reject with a bare string; the surface still gets
    // something to show rather than "[object Object]".
    ctx.authorization.registerFlow(flow(ctx, () => {
      // A bare string, the way some client libraries reject.
      throw 'the provider closed the connection'
    }))
    expect(remoteErrorOf(await failure(controller, { key: KEY }))).toMatchObject({
      code: 'authorization/rejected',
      message: 'the provider closed the connection',
      details: { key: KEY },
    })

    const literal = await harness(LiteralRejectingCredentials)
    const refused = await literal.controller.signOut(KEY).catch((error: unknown) => error)
    expect(remoteErrorOf(refused)).toMatchObject({
      code: 'authorization/rejected',
      message: 'the store refused',
      details: { key: KEY },
    })
  })

  it('treats a declined prompt exactly as the seam does when the flow rethrows it', async () => {
    const { ctx, controller } = await harness()
    ctx.authorization.registerFlow(flow(ctx, async (session) => {
      try {
        await session.prompt({ kind: 'text', message: 'Paste the code' })
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(AuthorizationDeclinedError)
        throw error
      }
    }))
    const stream = open(controller, { key: KEY })
    const prompt = promptOf(await stream.next())
    await controller.decline(KEY, prompt.promptId)
    expect(await stream.next()).toEqual({ type: 'settled', status: 'cancelled' })
  })
})
