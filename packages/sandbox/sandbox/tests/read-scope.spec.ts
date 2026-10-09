/** Read-scope helpers and the seam's default unconfined read scope. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider, isReadableIn, nameGlobMatcher } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('nameGlobMatcher', () => {
  it('matches whole names with star wildcards, ignoring case', () => {
    expect(nameGlobMatcher(['.env'])('.env')).toBe(true)
    expect(nameGlobMatcher(['.env.*'])('.env.local')).toBe(true)
    expect(nameGlobMatcher(['id_rsa*'])('ID_RSA.pub')).toBe(true)
    expect(nameGlobMatcher(['.env'])('xenv')).toBe(false)
    expect(nameGlobMatcher(['a+b(1)'])('a+b(1)')).toBe(true)
  })

  it('matches any of several globs without one glob leaking into another', () => {
    const matches = nameGlobMatcher(['.env', '*.pem', 'a|b'])
    expect(matches('cert.PEM')).toBe(true)
    expect(matches('.env')).toBe(true)
    expect(matches('a|b')).toBe(true)
    expect(matches('.env.pem.x')).toBe(false)
    expect(matches('a')).toBe(false)
  })

  it('matches nothing without globs', () => {
    expect(nameGlobMatcher([])('')).toBe(false)
    expect(nameGlobMatcher([])('.env')).toBe(false)
  })
})

describe('isReadableIn', () => {
  it('contains paths canonically and refuses hidden names', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-read-scope-')))
    dirs.push(root)
    mkdirSync(join(root, 'ws'))
    symlinkSync('/etc', join(root, 'ws', 'escape'))
    const scope = { roots: [join(root, 'ws')], hiddenNames: ['.env'] }
    expect(isReadableIn(join(root, 'ws', 'src', 'new.ts'), scope)).toBe(true)
    expect(isReadableIn(join(root, 'ws'), scope)).toBe(true)
    expect(isReadableIn(join(root, 'ws', 'missing', '..', '..', 'other'), scope)).toBe(false)
    expect(isReadableIn(join(root, 'ws', 'escape', 'passwd'), scope)).toBe(false)
    expect(isReadableIn(join(root, 'wsx'), scope)).toBe(false)
    expect(isReadableIn(join(root, 'ws', '.ENV'), scope)).toBe(false)
    expect(isReadableIn('/etc/hosts', { roots: ['/'], hiddenNames: [] })).toBe(true)
  })
})

describe('SandboxProvider.readScope', () => {
  it('confines no reads by default', async () => {
    class Passthrough extends SandboxProvider {
      confine(argv: readonly string[]): Promise<ConfinedArgv> {
        return Promise.resolve({ argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
      }
    }
    const ctx = new Context()
    await ctx.plugin(Passthrough)
    expect(ctx.sandbox.readScope({ mode: 'read-only', workspaceRoot: '/ws' })).toBeUndefined()
    expect(ctx.sandbox.escalationNote({ mode: 'read-only', workspaceRoot: '/ws' }, 'danger-full-access')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
