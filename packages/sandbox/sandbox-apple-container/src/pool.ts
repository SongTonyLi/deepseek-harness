/**
 * The provider's owned containers: one per (canonical workspace root, confined
 * mode), shared by every session and subagent in that workspace and mode. The
 * workspace is bind-mounted at its canonical path, plus its lexical path when
 * that differs; `read-only` mounts it read-only, and `workspace-write` mounts
 * its protected directories (such as `.git`) read-only. Extra read-only
 * directories are mounted at their own paths, and hidden files found at start
 * are masked. Each container also mounts a private host run directory, named
 * after the container, writable at {@link GUEST_RUN_DIR} for the exec shim's
 * start sentinels. A cached container is re-inspected at most once per
 * `recheckMs` and restarted when gone or when its run directory is gone.
 * @module @deepseek-ai/dsh-sandbox-apple-container/pool
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedSandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ContainerMount, ContainerRuntime } from './runtime.ts'
import { findHiddenFiles } from './secrets.ts'
import type { HiddenFileScan } from './secrets.ts'
import { GUEST_RUN_DIR } from './shim.ts'

/** Label naming the owning DSH process id. */
export const PID_LABEL = 'dsh.pid'

/** Owned container names: a workspace-and-mode hash and the owning process id. */
const CONTAINER_NAME = /^dsh-[0-9a-f]{12}-(\d+)$/u

/** One owned container. */
export interface PoolEntry {
  /** The confined mode the container's mounts enforce. */
  mode: ConfinedSandboxMode
  /** The canonical workspace root it mounts. */
  root: string
  /** The container name. */
  name: string
  /** The host directory mounted writable at {@link GUEST_RUN_DIR}. */
  runDir: string
}

/** Pool settings. */
export interface PoolOptions {
  /** This process's id, carried in names and the {@link PID_LABEL} label. */
  pid: number
  /** Minimum interval between liveness checks of a cached container. */
  recheckMs: number
  /** Clock in milliseconds. */
  now: () => number
  /** Workspace-relative directories mounted read-only under `workspace-write`. */
  protectedPaths: readonly string[]
  /** Absolute host directories mounted read-only at their own paths. */
  readOnlyMounts: readonly string[]
  /** Files masked with `/dev/null` in the guest. */
  hidden: HiddenFileScan
  /** Canonical host directory holding one run directory per owned container, named after it. */
  runRoot: string
}

/** Whether `path` is an existing directory. */
function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true
}

/** The runtime operations the pool uses. */
export type PoolRuntime = Pick<ContainerRuntime, 'ensureService' | 'state' | 'run' | 'remove' | 'list'>

interface Slot extends PoolEntry {
  ready: Promise<void>
  checkedAt: number
}

/** Owned-container cache over the `container` runtime. */
export class ContainerPool {
  private readonly slots = new Map<string, Slot>()

  constructor(private readonly runtime: PoolRuntime, private readonly options: PoolOptions) {}

  /**
   * Return a running container for `policy`, starting one when none is cached
   * or the cached one is gone. Concurrent callers share one start.
   * @param policy - the confined mode and workspace root.
   * @returns the container's entry.
   * @throws {Error} when the root or run directory cannot be mounted or the runtime fails.
   */
  async ensure(policy: SandboxPolicy): Promise<PoolEntry> {
    const root = canonicalPath(policy.workspaceRoot)
    if (root.includes(',') || policy.workspaceRoot.includes(',')) {
      throw new Error(`workspace root ${JSON.stringify(policy.workspaceRoot)} contains a comma, which \`container --mount\` cannot express`)
    }
    if (this.options.runRoot.includes(',')) {
      throw new Error(`container run directory ${JSON.stringify(this.options.runRoot)} contains a comma, which \`container --mount\` cannot express; set TMPDIR to a path without one`)
    }
    const key = `${policy.mode}\0${root}`
    const now = this.options.now()
    let slot = this.slots.get(key)
    if (slot === undefined) {
      const name = `dsh-${createHash('sha256').update(key).digest('hex').slice(0, 12)}-${this.options.pid}`
      const entry: PoolEntry = { mode: policy.mode, root, name, runDir: join(this.options.runRoot, name) }
      slot = { ...entry, checkedAt: now, ready: this.start(entry, policy.workspaceRoot) }
      this.slots.set(key, slot)
    } else if (now - slot.checkedAt >= this.options.recheckMs) {
      const entry = slot
      slot.checkedAt = now
      slot.ready = slot.ready.then(() => this.recheck(entry, policy.workspaceRoot))
    }
    try {
      await slot.ready
    } catch (error: unknown) {
      if (this.slots.get(key) === slot) this.slots.delete(key)
      throw error
    }
    return { mode: slot.mode, root: slot.root, name: slot.name, runDir: slot.runDir }
  }

  /**
   * Every owned container.
   * @returns the entries in first-start order.
   */
  entries(): PoolEntry[] {
    return [...this.slots.values()].map(({ mode, root, name, runDir }) => ({ mode, root, name, runDir }))
  }

  /**
   * Delete containers and run directories left by DSH processes that no longer exist.
   * @param isAlive - whether a process id names a live process.
   */
  async sweep(isAlive: (pid: number) => boolean): Promise<void> {
    const stale = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0 && pid !== this.options.pid && !isAlive(pid)
    const containers = (await this.runtime.list()).filter(container => stale(Number(container.labels[PID_LABEL])))
    await Promise.all(containers.map(container => this.runtime.remove(container.id)))
    let runDirs: string[]
    try {
      runDirs = await readdir(this.options.runRoot)
    } catch (error: unknown) {
      // ENOENT: no container has started under this run root yet.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const orphaned = runDirs.filter(name => stale(Number(CONTAINER_NAME.exec(name)?.[1])))
    await Promise.all(orphaned.map(name => rm(join(this.options.runRoot, name), { recursive: true, force: true })))
  }

  /** Delete every owned container and its run directory, after any in-flight start settles. */
  async dispose(): Promise<void> {
    const slots = [...this.slots.values()]
    this.slots.clear()
    await Promise.allSettled(slots.map(slot => slot.ready))
    await Promise.all(slots.map(async (slot) => {
      await this.runtime.remove(slot.name)
      await rm(slot.runDir, { recursive: true, force: true })
    }))
  }

  /**
   * Inspect a cached container on the command path; only one that stopped,
   * vanished, or lost its run directory pays for a service check and start.
   */
  private async recheck(entry: PoolEntry, lexical: string): Promise<void> {
    if (isDirectory(entry.runDir) && await this.runtime.state(entry.name) === 'running') return
    await this.start(entry, lexical)
  }

  private async start({ name, mode, root, runDir }: PoolEntry, lexical: string): Promise<void> {
    // The scan never rejects; it overlaps the service and state checks.
    const masks = findHiddenFiles(root, this.options.hidden)
    await this.runtime.ensureService()
    const state = await this.runtime.state(name)
    if (state === 'running' && isDirectory(runDir)) return
    if (state !== 'missing') await this.runtime.remove(name)
    await mkdir(runDir, { recursive: true, mode: 0o700 })
    // Every guest path under the workspace also appears under its lexical spelling.
    const spellings = (path: string): string[] => lexical === root ? [path] : [path, join(lexical, path.slice(root.length))]
    const bind = (source: string, readonly: boolean): ContainerMount[] => spellings(source).map(target => ({ source, target, readonly }))
    const protectedDirs = mode === 'workspace-write'
      ? this.options.protectedPaths.map(path => join(root, path)).filter(isDirectory)
      : []
    await this.runtime.run({
      name,
      labels: { [PID_LABEL]: String(this.options.pid), 'dsh.workspace': root, 'dsh.mode': mode },
      mounts: [
        ...bind(root, mode === 'read-only'),
        ...protectedDirs.flatMap(dir => bind(dir, true)),
        ...this.options.readOnlyMounts.flatMap((path) => {
          const source = canonicalPath(path)
          return isDirectory(source) ? [...new Set([source, path])].map(target => ({ source, target, readonly: true })) : []
        }),
        { source: runDir, target: GUEST_RUN_DIR, readonly: false },
      ],
      maskedPaths: (await masks).flatMap(spellings),
    })
  }
}
