/** Team rows reuse the subagent catalog without duplicating child activity. */
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { KEY, bench } from './bench.ts'
import { listed, provideTeam } from './team-bench.ts'

it('draws a continuable teammate once and keeps one-shot children in the subagent panel', async () => {
  const test = await bench({ before(ctx) { provideTeam(ctx, () => [listed('session-ada', 'Ada'), listed('session-kid', 'explorer', 'one-shot')]) } })
  const ada = await test.createChild({ id: 'session-ada' })
  const kid = await test.createChild({ id: 'session-kid' })
  test.ctx.emit('subagent/start', { runId: 'run-kid', provider: 'test', id: kid.id, local: true } as never)
  kid.setStatus('running')
  test.tick(0)
  await test.settle()
  ada.setStatus('running')
  ada.session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'Checking the lockfile.' }], source: { provider: 'test-provider', model: 'test-model' } }),
  }, { surfaceOp: 'append' })
  const screen = await test.screen()
  expect(screen).toContain('team · 1 teammate · working: Ada')
  expect(screen).toContain('Ada · teammate › Checking the lockfile.')
  expect(screen).toContain('subagents · 1 listed · explorer')
  expect(screen.match(/^\s*\S Ada · /gmu)).toHaveLength(1)
})

it('leaves continuable children in the subagent panel while Team mode is off', async () => {
  const test = await bench({ before(ctx) { provideTeam(ctx, () => [listed('session-ada', 'Ada')]).enabled = false } })
  const ada = await test.createChild({ id: 'session-ada' })
  test.ctx.emit('subagent/start', { runId: 'run-ada', provider: 'test', id: ada.id, local: true } as never)
  ada.setStatus('running')
  test.tick(0)
  await test.settle()
  expect(await test.screen()).toContain('subagents · 1 listed · Ada')
  expect(await test.screen()).not.toContain('team ·')
})

describe('teammate navigation', () => {
  it('uses the durable child label in the title and returns to the root', async () => {
    const test = await bench({ before(ctx) { provideTeam(ctx, () => [listed('session-ada', 'Ada')]) } })
    await test.createChild({ id: 'session-ada' })
    for (const char of '/team') test.terminal.type(char)
    test.terminal.type(KEY.enter)
    await test.settle()
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(await test.screen()).toContain('◆ teammate Ada · teammate')
    test.terminal.type('\u0010')
    await test.settle()
    expect(await test.screen()).toContain('✦ team · /team-play · /help')
    expect(await test.screen()).not.toContain('◆ teammate')
  })
})
