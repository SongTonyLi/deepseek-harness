/** The Agent Teams indicators on the main page: the header trail and the spinning team glyph. */
import type {} from '@deepseek-ai/dsh-agent-team'
import { describe, expect, it } from 'vitest'
import { FADE_TICK_MS } from '../src/fade.ts'
import { BENCH_SPINNER_MS, bench } from './bench.ts'
import { listed, provideTeam } from './team-bench.ts'

const HEADER_TRAIL = '· ✦ team · /team-play · /help'

describe('the header', () => {
  it('names the team and its room while Team mode is on', async () => {
    const test = await bench({ before(ctx) { provideTeam(ctx) } })
    expect(await test.screen()).toContain(HEADER_TRAIL)
  })

  it('keeps the plain help trail while Team mode is off', async () => {
    const test = await bench({ before(ctx) { provideTeam(ctx).enabled = false } })
    const screen = await test.screen()
    expect(screen).toContain('· /help for commands')
    expect(screen).not.toContain('✦ team')
  })
})

describe('an empty session when Team mode is switched on', () => {
  it('shows the header trail with no start card and no entrance tick', async () => {
    let mode = { enabled: true }
    const test = await bench({ color: true, before(ctx) { mode = provideTeam(ctx); mode.enabled = false } })
    expect(await test.screen()).toContain('· /help for commands')
    mode.enabled = true
    test.session.append('team/mode', { enabled: true })
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain(HEADER_TRAIL)
    expect(screen).not.toContain('The lead splits the work')
    expect(screen).not.toContain('◆ ─┬─')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })
})

describe('the team glyph on the summary line', () => {
  it('spins while a teammate runs and rests once none does', async () => {
    const test = await bench({ before(ctx) { provideTeam(ctx, () => [listed('session-ada', 'Ada')]) } })
    const ada = await test.createChild({ id: 'session-ada' })
    ada.setStatus('running')
    await test.settle()
    expect(await test.screen()).toContain('✦ team · 1 teammate · working: Ada')
    expect(test.tickArmed(BENCH_SPINNER_MS)).toBe(true)
    test.runTick(BENCH_SPINNER_MS)
    await test.settle()
    expect(await test.screen()).toContain('✣ team · 1 teammate · working: Ada')
    ada.setStatus('idle')
    await test.settle()
    expect(await test.screen()).toContain('✦ team · 1 teammate · tasks')
    expect(test.tickArmed(BENCH_SPINNER_MS)).toBe(false)
  })

  it('rests under reduced motion', async () => {
    const test = await bench({ reducedMotion: true, before(ctx) { provideTeam(ctx, () => [listed('session-ada', 'Ada')]) } })
    const ada = await test.createChild({ id: 'session-ada' })
    ada.setStatus('running')
    await test.settle()
    test.runTick(BENCH_SPINNER_MS)
    await test.settle()
    expect(await test.screen()).toContain('✦ team · 1 teammate · working: Ada')
    expect(test.tickArmed(BENCH_SPINNER_MS)).toBe(false)
  })
})
