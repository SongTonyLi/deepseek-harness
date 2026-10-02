/**
 * Host support for the container backend and the `auto` backend resolution:
 * Apple `container` runs only on macOS on Apple silicon, so `auto` selects
 * the container there when its CLI resolves and the local backend everywhere
 * else.
 * @module @deepseek-ai/dsh-sandbox-apple-container/host
 */

import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { SandboxBackend } from './session-backend.ts'

/** The configured backend: a fixed backend, or `auto` resolved per host at load. */
export type ConfiguredBackend = SandboxBackend | 'auto'

/** The host facts backend resolution reads. */
export interface HostFacts {
  /** `process.platform`. */
  platform: string
  /** `process.arch`. */
  arch: string
  /** `PATH` used to resolve a bare executable name. */
  path: string | undefined
}

/**
 * Whether `executable` resolves to an executable file: an absolute path is
 * checked directly, a bare name against each `PATH` directory.
 * @param executable - the configured `container` CLI.
 * @param path - the `PATH` value.
 * @returns true when an executable file is found.
 */
export function executableResolves(executable: string, path: string | undefined): boolean {
  const candidates = isAbsolute(executable) ? [executable] : (path ?? '').split(delimiter).filter(dir => dir !== '').map(dir => join(dir, executable))
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      // Not executable at this candidate; try the next PATH entry.
      return false
    }
  })
}

/**
 * Whether this host can run the container backend: macOS on Apple silicon
 * with the `container` CLI resolvable.
 * @param executable - the configured `container` CLI.
 * @param host - platform, architecture, and `PATH`.
 * @returns true when the container backend is usable.
 */
export function containerSupported(executable: string, host: HostFacts): boolean {
  return host.platform === 'darwin' && host.arch === 'arm64' && executableResolves(executable, host.path)
}

/**
 * Resolve the configured backend for this host: `auto` becomes `container`
 * where {@link containerSupported} holds and `local` elsewhere; a fixed
 * backend is kept as configured.
 * @param backend - the configured backend.
 * @param supported - whether the container backend is usable here.
 * @returns the deployment default backend.
 */
export function resolveBackend(backend: ConfiguredBackend, supported: boolean): SandboxBackend {
  if (backend !== 'auto') return backend
  return supported ? 'container' : 'local'
}
