/** `/btw` answers on the alternate screen and does not enter the agent loop. */

import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { KEY, bench } from './bench.ts'

function typeLine(terminal: { type(data: string): void }, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

function scriptedStream(chunks: readonly StreamChunk[]): (options: GenerateOptions) => AsyncIterable<StreamChunk> {
  return function stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    return (async function* () {
      yield * chunks
    })()
  }
}

const seen: GenerateOptions[] = []

describe('/btw', () => {
  it('shows the answer on its own page and leaves the agent and the session log alone', async () => {
    seen.length = 0
    const test = await bench({
      before: (ctx) => {
        ctx.provide('llm', { stream: scriptedStream([
          { type: 'text-delta', index: 0, text: 'side answer' },
          { type: 'finish', reason: { kind: 'stop' } },
        ]) } as never)
      },
    })
    const logged = test.session.snapshotEvents().length
    test.appendPrompt('the task')
    typeLine(test.terminal, '/btw what is the task')
    await test.settle()
    expect(test.calls.followups).toEqual([])
    expect(test.calls.steers).toEqual([])
    expect(test.calls.injections).toEqual([])
    expect(test.calls.cancels).toBe(0)
    expect(test.session.snapshotEvents().length).toBe(logged + 1)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.tools).toBeUndefined()
    expect(seen[0]?.system).toContain('side question')
    expect(seen[0]?.messages.some(message => message.role === 'user' && JSON.stringify(message).includes('what is the task'))).toBe(true)
    const page = await test.screen()
    expect(page).toContain('side answer')
    expect(page).toContain('what is the task')
    test.terminal.type(KEY.escape)
    await test.settle()
    const restored = await test.screen()
    expect(restored).not.toContain('side answer')
    expect(restored).toContain('the task')
  })

  it('does not run a tool call from the side answer', async () => {
    seen.length = 0
    const test = await bench({
      running: true,
      before: (ctx) => {
        ctx.provide('llm', { stream: scriptedStream([
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ]) } as never)
      },
    })
    typeLine(test.terminal, '/btw run a tool')
    await test.settle()
    expect(test.calls.cancels).toBe(0)
    expect(test.calls.followups).toEqual([])
    expect(await test.screen()).toContain('does not run tools')
  })

  it('rejects an empty question before calling the model', async () => {
    seen.length = 0
    const test = await bench({
      before: (ctx) => {
        ctx.provide('llm', { stream: scriptedStream([]) } as never)
      },
    })
    typeLine(test.terminal, '/btw')
    await test.settle()
    expect(seen).toHaveLength(0)
    expect(test.terminal.text()).toContain('usage: /btw <question>')
  })
})
