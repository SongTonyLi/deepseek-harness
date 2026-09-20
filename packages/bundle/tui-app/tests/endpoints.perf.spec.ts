/**
 * Threshold-free diagnostics for the TUI performance cards. They report
 * shares and counts; they do not fail on wall-clock. Cards A and B as a
 * built `dsh --profile tui` child stay behind `DSH_TUI_PERF_CHILD=1`.
 */

import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AssistantBlock, type BlockTheme } from '../src/blocks.ts'
import { createPalette, type CodeHighlighter } from '../src/style.ts'
import { bench } from './bench.ts'

const theme: BlockTheme = { palette: createPalette(false), toolPreviewLines: 2, contextPreviewLines: 4 }
const CHILD = process.env.DSH_TUI_PERF_CHILD === '1'

/**
 * A highlighter that counts every colour request.
 * @returns the highlighter and the count it keeps.
 */
function countingHighlighter(): { highlight: CodeHighlighter; counter: { calls: number } } {
  const counter = { calls: 0 }
  const highlight: CodeHighlighter = {
    lines(code) {
      counter.calls += 1
      return code.split('\n').map(line => `«${line}»`)
    },
  }
  return { highlight, counter }
}

describe('TUI measurement cards', () => {
  it('card C: one burst of a 20k live reply lexes the closed prefix once', () => {
    const { highlight, counter } = countingHighlighter()
    const block = new AssistantBlock({ ...theme, codeHighlight: highlight }, 1)
    const fence = `${'```ts\n'}${Array.from({ length: 200 }, (_, index) => `const v${String(index)} = ${String(index)}`).join('\n')}\n\`\`\`\n\n`
    const tail = 'word '.repeat(4_000)
    const text = `${fence}${tail}`
    expect(text.length).toBeGreaterThan(20_000)
    const deltas = 50
    const started = performance.now()
    for (let index = 0; index < deltas; index += 1) {
      const from = Math.floor((text.length * index) / deltas)
      const to = Math.floor((text.length * (index + 1)) / deltas)
      block.appendText(text.slice(from, to))
    }
    const afterDeltas = performance.now()
    const lines = block.render(80)
    const afterRender = performance.now()
    expect(lines.join('\n')).toContain('«const v0 = 0»')
    expect(lines.join('\n')).toContain('word')
    expect(counter.calls).toBe(1)
    // Threshold-free report: one parse of the closed fence for the burst.
    expect({
      card: 'C',
      deltas,
      chars: text.length,
      highlighterCalls: counter.calls,
      appendMs: afterDeltas - started,
      renderMs: afterRender - afterDeltas,
      lines: lines.length,
    }).toMatchObject({ card: 'C', highlighterCalls: 1 })
  })

  it('card D: a settled transcript draw stays one walk per ask', async () => {
    const history: SessionEvent[] = []
    let seq = 0
    for (let turn = 1; turn <= 20; turn += 1) {
      history.push({
        type: 'user/message',
        seq: seq++,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: `prompt ${String(turn)}` }], source: { kind: 'user' } }),
      } as never)
    }
    const test = await bench({ history, reducedMotion: true, codeHighlight: false })
    await test.settle()
    const started = performance.now()
    let frames = 0
    for (let index = 0; index < 12; index += 1) {
      await test.screen()
      frames += 1
    }
    const elapsed = performance.now() - started
    const screen = await test.screen()
    expect(screen).toContain('› prompt 1')
    expect(screen).toContain('› prompt 20')
    expect({ card: 'D', frames, elapsedMs: elapsed }).toMatchObject({ card: 'D', frames: 12 })
    test.app.stop()
  })

  it.skipIf(!CHILD)('cards A and B: built dsh --profile tui child', () => {
    expect(CHILD).toBe(true)
  })
})
