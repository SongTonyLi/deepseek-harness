/** Transcript components rendered at fixed widths. */

import { describe, expect, it } from 'vitest'
import { AssistantBlock, ContextBlock, NoticeBlock, ToolBlock, UserBlock, type BlockFade, type BlockTheme, type FadeRender } from '../src/blocks.ts'
import type { FadeStyle } from '../src/fade.ts'
import { createPalette } from '../src/style.ts'

const theme: BlockTheme = { palette: createPalette(false), toolPreviewLines: 2 }

/** The two-level fade style, which draws one sequence whatever the ramp would be. */
const FADE: FadeStyle = { capability: 'dim', ramp: [] }

/**
 * A card fade fixed at one level.
 * @param age - the level, or undefined for a fade that already settled.
 * @returns the fade the block reads per render.
 */
function blockFade(age: number | undefined): BlockFade {
  return { age: () => age, style: () => FADE }
}

describe('blocks', () => {
  it('wraps a long prompt under its marker', () => {
    const block = new UserBlock(theme, 'one two three four', 1)
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
    const block = new AssistantBlock(theme, 1)
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
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    expect(block.render(40)).toEqual(['', '● bash ls', '  │ cwd: /w'])
    block.setResult(['a', 'b', 'c'], false)
    expect(block.render(40)).toEqual(['', '● bash ls', '  │ cwd: /w', '  │ a', '  │ … 2 more lines (Ctrl+O expands)'])
    block.setExpanded(true)
    expect(block.render(40)).toHaveLength(6)
    const failed = new ToolBlock(theme, 'bash', { title: '', lines: [] }, 1)
    failed.setResult(['boom'], true)
    expect(failed.render(40)).toEqual(['', '● bash', '  │ boom'])
    failed.invalidate()
  })

  it('draws the header and call rows at the level of the card fade, and the result rows at their own', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    block.setResult(['out'], false)
    block.setFade(blockFade(0))
    block.setResultFade(blockFade(undefined))
    expect(block.render(40)).toEqual([
      '',
      '\u001b[2m\u25cf bash ls\u001b[22m',
      '\u001b[2m  \u2502 cwd: /w\u001b[22m',
      '  \u2502 out',
    ])
  })

  it('draws the truncation marker with the group whose rows it cut into', () => {
    const block = new ToolBlock({ ...theme, toolPreviewLines: 1 }, 'bash', { title: '', lines: ['a', 'b'] }, 1)
    block.setResult(['c'], false)
    block.setFade(blockFade(0))
    block.setResultFade(blockFade(undefined))
    // The preview stops inside the call rows, so no result row is drawn at all
    // and the marker fades with the call.
    expect(block.render(40)).toEqual([
      '',
      '\u001b[2m\u25cf bash\u001b[22m',
      '\u001b[2m  \u2502 a\u001b[22m',
      '\u001b[2m  \u2502 \u2026 2 more lines (Ctrl+O expands)\u001b[22m',
    ])
  })

  it('recolors the reasoning tail and flushes it when the width changes', () => {
    let flushed = 0
    const block = new AssistantBlock(theme, 1)
    block.appendReasoning('thinking hard')
    block.appendText('reply')
    block.setReasoningFade({
      spans: () => [{ text: 'hard', age: 0 }],
      style: () => FADE,
      steps: 5,
      flush: () => { flushed += 1 },
    })
    expect(block.render(40)[1]).toContain('thinking \u001b[2mhard')
    expect(block.render(40).at(-1)?.trimEnd()).toBe('reply')
    expect(flushed).toBe(0)
    block.render(20)
    expect(flushed).toBe(1)
  })

  it('keeps a card fade off the rows above the repaint floor', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    block.setResult(['out'], false)
    block.setFade(blockFade(0))
    block.setResultFade(blockFade(0))
    expect(block.setRepaintFloor(2)).toBe(true)
    expect(block.render(40)).toEqual([
      '',
      '● bash ls',
      '\u001b[2m  \u2502 cwd: /w\u001b[22m',
      '\u001b[2m  \u2502 out\u001b[22m',
    ])
  })

  it('never lowers a card floor and reports no change while both fades are settled', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    block.setFade(blockFade(0))
    expect(block.setRepaintFloor(2)).toBe(true)
    expect(block.setRepaintFloor(1)).toBe(false)
    // The header sits at index 1, which the floor of 2 keeps out of the fade.
    expect(block.render(40)[1]).toBe('● bash ls')

    const settled = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    settled.setFade(blockFade(undefined))
    expect(settled.setRepaintFloor(2)).toBe(false)
  })

  it('keeps each tail off the rows above the repaint floor', () => {
    const tail = (text: string): FadeRender => ({
      spans: () => [{ text, age: 0 }],
      style: () => FADE,
      steps: 5,
      flush: () => {},
    })
    const block = new AssistantBlock(theme, 1)
    block.appendReasoning('thinking hard')
    block.appendText('reply')
    block.setReasoningFade(tail('hard'))
    block.setFade(tail('reply'))
    // Line 0 is blank, 1 carries the reasoning, 2 is blank, 3 carries the reply.
    expect(block.setRepaintFloor(3)).toBe(true)
    const lines = block.render(40)
    expect(lines[1]).not.toContain('\u001b[2m')
    expect(lines[3]).toContain('\u001b[2mreply')
    expect(block.setRepaintFloor(4)).toBe(true)
    expect(block.render(40)[3]).not.toContain('\u001b[2m')
  })

  it('reports no change from a floor while no tail is drawing', () => {
    const block = new AssistantBlock(theme, 1)
    block.appendText('reply')
    expect(block.setRepaintFloor(2)).toBe(false)
    block.setFade({ spans: () => [{ text: 'reply', age: 4 }], style: () => FADE, steps: 5, flush: () => {} })
    expect(block.setRepaintFloor(3)).toBe(false)
  })

  it('drops both tails when the message commits', () => {
    const block = new AssistantBlock(theme, 1)
    block.appendReasoning('thinking hard')
    block.setReasoningFade({ spans: () => [{ text: 'hard', age: 0 }], style: () => FADE, steps: 5, flush: () => {} })
    block.commit('done', 'thinking hard', false)
    expect(block.render(40)[1]).not.toContain('\u001b[2m')
  })
})

describe('navigable sections', () => {
  it('reports a prompt as one section, split at its own newlines', () => {
    const block = new UserBlock(theme, 'read the spec\nthen fix it', 4)
    expect(block.turn).toBe(4)
    expect(block.blockKind).toBe('user')
    expect(block.parts()).toEqual([{ kind: 'user', rows: ['read the spec', 'then fix it'] }])
  })

  it('reports a message as its reasoning and its Markdown source, reasoning only once it has some', () => {
    const block = new AssistantBlock(theme, 2)
    expect(block.parts()).toEqual([{ kind: 'reply', rows: [''] }])
    block.appendReasoning('weighing it\nup')
    expect(block.parts()).toEqual([{ kind: 'reasoning', rows: ['weighing it', 'up'] }])
    block.appendText('# done')
    expect(block.parts()).toEqual([
      { kind: 'reasoning', rows: ['weighing it', 'up'] },
      { kind: 'reply', rows: ['# done'] },
    ])
  })

  it('reports a card as its call, and its result once the tool answered', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'git status', lines: ['cwd: /w'] }, 5)
    expect(block.title).toBe('git status')
    expect(block.parts()).toEqual([{ kind: 'call', rows: ['git status', 'cwd: /w'] }])
    block.setResult(['a', 'b', 'c', 'd'], false)
    // The section carries every result row, whatever the collapsed card draws.
    expect(block.parts()[1]).toEqual({ kind: 'result', rows: ['a', 'b', 'c', 'd'] })
  })

  it('names an empty call and an empty result rather than reporting no rows', () => {
    const block = new ToolBlock(theme, 'read', { title: '', lines: [] }, 1)
    expect(block.parts()).toEqual([{ kind: 'call', rows: ['(no arguments)'] }])
    block.setResult([], false)
    expect(block.parts()[1]).toEqual({ kind: 'result', rows: ['(no output)'] })
  })
})

describe('the focus gutter', () => {
  const trimmed = (lines: string[]): string[] => lines.map(line => line.trimEnd())

  it('draws a prompt behind the focus gutter, two columns narrower', () => {
    const block = new UserBlock(theme, 'one two three four', 1)
    block.setHighlight(0)
    expect(block.render(10)).toEqual(['┃ ', '┃ › one', '┃   two', '┃   three', '┃   four'])
    block.setHighlight(undefined)
    expect(block.render(10)).toEqual(['', '› one two', '  three', '  four'])
  })

  it('accents only the focused half of a message and dims the rest of the block', () => {
    const block = new AssistantBlock(theme, 1)
    block.appendReasoning('weighing it up')
    block.appendText('done')
    block.setHighlight(0)
    expect(trimmed(block.render(40))).toEqual(['│', '┃ weighing it up', '│', '│ done'])
    block.setHighlight(1)
    expect(trimmed(block.render(40))).toEqual(['│', '│ weighing it up', '│', '┃ done'])
    block.setHighlight(9)
    expect(trimmed(block.render(40))).toEqual(['│', '│ weighing it up', '│', '┃ done'])
  })

  it('accents the header with the call rows, or the result rows, and leaves the truncation marker dim', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    block.setResult(['out'], false)
    block.setHighlight(0)
    expect(block.render(40)).toEqual(['│ ', '┃ ● bash ls', '┃   │ cwd: /w', '│   │ out'])
    block.setHighlight(1)
    expect(block.render(40)).toEqual(['│ ', '│ ● bash ls', '│   │ cwd: /w', '┃   │ out'])
    block.setHighlight(9)
    expect(block.render(40)).toEqual(['│ ', '┃ ● bash ls', '┃   │ cwd: /w', '│   │ out'])

    const long = new ToolBlock({ ...theme, toolPreviewLines: 1 }, 'bash', { title: '', lines: ['a', 'b'] }, 1)
    long.setResult(['c'], false)
    long.setHighlight(0)
    expect(long.render(40)).toEqual(['│ ', '┃ ● bash', '┃   │ a', '│   │ … 2 more lines (Ctrl+O expands)'])
    long.setExpanded(true)
    expect(long.render(40)).toEqual(['│ ', '┃ ● bash', '┃   │ a', '┃   │ b', '│   │ c'])
  })

  it('prepends the gutter after the fade, so the fade keeps matching the card own text', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    block.setFade(blockFade(0))
    block.setHighlight(0)
    expect(block.render(40)).toEqual([
      '│ ',
      '┃ \u001b[2m● bash ls\u001b[22m',
      '┃ \u001b[2m  │ cwd: /w\u001b[22m',
    ])
  })
})

describe('ContextBlock', () => {
  it('draws the title and every source row in full', () => {
    const block = new ContextBlock(theme, 'system prompt', [{ kind: 'system', rows: ['You are the agent.', 'Be brief.'] }], 0)
    expect(block.render(40)).toEqual(['', '⬡ system prompt', '  You are the agent.', '  Be brief.'])
    expect(block.parts()[0]?.rows).toEqual(['You are the agent.', 'Be brief.'])
    block.invalidate()
  })

  it('names each snapshot contribution above its own rows', () => {
    const block = new ContextBlock(theme, 'snapshot · workspace', [
      { kind: 'snapshot', label: 'sandbox', rows: ['allow python'] },
      { kind: 'snapshot', label: 'git', rows: ['clean', 'tree'] },
    ], 0)
    expect(block.render(40)).toEqual([
      '',
      '⬡ snapshot · workspace',
      '  sandbox',
      '  allow python',
      '  git',
      '  clean',
      '  tree',
    ])
  })

  it('accents only the focused contribution and keeps the others on screen', () => {
    const trimmed = (lines: string[]): string[] => lines.map(line => line.trimEnd())
    const block = new ContextBlock(theme, 'snapshot · workspace', [
      { kind: 'snapshot', label: 'sandbox', rows: ['allow python'] },
      { kind: 'snapshot', label: 'git', rows: ['clean'] },
    ], 0)
    block.setHighlight(1)
    expect(trimmed(block.render(40))).toEqual([
      '│',
      '│ ⬡ snapshot · workspace',
      '│   sandbox',
      '│   allow python',
      '┃   git',
      '┃   clean',
    ])
    block.setHighlight(0)
    expect(trimmed(block.render(40))).toEqual([
      '│',
      '│ ⬡ snapshot · workspace',
      '┃   sandbox',
      '┃   allow python',
      '│   git',
      '│   clean',
    ])
    block.setHighlight(9)
    expect(trimmed(block.render(40))[0]).toBe('┃')
  })

  it('omits a blank body when a notice has only a title', () => {
    const block = new ContextBlock(theme, 'notice · skill loaded', [{ kind: 'notice', rows: [''] }], 0)
    expect(block.render(40)).toEqual(['', '⬡ notice · skill loaded'])
  })

  it('wraps a long title under the glyph', () => {
    const block = new ContextBlock(theme, 'instructions · agent-instructions', [{ kind: 'instructions', rows: ['# AGENTS.md'] }], 0)
    expect(block.render(16)[1]).toContain('⬡')
    expect(block.render(16).join('\n')).toContain('instructions')
    expect(block.render(16).join('\n')).toContain('# AGENTS.md')
  })

  it('keeps every character of a long context row, wrapping instead of cutting', () => {
    const long = 'x'.repeat(40)
    const drawn = new ContextBlock(theme, 'system prompt', [{ kind: 'system', rows: [long] }], 0).render(16).join('\n')
    expect(drawn.replaceAll(/[^x]/g, '')).toBe(long)
    expect(drawn).not.toContain('…')
  })
})
