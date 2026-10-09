/** ContainerPool over a scripted runtime double. */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContainerPool, PID_LABEL } from '../src/pool.ts'
import type { PoolEntry, PoolOptions } from '../src/pool.ts'
import type { ContainerSpec, ContainerState, ListedContainer } from '../src/runtime.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-pool-')))
  dirs.push(dir)
  return dir
}

class RuntimeDouble {
  calls: string[] = []
  runs: ContainerSpec[] = []
  states = new Map<string, ContainerState>()
  listed: ListedContainer[] = []
  failRun: Error | undefined
  ensureService(): Promise<void> {
    this.calls.push('ensureService')
    return Promise.resolve()
  }

  state(name: string): Promise<ContainerState> {
    this.calls.push(`state ${name}`)
    return Promise.resolve(this.states.get(name) ?? 'missing')
  }

  run(spec: ContainerSpec): Promise<void> {
    this.calls.push(`run ${spec.name}`)
    if (this.failRun !== undefined) return Promise.reject(this.failRun)
    this.runs.push(spec)
    this.states.set(spec.name, 'running')
    return Promise.resolve()
  }

  remove(name: string): Promise<void> {
    this.calls.push(`remove ${name}`)
    this.states.delete(name)
    return Promise.resolve()
  }

  list(): Promise<ListedContainer[]> {
    return Promise.resolve(this.listed)
  }
}

/** The writable run-directory mount every owned container ends with. */
function runMount(entry: PoolEntry): { source: string; target: string; readonly: boolean } {
  return { source: entry.runDir, target: '/run/dsh', readonly: false }
}

function setup(
  recheckMs = 1000,
  layout: Partial<Pick<PoolOptions, 'protectedPaths' | 'readOnlyMounts' | 'hidden' | 'runRoot'>> = {},
): { runtime: RuntimeDouble; pool: ContainerPool; clock: { now: number }; runRoot: string } {
  const runtime = new RuntimeDouble()
  const clock = { now: 0 }
  const runRoot = join(workspace(), 'run')
  const pool = new ContainerPool(runtime, {
    pid: 42,
    recheckMs,
    now: () => clock.now,
    protectedPaths: ['.git'],
    readOnlyMounts: [],
    hidden: { names: ['.env'], maxDepth: 4, skipDirs: ['node_modules'] },
    runRoot,
    ...layout,
  })
  return { runtime, pool, clock, runRoot }
}

describe('ContainerPool', () => {
  it('starts one labelled container per workspace and mode', async () => {
    const { runtime, pool, runRoot } = setup()
    const root = workspace()
    const entry = await pool.ensure({ mode: 'workspace-write', workspaceRoot: root })
    const { name } = entry
    expect(name).toMatch(/^dsh-[0-9a-f]{12}-42$/u)
    expect(entry).toEqual({ mode: 'workspace-write', root, name, runDir: join(runRoot, name) })
    expect(statSync(entry.runDir).mode & 0o777).toBe(0o700)
    expect(runtime.calls).toEqual(['ensureService', `state ${name}`, `run ${name}`])
    expect(runtime.runs[0]).toEqual({
      name,
      labels: { [PID_LABEL]: '42', 'dsh.workspace': root, 'dsh.mode': 'workspace-write' },
      mounts: [{ source: root, target: root, readonly: false }, runMount(entry)],
      maskedPaths: [],
    })
    const readOnly = await pool.ensure({ mode: 'read-only', workspaceRoot: root })
    expect(readOnly.name).not.toBe(name)
    expect(readOnly.runDir).not.toBe(entry.runDir)
    expect(runtime.runs[1]?.mounts).toEqual([{ source: root, target: root, readonly: true }, runMount(readOnly)])
    expect(pool.entries()).toEqual([entry, readOnly])
  })

  it('also mounts the lexical path of a symlinked workspace', async () => {
    const { runtime, pool } = setup()
    const root = workspace()
    const link = join(workspace(), 'link')
    symlinkSync(root, link)
    const entry = await pool.ensure({ mode: 'workspace-write', workspaceRoot: link })
    expect(runtime.runs[0]?.mounts).toEqual([
      { source: root, target: root, readonly: false },
      { source: root, target: link, readonly: false },
      runMount(entry),
    ])
  })

  it('keeps protected directories read-only under workspace-write and masks hidden files', async () => {
    const { runtime, pool } = setup()
    const root = workspace()
    const link = join(workspace(), 'link')
    symlinkSync(root, link)
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, '.env'), 'KEY=1')
    writeFileSync(join(root, 'node_modules', '.env'), 'KEY=2')
    const entry = await pool.ensure({ mode: 'workspace-write', workspaceRoot: link })
    expect(runtime.runs[0]?.mounts).toEqual([
      { source: root, target: root, readonly: false },
      { source: root, target: link, readonly: false },
      { source: join(root, '.git'), target: join(root, '.git'), readonly: true },
      { source: join(root, '.git'), target: join(link, '.git'), readonly: true },
      runMount(entry),
    ])
    expect(runtime.runs[0]?.maskedPaths).toEqual([join(root, '.env'), join(link, '.env')])
    const readOnly = await pool.ensure({ mode: 'read-only', workspaceRoot: root })
    expect(runtime.runs[1]?.mounts).toEqual([{ source: root, target: root, readonly: true }, runMount(readOnly)])
  })

  it('mounts existing extra directories read-only at their own and canonical paths', async () => {
    const real = workspace()
    const alias = join(workspace(), 'skills')
    symlinkSync(real, alias)
    const { runtime, pool } = setup(1000, { readOnlyMounts: [real, alias, join(real, 'missing')] })
    const root = workspace()
    await pool.ensure({ mode: 'workspace-write', workspaceRoot: root })
    expect(runtime.runs[0]?.mounts.slice(1, -1)).toEqual([
      { source: real, target: real, readonly: true },
      { source: real, target: real, readonly: true },
      { source: real, target: alias, readonly: true },
    ])
  })

  it('shares one start between concurrent callers and skips rechecks inside the interval', async () => {
    const { runtime, pool, clock } = setup()
    const root = workspace()
    const [a, b] = await Promise.all([
      pool.ensure({ mode: 'workspace-write', workspaceRoot: root }),
      pool.ensure({ mode: 'workspace-write', workspaceRoot: root }),
    ])
    expect(a).toEqual(b)
    clock.now = 999
    await pool.ensure({ mode: 'workspace-write', workspaceRoot: root })
    expect(runtime.calls.filter(call => call.startsWith('run'))).toHaveLength(1)
    expect(runtime.calls.filter(call => call.startsWith('state'))).toHaveLength(1)
  })

  it('rechecks after the interval and recreates a vanished container', async () => {
    const { runtime, pool, clock } = setup()
    const root = workspace()
    const { name } = await pool.ensure({ mode: 'workspace-write', workspaceRoot: root })
    runtime.calls = []
    clock.now = 1000
    await pool.ensure({ mode: 'workspace-write', workspaceRoot: root })
    expect(runtime.calls).toEqual([`state ${name}`])
    runtime.calls = []
    clock.now = 2000
    runtime.states.delete(name)
    await expect(pool.ensure({ mode: 'workspace-write', workspaceRoot: root })).resolves.toMatchObject({ name })
    expect(runtime.calls).toEqual([`state ${name}`, 'ensureService', `state ${name}`, `run ${name}`])
  })

  it('replaces a running container whose run directory was deleted', async () => {
    const { runtime, pool, clock } = setup()
    const root = workspace()
    const { name, runDir } = await pool.ensure({ mode: 'workspace-write', workspaceRoot: root })
    rmSync(runDir, { recursive: true })
    runtime.calls = []
    clock.now = 1000
    await pool.ensure({ mode: 'workspace-write', workspaceRoot: root })
    expect(runtime.calls).toEqual(['ensureService', `state ${name}`, `remove ${name}`, `run ${name}`])
    expect(existsSync(runDir)).toBe(true)
  })

  it('replaces a stopped container and adopts a running one', async () => {
    const { runtime, pool } = setup()
    const root = workspace()
    const { name: probe, runDir } = await pool.ensure({ mode: 'read-only', workspaceRoot: root })
    await pool.dispose()
    runtime.calls = []
    runtime.states.set(probe, 'stopped')
    await pool.ensure({ mode: 'read-only', workspaceRoot: root })
    expect(runtime.calls).toEqual(['ensureService', `state ${probe}`, `remove ${probe}`, `run ${probe}`])
    await pool.dispose()
    runtime.calls = []
    runtime.states.set(probe, 'running')
    mkdirSync(runDir)
    await pool.ensure({ mode: 'read-only', workspaceRoot: root })
    expect(runtime.calls).toEqual(['ensureService', `state ${probe}`])
  })

  it('retries a failed start on the next call', async () => {
    const { runtime, pool } = setup()
    const root = workspace()
    runtime.failRun = new Error('container run failed: no image')
    await expect(pool.ensure({ mode: 'workspace-write', workspaceRoot: root })).rejects.toThrow('no image')
    runtime.failRun = undefined
    await expect(pool.ensure({ mode: 'workspace-write', workspaceRoot: root })).resolves.toMatchObject({ name: expect.stringMatching(/^dsh-/u) as string })
  })

  it('keeps a slot cleared by dispose while its start fails', async () => {
    const { runtime, pool } = setup()
    const root = workspace()
    let fail: (error: Error) => void = () => {}
    runtime.run = (spec) => {
      runtime.calls.push(`run ${spec.name}`)
      return new Promise((_resolve, reject) => { fail = reject })
    }
    const pending = pool.ensure({ mode: 'workspace-write', workspaceRoot: root })
    await vi.waitFor(() => { expect(runtime.calls.some(call => call.startsWith('run'))).toBe(true) })
    const disposed = pool.dispose()
    fail(new Error('container run failed: interrupted'))
    await expect(pending).rejects.toThrow('interrupted')
    await disposed
    expect(pool.entries()).toEqual([])
  })

  it('rejects a workspace root containing a comma', async () => {
    const { pool } = setup()
    await expect(pool.ensure({ mode: 'workspace-write', workspaceRoot: '/no,such' })).rejects.toThrow('contains a comma')
  })

  it('rejects a run root containing a comma before starting anything', async () => {
    const { runtime, pool } = setup(1000, { runRoot: '/tmp/a,b' })
    await expect(pool.ensure({ mode: 'workspace-write', workspaceRoot: workspace() })).rejects.toThrow('container run directory "/tmp/a,b" contains a comma')
    expect(runtime.calls).toEqual([])
  })

  it('sweeps containers and run directories left by dead DSH processes', async () => {
    const { runtime, pool, runRoot } = setup()
    const dirs = ['dsh-0123456789ab-7', 'dsh-0123456789ab-8', 'dsh-0123456789ab-42', 'dsh-other-7']
    for (const dir of dirs) mkdirSync(join(runRoot, dir), { recursive: true })
    runtime.listed = [
      { id: 'dead', labels: { [PID_LABEL]: '7' } },
      { id: 'alive', labels: { [PID_LABEL]: '8' } },
      { id: 'own', labels: { [PID_LABEL]: '42' } },
      { id: 'foreign', labels: {} },
      { id: 'garbled', labels: { [PID_LABEL]: 'x' } },
    ]
    await pool.sweep(pid => pid === 8)
    expect(runtime.calls).toEqual(['remove dead'])
    expect(dirs.filter(dir => existsSync(join(runRoot, dir)))).toEqual(['dsh-0123456789ab-8', 'dsh-0123456789ab-42', 'dsh-other-7'])
  })

  it('sweeps before any run directory exists', async () => {
    const { runtime, pool } = setup()
    runtime.listed = [{ id: 'dead', labels: { [PID_LABEL]: '7' } }]
    await pool.sweep(() => false)
    expect(runtime.calls).toEqual(['remove dead'])
  })

  it('deletes every owned container on dispose', async () => {
    const { runtime, pool } = setup()
    const root = workspace()
    const a = await pool.ensure({ mode: 'workspace-write', workspaceRoot: root })
    const b = await pool.ensure({ mode: 'read-only', workspaceRoot: root })
    runtime.calls = []
    await pool.dispose()
    expect(runtime.calls).toEqual([`remove ${a.name}`, `remove ${b.name}`])
    expect([existsSync(a.runDir), existsSync(b.runDir)]).toEqual([false, false])
    expect(pool.entries()).toEqual([])
  })
})
