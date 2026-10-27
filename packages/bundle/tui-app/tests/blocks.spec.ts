/** Transcript components rendered at fixed widths. */

import { describe, expect, it } from 'vitest'
import { Markdown, visibleWidth } from '@earendil-works/pi-tui'
import { AssistantBlock, ContextBlock, NoticeBlock, SUBAGENT_RUNNING_GLYPH, TOOL_RUNNING_ROW, ToolBlock, UserBlock, UserShellBlock, isFoldable, type BlockTheme, type FadeRender } from '../src/blocks.ts'
import type { FadeStyle } from '../src/fade.ts'
import { jsonTreeText } from '../src/json-tree.ts'
import { createPalette, markdownTheme, type CodeHighlighter } from '../src/style.ts'
import type { CodeSpan } from '../src/transcript.ts'
import { CardFlow } from '../src/pace.ts'

const theme: BlockTheme = { palette: createPalette(false), toolPreviewLines: 2, contextPreviewLines: 6 }

/** The two-level fade style, which draws one sequence whatever the ramp would be. */
const FADE: FadeStyle = { capability: 'dim', ramp: [] }

/** A card's flow on a clock the test moves; at width 40 its front crosses two columns per millisecond. */
interface FlowClock {
  flow: CardFlow
  /** Move the clock and run the card's frame. */
  frame: (ms: number) => void
}

/**
 * Build the flow of a card on a clock the test moves: a 40-column row takes
 * one 20 ms frame, and a run drawn by a frame recedes over four of them.
 * @param shown - columns drawn before the first frame.
 * @returns the flow and a function that moves its clock.
 */
function flowClock(shown = 0): { flow: CardFlow; advance: (ms: number) => void } {
  let now = 1000
  const flow = new CardFlow({ rowFrames: 1, stepMs: 20, steps: 4, now: () => now }, shown)
  return { flow, advance: (ms) => { now += ms } }
}

/**
 * Flow a card: hand it a flow on a test clock and measure it once.
 * @param block - the card.
 * @param style - the colors the trail is drawn with; absent flows without color.
 * @param shown - columns drawn before the first frame.
 * @returns the flow, with a `frame` that moves the clock and runs the card's frame.
 */
function flowOut(block: ToolBlock, style?: () => FadeStyle, shown = 0): FlowClock {
  const { flow, advance } = flowClock(shown)
  block.setFlow(flow, style)
  block.render(40)
  return { flow, frame: (ms) => { advance(ms); block.revealFrame() } }
}

describe('blocks', () => {
  it('wraps a long prompt under its marker', () => {
    const block = new UserBlock(theme, 'one two three four', 1)
    expect(block.render(10)).toEqual(['', '❯ one two', '  three', '  four'])
    block.invalidate()
  })

  it('draws a recognized credential masked while the section keeps the sent text', () => {
    const key = `sk-${'a1b2c3d4e5f6g7h8i9j0'}`
    const block = new UserBlock(theme, `use ${key} now`, 1)
    const drawn = block.render(60).join('\n')
    expect(drawn).toContain('use sk-a1b2c')
    expect(drawn).toContain('*')
    expect(drawn).not.toContain(key)
    expect(block.parts()).toEqual([{ kind: 'user', rows: [`use ${key} now`] }])
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

  it('draws a tool card header with the status-coloured glyph, the name in the tool colour, and the title in the subject colour', () => {
    const on = createPalette(true)
    const block = new ToolBlock({ ...theme, palette: on }, 'edit', { title: 'src/a.ts', lines: [] }, 1)
    expect(block.render(40)[1]).toBe(`${on.warning('◆')} ${on.bold(on.tool('edit'))} ${on.subject('src/a.ts')}`)
    block.setResult([], true)
    expect(block.render(40)[1]?.startsWith(on.error('◆'))).toBe(true)
  })

  it('draws a steered or injected prompt dim on a darker band', () => {
    const on = createPalette(true)
    const block = new UserBlock({ ...theme, palette: on }, 'change course', 1, 'injected')
    const lines = block.render(20)
    expect(lines[0]).toBe('')
    expect(lines[1]).toBe(on.injectedBand(`${on.dim('❯ change course')}     `))
    expect(block.render(10).slice(1)).toEqual([
      on.injectedBand(`${on.dim('❯ change')}  `),
      on.injectedBand(`${on.dim('  course')}  `),
    ])
    expect(new UserBlock({ ...theme, palette: on }, 'change course', 1).render(20)[1]?.startsWith('\u001b[48;5;236m')).toBe(true)
  })

  it('spins a running card glyph until the result lands', () => {
    const on = createPalette(true)
    const block = new ToolBlock({ ...theme, palette: on }, 'bash', { title: 'ls', lines: [] }, 1)
    let frame = '⠋'
    block.setSpinner(() => frame)
    expect(block.spinning()).toBe(true)
    expect(block.render(40)[1]).toBe(`${on.warning('⠋')} ${on.bold(on.tool('bash'))} ${on.subject('ls')}`)
    frame = '⠙'
    expect(block.render(40)[1]?.startsWith(on.warning('⠙'))).toBe(true)
    block.setResult(['ok'], false)
    expect(block.spinning()).toBe(false)
    expect(block.render(40)[1]?.startsWith(on.success('◆'))).toBe(true)
  })

  it('spins a folded subagent row glyph like a card header', () => {
    const on = createPalette(true)
    const block = new ToolBlock({ ...theme, palette: on }, 'subagent', { title: '', lines: [] }, 1)
    block.setSubagent({ description: 'Rank', meta: [] })
    block.setSpinner(() => '⠹')
    expect(block.render(40)[1]?.startsWith(on.warning('⠹'))).toBe(true)
  })

  it('stops spinning once the header leaves the repaint window, and says the frame changed', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: [] }, 1)
    block.setSpinner(() => '⠋')
    expect(block.setRepaintFloor(1)).toBe(false)
    expect(block.render(40)[1]).toBe('⠋ bash ls')
    expect(block.setRepaintFloor(2)).toBe(true)
    expect(block.spinning()).toBe(false)
    expect(block.render(40)[1]).toBe('◆ bash ls')
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

  it('fills a changed row with its own tint and paints the sign apart from it', () => {
    const palette = createPalette(true)
    const colored = { ...theme, palette }
    const block = new ToolBlock(colored, 'edit', {
      title: 'Edit a.ts',
      lines: ['a.ts', '- old', '+ fresh'],
      diff: [undefined, 'removed', 'added'],
    }, 1)
    block.setExpanded(true)
    const shown = block.render(40).join('\n')
    // The card's rows lay out four columns in from its own width.
    expect(shown).toContain(palette.removedBand(`${palette.removedSign('-')} old${' '.repeat(36 - '- old'.length)}`))
    expect(shown).toContain(palette.addedBand(`${palette.addedSign('+')} fresh${' '.repeat(36 - '+ fresh'.length)}`))
    // A row the card's own presentation did not mark is filled by nothing.
    const unmarked = new ToolBlock(colored, 'bash', { title: '', lines: ['- not a diff'] }, 1)
    unmarked.setExpanded(true)
    expect(unmarked.render(40).join('\n')).toContain('- not a diff')
    expect(unmarked.render(40).join('\n')).not.toContain(palette.removedBand(''))
  })

  it('fills the changed rows of a diff card and leaves a fold marker outside every fill', () => {
    const block = new ToolBlock(theme, 'edit', {
      title: 'Edit a.ts',
      lines: ['a.ts', '- old', '+ fresh'],
      diff: [undefined, 'removed', 'added'],
    }, 1)
    block.setExpanded(true)
    // The palette draws no colour here, so the fill costs the rows nothing.
    expect(block.render(20)).toEqual([
      '',
      '◆ edit Edit a.ts',
      '  │ a.ts',
      '  │ - old',
      '  │ + fresh',
      '  │ …',
    ])
    block.setResult(['a.ts', '  one', '+ two', '+ three'], false, undefined, [undefined, undefined, 'added', 'added'])
    expect(block.render(20)).toEqual([
      '',
      '◆ edit Edit a.ts',
      '  │ a.ts',
      '  │   one',
      '  │ + two',
      '  │ + three',
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

  it('draws a call moved to the background with its job row, folded as a subagent row or open as a card', () => {
    const block = new ToolBlock(theme, 'subagent', { title: '', lines: [] }, 1)
    block.setSubagent({ description: 'Rank endpoints', meta: [] })
    block.setBackground(['◇ moved to the background as tool-1 · /jobs lists it'])
    expect(block.render(40).at(-1)).toMatch(/ \[background\]$/)
    block.setExpanded(true)
    expect(block.render(60)).toContain('  │ ◇ moved to the background as tool-1 · /jobs lists it')
    expect(block.parts().at(-1)).toEqual({ kind: 'result', rows: ['◇ moved to the background as tool-1 · /jobs lists it'] })
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

  it('floats the freshly drawn columns of a card out, each run at its own age', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    block.setResult(['out'], false)
    const { frame } = flowOut(block, () => FADE)
    // Rows are 9, 11, and 7 columns; 9 ms at two columns per millisecond draws 18 of the 27,
    // so the front stands inside the second row.
    frame(9)
    expect(block.render(40)).toEqual([
      '',
      '\u001b[2m\u25c6 bash ls\u001b[22m',
      '\u001b[2m  \u2502 cwd: \u001b[22m',
    ])
    frame(5)
    // The row the first frame left unfinished now holds two runs, each drawn at its own age.
    expect(block.render(40)).toEqual([
      '',
      '\u001b[2m\u25c6 bash ls\u001b[22m',
      '\u001b[2m  \u2502 cwd: \u001b[22m\u001b[2m/w\u001b[22m',
      '\u001b[2m  \u2502 out\u001b[22m',
    ])
  })

  it('colors the columns of one row by when they were drawn', () => {
    const style: FadeStyle = {
      capability: 'truecolor',
      ramp: [{ r: 0, g: 0, b: 0 }, { r: 80, g: 80, b: 80 }, { r: 160, g: 160, b: 160 }, { r: 240, g: 240, b: 240 }],
    }
    const block = new ToolBlock(theme, 'bash', { title: 'ls -la /tmp', lines: [] }, 1)
    const { frame } = flowOut(block, () => style)
    frame(3)
    frame(3)
    const row = block.render(40)[1] ?? ''
    const colors = [...row.matchAll(/\u001b\[38;2;(\d+);/g)].map(match => Number(match[1]))
    // The run drawn first has climbed further toward the settled color than the one drawn last.
    expect(colors.length).toBeGreaterThanOrEqual(2)
    expect(colors[0]).toBeGreaterThan(colors.at(-1) as number)
    expect(row.replace(/\u001b\[[0-9;]*m/g, '')).toBe('\u25c6 bash ls -l')
  })

  it('draws a cut row without the columns past the front, and the rows after it not at all', () => {
    const block = new ToolBlock({ ...theme, palette: createPalette(true) }, 'bash', { title: '', lines: ['alpha beta'] }, 1)
    block.setResult(['gamma'], false)
    const { frame } = flowOut(block, undefined, 0)
    frame(8)
    const drawn = block.render(40).map(line => line.replace(/\u001b\[[0-9;]*m/g, ''))
    expect(drawn).toEqual(['', '\u25c6 bash', '  \u2502 alpha '])
  })

  it('draws a card whole once its flow caught up and the trail receded', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: [] }, 1)
    const { frame } = flowOut(block, () => FADE)
    frame(10)
    expect(block.revealing()).toBe(true)
    const trailing = block.render(40)
    expect(trailing.every(line => line.includes('\u001b[2m') || line === '')).toBe(true)
    frame(100)
    frame(100)
    expect(block.revealFrame()).toBe(false)
    expect(block.revealing()).toBe(false)
    expect(block.render(40)).toEqual(['', '\u25c6 bash ls', '  \u2502 \u2026'])
  })

  it('flows without color when the card is given no style, or the terminal draws none', () => {
    const plain = new ToolBlock(theme, 'bash', { title: 'ls', lines: [] }, 1)
    const { frame } = flowOut(plain)
    frame(100)
    expect(plain.render(40)).toEqual(['', '\u25c6 bash ls', '  \u2502 \u2026'])

    const none = new ToolBlock(theme, 'bash', { title: 'ls', lines: [] }, 1)
    const { frame: noneFrame } = flowOut(none, () => ({ capability: 'none', ramp: [] }))
    noneFrame(100)
    expect(none.render(40)).toEqual(['', '\u25c6 bash ls', '  \u2502 \u2026'])
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

  it('spins the live Thinking header through its frame, and settles it once reasoning is done', () => {
    const block = new AssistantBlock(theme, 1)
    block.appendReasoning('thinking hard')
    expect(block.spinning()).toBe(false)
    expect(block.render(40)[1]).toContain('✻ Thinking')
    block.setReasoningSpinner(() => '✼')
    expect(block.spinning()).toBe(true)
    expect(block.render(40)[1]).toContain('✼ Thinking')
    block.setReasoningSpinner(undefined)
    expect(block.spinning()).toBe(false)
    expect(block.render(40)[1]).toContain('✻ Thinking')
    block.commit('reply', 'thinking hard', false)
    block.setReasoningSpinner(() => '✼')
    expect(block.spinning()).toBe(false)
    expect(block.render(40)[1]).toContain('✻ Thinking')
  })

  it('stops spinning a header the repaint floor took, and never resumes it', () => {
    const block = new AssistantBlock(theme, 1)
    block.appendReasoning('thinking hard')
    block.setReasoningSpinner(() => '✼')
    block.render(40)
    expect(block.setRepaintFloor(2)).toBe(true)
    expect(block.spinning()).toBe(false)
    expect(block.render(40)[1]).toContain('✻ Thinking')
    // The floor stays; a later header frame is dropped, not resumed.
    block.setReasoningSpinner(() => '✽')
    block.render(40)
    expect(block.spinning()).toBe(false)
    expect(block.render(40)[1]).toContain('✻ Thinking')
    expect(block.setRepaintFloor(1)).toBe(false)
  })

  it('keeps the trail off the rows above the repaint floor', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    block.setResult(['out'], false)
    const { frame } = flowOut(block, () => FADE)
    frame(14)
    expect(block.setRepaintFloor(2)).toBe(true)
    expect(block.render(40)).toEqual([
      '',
      '\u25c6 bash ls',
      '\u001b[2m  \u2502 cwd: /w\u001b[22m',
      '\u001b[2m  \u2502 out\u001b[22m',
    ])
  })

  it('never lowers a card floor and reports no change while its flow is settled', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    const { frame } = flowOut(block, () => FADE)
    frame(14)
    expect(block.setRepaintFloor(2)).toBe(true)
    expect(block.setRepaintFloor(1)).toBe(false)
    // The header sits at index 1, which the floor of 2 keeps out of the trail.
    expect(block.render(40)[1]).toBe('\u25c6 bash ls')

    const settled = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
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
  it('reuses sections until their block content changes', () => {
    const user = new UserBlock(theme, 'prompt', 1)
    expect(user.parts()).toBe(user.parts())

    const assistant = new AssistantBlock(theme, 1)
    const initial = assistant.parts()
    expect(assistant.parts()).toBe(initial)
    assistant.appendText('reply')
    const streamed = assistant.parts()
    expect(streamed).not.toBe(initial)
    expect(assistant.parts()).toBe(streamed)

    const tool = new ToolBlock(theme, 'read', { title: '', lines: [] }, 1)
    const call = tool.parts()
    expect(tool.parts()).toBe(call)
    tool.setCall('read', { title: 'file.ts', lines: [] })
    const changedCall = tool.parts()
    expect(changedCall).not.toBe(call)
    expect(tool.parts()).toBe(changedCall)
    tool.setResult(['contents'], false)
    const result = tool.parts()
    expect(result).not.toBe(changedCall)
    expect(tool.parts()).toBe(result)
  })

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

  it('prepends the gutter after the flow, so the trail keeps matching the card own text', () => {
    const block = new ToolBlock(theme, 'bash', { title: 'ls', lines: ['cwd: /w'] }, 1)
    const { frame } = flowOut(block, () => FADE)
    frame(13)
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

  it('draws a flowing card over the card body without rebuilding it', () => {
    const { highlight, counter } = countingHighlighter()
    const block = new ToolBlock({ ...theme, palette: createPalette(true), codeHighlight: highlight }, 'read', { title: 'a.ts', lines: [] }, 1)
    block.setResult(READ_ROWS, false, READ_CODE)
    const settled = block.render(40)
    const { frame } = flowOut(block, () => FADE, 0)
    frame(10)
    const faded = block.render(40)
    expect(faded).not.toEqual(settled)
    expect(faded.at(-1)).toContain('\u001b[2m')
    frame(200)
    frame(200)
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

  it('dims user-shell output and renders complete JSON output as a colored tree', () => {
    const palette = createPalette(true)
    const { highlight } = countingHighlighter()
    const shell = new UserShellBlock({ ...theme, palette, codeHighlight: highlight }, 'echo hi', ['$ echo hi', 'out'])
    expect(shell.render(40)).toEqual(['', `${palette.accent('$')} «echo hi»`, palette.dim('out'), ''])
    const json = new UserShellBlock({ ...theme, palette }, 'echo json', ['$ echo json', '{"ok":true}', '(exit 2)'])
    expect(json.render(40)).toEqual([
      '',
      `${palette.accent('$')} echo json`,
      `${palette.dim('╰─ ')}${palette.tool('ok')}: ${palette.link('true')}`,
      palette.dim('(exit 2)'),
      '',
    ])
  })

  it('dims model-shell output and keeps JSON styling off the fold marker', () => {
    const palette = createPalette(true)
    const shell = new ToolBlock({ ...theme, palette }, 'bash', { title: '', lines: [] }, 1)
    shell.setResult(['out'], false, undefined, undefined, { shellOutput: true })
    expect(shell.render(40)[2]).toBe(`  ${palette.dim('│')} ${palette.dim('out')}`)

    const tree = jsonTreeText('{"ok":true,"items":[1,2]}')
    if (tree === undefined) throw new Error('expected JSON tree')
    const json = new ToolBlock({ ...theme, palette, toolPreviewLines: 2 }, 'mystery', { title: '', lines: [] }, 1)
    json.setResult(tree.lines, false, undefined, undefined, { json: tree.json, shellOutput: true })
    const rendered = json.render(80)
    expect(rendered[2]).toBe(`  ${palette.dim('│')} ${palette.dim('├─ ')}${palette.tool('ok')}: ${palette.link('true')}`)
    expect(rendered.at(-1)).toBe(`  ${palette.dim('│')} … 2 more rows · ${palette.italic(palette.accent('Ctrl+O'))} expands`)
    expect(json.parts()[1]).toMatchObject({ kind: 'result', rows: tree.lines, json: tree.json, shellOutput: true })
    const titledCall = new ToolBlock({ ...theme, palette }, 'mystery', { title: 'JSON', lines: tree.lines, json: tree.json }, 1)
    expect(titledCall.parts()[0]).toMatchObject({ kind: 'call', json: [undefined, ...tree.json] })
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

describe('flowing a tool card out', () => {
  const ROWS = ['one', 'two', 'three']

  it('draws only the reached columns, row after row, and reports what is still to flow', () => {
    const block = new ToolBlock({ ...theme, toolPreviewLines: 8 }, 'bash', { title: 'ls', lines: [] }, 1)
    expect(block.revealing()).toBe(false)
    expect(block.revealFrame()).toBe(false)
    const { flow, advance } = flowClock(1)
    block.setFlow(flow)
    // A flow the card has not rendered under waits for the render to measure it.
    expect(block.revealing()).toBe(true)
    expect(block.revealFrame()).toBe(true)
    expect(block.render(40)).toEqual(['', '\u25c6'])
    expect(block.revealing()).toBe(true)

    // The header is nine columns: the front crosses four of them in two milliseconds.
    advance(2)
    expect(block.revealFrame()).toBe(true)
    expect(block.render(40)).toEqual(['', '\u25c6 bas'])
    // The next row starts after the header; a row is drawn from its first column.
    advance(4)
    block.revealFrame()
    expect(block.render(40)).toEqual(['', '\u25c6 bash ls', '  \u2502 '])
    advance(1)
    block.revealFrame()
    expect(block.render(40)).toEqual(['', '\u25c6 bash ls', '  \u2502 \u2026'])
    // Nothing is left to draw, and with no color there is no trail to wait for.
    expect(block.revealFrame()).toBe(false)
    expect(block.revealing()).toBe(false)

    // The result replaces the loading row, so the front, which stood at its end, stands inside the first result row.
    block.setResult(ROWS, false)
    expect(block.revealing()).toBe(true)
    expect(block.render(40)).toEqual(['', '\u25c6 bash ls', '  \u2502 o'])
    expect(block.revealFrame()).toBe(true)
    advance(8)
    block.revealFrame()
    expect(block.render(40)).toEqual(['', '\u25c6 bash ls', '  \u2502 one', '  \u2502 two', '  \u2502 thr'])
    advance(8)
    block.revealFrame()
    expect(block.render(40)).toEqual(['', '\u25c6 bash ls', '  \u2502 one', '  \u2502 two', '  \u2502 three'])
  })

  it('keeps its own pace when a result lands while the header still flows', () => {
    const block = new ToolBlock({ ...theme, toolPreviewLines: 8 }, 'bash', { title: 'ls', lines: [] }, 1)
    const { flow, advance } = flowClock(0)
    block.setFlow(flow)
    block.render(40)
    advance(2)
    block.revealFrame()
    // The card holds the result at once, and the front carries on through the header into the rows behind it.
    block.setResult(ROWS, false)
    expect(block.parts()).toEqual([{ kind: 'call', rows: ['ls'] }, { kind: 'result', rows: ROWS }])
    expect(block.render(40)).toEqual(['', '\u25c6 ba'])
    advance(2)
    block.revealFrame()
    expect(block.render(40)).toEqual(['', '\u25c6 bash l'])
    advance(2)
    block.revealFrame()
    expect(block.render(40)).toEqual(['', '\u25c6 bash ls', '  \u2502'])
  })

  it('draws every row once the card unfolds', () => {
    const block = new ToolBlock({ ...theme, toolPreviewLines: 8 }, 'bash', { title: 'ls', lines: [] }, 1)
    block.setFlow(flowClock(1).flow)
    block.setResult(ROWS, false)
    expect(block.render(40)).toHaveLength(2)
    block.setExpanded(false)
    expect(block.render(40)).toHaveLength(2)
    block.setExpanded(true)
    expect(block.render(40)).toHaveLength(5)
    expect(block.revealing()).toBe(false)
  })

  it('draws every column once the flowing row is above the repaintable lines', () => {
    const block = new ToolBlock({ ...theme, toolPreviewLines: 8 }, 'bash', { title: 'ls', lines: [] }, 1)
    block.setFlow(flowClock(1).flow)
    block.setResult(ROWS, false)
    block.render(40)
    // The front is in the header, line 1 of the card, so a floor at it can still follow the front.
    expect(block.setRepaintFloor(1)).toBe(false)
    expect(block.render(40)).toHaveLength(2)
    expect(block.setRepaintFloor(2)).toBe(true)
    expect(block.render(40)).toHaveLength(5)
    expect(block.setRepaintFloor(3)).toBe(false)
  })

  it('flows a focused card with its gutter', () => {
    const block = new ToolBlock({ ...theme, toolPreviewLines: 8 }, 'bash', { title: 'ls', lines: [] }, 1)
    const { flow, advance } = flowClock(1)
    block.setFlow(flow)
    block.setResult(ROWS, false)
    block.setHighlight(1)
    expect(block.render(40)).toEqual(['\u2502 ', '\u2502 \u25c6'])
    advance(8)
    block.revealFrame()
    block.render(40)
    advance(7)
    block.revealFrame()
    expect(block.render(40)).toEqual(['\u2502 ', '\u2502 \u25c6 bash ls', '\u2503   \u2502 one', '\u2503   \u2502 two', '\u2503   \u2502 thre'])
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
