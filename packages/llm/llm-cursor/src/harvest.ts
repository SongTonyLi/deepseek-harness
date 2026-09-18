/**
 * Optional reuse of a Cursor IDE or CLI login already on this machine.
 *
 * @module @deepseek-ai/dsh-llm-cursor/harvest
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { grantExpiryFromAccess } from './grant.ts'
import type { CursorOauthGrant } from './grant.ts'

const execFileAsync = promisify(execFile)

/** Raw tokens as stored by the Cursor app or CLI. */
export interface InstalledCursorTokens {
  /** Access token, when present. */
  accessToken?: string
  /** Refresh token, when present. */
  refreshToken?: string
}

/** Host seams harvest uses to read Keychain and `state.vscdb`. */
export interface HarvestHost {
  /** `process.platform`. */
  platform(): NodeJS.Platform
  /** User home directory. */
  homedir(): string
  /** Process environment. */
  env: NodeJS.ProcessEnv
  /**
   * Run one helper binary.
   * @param file - executable.
   * @param args - argv.
   * @param options - encoding and timeout.
   */
  execFile(
    file: string,
    args: string[],
    options: { encoding: 'utf8'; timeout: number },
  ): Promise<{ stdout: string }>
  /**
   * Open a SQLite database read-only.
   * @param path - `state.vscdb`.
   */
  openSqlite?(path: string): { get(sql: string): { value?: string } | undefined; close(): void }
  /**
   * Whether a path exists; used to detect a WSL Windows mount.
   * @param path - candidate path.
   */
  exists?(path: string): boolean
}

/**
 * Windows account that owns this WSL session.
 * @param env - process environment.
 * @returns a usable username, or `undefined`.
 */
export function windowsUsernameFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const profile = env.USERPROFILE?.trim()
  if (profile !== undefined && profile.length > 0) {
    const match = /\/Users\/([^/]+)/i.exec(profile.replaceAll('\\', '/'))
    const fromProfile = match?.[1]?.trim()
    if (
      fromProfile !== undefined
      && fromProfile.length > 0
      && fromProfile !== 'Public'
      && fromProfile !== 'Default'
      && !fromProfile.startsWith('.')
    ) {
      return fromProfile
    }
  }
  const username = env.USERNAME?.trim()
  if (
    username !== undefined
    && username.length > 0
    && username !== 'Public'
    && username !== 'Default'
    && !username.startsWith('.')
  ) {
    return username
  }
  return undefined
}

function isFreshAccess(token: string | undefined, now: () => number): token is string {
  if (token === undefined || token.trim().length === 0) return false
  return now() < grantExpiryFromAccess(token, now)
}

async function readKeychainTokens(host: HarvestHost): Promise<InstalledCursorTokens> {
  if (host.platform() !== 'darwin') return {}
  const [accessResult, refreshResult] = await Promise.allSettled([
    host.execFile('security', ['find-generic-password', '-s', 'cursor-access-token', '-a', 'cursor-user', '-w'], {
      encoding: 'utf8',
      timeout: 2000,
    }),
    host.execFile('security', ['find-generic-password', '-s', 'cursor-refresh-token', '-a', 'cursor-user', '-w'], {
      encoding: 'utf8',
      timeout: 2000,
    }),
  ])
  const tokens: InstalledCursorTokens = {}
  if (accessResult.status === 'fulfilled') {
    const raw = accessResult.value.stdout.trim()
    if (raw.length > 0) tokens.accessToken = raw
  }
  if (refreshResult.status === 'fulfilled') {
    const raw = refreshResult.value.stdout.trim()
    if (raw.length > 0) tokens.refreshToken = raw
  }
  return tokens
}

function vscdbPaths(host: HarvestHost): string[] {
  const home = host.homedir()
  const paths: string[] = []
  const platform = host.platform()
  if (platform === 'darwin') {
    paths.push(join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb'))
  } else if (platform === 'win32') {
    if (host.env.APPDATA !== undefined) {
      paths.push(join(host.env.APPDATA, 'Cursor/User/globalStorage/state.vscdb'))
    }
  } else {
    paths.push(join(home, '.config/Cursor/User/globalStorage/state.vscdb'))
    const existsPath = (path: string): boolean => host.exists === undefined ? existsSync(path) : host.exists(path)
    const wslHost = Boolean(host.env.WSL_DISTRO_NAME || host.env.WSL_INTEROP || existsPath('/mnt/c/Users'))
    if (wslHost) {
      const windowsUser = windowsUsernameFromEnv(host.env)
      if (windowsUser !== undefined) {
        paths.push(join('/mnt/c/Users', windowsUser, 'AppData/Roaming/Cursor/User/globalStorage/state.vscdb'))
      }
    }
  }
  return paths
}

function readVscdbTokens(host: HarvestHost): InstalledCursorTokens {
  if (host.openSqlite === undefined) return {}
  const fallback: InstalledCursorTokens = {}
  for (const dbPath of vscdbPaths(host)) {
    try {
      const db = host.openSqlite(dbPath)
      let accessRow: { value?: string } | undefined
      let refreshRow: { value?: string } | undefined
      try {
        accessRow = db.get("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
        refreshRow = db.get("SELECT value FROM ItemTable WHERE key = 'cursorAuth/refreshToken'")
      } finally {
        db.close()
      }
      const accessToken = typeof accessRow?.value === 'string' ? accessRow.value.trim() : undefined
      const refreshToken = typeof refreshRow?.value === 'string' ? refreshRow.value.trim() : undefined
      if (accessToken !== undefined && accessToken.length > 0) {
        return { accessToken, ...refreshToken === undefined ? {} : { refreshToken } }
      }
      if (fallback.refreshToken === undefined && refreshToken !== undefined && refreshToken.length > 0) {
        fallback.refreshToken = refreshToken
      }
    } catch (_unreadableVscdb) {
      // Missing or unreadable profile: try the next path.
    }
  }
  return fallback
}

/**
 * Read Keychain then `state.vscdb` using one host.
 * @param host - process, exec, and sqlite seams.
 * @returns token pairs in preference order, empty sources omitted.
 */
export async function readInstalledCursorSources(host: HarvestHost): Promise<InstalledCursorTokens[]> {
  const sources: InstalledCursorTokens[] = []
  const keychain = await readKeychainTokens(host)
  if (keychain.accessToken !== undefined || keychain.refreshToken !== undefined) sources.push(keychain)
  const vscdb = readVscdbTokens(host)
  if (vscdb.accessToken !== undefined || vscdb.refreshToken !== undefined) sources.push(vscdb)
  return sources
}

/**
 * Load `node:sqlite` for production harvest.
 * @returns the DatabaseSync constructor, or `undefined` when the module is unavailable.
 */
export async function loadSqliteDatabaseSync(): Promise<(
  new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(): unknown }
    close(): void
  }
) | undefined> {
  try {
    const mod = await import('node:sqlite')
    return mod.DatabaseSync
    /* v8 ignore start -- Node 22 ships `node:sqlite`; the catch is for builds that omit it. */
  } catch (_sqliteUnavailable) {
    return undefined
  }
  /* v8 ignore stop */
}

/**
 * Production source reader: Keychain plus `state.vscdb` when sqlite loads.
 * @returns a function that yields installed token pairs.
 */
export async function createDefaultHarvestSources(): Promise<() => Promise<InstalledCursorTokens[]>> {
  const DatabaseSync = await loadSqliteDatabaseSync()
  const host: HarvestHost = {
    platform: () => process.platform,
    homedir,
    env: process.env,
    execFile: execFileAsync,
    exists: existsSync,
  }
  /* v8 ignore next -- Node 22 always loads `node:sqlite` in this engine range. */
  if (DatabaseSync === undefined) return () => readInstalledCursorSources(host)
  host.openSqlite = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true })
    return {
      get: (sql: string) => db.prepare(sql).get() as { value?: string } | undefined,
      close: () => { db.close() },
    }
  }
  return () => readInstalledCursorSources(host)
}

/**
 * Resolve an access token from installed Cursor logins.
 * @param options - whether harvest is enabled, the source reader, and refresh.
 * @returns an access token, or `undefined` when nothing usable is installed.
 */
export async function harvestInstalledCursorLogin(options: {
  enabled: boolean
  readSources: () => Promise<InstalledCursorTokens[]>
  refresh: (refreshToken: string) => Promise<CursorOauthGrant>
  now?: () => number
}): Promise<string | undefined> {
  if (!options.enabled) return undefined
  const now = options.now ?? Date.now
  for (const source of await options.readSources()) {
    if (isFreshAccess(source.accessToken, now)) return source.accessToken
    if (source.refreshToken !== undefined && source.refreshToken.length > 0) {
      try {
        const granted = await options.refresh(source.refreshToken)
        return granted.access
      } catch (_staleInstalledRefresh) {
        // A stale IDE refresh does not fail the DSH request; try the next source.
      }
    }
  }
  return undefined
}
