/**
 * AppleContainerSandboxProvider over a fake `container` CLI: per-session
 * routing between the local chain and the container shim, the `sandbox/backend`
 * projection, the `/sandbox` command, the model context contribution, warm-up,
 * stale-container sweep, and disposal.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SANDBOX_UNAVAILABLE } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AppleContainerSandboxProvider, { DEFAULT_ENV_DENYLIST, setSandboxBackend, shimInvocation } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { SHIM_FAILURE_EXIT, SHIM_FAILURE_PREFIX } from '../src/shim.ts'
import { fakeContainer } from './fake-container.ts'
import type { FakeContainer } from './fake-container.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

interface Harness {
  ctx: Context
  fake: FakeContainer
  sandbox: AppleContainerSandboxProvider
  root: string
  session(id: string): Session
}

async function mounted(options: { config?: Config; policy?: 'read-only' | 'workspace-write' | 'danger-full-access'; prompt?: boolean } = {}): Promise<Harness> {
  const fake = fakeContainer()
  cleanups.push(() => { fake.dispose() })
  fake.answer('inspect', { code: 1 })
  const root = tempDir('dsh-provider-ws-')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  if (options.prompt === true) await ctx.plugin(SystemPrompt, {})
  if (options.policy !== undefined) await ctx.plugin(SandboxPolicyService, { mode: options.policy, workspaceRoot: root })
  await ctx.plugin(AppleContainerSandboxProvider, { executable: fake.executable, ...options.config })
  return {
    ctx,
    fake,
    root,
    sandbox: ctx.sandbox as AppleContainerSandboxProvider,
    session: id => ctx.sessions.create(SessionId(id), { meta: { cwd: root } }),
  }
}

/** Mint a scoped agent over a live session, the command executor's addressing input. */
async function agentFor(ctx: Context, session: Session): Promise<Agent> {
  const agent = { id: session.id, session, inject: vi.fn<Agent['inject']>() } as Partial<Agent> as Agent
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['commands'] }))
  return agent
}

async function command(ctx: Context, agent: Agent, line: string): Promise<{ kind: string; text?: string }> {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  return execution?.result ?? { kind: 'missing' }
}

async function backendContext(ctx: Context, agent: Agent): Promise<string | undefined> {
  return (await ctx.systemPrompt.assemble({ agent })).contexts.find(context => context.name === 'sandbox:backend')?.text
}

/** Wait until the fake CLI has logged a call matching `predicate`. */
async function called(fake: FakeContainer, predicate: (call: string[]) => boolean): Promise<void> {
  await vi.waitFor(() => { expect(fake.calls().some(predicate)).toBe(true) })
}

describe('AppleContainerSandboxProvider', () => {
  it('routes the container backend through the exec shim', async () => {
    const h = await mounted()
    const session = h.session('s-container')
    const confined = await h.sandbox.confine(['bash', '-c', 'true'], { mode: 'workspace-write', workspaceRoot: h.root, sessionId: session.id })
    const run = h.fake.calls().find(call => call[0] === 'run')
    const name = run?.[run.indexOf('--name') + 1]
    expect(name).toMatch(/^dsh-[0-9a-f]{12}-\d+$/u)
    expect(run).toContain(`type=bind,source=${h.root},target=${h.root}`)
    expect(confined).toEqual({
      argv: [...shimInvocation(new URL('../src/index.ts', import.meta.url).href), h.fake.executable, name, DEFAULT_ENV_DENYLIST.join(','), '--', 'bash', '-c', 'true'],
      enforcement: 'full',
      denialSignatures: ['read-only file system'],
      runnerFailureRules: [{ allowedExitCodes: [SHIM_FAILURE_EXIT], fatalSignatures: [SHIM_FAILURE_PREFIX] }],
    })
  })

  it('delegates the local backend and agentless calls to the local chain', async () => {
    const h = await mounted({ config: { backend: 'local', runnerCommand: ['runner'], runnerFailureSignatures: ['runner: '] } })
    const local = await h.sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: h.root })
    expect(local.argv[0]).toBe('runner')
    const session = h.session('s-switch')
    setSandboxBackend(session, 'container')
    const container = await h.sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: h.root, sessionId: session.id })
    expect(container.argv).toContain(h.fake.executable)
    expect(h.fake.calls().find(call => call[0] === 'run')).toContain(`type=bind,source=${h.root},target=${h.root},readonly`)
    const unknown = await h.sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: h.root, sessionId: SessionId('not-live') })
    expect(unknown.argv[0]).toBe('runner')
  })

  it('fails closed with the local fallback named when the container cannot start', async () => {
    const h = await mounted()
    h.fake.answer('inspect', { code: 1 })
    h.fake.answer('run', { code: 1, stderr: 'Error: image not found' })
    await expect(h.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: h.root })).rejects.toMatchObject({
      code: SANDBOX_UNAVAILABLE,
      message: expect.stringContaining('container run failed: Error: image not found; run /sandbox local') as string,
    })
  })

  it('honors cancellation before and after the container is ready', async () => {
    const h = await mounted()
    const before = new AbortController()
    before.abort(new Error('cancelled early'))
    await expect(h.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: h.root }, before.signal)).rejects.toThrow('cancelled early')
    const after = new AbortController()
    const pending = h.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: h.root }, after.signal)
    after.abort(new Error('cancelled late'))
    await expect(pending).rejects.toThrow('cancelled late')
  })

  it('reports and switches the backend through /sandbox', async () => {
    const h = await mounted()
    const session = h.session('s-command')
    const agent = await agentFor(h.ctx, session)
    expect(await command(h.ctx, agent, '/sandbox')).toEqual({
      kind: 'success',
      text: 'backend container: image node:22-bookworm; no container started yet (/sandbox local switches)',
    })
    await h.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: h.root, sessionId: session.id })
    h.fake.answer('inspect', { stdout: JSON.stringify([{ status: { state: 'running' } }]) })
    const status = (await command(h.ctx, agent, '/sandbox')).text ?? ''
    expect(status).toMatch(/^backend container: image node:22-bookworm; workspace-write dsh-[0-9a-f]{12}-\d+ running at /u)
    expect(status.endsWith(`running at ${h.root} (/sandbox local switches)`)).toBe(true)
    h.fake.answer('inspect', { code: 1 })
    expect((await command(h.ctx, agent, '/sandbox')).text).toContain('missing')
    expect(await command(h.ctx, agent, '/sandbox yolo')).toEqual({ kind: 'error', text: 'unknown backend "yolo" (available: container, local)' })
    expect(await command(h.ctx, agent, '/sandbox local')).toEqual({ kind: 'success', text: 'backend local' })
    expect(h.sandbox.backendFor(session)).toBe('local')
    expect(await command(h.ctx, agent, '/sandbox')).toEqual({
      kind: 'success',
      text: 'backend local: confined commands run on this host under the local sandbox (/sandbox container switches)',
    })
    expect(await command(h.ctx, agent, '/sandbox container')).toEqual({ kind: 'success', text: 'backend container (image node:22-bookworm)' })
    expect(session.snapshotEvents().filter(event => event.type === 'sandbox/backend').map(event => event.data)).toEqual([
      { backend: 'local' },
      { backend: 'container' },
    ])
  })

  it('names an unreadable container state in the status line', async () => {
    const h = await mounted()
    const session = h.session('s-state')
    const agent = await agentFor(h.ctx, session)
    await h.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: h.root, sessionId: session.id })
    rmSync(h.fake.executable)
    expect((await command(h.ctx, agent, '/sandbox')).text).toContain('unknown (cannot run')
  })

  it('tells the model about the container only for confined container sessions', async () => {
    const h = await mounted({ policy: 'workspace-write', prompt: true })
    const session = h.session('s-context')
    const agent = await agentFor(h.ctx, session)
    expect(await backendContext(h.ctx, agent)).toBe(
      'Commands confined by the DSH file sandbox run inside a Linux container from image "node:22-bookworm". '
      + `Only the session workspace ${JSON.stringify(h.root)} is shared with the host; `
      + 'files written elsewhere stay inside the container and are not visible to file tools. '
      + 'File tools cannot read host paths outside the workspace, and secret files such as `.env` and private keys are hidden from commands and file tools.',
    )
    setSandboxMode(session, 'danger-full-access')
    expect(await backendContext(h.ctx, agent)).toBe('')
    setSandboxMode(session, 'read-only')
    setSandboxBackend(session, 'local')
    expect(await backendContext(h.ctx, agent)).toBe('')
    expect((await h.ctx.systemPrompt.assemble({})).contexts.find(context => context.name === 'sandbox:backend')?.text ?? '').toBe('')
  })

  it('warms the default-mode container and deletes owned containers on dispose', async () => {
    const h = await mounted({ policy: 'workspace-write' })
    await called(h.fake, call => call[0] === 'run')
    const run = h.fake.calls().find(call => call[0] === 'run') ?? []
    const name = run[run.indexOf('--name') + 1]
    await h.ctx.fiber.dispose()
    expect(h.fake.calls()).toContainEqual(['delete', '--force', name])
  })

  it('skips warm-up for the local backend and unconfined defaults', async () => {
    const local = await mounted({ policy: 'workspace-write', config: { backend: 'local' } })
    const full = await mounted({ policy: 'danger-full-access' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(local.fake.calls()).toEqual([])
    expect(full.fake.calls().filter(call => call[0] === 'run')).toEqual([])
  })

  it('sweeps containers left by dead DSH processes', async () => {
    const fake = fakeContainer()
    cleanups.push(() => { fake.dispose() })
    fake.answer('list', { stdout: JSON.stringify([{ configuration: { id: 'stale', labels: { 'dsh.pid': '2147483646' } } }]) })
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AppleContainerSandboxProvider, { executable: fake.executable })
    await called(fake, call => call[0] === 'delete' && call[2] === 'stale')
  })

  it('logs warm-up and sweep failures instead of failing the load', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: tempDir('dsh-provider-warn-') })
    await ctx.plugin(AppleContainerSandboxProvider, { executable: '/nonexistent/container' })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(2) })
    expect(warn.mock.calls.map(call => String(call[0])).sort()).toEqual([
      expect.stringContaining('removing stale containers failed: cannot run "/nonexistent/container"'),
      expect.stringContaining('starting the read-only container failed: cannot run "/nonexistent/container"'),
    ])
  })

  it('confines host reads of container sessions to the workspace and extra mounts', async () => {
    const skills = tempDir('dsh-provider-skills-')
    const h = await mounted({ policy: 'workspace-write', config: { readOnlyMounts: [skills], hiddenFiles: ['.env'] } })
    const session = h.session('s-scope')
    const policy = { mode: 'workspace-write' as const, workspaceRoot: h.root, sessionId: session.id }
    expect(h.sandbox.readScope(policy)).toEqual({ roots: [h.root, skills], hiddenNames: ['.env'] })
    expect(h.ctx.sandboxPolicy.canRead(join(h.root, 'src', 'a.ts'), { session })).toBe(true)
    expect(h.ctx.sandboxPolicy.canRead(join(skills, 'x', 'SKILL.md'), { session })).toBe(true)
    expect(h.ctx.sandboxPolicy.canRead(join(h.root, '.env'), { session })).toBe(false)
    expect(h.ctx.sandboxPolicy.canRead('/etc/passwd', { session })).toBe(false)
    expect(h.ctx.sandboxPolicy.canRead(join(h.root, '..', 'sibling'), { session })).toBe(false)
    expect(h.ctx.sandboxPolicy.canRead('/etc/passwd', { session, mode: 'danger-full-access' })).toBe(true)
    expect(h.sandbox.readScope({ ...policy, mode: 'danger-full-access' })).toBeUndefined()
    setSandboxBackend(session, 'local')
    expect(h.sandbox.readScope(policy)).toBeUndefined()
    expect(h.ctx.sandboxPolicy.canRead('/etc/passwd', { session })).toBe(true)
  })

  it('mounts extra read-only directories and masks hidden files in new containers', async () => {
    const skills = tempDir('dsh-provider-mounts-')
    const h = await mounted({ config: { readOnlyMounts: [skills] } })
    writeFileSync(join(h.root, '.env'), 'DEEPSEEK_API_KEY=sk-test')
    await h.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: h.root })
    const run = h.fake.calls().find(call => call[0] === 'run') ?? []
    expect(run).toContain(`type=bind,source=${skills},target=${skills},readonly`)
    expect(run[run.indexOf('--masked-path') + 1]).toBe(join(h.root, '.env'))
  })

  it('rejects invalid configuration at load', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await expect(ctx.plugin(AppleContainerSandboxProvider, { backend: 'local', envDenylist: ['A,B'] }))
      .rejects.toThrow('envDenylist entries must be non-empty and contain no comma')
    await expect(ctx.plugin(AppleContainerSandboxProvider, { backend: 'local', cpus: 0 }))
      .rejects.toThrow('cpus must be positive')
    await expect(ctx.plugin(AppleContainerSandboxProvider, { backend: 'local', readOnlyMounts: ['relative/skills'] }))
      .rejects.toThrow('readOnlyMounts entries must be absolute paths without a comma')
    for (const protectedPaths of [['../escape'], ['/abs'], [''], ['a,b']]) {
      await expect(ctx.plugin(AppleContainerSandboxProvider, { backend: 'local', protectedPaths }))
        .rejects.toThrow('protectedPaths entries must be workspace-relative paths')
    }
  })

  it('passes resources to container run', async () => {
    const h = await mounted({ config: { cpus: 2, memory: '4g' } })
    await h.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: h.root })
    expect(h.fake.calls().find(call => call[0] === 'run')).toEqual(expect.arrayContaining(['--cpus', '2', '--memory', '4g']))
  })
})

describe('shimInvocation', () => {
  it('prefers a built sibling entry under plain Node', () => {
    const dir = tempDir('dsh-shim-entry-')
    const built = join(dir, 'exec-shim.js')
    writeFileSync(built, '')
    expect(shimInvocation(new URL(`file://${dir}/index.js`).href)).toEqual([process.execPath, built])
  })

  it('falls back to the source entry through tsx', () => {
    const dir = tempDir('dsh-shim-source-')
    const invocation = shimInvocation(new URL(`file://${dir}/index.ts`).href)
    expect(invocation.slice(0, 2)).toEqual([process.execPath, '--import'])
    expect(invocation[2]).toMatch(/^data:text\/javascript,/u)
    expect(invocation[3]).toBe(join(dir, 'exec-shim.ts'))
  })
})
