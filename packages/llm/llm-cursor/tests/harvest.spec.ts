/** Installed Cursor login harvest. */
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createDefaultHarvestSources,
  harvestInstalledCursorLogin,
  loadSqliteDatabaseSync,
  readInstalledCursorSources,
  windowsUsernameFromEnv,
} from '../src/harvest.ts'
import type { HarvestHost } from '../src/harvest.ts'
import { grantExpiryFromAccess } from '../src/grant.ts'

function jwt(expSeconds: number): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.x`
}

describe('windowsUsernameFromEnv', () => {
  it('reads USERPROFILE then USERNAME and skips public accounts', () => {
    expect(windowsUsernameFromEnv({ USERPROFILE: 'C:\\Users\\Ada' })).toBe('Ada')
    expect(windowsUsernameFromEnv({ USERNAME: 'Ada' })).toBe('Ada')
    expect(windowsUsernameFromEnv({ USERNAME: 'Public' })).toBeUndefined()
    expect(windowsUsernameFromEnv({ USERPROFILE: 'C:\\Users\\Public' })).toBeUndefined()
    expect(windowsUsernameFromEnv({ USERPROFILE: 'C:\\Users\\Default' })).toBeUndefined()
    expect(windowsUsernameFromEnv({ USERNAME: 'Default' })).toBeUndefined()
    expect(windowsUsernameFromEnv({ USERNAME: '.hidden' })).toBeUndefined()
    expect(windowsUsernameFromEnv({ USERPROFILE: 'C:\\Users\\.hidden' })).toBeUndefined()
    expect(windowsUsernameFromEnv({})).toBeUndefined()
  })
})

describe('readInstalledCursorSources', () => {
  it('reads Keychain on darwin and vscdb tokens', async () => {
    const host: HarvestHost = {
      platform: () => 'darwin',
      homedir: () => '/Users/ada',
      env: {},
      execFile: vi.fn(async (_file: string, args: string[]) => {
        if (args.includes('cursor-access-token')) return { stdout: ' keychain-at \n' }
        return { stdout: 'keychain-rt' }
      }),
      openSqlite: () => ({
        get: (sql: string) => sql.includes('accessToken') ? { value: 'vscdb-at' } : { value: 'vscdb-rt' },
        close: () => {},
      }),
    }
    const sources = await readInstalledCursorSources(host)
    expect(sources).toEqual([
      { accessToken: 'keychain-at', refreshToken: 'keychain-rt' },
      { accessToken: 'vscdb-at', refreshToken: 'vscdb-rt' },
    ])
  })

  it('skips Keychain off darwin and walks Windows, Linux, and WSL vscdb paths', async () => {
    const opened: string[] = []
    const linux: HarvestHost = {
      platform: () => 'linux',
      homedir: () => '/home/ada',
      env: { WSL_DISTRO_NAME: 'Ubuntu', USERPROFILE: 'C:\\Users\\Ada' },
      execFile: vi.fn(),
      exists: () => true,
      openSqlite: (path) => {
        opened.push(path)
        throw new Error('missing')
      },
    }
    expect(await readInstalledCursorSources(linux)).toEqual([])
    expect(opened.some(path => path.includes('.config/Cursor'))).toBe(true)
    expect(opened.some(path => path.includes('/mnt/c/Users/Ada'))).toBe(true)

    const win: HarvestHost = {
      platform: () => 'win32',
      homedir: () => 'C:\\Users\\ada',
      env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' },
      execFile: vi.fn(),
      openSqlite: () => ({
        get: () => ({ value: '  ' }),
        close: () => {},
      }),
    }
    expect(await readInstalledCursorSources(win)).toEqual([])

    const winNoAppData: HarvestHost = {
      platform: () => 'win32',
      homedir: () => 'C:\\Users\\ada',
      env: {},
      execFile: vi.fn(),
      openSqlite: () => {
        throw new Error('should not open a missing APPDATA path')
      },
    }
    expect(await readInstalledCursorSources(winNoAppData)).toEqual([])

    const wslNoUser: HarvestHost = {
      platform: () => 'linux',
      homedir: () => '/home/ada',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      execFile: vi.fn(),
      exists: () => true,
      openSqlite: () => {
        throw new Error('missing')
      },
    }
    expect(await readInstalledCursorSources(wslNoUser)).toEqual([])

    const darwinReject: HarvestHost = {
      platform: () => 'darwin',
      homedir: () => '/Users/ada',
      env: {},
      execFile: vi.fn(async () => {
        throw new Error('no item')
      }),
    }
    expect(await readInstalledCursorSources(darwinReject)).toEqual([])

    const accessOnlyKeychain: HarvestHost = {
      platform: () => 'darwin',
      homedir: () => '/Users/ada',
      env: {},
      execFile: vi.fn(async (_file: string, args: string[]) => {
        if (args.includes('cursor-access-token')) return { stdout: 'only-at' }
        throw new Error('no refresh')
      }),
    }
    expect(await readInstalledCursorSources(accessOnlyKeychain)).toEqual([{ accessToken: 'only-at' }])

    const refreshOnlyKeychain: HarvestHost = {
      platform: () => 'darwin',
      homedir: () => '/Users/ada',
      env: {},
      execFile: vi.fn(async (_file: string, args: string[]) => {
        if (args.includes('cursor-refresh-token')) return { stdout: 'only-rt' }
        throw new Error('no access')
      }),
    }
    expect(await readInstalledCursorSources(refreshOnlyKeychain)).toEqual([{ refreshToken: 'only-rt' }])

    let closed = 0
    const queryThrows: HarvestHost = {
      platform: () => 'linux',
      homedir: () => '/home/ada',
      env: {},
      execFile: vi.fn(),
      openSqlite: () => ({
        get: () => {
          throw new Error('query')
        },
        close: () => {
          closed += 1
        },
      }),
    }
    expect(await readInstalledCursorSources(queryThrows)).toEqual([])
    expect(closed).toBe(1)

    const openedNoExists: string[] = []
    const linuxDefaultExists: HarvestHost = {
      platform: () => 'linux',
      homedir: () => '/home/ada',
      env: {},
      execFile: vi.fn(),
      openSqlite: (path) => {
        openedNoExists.push(path)
        throw new Error('missing')
      },
    }
    expect(await readInstalledCursorSources(linuxDefaultExists)).toEqual([])
    expect(openedNoExists).toEqual([join('/home/ada', '.config/Cursor/User/globalStorage/state.vscdb')])

    const winAppData: string[] = []
    const winOpened: HarvestHost = {
      platform: () => 'win32',
      homedir: () => 'C:\\Users\\ada',
      env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' },
      execFile: vi.fn(),
      openSqlite: (path) => {
        winAppData.push(path)
        throw new Error('missing')
      },
    }
    expect(await readInstalledCursorSources(winOpened)).toEqual([])
    expect(winAppData).toEqual(['C:\\Users\\ada\\AppData\\Roaming/Cursor/User/globalStorage/state.vscdb'])

    const accessOnly: HarvestHost = {
      platform: () => 'linux',
      homedir: () => '/home/ada',
      env: {},
      execFile: vi.fn(),
      openSqlite: () => ({
        get: (sql: string) => sql.includes('accessToken') ? { value: 'only-at' } : undefined,
        close: () => {},
      }),
    }
    expect(await readInstalledCursorSources(accessOnly)).toEqual([{ accessToken: 'only-at' }])

    const twoRefresh: HarvestHost = {
      platform: () => 'linux',
      homedir: () => '/home/ada',
      env: { WSL_DISTRO_NAME: 'Ubuntu', USERPROFILE: 'C:\\Users\\Ada' },
      execFile: vi.fn(),
      exists: () => true,
      openSqlite: (path: string) => ({
        get: (sql: string) => {
          if (!sql.includes('refreshToken')) return undefined
          return { value: path.includes('/mnt/c/Users') ? 'second-rt' : 'first-rt' }
        },
        close: () => {},
      }),
    }
    expect(await readInstalledCursorSources(twoRefresh)).toEqual([{ refreshToken: 'first-rt' }])
  })

  it('omits empty Keychain values and walks WSL from the mount without env markers', async () => {
    const darwin: HarvestHost = {
      platform: () => 'darwin',
      homedir: () => '/Users/ada',
      env: {},
      execFile: vi.fn(async () => ({ stdout: '  \n' })),
    }
    expect(await readInstalledCursorSources(darwin)).toEqual([])

    const opened: string[] = []
    const linux: HarvestHost = {
      platform: () => 'linux',
      homedir: () => '/home/ada',
      env: { USERPROFILE: 'C:\\Users\\Ada' },
      execFile: vi.fn(),
      exists: path => path === '/mnt/c/Users',
      openSqlite: (path) => {
        opened.push(path)
        throw new Error('missing')
      },
    }
    expect(await readInstalledCursorSources(linux)).toEqual([])
    expect(opened.some(path => path.includes('/mnt/c/Users/Ada'))).toBe(true)
  })

  it('keeps a vscdb refresh token when access is missing', async () => {
    const host: HarvestHost = {
      platform: () => 'linux',
      homedir: () => '/home/ada',
      env: {},
      execFile: vi.fn(),
      openSqlite: () => ({
        get: (sql: string) => sql.includes('refreshToken') ? { value: 'only-rt' } : undefined,
        close: () => {},
      }),
    }
    expect(await readInstalledCursorSources(host)).toEqual([{ refreshToken: 'only-rt' }])
  })
})

describe('harvestInstalledCursorLogin', () => {
  it('returns a fresh access token and ignores harvest when disabled', async () => {
    const access = jwt(Math.floor(Date.now() / 1000) + 3600)
    await expect(harvestInstalledCursorLogin({
      enabled: false,
      readSources: () => Promise.resolve([{ accessToken: access }]),
      refresh: () => Promise.reject(new Error('no')),
    })).resolves.toBeUndefined()
    await expect(harvestInstalledCursorLogin({
      enabled: true,
      readSources: () => Promise.resolve([{ accessToken: access }]),
      refresh: () => Promise.reject(new Error('no')),
    })).resolves.toBe(access)
  })

  it('refreshes a stale source and skips a failed refresh', async () => {
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error('stale'))
      .mockResolvedValueOnce({ type: 'oauth', access: 'new', refresh: 'rt2', expires: Date.now() + 60_000 })
    await expect(harvestInstalledCursorLogin({
      enabled: true,
      readSources: () => Promise.resolve([{ refreshToken: 'bad' }, { refreshToken: 'good' }]),
      refresh,
    })).resolves.toBe('new')
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('refreshes a stale access token and skips a source with neither', async () => {
    const stale = jwt(Math.floor(Date.now() / 1000) - 3600)
    await expect(harvestInstalledCursorLogin({
      enabled: true,
      readSources: () => Promise.resolve([{ accessToken: stale }, { refreshToken: 'good' }]),
      refresh: () => Promise.resolve({ type: 'oauth', access: 'new', refresh: 'rt2', expires: Date.now() + 60_000 }),
    })).resolves.toBe('new')
  })

  it('returns undefined when every installed source fails', async () => {
    await expect(harvestInstalledCursorLogin({
      enabled: true,
      readSources: () => Promise.resolve([{ refreshToken: 'bad' }, {}]),
      refresh: () => Promise.reject(new Error('stale')),
    })).resolves.toBeUndefined()
  })
})

describe('production sqlite loader', () => {
  it('loads DatabaseSync on this Node', async () => {
    expect(await loadSqliteDatabaseSync()).toBeTypeOf('function')
    const sources = await (await createDefaultHarvestSources())()
    expect(Array.isArray(sources)).toBe(true)
  })
})

describe('grantExpiryFromAccess used by harvest freshness', () => {
  it('treats opaque tokens as short-lived', () => {
    const now = () => 10_000
    expect(grantExpiryFromAccess('opaque', now)).toBeGreaterThan(now())
    expect(grantExpiryFromAccess('opaque')).toBeGreaterThan(Date.now())
  })
})
