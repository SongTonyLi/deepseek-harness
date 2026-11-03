/** Failed-turn recovery across real pi-ai Anthropic and OpenAI transports, with local provider stand-ins. */
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'

afterEach(() => { vi.unstubAllEnvs() })

const CHECKPOINT = 'Goal KEEP_GOAL. Decision KEEP_DECISION. Tool completed KEEP_TOOL. Next KEEP_NEXT.'

async function destinationServer(failSummary: boolean) {
  const requests: Record<string, unknown>[] = []
  let rejectSummary = failSummary
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      requests.push(body)
      const summary = JSON.stringify(body).includes('You are now acting as a compaction engine')
      if (summary && rejectSummary) {
        rejectSummary = false
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'destination quota exceeded', type: 'rate_limit_error' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const content = summary ? CHECKPOINT : 'CONTINUED KEEP_NEXT'
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  onTestFinished(() => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('destination did not bind TCP')
  return { requests, url: `http://127.0.0.1:${address.port}/v1` }
}

describe('pi-ai to pi-ai recovery after a failed turn', () => {
  it.each(['history', 'automatic summary', 'manual summary', 'failed summary then retry'] as const)(
    'preserves task and tool context through %s',
    async (mode) => {
      const source = await startMockLlmServer({
        sequence: ['tool_call_success', 'success', 'rate_limit'],
        repeatLast: true,
        successText: 'Decision KEEP_DECISION. Next KEEP_NEXT.',
        toolName: 'remember', toolArguments: '{}',
      })
      onTestFinished(() => source.close())
      const destination = await destinationServer(mode === 'failed summary then retry')
      vi.stubEnv('PI_SWITCH_KEY', 'fixture-key')
      const ctx = new Context()
      onTestFinished(() => ctx.fiber.dispose())
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(LlmPiAi, { providers: {
        anthropic: {
          apiKeyEnv: 'PI_SWITCH_KEY', baseURL: source.baseURL,
          models: [{ id: 'claude-sonnet-4-5', contextWindow: 100_000, maxTokens: 1024 }],
        },
        openai: {
          apiKeyEnv: 'PI_SWITCH_KEY', baseURL: destination.url, api: 'openai-completions',
          models: [{ id: 'gpt-4.1', contextWindow: 100_000, maxTokens: 1024 }],
        },
      } })
      await ctx.plugin(TokenMeter)
      const fiber = await ctx.plugin(BasicCompactionEngine, {
        headroomTokens: 0, maxTokens: 256, retainTokens: 20,
        modelPolicies: [{ provider: 'openai', model: 'gpt-4.1', thresholdRatio: mode === 'history' ? 0.8 : 0.005 }],
      })
      const compact = fiber.ctx.compaction as BasicCompactionEngine
      ctx.systemPrompt.section({ name: 'switch-test', order: 0, text: 'Keep KEEP_SYSTEM and the existing task decisions.' })
      ctx.effect(() => ctx.tools.register(defineContentToolFixture({
        name: 'remember', description: 'Remember the completed work', parameters: {},
        isConcurrencySafe: () => true,
        async execute() { return [{ type: 'text', text: 'KEEP_TOOL' }] },
      })))
      const loop = await mountAgentLoopTestHarness(ctx)
      const agent = await loop.create(SessionId(`pi-switch-${mode}`), { provider: 'anthropic', model: 'claude-sonnet-4-5' })
      const send = async (text: string) => {
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
        await agent.whenIdle()
      }
      await send(`Goal KEEP_GOAL. ${'older task detail '.repeat(500)}`)
      await send('KEEP_FAILED_INPUT: continue the current task.')
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({
        data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } },
      })
      const original = structuredClone(agent.session.snapshotEvents())
      const previous = agent.session.requestHeader()
      const sourceRequests = source.requests.length
      expect(sourceRequests).toBe(3)
      agent.model.select({ provider: 'openai', model: 'gpt-4.1' })

      if (mode === 'manual summary') {
        expect(await compact.compactNow(agent, new AbortController().signal)).not.toBeNull()
      }
      if (mode === 'failed summary then retry') {
        await send('Retry KEEP_NEXT.')
        expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({
          data: { reason: { kind: 'error', error: { code: 'MODEL_SWITCH_COMPACTION_FAILED' } } },
        })
        expect(agent.session.requestHeader()).toEqual(previous)
        expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
      }
      await send('Continue KEEP_NEXT without repeating completed work.')
      const finalReason = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason
      expect(finalReason, JSON.stringify(finalReason)).toMatchObject({ kind: 'completed' })
      expect(agent.session.requestHeader()?.config).toMatchObject({ provider: 'openai', model: 'gpt-4.1' })
      expect(source.requests).toHaveLength(sourceRequests)
      expect(agent.session.snapshotEvents().slice(0, original.length)).toEqual(original)
      const firstInput = JSON.stringify(destination.requests[0])
      for (const marker of ['KEEP_SYSTEM', 'KEEP_GOAL', 'KEEP_DECISION', 'KEEP_TOOL']) expect(firstInput).toContain(marker)
      if (mode === 'history') {
        const messages = destination.requests[0]?.messages as Record<string, unknown>[]
        expect(messages.find(message => message.role === 'tool')?.content).toContain('KEEP_TOOL')
        const toolCalls = messages.find(message => message.tool_calls !== undefined)?.tool_calls
        expect(toolCalls).toEqual([{ id: expect.any(String) as string, type: 'function', function: { name: 'remember', arguments: '{}' } }])
      }
      const finalInput = JSON.stringify(destination.requests.at(-1))
      for (const marker of ['KEEP_SYSTEM', 'KEEP_GOAL', 'KEEP_DECISION', 'KEEP_TOOL', 'KEEP_NEXT', 'KEEP_FAILED_INPUT']) {
        expect(finalInput).toContain(marker)
      }
      const summaries = agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')
      expect(summaries).toHaveLength(mode === 'history' ? 0 : 1)
      if (summaries.length > 0) expect(summaries[0]?.data).toMatchObject({ provider: 'openai', model: 'gpt-4.1' })
      expect(destination.requests).toHaveLength(mode === 'history' ? 1 : mode === 'failed summary then retry' ? 3 : 2)
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')?.data.message.content)
        .toContainEqual({ type: 'text', text: 'CONTINUED KEEP_NEXT' })
    },
  )
})
