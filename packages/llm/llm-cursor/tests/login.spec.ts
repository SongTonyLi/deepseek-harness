/** Authorization flow commit and catalog-refresh containment. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationInteraction, AuthorizationNotice } from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { registerCursorFlow } from '../src/login.ts'
import { CURSOR_RECORD_KEY } from '../src/token.ts'
import { parseCursorGrant } from '../src/grant.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function harness(oauth: Parameters<typeof registerCursorFlow>[1], onAuthorized?: () => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cursor-login-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  registerCursorFlow(ctx, oauth, onAuthorized)
  return ctx
}

function surface(): AuthorizationInteraction & { notices: AuthorizationNotice[] } {
  const notices: AuthorizationNotice[] = []
  return {
    notices,
    notify: (notice) => { notices.push(notice) },
    prompt: () => Promise.resolve(''),
  }
}

describe('registerCursorFlow', () => {
  it('notifies the PKCE URL, commits the grant, and lists the oauth method', async () => {
    const ctx = await harness({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        accessToken: 'at',
        refreshToken: 'rt',
      }), { status: 200 })),
      sleep: () => Promise.resolve(),
      randomUUID: () => 'uuid',
      generatePkce: () => Promise.resolve({ verifier: 'v', challenge: 'c' }),
    })
    const listed = ctx.authorization.list()
    expect(listed.some(flow => flow.key === CURSOR_RECORD_KEY && flow.methods[0]?.id === 'oauth')).toBe(true)
    const ui = surface()
    await expect(ctx.authorization.begin({ key: CURSOR_RECORD_KEY, interaction: ui }))
      .resolves.toEqual({ status: 'authorized' })
    expect(ui.notices[0]?.url).toContain('loginDeepControl')
    expect(ui.notices[0]?.openInBrowser).toBe(true)
    const stored = await ctx.credentials.readRecord(CURSOR_RECORD_KEY)
    expect(parseCursorGrant(stored?.kind === 'grant' ? stored.payload : undefined)?.access).toBe('at')
  })

  it('does not fail the attempt when catalog refresh throws', async () => {
    const ctx = await harness({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        accessToken: 'at',
        refreshToken: 'rt',
      }), { status: 200 })),
      sleep: () => Promise.resolve(),
    }, () => Promise.reject(new Error('catalog down')))
    await expect(ctx.authorization.begin({ key: CURSOR_RECORD_KEY, interaction: surface() }))
      .resolves.toEqual({ status: 'authorized' })
  })

  it('fails the attempt when the credentials service is absent', async () => {
    const ctx = new Context()
    let run: ((session: {
      method: string
      signal: AbortSignal
      notify: (notice: AuthorizationNotice) => void
      prompt: () => Promise<string>
    }) => Promise<void>) | undefined
    Object.assign(ctx, {
      authorization: {
        registerFlow(flow: { run: NonNullable<typeof run> }) {
          run = flow.run
          return () => {}
        },
      },
    })
    registerCursorFlow(ctx, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        accessToken: 'at',
        refreshToken: 'rt',
      }), { status: 200 })),
      sleep: () => Promise.resolve(),
    })
    await expect(run!({
      method: 'oauth',
      signal: new AbortController().signal,
      notify: () => {},
      prompt: () => Promise.resolve(''),
    })).rejects.toThrow(/credentials service/)
  })
})
