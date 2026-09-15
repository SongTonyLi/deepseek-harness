/** Transcript components rendered at fixed widths. */

import { describe, expect, it } from 'vitest'
import { AssistantBlock, NoticeBlock, ToolBlock, UserBlock, type BlockTheme } from '../src/blocks.ts'
import { createPalette } from '../src/style.ts'

const theme: BlockTheme = { palette: createPalette(false), toolPreviewLines: 2 }

describe('blocks', () => {
  it('wraps a long prompt under its marker', () => {
    const block = new UserBlock(theme, 'one two three four')
    expect(block.render(10)).toEqual(['', '› one two', '  three', '  four'])
    block.invalidate()
  })

  it('draws notices in their tone', () => {
    const block = new NoticeBlock({ ...theme, palette: createPalette(true) }, 'saved', 'success')
    expect(block.render(20)[0]).toContain('· saved')
    block.invalidate()
  })

  it('draws reasoning, text, and the interrupted marker as they arrive', () => {
    const trimmed = (lines: string[]): string[] => lines.map(line => line.trimEnd())
    const block = new AssistantBlock(theme)
    expect(block.render(40)).toEqual([''])
    block.appendReasoning('thinking ')
    block.appendReasoning('hard\n')
    expect(trimmed(block.render(40))).toEqual(['', 'thinking hard', ''])
    block.appendText('Answer')
    expect(trimmed(block.render(40))).toEqual(['', 'thinking hard', '', 'Answer'])
    block.commit('Final', '', true)
    expect(trimmed(block.render(40))).toEqual(['', 'Final', '[interrupted]'])
    block.invalidate()
  })

  it('draws a tool card with its status glyph and folded body', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] })
    expect(block.render(40)).toEqual(['', '● bash ls', '  │ cwd: /w'])
    block.setResult(['a', 'b', 'c'], false)
    expect(block.render(40)).toEqual(['', '● bash ls', '  │ cwd: /w', '  │ a', '  │ … 2 more lines (Ctrl+O expands)'])
    block.setExpanded(true)
    expect(block.render(40)).toHaveLength(6)
    const failed = new ToolBlock(theme, 'bash', { title: '', lines: [] })
    failed.setResult(['boom'], true)
    expect(failed.render(40)).toEqual(['', '● bash', '  │ boom'])
    failed.invalidate()
  })
})
