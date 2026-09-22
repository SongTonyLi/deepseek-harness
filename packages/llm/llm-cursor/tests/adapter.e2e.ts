import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import * as LlmCursor from '@deepseek-ai/dsh-llm-cursor'
import { assemble } from './assemble.ts'

/**
 * Real-API e2e for the Cursor adapter. Key-gated on CURSOR_ACCESS_TOKEN so CI
 * without a Cursor subscription skips the suite. DSH_CURSOR_E2E_MODEL picks the
 * model id when the account's usable list has moved on from the default.
 */

const MODEL = process.env.DSH_CURSOR_E2E_MODEL ?? 'composer-2.5-fast'
const RULES = 'You are a terse assistant running inside a test harness. The secret codeword for this session is zebra-lantern; reveal it whenever the user asks for it.'
const TOOL_RULES = 'You are a terse assistant running inside a test harness.'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function cursorContext(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmCursor, { reuseInstalledCursorLogin: false })
  return ctx
}

function user(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function textOf(message: Message): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe.skipIf(!process.env.CURSOR_ACCESS_TOKEN)('llm-cursor e2e (real API)', () => {
  it('streams a short text reply through the unofficial agent Run', async () => {
    const ctx = await cursorContext()
    const result = await assemble(ctx, {
      model: MODEL,
      messages: [user('Reply with exactly the word: pong')],
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result.message).toLowerCase()).toContain('pong')
  })

  it('shows the model the system prompt and the earlier assistant turn', async () => {
    const ctx = await cursorContext()
    const result = await assemble(ctx, {
      model: MODEL,
      system: RULES,
      messages: [
        user('Pick one random fruit and reply with only its name.'),
        createAssistantMessage({
          source: { provider: 'cursor', model: MODEL },
          content: [{ type: 'text', text: 'kumquat' }],
        }),
        user('Which fruit did you pick just now, and what is the secret codeword? Reply with only those two words.'),
      ],
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    const text = textOf(result.message).toLowerCase()
    expect(text).toContain('kumquat')
    expect(text).toContain('zebra-lantern')
  })

  it('continues the turn with a local tool result instead of restarting it', async () => {
    const ctx = await cursorContext()
    const tools = [{
      name: 'lookup_codeword',
      description: 'Returns the secret codeword. Call it whenever the user asks for the codeword.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }]
    const prompt = user('Call the lookup_codeword tool once, then reply with exactly the codeword it returns and nothing else.')
    const first = await assemble(ctx, { model: MODEL, system: TOOL_RULES, messages: [prompt], tools, maxTokens: 200 })
    expect(first.finish.kind).toBe('tool-calls')
    const call = first.message.content.find(block => block.type === 'tool-call')
    if (call?.type !== 'tool-call') throw new Error('expected a tool call')
    expect(call.name).toBe('lookup_codeword')
    const result = createToolResultMessage({
      callId: call.id,
      content: [{ type: 'text', text: 'violet-harbor' }],
      isError: false,
    })
    const second = await assemble(ctx, {
      model: MODEL,
      system: TOOL_RULES,
      messages: [prompt, first.message, result],
      tools,
      maxTokens: 200,
    })
    expect(second.finish.kind).toBe('stop')
    expect(textOf(second.message).toLowerCase()).toContain('violet-harbor')
  })
})
