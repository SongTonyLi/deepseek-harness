/** The Agent Teams indicators on the main page: the header trail, the start card's entrance, and the spinning team glyph. */
import type {} from '@deepseek-ai/dsh-agent-team'
import { describe, expect, it } from 'vitest'
import { FADE_TICK_MS } from '../src/fade.ts'
import { TEAM_INTRO_LAST_STEP, TEAM_INTRO_SENTENCE } from '../src/team-intro.ts'
import { BENCH_SPINNER_MS, bench, type Bench } from './bench.ts'
import { listed, provideTeam } from './team-bench.ts'

const HEADER_TRAIL = '· ✦ team · /team-play · /help'

const SETTLED_FIGURE = '◆ ─┬─ ●'

/** Run the fade tick through the whole entrance, one spinner period per run, then once more so the registry drops the card. */
async function playEntrance(test: Bench): Promise<void> {
  for (let step = 0; step < TEAM_INTRO_LAST_STEP; step += 1) test.runTick(FADE_TICK_MS, BENCH_SPINNER_MS)
  test.runTick(FADE_TICK_MS)
  await test.settle()
}

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

describe('the start card entrance', () => {
  it('starts from the lead alone and settles on the full card, then stops the fade tick', async () => {
    const test = await bench({ color: true, before(ctx) { provideTeam(ctx) } })
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)
    const first = await test.screen()
    expect(first).toContain('◆')
    expect(first).not.toContain(TEAM_INTRO_SENTENCE)
    await playEntrance(test)
    const settled = await test.screen()
    expect(settled).toContain(SETTLED_FIGURE)
    expect(settled).toContain(TEAM_INTRO_SENTENCE)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('draws the settled card at once under reduced motion', async () => {
    const test = await bench({ color: true, reducedMotion: true, before(ctx) { provideTeam(ctx) } })
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
    const screen = await test.screen()
    expect(screen).toContain(SETTLED_FIGURE)
    expect(screen).toContain(TEAM_INTRO_SENTENCE)
  })

  it('settles at once when the card sits above the repaint window', async () => {
    const test = await bench({ color: true, before(ctx) { provideTeam(ctx) } })
    test.terminal.rows = 4
    test.runTick(FADE_TICK_MS, 1)
    await test.settle()
    test.runTick(FADE_TICK_MS, 1)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
    expect(await test.screen()).toContain(TEAM_INTRO_SENTENCE)
  })

  it('plays again from the lead when Team mode is switched back on', async () => {
    const test = await bench({ color: true, before(ctx) { provideTeam(ctx) } })
    for (let step = 0; step < 4; step += 1) test.runTick(FADE_TICK_MS, BENCH_SPINNER_MS)
    expect(await test.screen()).toContain(TEAM_INTRO_SENTENCE)
    test.session.append('team/mode', { enabled: true })
    await test.settle()
    expect(await test.screen()).not.toContain(TEAM_INTRO_SENTENCE)
    await playEntrance(test)
    expect(await test.screen()).toContain(TEAM_INTRO_SENTENCE)
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
