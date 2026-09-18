import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmCursor from '@deepseek-ai/dsh-llm-cursor'
import { assemble } from './assemble.ts'

/**
 * Real-API e2e for the Cursor adapter. Key-gated on CURSOR_ACCESS_TOKEN so CI
 * without a Cursor subscription skips the suite.
 */

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe.skipIf(!process.env.CURSOR_ACCESS_TOKEN)('llm-cursor e2e (real API)', () => {
  it('streams a short text reply through the unofficial agent Run', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmCursor, { reuseInstalledCursorLogin: false })
    const result = await assemble(ctx, {
      model: 'composer-2-fast',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Reply with exactly the word: pong' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    const text = result.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(text.toLowerCase()).toContain('pong')
  })
})
