/**
 * `/context` in the terminal: the report over the bound session's measured
 * surface, its open animation and live re-reads on the fade tick, and the
 * settled report a newer `/context` or a terminal without motion draws.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createSystemMessage, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { FADE_TICK_MS } from '../src/fade.ts'
import { KEY, bench } from './bench.ts'
import { testContextSource } from './message-sources.ts'

function typeLine(terminal: { type(data: string): void }, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

/** A system prompt, an instruction file, and one completed turn, as the loop logs them. */
function history(session: Session): void {
  session.append('system/message', { turn: 0, step: 1, message: createSystemMessage('You are the agent. '.repeat(40)) }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: text('# AGENTS.md\n'.repeat(30)),
    source: testContextSource({ form: 'instructions' }),
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: text('Fix the lexer'), source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({ content: text('Done. '.repeat(50)), source: { provider: 'test-provider', model: 'test-model' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/**
 * The hot-region count the newest report on screen draws.
 * @param screen - one complete frame.
 * @returns the tokens the hot row names.
 */
function hotTokens(screen: string): number {
  const counts = [...screen.matchAll(/hot: \+(\d+) tokens in turn/gu)].map(match => Number(match[1]))
  return counts.at(-1) ?? 0
}

describe('/context', () => {
  it('reports the measured surface by category, with the newest turn as the hot region', async () => {
    const test = await bench({ before: async (ctx) => { await ctx.plugin(TokenMeter) } })
    history(test.session)
    typeLine(test.terminal, '/context')
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain('Context usage')
    expect(screen).toContain('test-provider/test-model')
    expect(screen).toContain('window not reported yet')
    expect(screen).toMatch(/System prompt: \d+ tokens/u)
    expect(screen).toMatch(/Instructions: \d+ tokens/u)
    expect(screen).toMatch(/▲ hot: \+\d+ tokens in turn 1/u)
    expect(screen).toContain('Skills: 0 tokens')
    // A terminal without motion draws the settled report and arms nothing.
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('animates on a terminal with motion, re-reads while a turn runs, and settles once it ends', async () => {
    const test = await bench({ color: true, background: 'rgb:0000/0000/0000', before: async (ctx) => { await ctx.plugin(TokenMeter) } })
    await test.settle()
    history(test.session)
    test.session.append('turn/start', { turn: 2 })
    test.session.append('user/message', createUserMessage({ content: text('Now the parser'), source: { kind: 'user' } }), { surfaceOp: 'append' })
    typeLine(test.terminal, '/context')
    await test.settle()
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)
    test.runTick(FADE_TICK_MS, 1000)
    await test.settle()
    const live = await test.screen()
    expect(live).toContain(' · live')

    test.session.append('step/start', { turn: 2, step: 1 })
    test.session.append('assistant/message', {
      stream: [],
      turn: 2,
      step: 1,
      message: createAssistantMessage({ content: text('Parsed. '.repeat(30)), source: { provider: 'test-provider', model: 'test-model' } }),
    }, { surfaceOp: 'append' })
    test.runTick(FADE_TICK_MS, 300)
    await test.settle()
    // The reply landed after the block opened, and the re-read counts it.
    expect(hotTokens(await test.screen())).toBeGreaterThan(hotTokens(live))

    test.session.append('step/end', { turn: 2, step: 1 })
    test.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    test.runTick(FADE_TICK_MS, 4000)
    await test.settle()
    const settled = await test.screen()
    expect(settled).not.toContain(' · live')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('settles the previous report when another one opens', async () => {
    const test = await bench({ color: true, background: 'rgb:0000/0000/0000', before: async (ctx) => { await ctx.plugin(TokenMeter) } })
    await test.settle()
    history(test.session)
    typeLine(test.terminal, '/context')
    await test.settle()
    typeLine(test.terminal, '/context')
    await test.settle()
    test.runTick(FADE_TICK_MS, 4000)
    await test.settle()
    expect((await test.screen()).match(/Context usage/gu)).toHaveLength(2)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('names the missing token meter', async () => {
    const test = await bench()
    typeLine(test.terminal, '/context')
    await test.settle()
    expect(await test.screen()).toContain('/context needs the token meter in this composition')
  })
})

/**
 * A token meter that prices every surface node at 100 tokens, for compositions
 * without the projection registry the real meter injects.
 * @param ctx - the bench context.
 */
function flatMeter(ctx: Context): void {
  ctx.provide('tokenMeter', {
    measure: (session: Session) => ({ nodes: session.surface.nodes.map(seq => ({ seq, tokens: 100, heuristicTokens: 100 })) }),
  } as never)
}

describe('/context occupancy', () => {
  it('reads the occupancy and the tool definitions from the session projections', async () => {
    const test = await bench({
      projections: {
        snapshot: () => ({
          asOfSeq: 1,
          values: {
            contextPressure: { projectedTokens: 54_000, pressureTokens: 50_000, contextWindow: 128_000 },
            contextBreakdown: { systemTokens: 0, toolsTokens: 3000, messageTokens: 0 },
          },
        }),
        onChanged: () => () => {},
      },
      before: flatMeter,
    })
    history(test.session)
    typeLine(test.terminal, '/context')
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain('54k/128k tokens (42%)')
    expect(screen).toContain('System tools: 3k tokens (2.3%)')
    expect(screen).toContain('Messages: 200 tokens (0.2%)')
  })

  it('takes the window the latest request recorded when no projection reports one', async () => {
    const test = await bench({ projections: 'none', before: flatMeter })
    history(test.session)
    test.session.append('request/context', { provider: 'test-provider', model: 'test-model', contextWindow: 200_000 })
    typeLine(test.terminal, '/context')
    await test.settle()
    expect(await test.screen()).toContain('400/200k tokens (0%)')
  })
})
