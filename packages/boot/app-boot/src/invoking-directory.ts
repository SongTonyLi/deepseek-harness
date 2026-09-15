/**
 * Restore the directory the user invoked `dsh` from when a package manager
 * rewrote `process.cwd()` to the package that owns the script.
 * @module @deepseek-ai/dsh-app-boot/invoking-directory
 */

import { realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Inputs for {@link resolveInvokingDirectory}. */
export interface InvokingDirectoryRequest {
  /** `process.cwd()` as the manager left it. */
  cwd: string
  /** npm/pnpm `INIT_CWD`: the directory the user invoked the script from. */
  initCwd?: string | undefined
  /** npm/pnpm `npm_package_json`: the package whose script is running. */
  packageJson?: string | undefined
}

/**
 * Realpath of an existing directory, or `undefined` when the path cannot be a workspace root.
 * @param path - a candidate directory.
 * @returns the realpath, or `undefined`.
 */
function realExistingDirectory(path: string): string | undefined {
  try {
    if (!statSync(path).isDirectory()) return undefined
    return realpathSync(path)
  } catch (error: unknown) {
    // Absent, not a directory, or unreadable: keep the process cwd.
    void error
    return undefined
  }
}

/**
 * Directory that should be the workspace root for this launch.
 * npm and pnpm run a package script with cwd set to that package and record
 * the user's directory in `INIT_CWD`. A child spawned with an explicit cwd
 * while inheriting those variables must keep the spawn cwd: its
 * `npm_package_json` names a package other than the spawn cwd.
 * @param request - the process cwd and the manager's launch variables.
 * @returns the workspace directory to use.
 */
export function resolveInvokingDirectory(request: InvokingDirectoryRequest): string {
  const cwd = realExistingDirectory(request.cwd) ?? resolve(request.cwd)
  const init = request.initCwd?.trim()
  if (init === undefined || init === '') return cwd
  const packageJson = request.packageJson?.trim()
  if (packageJson === undefined || packageJson === '') return cwd
  const packageDir = realExistingDirectory(dirname(packageJson))
  if (packageDir === undefined || packageDir !== cwd) return cwd
  return realExistingDirectory(init) ?? cwd
}

/**
 * `chdir` to {@link resolveInvokingDirectory} when a package-script rewrite applied.
 * @param env - the process environment; defaults to `process.env`.
 * @returns the workspace directory after any `chdir`.
 */
export function restoreInvokingDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const target = resolveInvokingDirectory({
    cwd: process.cwd(),
    initCwd: env.INIT_CWD,
    packageJson: env.npm_package_json,
  })
  if (target !== process.cwd()) process.chdir(target)
  return process.cwd()
}
