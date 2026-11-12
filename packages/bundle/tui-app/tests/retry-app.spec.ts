/** Explicit continuation through a real Agent and the terminal command path. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, LlmError, type BuiltinLlmFailureCode, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionContinuation from '@deepseek-ai/dsh-session-continuation'
import { expect, it, onTestFinished, vi } from 'vitest'
import { TuiApp, type BoundSession, type SessionHost } from '../src/app.ts'
import { createPalette } from '../src/style.ts'
import { FakeTerminal, KEY } from './bench.ts'

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly code: BuiltinLlmFailureCode) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) throw new LlmError('failed', this.code)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const human = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))

async function setup(options: { code?: BuiltinLlmFailureCode; service?: boolean; child?: boolean } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new Adapter(options.code ?? 'SERVER')
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  if (options.service !== false) await ctx.plugin(SessionContinuation)
  const agent = await ctx.agentLoop.create(SessionId('retry-app'), { provider: 'mock', model: 'mock' })
  const bind = (value: typeof agent): BoundSession => ({
    agent: value, history: value.session.ownEvents(), dispose: () => Promise.resolve(),
  })
  const child = options.child === true
    ? await ctx.agentLoop.create(SessionId('retry-child'), { provider: 'mock', model: 'mock' }) : undefined
  if (child !== undefined) {
    ctx.provide('subagents', {
      rootOf: () => agent,
      listDescendants: () => Promise.resolve([{ kind: 'child', id: child.id, parentId: agent.id,
        depth: 1, mode: 'one-shot', activity: 'inactive', label: 'child', hasChildren: false }]),
    } as never)
  }
  let nextId = 0
  const create = async (): Promise<BoundSession> => bind(await ctx.agentLoop.create(SessionId(`retry-new-${String(++nextId)}`), { provider: 'mock', model: 'mock' }))
  const host: SessionHost = {
    create, resume: create, fork: create,
    observe: async () => child === undefined ? create() : bind(child),
    aside: create,
  }
  const applications: TuiApp[] = []
  const open = () => {
    const terminal = new FakeTerminal()
    terminal.backgroundReply = 'not-a-color'
    const app = new TuiApp({
      ctx, host, initial: bind(agent), terminal, palette: createPalette(false), toolPreviewLines: 3,
      contextPreviewLines: 3, focusPreviewLines: 3, readerMinColumns: 80, codeHighlight: false,
      toastMs: 1000, liveRefreshMs: 1000, fadeSteps: 2, fadeStepMs: 50, streamPaceFrames: 0,
      toolRevealFrames: 0, spinnerMs: 100, reducedMotion: true, env: {}, now: Date.now,
      tick: () => () => {}, cwd: '/work', releaseInput: () => {}, onQuit: () => {},
    })
    app.start(undefined)
    applications.push(app)
    return { app, terminal }
  }
  const { app, terminal } = open()
  onTestFinished(async () => { for (const application of applications) application.stop(); await ctx.fiber.dispose() })
  const command = async (line: string): Promise<void> => {
    for (const char of line) terminal.type(char)
    terminal.type(KEY.enter)
    await settle()
  }
  return { ctx, agent, adapter, app, terminal, command, open }
}

it('retries an eligible failed turn and preserves injected context', async () => {
  const t = await setup()
  t.agent.followup(human('original'))
  await t.agent.whenIdle()
  t.agent.inject(createUserMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'injected context' }] }))
  await t.command('/retry')
  await t.agent.whenIdle()
  expect(t.adapter.requests).toHaveLength(2)
  expect(JSON.stringify(t.adapter.requests[1]?.messages)).toContain('injected context')
  const retries = t.agent.session.ownEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'retry' ? [event.data] : [])
  expect(retries).toHaveLength(1)
  expect(retries[0]).toMatchObject({ content: [], source: { kind: 'retry', rpcId: expect.any(String) as string } })
  t.app.stop()
  const replay = t.open()
  await settle()
  expect(replay.terminal.text()).toContain('continuing failed turn')
})

it('refuses ineligible and queued turns without consuming input', async () => {
  const ineligible = await setup({ code: 'AUTH' })
  ineligible.agent.followup(human('original'))
  await ineligible.agent.whenIdle()
  await ineligible.command('/retry')
  expect(ineligible.terminal.text()).toContain('no eligible failed turn')
  expect(ineligible.adapter.requests).toHaveLength(1)

  const queued = await setup()
  queued.agent.followup(human('original'))
  await queued.agent.whenIdle()
  queued.agent.inbox.append('next-turn', human('waiting'))
  await queued.command('/retry')
  expect(queued.terminal.text()).toContain('human input is still waiting')
  expect(queued.agent.inbox.nextTurn).toHaveLength(1)
})

it('reports busy and missing services without starting a turn', async () => {
  const busy = await setup()
  busy.agent.followup(human('original'))
  await busy.agent.whenIdle()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  const maintenance = busy.agent.runMaintenance(() => release.promise)
  try {
    await busy.command('/retry')
    expect(busy.terminal.text()).toContain('wait for current work')
    expect(busy.adapter.requests).toHaveLength(1)
  } finally { release.resolve(); await maintenance }

  const missing = await setup({ service: false })
  await missing.command('/retry')
  expect(missing.terminal.text()).toContain('continuation service is not mounted')
  expect(missing.adapter.requests).toHaveLength(0)
})

it('keeps staged attachments after retry admission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tui-retry-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'pending.txt')
  await writeFile(path, 'attachment')
  const t = await setup()
  t.ctx.provide('attachments', { saveFile: () => Promise.resolve({ kind: 'file', id: 'file' }) } as never)
  t.agent.followup(human('original'))
  await t.agent.whenIdle()
  await t.command(`/attach ${path}`)
  await t.command('/retry')
  await t.agent.whenIdle()
  await t.command('/attach')
  expect(t.terminal.text()).toContain('attached: pending.txt')
  expect(t.agent.session.ownEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'retry'))
    .toHaveLength(1)
})

it('keeps an edited queued draft instead of submitting /retry as its replacement', async () => {
  const t = await setup()
  const queued = human('queued draft')
  t.agent.inbox.append('next-turn', queued)
  t.agent.ctx.emit('agent/inbox/inserted', { agent: t.agent, message: queued })
  await settle()
  t.terminal.type(KEY.up)
  t.terminal.type(KEY.ctrlU)
  await t.command('/retry')
  expect(t.terminal.text()).toContain('finish or cancel the queued draft first')
  expect(t.adapter.requests).toHaveLength(0)
  t.terminal.type(KEY.ctrlC)
  expect(t.agent.inbox.nextTurn).toEqual([queued])
})

it('refuses retry in a one-shot subagent view', async () => {
  const t = await setup({ child: true })
  const retry = vi.spyOn(t.ctx.sessionContinuation, 'retry')
  await t.command('/subagents')
  t.terminal.type(KEY.enter)
  await settle()
  expect(t.terminal.text()).toContain('one-shot, read-only')
  await t.command('/retry')
  expect(t.terminal.text()).toContain('/retry is unavailable in a read-only session view')
  expect(retry).not.toHaveBeenCalled()
})

it('rejects arguments and leaves empty Enter inert', async () => {
  const t = await setup()
  const retry = vi.spyOn(t.ctx.sessionContinuation, 'retry')
  t.terminal.type(KEY.enter)
  await t.command('/retry extra')
  expect(t.terminal.text()).toContain('usage: /retry')
  expect(t.terminal.text()).toContain('/retry extra')
  expect(retry).not.toHaveBeenCalled()
})

it('reports an unexpected admission failure and restores the submitted line', async () => {
  const t = await setup()
  vi.spyOn(t.ctx.sessionContinuation, 'retry').mockRejectedValue(new Error('admission failed'))
  await t.command('/retry')
  expect(t.terminal.text()).toContain('/retry failed: admission failed')
  expect(t.terminal.text()).toContain('/retry')
  expect(t.adapter.requests).toHaveLength(0)
})

it('keeps a newer editor draft when a delayed retry is refused', async () => {
  const t = await setup()
  const pending = Promise.withResolvers<'accepted' | 'unavailable'>()
  vi.spyOn(t.ctx.sessionContinuation, 'retry').mockReturnValue(pending.promise)
  onTestFinished(() => { pending.resolve('unavailable') })
  await t.command('/retry')
  for (const char of 'new draft') t.terminal.type(char)
  pending.resolve('unavailable')
  await settle()
  expect(t.terminal.text()).toContain('new draft')
  expect(t.terminal.text()).toContain('current draft is unchanged')
})

it('does not duplicate an unsettled request or show its late result after switching', async () => {
  const t = await setup()
  const pending = Promise.withResolvers<'accepted' | 'unavailable'>()
  const retry = vi.spyOn(t.ctx.sessionContinuation, 'retry').mockReturnValue(pending.promise)
  onTestFinished(() => { pending.resolve('unavailable') })
  await t.command('/retry')
  await t.command('/retry')
  expect(retry).toHaveBeenCalledTimes(1)
  expect(t.terminal.text()).toContain('already submitting')
  // Clear the restored duplicate before switching sessions.
  t.terminal.type(KEY.ctrlU)
  await t.command('/new')
  t.terminal.output = ''
  pending.resolve('unavailable')
  await settle()
  expect(t.terminal.text()).not.toContain('no eligible failed turn')
})
