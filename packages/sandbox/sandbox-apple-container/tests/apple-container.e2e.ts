/**
 * Keyless macOS integration of the real provider, exec shim, and Apple
 * `container` runtime through `ctx.shell`. It checks world effects: the guest
 * is Linux, workspace writes reach the host, writes elsewhere stay in the VM,
 * unmounted host files and credential environment variables are absent,
 * secret files are masked, `.git` is read-only, read-only denials classify,
 * failing commands keep their status without leaving start sentinels, and
 * cancellation kills the guest process. Skips unless `container system
 * status` succeeds.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import AppleContainerSandboxProvider from '../src/index.ts'

const runtimeUp = process.platform === 'darwin' && spawnSync('container', ['system', 'status'], { stdio: 'ignore', timeout: 10_000 }).status === 0

let ctx: Context
let workspace: string
let outside: string
let bash: SandboxBashExecutor

async function run(command: string, mode: 'read-only' | 'workspace-write' = 'workspace-write', signal?: AbortSignal): Promise<ShellRunResult> {
  const spec = bash.resolve({
    command,
    workdir: workspace,
    sandboxPolicy: { mode, workspaceRoot: workspace },
    ...signal === undefined ? {} : { signal },
  })
  return (await bash.execute(spec)).result()
}

describe.skipIf(!runtimeUp)('sandbox-apple-container: real container confinement through ctx.shell', () => {
  beforeAll(async () => {
    workspace = await realpath(await mkdtemp(join(homedir(), 'dsh-container-e2e-ws-')))
    outside = await realpath(await mkdtemp(join(homedir(), 'dsh-container-e2e-out-')))
    await writeFile(join(outside, 'host-secret.txt'), 'host only\n')
    await writeFile(join(workspace, '.env'), 'DEEPSEEK_API_KEY=sk-e2e\n')
    await mkdir(join(workspace, '.git', 'hooks'), { recursive: true })
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: workspace })
    await ctx.plugin(AppleContainerSandboxProvider, {})
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SandboxBashExecutor, { cwd: workspace, timeoutMs: 300_000 })
    bash = ctx.shell as SandboxBashExecutor
  }, 600_000)

  afterAll(async () => {
    await ctx.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('runs Linux in the workspace and lands workspace writes on the host', async () => {
    const result = await run('uname -s; pwd; echo written > out.txt; echo vm > /tmp/vm-only.txt; echo "$HOME"')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe(`Linux\n${workspace}\n/root\n`)
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    expect(readFileSync(join(workspace, 'out.txt'), 'utf8')).toBe('written\n')
    expect(existsSync('/tmp/vm-only.txt') && readFileSync('/tmp/vm-only.txt', 'utf8') === 'vm\n').toBe(false)
  }, 600_000)

  it('cannot read unmounted host files, secret files, or credential variables', async () => {
    const result = await run(`cat ${join(outside, 'host-secret.txt')}; echo "env=[$(cat .env)]"; env | grep -ci -e key -e token -e secret`)
    expect(result.stdout.text).toBe('env=[]\n0\n')
    expect(result.stderr.text).toContain('No such file or directory')
    expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=sk-e2e\n')
  }, 600_000)

  it('keeps .git read-only under workspace-write', async () => {
    const result = await run('echo evil > .git/hooks/pre-commit')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.text.toLowerCase()).toContain('read-only file system')
    expect(existsSync(join(workspace, '.git', 'hooks', 'pre-commit'))).toBe(false)
  }, 600_000)

  it('denies workspace writes under read-only and classifies the denial', async () => {
    const result = await run('echo no > denied.txt', 'read-only')
    expect(result.exitCode).not.toBe(0)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
    expect(existsSync(join(workspace, 'denied.txt'))).toBe(false)
  }, 600_000)

  it('reports a failing command\'s own status and leaves no start sentinel behind', async () => {
    const result = await run('echo failing >&2; exit 3', 'read-only')
    expect(result.exitCode).toBe(3)
    expect(result.stderr.text).toBe('failing\n')
    const runRoot = join(realpathSync(tmpdir()), 'dsh-container-run')
    const owned = readdirSync(runRoot).filter(name => name.endsWith(`-${process.pid}`))
    expect(owned.length).toBeGreaterThan(0)
    expect(owned.flatMap(name => readdirSync(join(runRoot, name)))).toEqual([])
  }, 600_000)

  it('kills the guest process when the call is cancelled', async () => {
    const controller = new AbortController()
    const pending = run('sleep 300', 'workspace-write', controller.signal)
    await new Promise(resolve => setTimeout(resolve, 3_000))
    controller.abort()
    const result = await pending
    expect(result.aborted).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 1_000))
    const ps = await run('ps -eo cmd')
    expect(ps.stdout.text).not.toContain('sleep 300')
  }, 600_000)
})
