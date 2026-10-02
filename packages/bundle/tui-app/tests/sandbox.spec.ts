/** Backend previews follow focus without changing the session choice. */
import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SandboxPrompt } from '../src/sandbox.ts'
import { createPalette } from '../src/style.ts'

const palette = createPalette(false)
const session = Session.create(SessionId('sandbox-picker'))
const provider = { containerSupported: true, backendFor: () => 'container' as const }
const policy = { mode: 'workspace-write' as const, workspaceRoot: '/work/project' }
const text = (prompt: SandboxPrompt): string => prompt.render(100).join('\n')

describe('sandbox backend picker', () => {
  it('opens on the current backend and previews local access when focus moves', async () => {
    const prompt = new SandboxPrompt(palette, provider, session, policy)
    expect(text(prompt)).toContain('Container ✓')
    expect(text(prompt)).toContain('Commands → Linux container → shared workspace')
    expect(text(prompt)).toContain('other host paths and configured secret-file patterns hidden')
    expect(text(prompt)).toContain('/work/project')
    prompt.handleInput('\u001b[B')
    expect(text(prompt)).toContain('Access preview · Local')
    expect(text(prompt)).toContain('Commands → host → native file sandbox')
    expect(text(prompt)).toContain('host paths (subject to OS permissions)')
    expect(text(prompt)).not.toContain('secret-file patterns hidden')
    expect(session.seq).toBe(0)
    prompt.handleInput('\r')
    await expect(prompt.settled).resolves.toMatchObject({ value: 'local' })
    expect(session.seq).toBe(0)
  })

  it('explains unavailable containers and keeps the choice on cancellation', async () => {
    const prompt = new SandboxPrompt(palette, { containerSupported: false, backendFor: () => 'local' }, session, policy)
    expect(text(prompt)).toContain('Container unavailable:')
    expect(text(prompt)).toContain('Local ✓')
    prompt.handleInput('\u001b')
    await expect(prompt.settled).resolves.toBeUndefined()
  })

  it('distinguishes blocked writes from a bypassed sandbox for both backends', () => {
    const readonly = new SandboxPrompt(palette, provider, session, { ...policy, mode: 'read-only' })
    expect(text(readonly)).toContain('BLOCKED · file modifications')
    const full = new SandboxPrompt(palette, provider, session, { ...policy, mode: 'danger-full-access' })
    expect(text(full)).toContain('Sandbox bypassed: commands run on the host, regardless of backend choice.')
    expect(text(full)).toContain('UNRESTRICTED · host file modifications')
    expect(text(full)).not.toContain('secret-file patterns hidden')
    full.handleInput('\u001b[B')
    expect(text(full)).toContain('Sandbox bypassed:')
  })

  it('filters choices, hides unmatched previews, and wraps at narrow widths', () => {
    const prompt = new SandboxPrompt(palette, provider, session, policy)
    prompt.handleInput('local')
    expect(text(prompt)).toContain('Access preview · Local')
    prompt.handleInput('zzzz')
    expect(text(prompt)).toContain('no row matches')
    expect(text(prompt)).not.toContain('Access preview')
    prompt.handleInput('\u001b')
    expect(text(prompt)).toContain('Access preview · Container')
    for (const width of [20, 40, 80]) {
      expect(prompt.render(width).every(line => visibleWidth(line) <= width)).toBe(true)
    }
    prompt.invalidate()
    prompt.withdraw()
  })
})
