/**
 * The provider's owned containers: one per (canonical workspace root, confined
 * mode), shared by every session and subagent in that workspace and mode. The
 * workspace is bind-mounted at its canonical path, plus its lexical path when
 * that differs; `read-only` mounts it read-only. A cached container is
 * re-inspected at most once per `recheckMs` and restarted when gone.
 * @module @deepseek-ai/dsh-sandbox-apple-container/pool
 */

import { createHash } from 'node:crypto'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedSandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ContainerRuntime } from './runtime.ts'

/** Label naming the owning DSH process id. */
export const PID_LABEL = 'dsh.pid'

/** One owned container. */
export interface PoolEntry {
  /** The confined mode the container's mounts enforce. */
  mode: ConfinedSandboxMode
  /** The canonical workspace root it mounts. */
  root: string
  /** The container name. */
  name: string
}

/** Pool settings. */
export interface PoolOptions {
  /** This process's id, carried in names and the {@link PID_LABEL} label. */
  pid: number
  /** Minimum interval between liveness checks of a cached container. */
  recheckMs: number
  /** Clock in milliseconds. */
  now: () => number
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
   * Return the name of a running container for `policy`, starting one when
   * none is cached or the cached one is gone. Concurrent callers share one start.
   * @param policy - the confined mode and workspace root.
   * @returns the container name.
   * @throws {Error} when the root cannot be mounted or the runtime fails.
   */
  async ensure(policy: SandboxPolicy): Promise<string> {
    const root = canonicalPath(policy.workspaceRoot)
    if (root.includes(',') || policy.workspaceRoot.includes(',')) {
      throw new Error(`workspace root ${JSON.stringify(policy.workspaceRoot)} contains a comma, which \`container --mount\` cannot express`)
    }
    const key = `${policy.mode}\0${root}`
    const now = this.options.now()
    let slot = this.slots.get(key)
    if (slot === undefined) {
      const name = `dsh-${createHash('sha256').update(key).digest('hex').slice(0, 12)}-${this.options.pid}`
      slot = { mode: policy.mode, root, name, checkedAt: now, ready: this.start(name, policy.mode, root, policy.workspaceRoot) }
      this.slots.set(key, slot)
    } else if (now - slot.checkedAt >= this.options.recheckMs) {
      const { name } = slot
      slot.checkedAt = now
      slot.ready = slot.ready.then(() => this.start(name, policy.mode, root, policy.workspaceRoot))
    }
    try {
      await slot.ready
    } catch (error: unknown) {
      if (this.slots.get(key) === slot) this.slots.delete(key)
      throw error
    }
    return slot.name
  }

  /**
   * Every owned container.
   * @returns the entries in first-start order.
   */
  entries(): PoolEntry[] {
    return [...this.slots.values()].map(({ mode, root, name }) => ({ mode, root, name }))
  }

  /**
   * Delete containers left by DSH processes that no longer exist.
   * @param isAlive - whether a process id names a live process.
   */
  async sweep(isAlive: (pid: number) => boolean): Promise<void> {
    const stale = (await this.runtime.list()).filter((container) => {
      const pid = Number(container.labels[PID_LABEL])
      return Number.isSafeInteger(pid) && pid > 0 && pid !== this.options.pid && !isAlive(pid)
    })
    await Promise.all(stale.map(container => this.runtime.remove(container.id)))
  }

  /** Delete every owned container, after any in-flight start settles. */
  async dispose(): Promise<void> {
    const slots = [...this.slots.values()]
    this.slots.clear()
    await Promise.allSettled(slots.map(slot => slot.ready))
    await Promise.all(slots.map(slot => this.runtime.remove(slot.name)))
  }

  private async start(name: string, mode: ConfinedSandboxMode, root: string, lexical: string): Promise<void> {
    await this.runtime.ensureService()
    const state = await this.runtime.state(name)
    if (state === 'running') return
    if (state === 'stopped') await this.runtime.remove(name)
    const readonly = mode === 'read-only'
    await this.runtime.run({
      name,
      labels: { [PID_LABEL]: String(this.options.pid), 'dsh.workspace': root, 'dsh.mode': mode },
      mounts: [
        { source: root, target: root, readonly },
        ...lexical === root ? [] : [{ source: root, target: lexical, readonly }],
      ],
    })
  }
}
