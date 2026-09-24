/** Transcript components rendered at fixed widths. */

import { describe, expect, it } from 'vitest'
import { Markdown, visibleWidth } from '@earendil-works/pi-tui'
import { AssistantBlock, ContextBlock, NoticeBlock, SUBAGENT_RUNNING_GLYPH, TOOL_RUNNING_ROW, ToolBlock, UserBlock, UserShellBlock, isFoldable, type BlockFade, type BlockTheme, type FadeRender } from '../src/blocks.ts'
import type { FadeStyle } from '../src/fade.ts'
import { createPalette, markdownTheme, type CodeHighlighter } from '../src/style.ts'
import type { CodeSpan } from '../src/transcript.ts'
import { RowReveal } from '../src/pace.ts'

const theme: BlockTheme = { palette: createPalette(false), toolPreviewLines: 2, contextPreviewLines: 6 }

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
    expect(block.render(10)).toEqual(['', '❯ one two', '  three', '  four'])
    block.invalidate()
  })

  it('lays every prompt row on the background band, the leading blank line left bare', () => {
    const block = new UserBlock({ ...theme, palette: createPalette(true) }, 'one two three', 1)
    const lines = block.render(10)
    expect(lines[0]).toBe('')
    for (const line of lines.slice(1)) {
      expect(line.startsWith('\u001b[48;5;236m')).toBe(true)
      expect(visibleWidth(line)).toBe(10)
    }
    block.setHighlight(0)
    expect(block.render(10).slice(1).map(line => visibleWidth(line))).toEqual([10, 10, 10])
  })

  it('heads reasoning with its glyph, cut to a narrow width, and indents the rows under it', () => {
    const block = new AssistantBlock(theme, 1)
    block.appendReasoning('hmm')
    const lines = block.render(6)
    expect(lines[1]?.startsWith('✻ Thi')).toBe(true)
    expect(visibleWidth(lines[1] ?? '')).toBe(6)
    expect(lines.slice(2).map(line => line.trimEnd())).toEqual(['  hmm', ''])
  })

  it('colours a subagent row glyph by status, dim for a child handed to the background', () => {
    const on = createPalette(true)
    const block = new ToolBlock({ ...theme, palette: on }, 'subagent', { title: '', lines: [] }, 1)
    block.setSubagent({ description: 'Rank', meta: [] })
    expect(block.render(40)[1]).toContain(on.warning(SUBAGENT_RUNNING_GLYPH))
    block.setResult(['answer'], false)
    expect(block.render(40)[1]).toContain(on.success(SUBAGENT_RUNNING_GLYPH))
    block.setResult(['started subagent child-1'], false)
    expect(block.render(40)[1]).toContain(on.dim(SUBAGENT_RUNNING_GLYPH))
    block.setResult(['boom'], true)
    expect(block.render(40)[1]).toContain(on.error(SUBAGENT_RUNNING_GLYPH))
  })

  it('draws a tool card header with the status-coloured glyph and the title in the link colour', () => {
    const on = createPalette(true)
    const block = new ToolBlock({ ...theme, palette: on }, 'edit', { title: 'src/a.ts', lines: [] }, 1)
    expect(block.render(40)[1]).toBe(`${on.warning('◆')} ${on.bold('edit')} ${on.link('src/a.ts')}`)
    block.setResult([], true)
    expect(block.render(40)[1]?.startsWith(on.error('◆'))).toBe(true)
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
    expect(trimmed(block.render(40))).toEqual(['', '✻ Thinking', '  thinking hard', ''])
    block.appendText('Answer')
    expect(trimmed(block.render(40))).toEqual(['', '✻ Thinking', '  thinking hard', '', 'Answer'])
    block.commit('Final', '', true)
    expect(trimmed(block.render(40))).toEqual(['', 'Final', '[interrupted]'])
    block.invalidate()
  })

  it('draws a tool card with its status glyph and folded body', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    expect(block.render(40)).toEqual(['', '◆ bash ls', '  │ cwd: /w', `  │ ${TOOL_RUNNING_ROW}`])
    block.setResult(['a', 'b', 'c'], false)
    expect(block.render(40)).toEqual(['', '◆ bash ls', '  │ cwd: /w', '  │ a', '  │ … 2 more rows · Ctrl+O expands'])
    block.setExpanded(true)
    expect(block.render(40)).toHaveLength(6)
    const failed = new ToolBlock(theme, 'bash', { title: '', lines: [] }, 1)
    failed.setResult(['boom'], true)
    expect(failed.render(40)).toEqual(['', '◆ bash', '  │ boom'])
    failed.invalidate()
  })

  it('draws added tool rows green and removed rows red', () => {
    const colored = { ...theme, palette: createPalette(true) }
    const block = new ToolBlock(colored, 'edit', { title: 'Edit a.ts', lines: ['a.ts', '- old', '+ fresh'] }, 1)
    block.setExpanded(true)
    const shown = block.render(40).join('\n')
    expect(shown).toContain('\u001b[31m- old\u001b[39m')
    expect(shown).toContain('\u001b[32m+ fresh\u001b[39m')
  })

  it('boxes the changed rows of a diff card and leaves a fold marker outside every box', () => {
    const block = new ToolBlock(theme, 'edit', {
      title: 'Edit a.ts',
      lines: ['a.ts', '- old', '+ fresh'],
      diff: [undefined, 'removed', 'added'],
    }, 1)
    block.setExpanded(true)
    expect(block.render(20)).toEqual([
      '',
      '◆ edit Edit a.ts',
      '  │ a.ts',
      '  │ ╭──────────────╮',
      '  │ │ - old        │',
      '  │ ╰──────────────╯',
      '  │ ╭──────────────╮',
      '  │ │ + fresh      │',
      '  │ ╰──────────────╯',
      '  │ …',
    ])
    block.setResult(['a.ts', '  one', '+ two', '+ three'], false, undefined, [undefined, undefined, 'added', 'added'])
    expect(block.render(20)).toEqual([
      '',
      '◆ edit Edit a.ts',
      '  │ a.ts',
      '  │   one',
      '  │ ╭──────────────╮',
      '  │ │ + two        │',
      '  │ │ + three      │',
      '  │ ╰──────────────╯',
    ])
    block.setExpanded(false)
    expect(block.render(60).at(-1)).toBe('  │ … 2 more rows · Ctrl+O expands')
  })

  it('draws a folded subagent card as one row: the tool while it runs, then the outcome at the right edge', () => {
    const call = { title: '', lines: ['{"description":"Rank endpoints"}'] }
    const block = new ToolBlock(theme, 'subagent', call, 1)
    block.setSubagent({ description: 'Rank endpoints', meta: ['deepseek-chat'] })
    expect(block.render(60)).toEqual(['', `${SUBAGENT_RUNNING_GLYPH} subagent  Rank endpoints deepseek-chat`])
    block.setResult(['the slowest is /search'], false)
    expect(block.render(40)).toEqual(['', `${SUBAGENT_RUNNING_GLYPH} Rank endpoints deepseek-chat    [done]`])
    block.setResult(['started subagent child-1'], false)
    expect(block.render(40).at(-1)).toMatch(/ \[started\]$/)
    block.setResult(['boom'], true)
    expect(block.render(40).at(-1)).toMatch(/ \[failed\]$/)
    block.setExpanded(true)
    expect(block.render(40)).toContain('  │ boom')
  })

  it('names a subagent row by its tool until the arguments carry a description, and fits a narrow width', () => {
    const block = new ToolBlock({ ...theme, palette: createPalette(true) }, 'subagent', { title: '', lines: [] }, 1)
    block.setSubagent({ description: '', meta: [] })
    expect(block.render(40)[1]).toContain('subagent')
    block.setResult(['answer'], false)
    const narrow = block.render(12)[1] ?? ''
    expect(narrow).toContain('[done]')
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(12)
  })

  it('draws the header and call rows at the level of the card fade, and the result rows at their own', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    block.setResult(['out'], false)
    block.setFade(blockFade(0))
    block.setResultFade(blockFade(undefined))
    expect(block.render(40)).toEqual([
      '',
      '\u001b[2m\u25c6 bash ls\u001b[22m',
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
      '\u001b[2m\u25c6 bash\u001b[22m',
      '\u001b[2m  \u2502 a\u001b[22m',
      '\u001b[2m  \u2502 \u2026 2 more rows · Ctrl+O expands\u001b[22m',
    ])
  })

  it('flushes the reply tail when the width changes', () => {
    let flushed = 0
    const block = new AssistantBlock(theme, 1)
    block.appendText('hello world')
    block.setFade({
      spans: () => [{ text: 'world', age: 0 }],
      style: () => FADE,
      steps: 5,
      flush: () => { flushed += 1 },
    })
    expect(block.render(40).at(-1)).toContain('hello \u001b[2mworld')
    block.render(20)
    expect(flushed).toBe(1)
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
    expect(block.render(40)[2]).toContain('  thinking \u001b[2mhard')
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
      '◆ bash ls',
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
    expect(block.render(40)[1]).toBe('◆ bash ls')

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
    // Line 0 is blank, 1 is the reasoning header, 2 carries the reasoning, 3
    // is blank, 4 carries the reply.
    expect(block.setRepaintFloor(4)).toBe(true)
    const lines = block.render(40)
    expect(lines[2]).not.toContain('\u001b[2m')
    expect(lines[4]).toContain('\u001b[2mreply')
    expect(block.setRepaintFloor(5)).toBe(true)
    expect(block.render(40)[4]).not.toContain('\u001b[2m')
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
    expect(block.render(40)[2]).not.toContain('\u001b[2m')
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

  it('replaces the call half and drops the loading row once the tool answers', () => {
    const block = new ToolBlock(theme, 'read', { title: '', lines: [] }, 1)
    expect(block.render(40)).toEqual(['', '◆ read', `  │ ${TOOL_RUNNING_ROW}`])
    block.setCall('read', { title: 'a.ts', lines: [] })
    expect(block.name).toBe('read')
    expect(block.title).toBe('a.ts')
    expect(block.render(40)).toEqual(['', '◆ read a.ts', `  │ ${TOOL_RUNNING_ROW}`])
    block.setResult(['ok'], false)
    expect(block.render(40)).toEqual(['', '◆ read a.ts', '  │ ok'])
  })

  it('reports a card as its call, and its result once the tool answered', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'git status', lines: ['cwd: /w'] }, 5)
    expect(block.title).toBe('git status')
    expect(block.parts()).toEqual([{ kind: 'call', rows: ['git status', 'cwd: /w'] }])
    block.setResult(['a', 'b', 'c', 'd'], false)
    // The section carries every result row, whatever the collapsed card draws.
    expect(block.parts()[1]).toEqual({ kind: 'result', rows: ['a', 'b', 'c', 'd'] })
  })

  it('carries the code span behind each call and result row, past the headline row', () => {
    const span = { lang: 'ts', prefix: '   1│ ', source: 'const a = 1' }
    const shell = { lang: 'shellscript', prefix: '$ ', source: 'ls' }
    const block = new ToolBlock(theme, 'read', { title: 'a.ts', lines: ['$ ls'], code: [shell] }, 1)
    expect(block.parts()[0]).toEqual({ kind: 'call', rows: ['a.ts', '$ ls'], code: [undefined, shell] })
    block.setResult(['   1│ const a = 1'], false, [span])
    expect(block.parts()[1]).toEqual({ kind: 'result', rows: ['   1│ const a = 1'], code: [span] })
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
    expect(block.render(10)).toEqual(['┃ ', '┃ ❯ one', '┃   two', '┃   three', '┃   four'])
    block.setHighlight(undefined)
    expect(block.render(10)).toEqual(['', '❯ one two', '  three', '  four'])
  })

  it('accents only the focused half of a message and dims the rest of the block', () => {
    const block = new AssistantBlock(theme, 1)
    block.appendReasoning('weighing it up')
    block.appendText('done')
    block.setHighlight(0)
    expect(trimmed(block.render(40))).toEqual(['│', '┃ ✻ Thinking', '┃   weighing it up', '│', '│ done'])
    block.setHighlight(1)
    expect(trimmed(block.render(40))).toEqual(['│', '│ ✻ Thinking', '│   weighing it up', '│', '┃ done'])
    block.setHighlight(9)
    expect(trimmed(block.render(40))).toEqual(['│', '│ ✻ Thinking', '│   weighing it up', '│', '┃ done'])
  })

  it('accents the header with the call rows, or the result rows, and leaves the truncation marker dim', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    block.setResult(['out'], false)
    block.setHighlight(0)
    expect(block.render(40)).toEqual(['│ ', '┃ ◆ bash ls', '┃   │ cwd: /w', '│   │ out'])
    block.setHighlight(1)
    expect(block.render(40)).toEqual(['│ ', '│ ◆ bash ls', '│   │ cwd: /w', '┃   │ out'])
    block.setHighlight(9)
    expect(block.render(40)).toEqual(['│ ', '┃ ◆ bash ls', '┃   │ cwd: /w', '│   │ out'])

    const long = new ToolBlock({ ...theme, toolPreviewLines: 1 }, 'bash', { title: '', lines: ['a', 'b'] }, 1)
    long.setResult(['c'], false)
    long.setHighlight(0)
    // The card holds the focus, so its marker names the key that opens this
    // block alone rather than the one that opens every block.
    expect(long.render(40)).toEqual(['│ ', '┃ ◆ bash', '┃   │ a', '│   │ … 2 more rows · Space expands'])
    // The result has no drawn row of its own here, so the marker that stands
    // for the rows the fold took carries the mark: a card the inspector
    // reports as marked always marks a line.
    long.setHighlight(1)
    expect(long.render(40)).toEqual(['│ ', '│ ◆ bash', '│   │ a', '┃   │ … 2 more rows · Space expands'])
    long.setExpanded(true)
    expect(long.render(40)).toEqual(['│ ', '│ ◆ bash', '│   │ a', '│   │ b', '┃   │ c'])
    long.setHighlight(0)
    expect(long.render(40)).toEqual(['│ ', '┃ ◆ bash', '┃   │ a', '┃   │ b', '│   │ c'])
  })

  it('prepends the gutter after the fade, so the fade keeps matching the card own text', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    block.setFade(blockFade(0))
    block.setHighlight(0)
    expect(block.render(40)).toEqual([
      '│ ',
      '┃ \u001b[2m◆ bash ls\u001b[22m',
      '┃ \u001b[2m  │ cwd: /w\u001b[22m',
      `┃ \u001b[2m  │ ${TOOL_RUNNING_ROW}\u001b[22m`,
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

describe('folding a block', () => {
  /** An injection far longer than any preview budget. */
  const RULES = Array.from({ length: 30 }, (_, index) => `rule ${String(index)}`)

  it('draws an injection folded at its budget under a title it never folds', () => {
    const block = new ContextBlock({ ...theme, contextPreviewLines: 4 }, 'system prompt', [{ kind: 'system', rows: RULES }], 0)
    expect(block.isExpanded()).toBe(false)
    expect(block.render(40)).toEqual([
      '',
      '⬡ system prompt',
      '  rule 0',
      '  rule 1',
      '  rule 2',
      '  rule 3',
      '  … 26 more rows · Ctrl+O expands',
    ])
    // What the model was given is never cut from what the keyboard reads.
    expect(block.parts()[0]?.rows).toEqual(RULES)
    block.setExpanded(true)
    expect(block.isExpanded()).toBe(true)
    const expanded = block.render(40)
    expect(expanded).toHaveLength(2 + RULES.length)
    expect(expanded.at(-1)).toBe('  rule 29')
    expect(block.parts()[0]?.rows).toEqual(RULES)
  })

  it('marks the drawn rows of the focused contribution and leaves the marker to the block', () => {
    const block = new ContextBlock({ ...theme, contextPreviewLines: 3 }, 'snapshot · workspace', [
      { kind: 'snapshot', label: 'sandbox', rows: ['allow python'] },
      { kind: 'snapshot', label: 'git', rows: ['clean', 'tree'] },
    ], 0)
    block.setHighlight(1)
    // The block holds the focus, so the marker names the key that opens this
    // block alone, and the rows the fold took are not the focused section's.
    expect(block.render(40).map(line => line.trimEnd())).toEqual([
      '│',
      '│ ⬡ snapshot · workspace',
      '│   sandbox',
      '│   allow python',
      '┃   git',
      '│   … 2 more rows · Space expands',
    ])
    // A contribution the fold left out entirely has no row of its own to
    // mark, so the marker that stands for the rows the fold took carries the
    // focus: a block the inspector reports as marked always marks a line.
    const cut = new ContextBlock({ ...theme, contextPreviewLines: 1 }, 'snapshot · workspace', [
      { kind: 'snapshot', label: 'sandbox', rows: ['allow python'] },
      { kind: 'snapshot', label: 'git', rows: ['clean'] },
    ], 0)
    cut.setHighlight(1)
    expect(cut.render(40).map(line => line.trimEnd())).toEqual([
      '│',
      '│ ⬡ snapshot · workspace',
      '│   sandbox',
      '┃   … 3 more rows · Space expands',
    ])
    cut.setHighlight(0)
    expect(cut.render(40).map(line => line.trimEnd())).toEqual([
      '│',
      '│ ⬡ snapshot · workspace',
      '┃   sandbox',
      '│   … 3 more rows · Space expands',
    ])
  })

  it('counts one row left out in the singular', () => {
    const block = new ContextBlock({ ...theme, contextPreviewLines: 1 }, 'system prompt', [{ kind: 'system', rows: ['keep', 'cut'] }], 0)
    expect(block.render(40).at(-1)).toBe('  … 1 more row · Ctrl+O expands')
  })

  it('wraps the marker to the width every other row it draws is wrapped to', () => {
    const block = new ContextBlock({ ...theme, contextPreviewLines: 1 }, 'system prompt', [{ kind: 'system', rows: RULES }], 0)
    // pi-tui refuses to write a line wider than the terminal, so the row that
    // names the fold is wrapped like the rows it stands for.
    expect(block.render(24)).toEqual(['', '⬡ system prompt', '  rule 0', '  … 29 more rows ·', '  Ctrl+O expands'])
    block.setHighlight(0)
    // The gutter still marks the focused contribution's own row and leaves
    // every row of the marker to the block.
    expect(block.render(24)).toEqual(['│ ', '│ ⬡ system prompt', '┃   rule 0', '│   … 29 more rows ·', '│   Space expands'])
  })

  it('is the marker every foldable block carries, and nothing else carries', () => {
    expect(isFoldable(new ContextBlock(theme, 'system prompt', [{ kind: 'system', rows: ['a'] }], 0))).toBe(true)
    expect(isFoldable(new ToolBlock(theme, 'bash', { title: '', lines: [] }, 1))).toBe(true)
    expect(isFoldable(new UserBlock(theme, 'read the spec', 1))).toBe(false)
    expect(isFoldable(new AssistantBlock(theme, 1))).toBe(false)
    expect(isFoldable(undefined)).toBe(false)
  })
})

/**
 * A highlighter that counts how often it is asked. It wraps every line in
 * guillemets, or leaves the block plain like a grammar that has not landed.
 * @param colour - whether it answers with coloured lines at all.
 * @returns the highlighter and the count it keeps.
 */
function countingHighlighter(colour = true): { highlight: CodeHighlighter; counter: { calls: number } } {
  const counter = { calls: 0 }
  const highlight: CodeHighlighter = {
    lines: (code) => {
      counter.calls += 1
      return colour ? code.split('\n').map(line => `«${line}»`) : undefined
    },
  }
  return { highlight, counter }
}

/** A two-row `read` result and the code spans behind it. */
const READ_ROWS = ['1│ const a = 1', '2│ const b = 2']
const READ_CODE: CodeSpan[] = [
  { lang: 'ts', prefix: '1│ ', source: 'const a = 1' },
  { lang: 'ts', prefix: '2│ ', source: 'const b = 2' },
]

describe('render reuse', () => {
  const RULES = Array.from({ length: 30 }, (_, index) => `rule ${String(index)}`)

  it('colours a tool card once and hands back the same lines while nothing changed', () => {
    const { highlight, counter } = countingHighlighter()
    const block = new ToolBlock({ ...theme, codeHighlight: highlight }, 'read', { title: 'a.ts', lines: [] }, 1)
    block.setResult(READ_ROWS, false, READ_CODE)
    const first = block.render(40)
    expect(first).toEqual(['', '◆ read a.ts', '  │ 1│ «const a = 1»', '  │ 2│ «const b = 2»'])
    expect(block.render(40)).toBe(first)
    expect(block.render(40)).toBe(first)
    expect(counter.calls).toBe(1)
  })

  it('rebuilds a tool card when it folds or unfolds, and again when a grammar lands', () => {
    const { highlight, counter } = countingHighlighter()
    const block = new ToolBlock({ ...theme, toolPreviewLines: 1, codeHighlight: highlight }, 'read', { title: 'a.ts', lines: [] }, 1)
    block.setResult(READ_ROWS, false, READ_CODE)
    const folded = block.render(40)
    expect(folded).toHaveLength(4)
    block.setExpanded(true)
    const expanded = block.render(40)
    expect(expanded).toHaveLength(4)
    expect(expanded).not.toBe(folded)
    expect(expanded.at(-1)).toBe('  │ 2│ «const b = 2»')
    expect(counter.calls).toBe(2)
    // A grammar that lands asks every card to draw again: the rows it drew
    // plain are the ones the colour is for.
    block.invalidate()
    expect(block.render(40)).toEqual(expanded)
    expect(counter.calls).toBe(3)
  })

  it('draws a card fade over the card body without rebuilding it', () => {
    const { highlight, counter } = countingHighlighter()
    const block = new ToolBlock({ ...theme, palette: createPalette(true), codeHighlight: highlight }, 'read', { title: 'a.ts', lines: [] }, 1)
    block.setResult(READ_ROWS, false, READ_CODE)
    const settled = block.render(40)
    block.setResultFade(blockFade(0))
    const faded = block.render(40)
    expect(faded).not.toEqual(settled)
    expect(faded.at(-1)).toContain('[2m')
    block.setResultFade(blockFade(undefined))
    expect(block.render(40)).toBe(settled)
    expect(counter.calls).toBe(1)
    // The gutter narrows the card and renames its fold key, so the focus
    // landing rebuilds this one card; the mark then rides the rebuilt body.
    block.setHighlight(1)
    expect(block.render(40).at(-1)).toContain('┃')
  })

  it('hands back the same context lines until the block folds or unfolds', () => {
    const block = new ContextBlock({ ...theme, contextPreviewLines: 1 }, 'system prompt', [{ kind: 'system', rows: RULES }], 0)
    const folded = block.render(40)
    expect(block.render(40)).toBe(folded)
    block.setExpanded(true)
    const expanded = block.render(40)
    expect(expanded).not.toBe(folded)
    expect(expanded).toHaveLength(RULES.length + 2)
    expect(block.render(40)).toBe(expanded)
    block.setHighlight(0)
    expect(block.render(40)[2]).toBe('┃   rule 0')
    block.setHighlight(undefined)
    expect(block.render(40)).toEqual(expanded)
  })

  it('paints a user-shell $ command and rebuilds after invalidate', () => {
    const { highlight, counter } = countingHighlighter()
    const block = new UserShellBlock({ ...theme, codeHighlight: highlight }, 'echo hi', ['$ echo hi', 'out'])
    const first = block.render(40)
    expect(first).toEqual(['', '$ «echo hi»', 'out', ''])
    expect(block.render(40)).toBe(first)
    expect(counter.calls).toBe(1)
    block.invalidate()
    expect(block.render(40)).toEqual(first)
    expect(counter.calls).toBe(2)
    const plain = new UserShellBlock(theme, 'true', ['$ true'])
    expect(plain.render(20)).toEqual(['', '$ true', ''])
    plain.invalidate()
  })

  it('hands back the same prompt lines while nothing changed', () => {
    const block = new UserBlock(theme, 'one two three four', 1)
    const first = block.render(10)
    expect(block.render(10)).toBe(first)
    expect(block.render(12)).not.toBe(first)
    expect(block.render(10)).toEqual(first)
  })

  it('colours an unchanged fence once while the reply keeps streaming and when it commits', () => {
    const { highlight, counter } = countingHighlighter()
    const block = new AssistantBlock({ ...theme, codeHighlight: highlight }, 1)
    block.appendText('```ts\nconst a = 1\n```\n\nthen')
    expect(block.render(40).join('\n')).toContain('«const a = 1»')
    expect(counter.calls).toBe(1)
    block.appendText(' more')
    expect(block.render(40).join('\n')).toContain('then more')
    expect(counter.calls).toBe(1)
    block.commit('```ts\nconst a = 1\n```\n\nthen more', '', false)
    expect(block.render(40).join('\n')).toContain('«const a = 1»')
    expect(counter.calls).toBe(1)
    block.invalidate()
    block.render(40)
    expect(counter.calls).toBe(2)
  })

  it('asks again for a fence the highlighter left plain, so the grammar that lands colours it', () => {
    const { highlight, counter } = countingHighlighter(false)
    const block = new AssistantBlock({ ...theme, codeHighlight: highlight }, 1)
    block.appendText('```ts\nconst a = 1\n```\n')
    block.render(40)
    block.appendText('\nthen')
    block.render(40)
    // The closed fence is cached; a later delta does not re-ask. The
    // application invalidates every block when the grammar lands.
    expect(counter.calls).toBe(1)
    block.invalidate()
    block.render(40)
    expect(counter.calls).toBe(2)
  })

  it('matches a full Markdown parse while a closed fence is followed by a growing tail', () => {
    const oracle = (text: string, width: number): string[] =>
      ['', ...new Markdown(text, 0, 0, markdownTheme(theme.palette)).render(width)]
    const block = new AssistantBlock(theme, 1)
    const steps = [
      '```ts\nconst a = 1\n',
      '```ts\nconst a = 1\n```\n',
      '```ts\nconst a = 1\n```\n\nthen',
      '```ts\nconst a = 1\n```\n\nthen more',
      '```ts\nconst a = 1\n```\n\nthen more\n\n1. one\n2. two',
      '```ts\nconst a = 1\n```\n\nthen more\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
    ]
    for (const text of steps) {
      const streamed = new AssistantBlock(theme, 1)
      streamed.appendText(text.slice(0, 12))
      streamed.render(40)
      streamed.appendText(text.slice(12))
      expect(streamed.render(40).map(line => line.trimEnd())).toEqual(oracle(text, 40).map(line => line.trimEnd()))
      expect(streamed.render(20).map(line => line.trimEnd())).toEqual(oracle(text, 20).map(line => line.trimEnd()))
    }
    block.appendText(steps[3] as string)
    block.setFade({
      spans: () => [{ text: 'more', age: 0 }],
      style: () => FADE,
      steps: 5,
      flush: () => {},
    })
    expect(block.render(40).join('\n')).toContain('then')
    expect(block.render(40).at(-1)).toContain('\u001b[2mmore')
  })

  it('treats a backtick run with backticks in its info as text, and closes a fence at EOF', () => {
    const skipped = new AssistantBlock(theme, 1)
    skipped.appendText('```ts`nope`\nnot a fence')
    expect(skipped.render(40).join('\n')).toContain('not a fence')

    const closed = new AssistantBlock(theme, 1)
    closed.appendText('```ts\nconst a = 1\n```')
    expect(closed.render(40).join('\n')).toContain('const a = 1')
    closed.appendText('\n\n')
    expect(closed.render(40).join('\n')).toContain('const a = 1')

    const tilde = new AssistantBlock(theme, 1)
    tilde.appendText('~~~\nplain\n~~~\nthen')
    expect(tilde.render(40).join('\n')).toContain('plain')
    expect(tilde.render(40).join('\n')).toContain('then')

    const indented = new AssistantBlock(theme, 1)
    indented.appendText('   ```ts\nconst a = 1\n   ```\n\nthen')
    expect(indented.render(40).join('\n')).toContain('const a = 1')

    const notCloser = new AssistantBlock(theme, 1)
    notCloser.appendText('```ts\nconst a = 1\n```lang\nstill open')
    notCloser.render(40)
    notCloser.appendText('\n```\n')
    expect(notCloser.render(40).join('\n')).toContain('still open')
  })

  it('hands back the same reply lines while the message is settled', () => {
    const block = new AssistantBlock(theme, 1)
    block.commit('Final answer', 'weighing it up', false)
    const first = block.render(40)
    expect(block.render(40)).toBe(first)
    block.setHighlight(1)
    const marked = block.render(40)
    expect(marked).not.toBe(first)
    expect(marked.at(-1)).toContain('┃')
    block.setHighlight(undefined)
    expect(block.render(40)).toEqual(first)
  })
})

describe('unrolling a tool card', () => {
  const ROWS = ['one', 'two', 'three']

  it('draws only the revealed rows, and reports the rows still to unroll', () => {
    const block = new ToolBlock({ ...theme, toolPreviewLines: 8 }, 'bash', { title: 'ls', lines: [] }, 1)
    expect(block.revealing()).toBe(false)
    expect(block.revealFrame()).toBe(false)
    block.setReveal(new RowReveal(1, 1))
    // A reveal the card has not rendered under waits for the render to measure it.
    expect(block.revealing()).toBe(true)
    expect(block.revealFrame()).toBe(true)
    expect(block.render(40)).toEqual(['', '◆ bash ls'])
    expect(block.revealing()).toBe(true)
    expect(block.revealFrame()).toBe(false)
    expect(block.render(40)).toEqual(['', '◆ bash ls', '  │ …'])
    expect(block.revealing()).toBe(false)

    block.setResult(ROWS, false)
    expect(block.revealing()).toBe(true)
    expect(block.render(40)).toEqual(['', '◆ bash ls', '  │ one'])
    expect(block.revealing()).toBe(true)
    expect(block.revealFrame()).toBe(false)
    expect(block.render(40)).toEqual(['', '◆ bash ls', '  │ one', '  │ two', '  │ three'])
  })

  it('draws every row once the card unfolds', () => {
    const block = new ToolBlock({ ...theme, toolPreviewLines: 8 }, 'bash', { title: 'ls', lines: [] }, 1)
    block.setReveal(new RowReveal(8, 1))
    block.setResult(ROWS, false)
    expect(block.render(40)).toHaveLength(2)
    block.setExpanded(false)
    expect(block.render(40)).toHaveLength(2)
    block.setExpanded(true)
    expect(block.render(40)).toHaveLength(5)
    expect(block.revealing()).toBe(false)
  })

  it('draws every row once the unrolling edge is above the repaintable lines', () => {
    const block = new ToolBlock({ ...theme, toolPreviewLines: 8 }, 'bash', { title: 'ls', lines: [] }, 1)
    block.setReveal(new RowReveal(8, 1))
    block.setResult(ROWS, false)
    block.render(40)
    // The edge sits right after the header, line 2 of the card, so a floor at it can still follow the rows.
    expect(block.setRepaintFloor(2)).toBe(false)
    expect(block.render(40)).toHaveLength(2)
    expect(block.setRepaintFloor(3)).toBe(true)
    expect(block.render(40)).toHaveLength(5)
    expect(block.setRepaintFloor(3)).toBe(false)
  })

  it('unrolls a focused card with its gutter', () => {
    const block = new ToolBlock({ ...theme, toolPreviewLines: 8 }, 'bash', { title: 'ls', lines: [] }, 1)
    block.setReveal(new RowReveal(8, 1))
    block.setResult(ROWS, false)
    block.setHighlight(1)
    expect(block.render(40)).toEqual(['│ ', '│ ◆ bash ls'])
    block.revealFrame()
    expect(block.render(40)).toEqual(['│ ', '│ ◆ bash ls', '┃   │ one'])
  })
})

describe('a diff result', () => {
  it('takes the place of the call-time diff rows', () => {
    const block = new ToolBlock({ ...theme, toolPreviewLines: 8 }, 'edit', { title: 'Edit a.ts', lines: ['- old', '+ new'], diff: ['removed', 'added'] }, 1)
    block.setResult(['3 - old', '3 + new'], false, undefined, ['removed', 'added'])
    expect(block.parts()).toEqual([{ kind: 'call', rows: ['Edit a.ts'] }, { kind: 'result', rows: ['3 - old', '3 + new'] }])
  })

  it('keeps a call-time diff when the result is not a diff', () => {
    const block = new ToolBlock({ ...theme, toolPreviewLines: 8 }, 'edit', { title: 'Edit a.ts', lines: ['- old', '+ new'], diff: ['removed', 'added'] }, 1)
    block.setResult(['no match'], true)
    expect(block.parts()[0]).toEqual({ kind: 'call', rows: ['Edit a.ts', '- old', '+ new'] })
  })
})
