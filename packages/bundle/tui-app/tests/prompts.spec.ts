/** Modal prompts settle once, and the queue shows one at a time. */

import { describe, expect, it } from 'vitest'
import { Container, type TUI } from '@earendil-works/pi-tui'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { ApprovalPrompt, DetailPrompt, ModalQueue, PickPrompt, QuestionPrompt } from '../src/prompts.ts'
import { createPalette } from '../src/style.ts'
import { KEY } from './bench.ts'

const palette = createPalette(false)

describe('prompts', () => {
  it('settles an approval once and ignores later answers', async () => {
    const prompt = new ApprovalPrompt(palette, 'bash', undefined)
    expect(prompt.render(40).join('\n')).toContain('Allow bash?')
    prompt.handleInput(KEY.enter)
    await expect(prompt.settled).resolves.toBe('allowed-once')
    prompt.withdraw()
    prompt.handleInput(KEY.down)
    prompt.handleInput(KEY.enter)
    prompt.invalidate()
    await expect(prompt.settled).resolves.toBe('allowed-once')
  })

  it('shows the call detail under the approval heading and folds long detail', () => {
    const bare = new ApprovalPrompt(palette, 'bash', 'policy asks', [])
    const detailed = new ApprovalPrompt(palette, 'bash', 'policy asks', ['rm -rf build', 'cwd: /work'])
    const bareLines = bare.render(40).map(line => line.trimEnd())
    const lines = detailed.render(40).map(line => line.trimEnd())
    expect(bareLines).toEqual(['', '? Allow bash?', 'policy asks', ...bareLines.slice(3)])
    expect(lines.slice(0, 5)).toEqual(['', '? Allow bash?', 'policy asks', '  rm -rf build', '  cwd: /work'])
    expect(lines.slice(5)).toEqual(bareLines.slice(3))
    const long = new ApprovalPrompt(palette, 'bash', undefined, Array.from({ length: 14 }, (_, i) => `row ${String(i)}`))
    const longLines = long.render(40).map(line => line.trimEnd())
    expect(longLines[2]).toBe('  row 0')
    expect(longLines[13]).toBe('  row 11')
    expect(longLines[14]).toBe('  … 2 more lines')
    expect(longLines[15]).toContain('Allow once')
    const one = new ApprovalPrompt(palette, 'bash', undefined, Array.from({ length: 13 }, () => 'row'))
    expect(one.render(40)[14]).toBe('  … 1 more line')
    const wide = new ApprovalPrompt(palette, 'bash', undefined, ['a'.repeat(30)])
    expect(wide.render(20).slice(2, 4)).toEqual([`  ${'a'.repeat(18)}`, `  ${'a'.repeat(12)}`])
  })

  it('renders question detail as Markdown under the question', () => {
    const prompt = new QuestionPrompt(palette, { id: 'q', header: 'Setup', question: 'Pick', detail: '# Plan\n\n- first\n- second', options: [{ label: 'a' }] })
    const lines = prompt.render(40).map(line => line.trimEnd())
    expect(lines.slice(0, 9)).toEqual(['', 'Setup', '? Pick', '', 'Plan', '', '- first', '- second', ''])
    expect(lines[9]).toContain('a')
    prompt.invalidate()
  })

  it('settles a question once', async () => {
    const prompt = new QuestionPrompt(palette, { id: 'q', question: 'Pick', options: [{ label: 'a' }] })
    prompt.handleInput(KEY.enter)
    await expect(prompt.settled).resolves.toEqual({ id: 'q', selected: ['a'] })
    prompt.withdraw()
    prompt.invalidate()
    await expect(prompt.settled).resolves.toEqual({ id: 'q', selected: ['a'] })
  })

  describe('plan review', () => {
    type Option = { label: string; description?: string }
    const plan = (options: Option[], approve: string, extra: Partial<AskUserQuestionItem> = {}): QuestionPrompt =>
      new QuestionPrompt(palette, { id: 'plan', question: 'Proceed?', detail: '## Steps\n\n1. build', options, intent: { kind: 'plan-review', approve }, ...extra })

    it('maps Approve to the intent-named option and Decline to the other one', async () => {
      const rendered = plan([{ label: 'Go' }, { label: 'No', description: 'stop here' }], 'No').render(60).map(line => line.trimEnd())
      expect(rendered.slice(0, 7)).toEqual(['', '? Proceed?', '', 'Steps', '', '1. build', ''])
      const rows = rendered.slice(7).join('\n')
      expect(rows).toContain('Approve')
      expect(rows).toContain('stop here')
      expect(rows).toContain('Decline')
      expect(rows).toContain('Go')
      expect(rows).toContain('Discuss')
      expect(rows).not.toContain('Type an answer')
      const approve = plan([{ label: 'Go' }, { label: 'No' }], 'No')
      approve.handleInput(KEY.enter)
      await expect(approve.settled).resolves.toEqual({ id: 'plan', selected: ['No'] })
      const decline = plan([{ label: 'Go' }, { label: 'No' }], 'No')
      decline.handleInput(KEY.down)
      decline.handleInput(KEY.enter)
      await expect(decline.settled).resolves.toEqual({ id: 'plan', selected: ['Go'] })
    })

    it('dismisses on Discuss or Escape so the user can reply in the composer', async () => {
      const discuss = plan([{ label: 'Approve' }, { label: 'Reject' }], 'Approve')
      expect(discuss.render(60).join('\n')).not.toMatch(/Approve\s+Approve/u)
      discuss.handleInput(KEY.down)
      discuss.handleInput(KEY.down)
      discuss.handleInput(KEY.enter)
      await expect(discuss.settled).resolves.toBeNull()
      const escaped = plan([{ label: 'Approve' }], 'Approve')
      const rows = escaped.render(60).join('\n')
      expect(rows).toContain('Discuss')
      expect(rows).not.toContain('Decline')
      escaped.handleInput(KEY.escape)
      await expect(escaped.settled).resolves.toBeNull()
    })

    it('keeps the generic list when the intent cannot be answered with two verdicts', () => {
      const generic = (prompt: QuestionPrompt): boolean => prompt.render(60).join('\n').includes('Type an answer')
      expect(generic(plan([{ label: 'Go' }, { label: 'No' }], 'Maybe'))).toBe(true)
      expect(generic(plan([{ label: 'Go' }, { label: 'No' }, { label: 'Later' }], 'Go'))).toBe(true)
      expect(generic(plan([{ label: 'Go' }, { label: 'No' }], 'Go', { multiSelect: true }))).toBe(true)
      expect(generic(plan([{ label: 'Go' }], 'Go', { detail: undefined } as never))).toBe(true)
      const optionless = new QuestionPrompt(palette, { id: 'q', question: 'Pick', detail: 'x', intent: { kind: 'plan-review', approve: 'Go' } })
      expect(optionless.render(60).join('\n')).toContain('Enter answers')
      expect(generic(new QuestionPrompt(palette, { id: 'q', question: 'Pick', detail: 'x', options: [{ label: 'Go' }], intent: { kind: 'plan-review', approve: 'Go' } }))).toBe(false)
    })
  })

  it('settles a pick once', async () => {
    const prompt = new PickPrompt(palette, 'Model', [{ value: 'p/m', label: 'p/m', description: 'big' }])
    expect(prompt.render(40).join('\n')).toContain('p/m')
    prompt.handleInput(KEY.enter)
    await expect(prompt.settled).resolves.toEqual({ value: 'p/m', label: 'p/m', description: 'big' })
    prompt.withdraw()
    prompt.invalidate()
    const cancelled = new PickPrompt(palette, 'Model', [])
    cancelled.handleInput(KEY.escape)
    await expect(cancelled.settled).resolves.toBeUndefined()
  })

  it('opens a pick on the row in force, marks it, and draws the body under the heading', async () => {
    const items = [
      { value: '', label: 'Provider default' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High', description: 'slow' },
    ]
    const marked = new PickPrompt(palette, 'Effort', items, { body: ['current: High'], current: 'high' })
    const lines = marked.render(40).map(line => line.trimEnd())
    expect(lines.slice(0, 3)).toEqual(['', '? Effort', '  current: High'])
    expect(lines.join('\n')).toContain('High ✓')
    expect(lines.join('\n')).not.toContain('Low ✓')
    marked.handleInput(KEY.enter)
    await expect(marked.settled).resolves.toEqual({ value: 'high', label: 'High', description: 'slow' })
    const first = new PickPrompt(palette, 'Effort', items, { current: '' })
    expect(first.render(40).join('\n')).toContain('Provider default ✓')
    first.handleInput(KEY.enter)
    await expect(first.settled).resolves.toEqual({ value: '', label: 'Provider default' })
    const absent = new PickPrompt(palette, 'Effort', items, { current: 'gone' })
    expect(absent.render(40).join('\n')).not.toContain('✓')
  })

  describe('detail page', () => {
    /** Keys the page scrolls with, as the raw bytes a terminal sends. */
    const PAGE_UP = '\u001b[5~'
    const PAGE_DOWN = '\u001b[6~'

    /** What the hint line says while every row fits at once. */
    const HINT = '↑ ↓ scroll · Enter, Esc, or ← returns'

    /** The drawn lines: a blank, the heading, the visible rows, then the hint line. */
    const page = (prompt: DetailPrompt, width = 40): string[] => prompt.render(width).map(line => line.trimEnd())

    /** Twenty numbered rows, four past the visible cap. */
    const numbered = Array.from({ length: 20 }, (_item, index) => `row ${String(index)}`)

    /** Whether the page has settled, once pending microtasks have run. */
    async function hasSettled(prompt: DetailPrompt): Promise<boolean> {
      let settled = false
      void prompt.settled.then(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 0))
      return settled
    }

    it('draws the heading over the rows and names the keys it answers', () => {
      const prompt = new DetailPrompt(palette, 'session-a', ['reviewer', 'running · continuable', 'created: 2026-02-03 14:25'])
      expect(page(prompt)).toEqual(['', 'session-a', 'reviewer', 'running · continuable', 'created: 2026-02-03 14:25', HINT])
      const colored = new DetailPrompt(createPalette(true), 'session-a', ['reviewer'])
      const lines = page(colored)
      expect(lines[1]).toBe('\u001b[1m\u001b[36msession-a\u001b[39m\u001b[22m')
      expect(lines.at(-1)).toBe(`\u001b[2m${HINT}\u001b[22m`)
      prompt.invalidate()
    })

    it('wraps a row too wide for the terminal', () => {
      const prompt = new DetailPrompt(palette, 'session-a', ['presented: report.md', 'a'.repeat(30)])
      expect(page(prompt, 20)).toEqual(['', 'session-a', 'presented: report.md', 'a'.repeat(20), 'a'.repeat(10), HINT])
    })

    it('keeps the rows still while they all fit', () => {
      const prompt = new DetailPrompt(palette, 'session-a', ['first', 'last'])
      prompt.handleInput(KEY.down)
      prompt.handleInput(PAGE_DOWN)
      expect(page(prompt)).toEqual(['', 'session-a', 'first', 'last', HINT])
    })

    it('scrolls the rows past the visible cap and reports the position', () => {
      const prompt = new DetailPrompt(palette, 'session-a', numbered)
      const first = page(prompt)
      expect(first.slice(2, 4)).toEqual(['row 0', 'row 1'])
      expect(first).toHaveLength(19)
      expect(first.at(-2)).toBe('row 15')
      expect(first.at(-1)).toBe(`${HINT} · (1/20)`)
      prompt.handleInput(KEY.down)
      const moved = page(prompt)
      expect(moved[2]).toBe('row 1')
      expect(moved.at(-1)).toBe(`${HINT} · (2/20)`)
      prompt.handleInput(KEY.up)
      prompt.handleInput(KEY.up)
      expect(page(prompt).at(-1)).toBe(`${HINT} · (1/20)`)
      prompt.handleInput(PAGE_DOWN)
      const paged = page(prompt)
      expect(paged[2]).toBe('row 4')
      expect(paged.at(-2)).toBe('row 19')
      expect(paged.at(-1)).toBe(`${HINT} · (5/20)`)
      prompt.handleInput(KEY.down)
      expect(page(prompt).at(-1)).toBe(`${HINT} · (5/20)`)
      prompt.handleInput(PAGE_UP)
      expect(page(prompt).at(-1)).toBe(`${HINT} · (1/20)`)
    })

    it('brings the rows back into view when a wider terminal wraps fewer of them', () => {
      const prompt = new DetailPrompt(palette, 'session-a', Array.from({ length: 6 }, () => 'alpha beta gamma delta epsilon zeta'))
      page(prompt, 12)
      prompt.handleInput(PAGE_DOWN)
      const scrolled = page(prompt, 12).at(-1)
      expect(scrolled).toMatch(/ · \((?!1\/)\d+\/\d+\)$/u)
      expect(page(prompt, 80).at(-1)).toBe(HINT)
    })

    it('settles on Enter, Escape, or Left and ignores every other key', async () => {
      for (const key of [KEY.enter, KEY.escape, KEY.left]) {
        const prompt = new DetailPrompt(palette, 'session-a', numbered)
        prompt.handleInput(key)
        await expect(hasSettled(prompt)).resolves.toBe(true)
      }
      const open = new DetailPrompt(palette, 'session-a', numbered)
      for (const key of [KEY.right, KEY.tab, KEY.space, 'x']) open.handleInput(key)
      await expect(hasSettled(open)).resolves.toBe(false)
      open.withdraw()
      await expect(open.settled).resolves.toBeUndefined()
    })
  })

  it('shows queued prompts in order and restores focus afterwards', async () => {
    const focused: unknown[] = []
    const renders: number[] = []
    const slot = new Container()
    const editor = new Container()
    const tui = {
      setFocus: (component: unknown) => { focused.push(component) },
      requestRender: () => { renders.push(1) },
    } as unknown as TUI
    const queue = new ModalQueue({ tui, slot, focusAfter: editor })
    expect(queue.isActive()).toBe(false)
    const first = new ApprovalPrompt(palette, 'a', undefined)
    const second = new ApprovalPrompt(palette, 'b', undefined)
    const firstDone = queue.run(first)
    const secondDone = queue.run(second)
    await Promise.resolve()
    expect(queue.isActive()).toBe(true)
    expect(slot.children).toEqual([first])
    expect(focused).toEqual([first])
    queue.withdrawActive()
    await expect(firstDone).resolves.toBe('cancelled')
    await Promise.resolve()
    await Promise.resolve()
    expect(slot.children).toEqual([second])
    expect(focused).toEqual([first, editor, second])
    second.handleInput(KEY.enter)
    await expect(secondDone).resolves.toBe('allowed-once')
    expect(slot.children).toEqual([])
    expect(queue.isActive()).toBe(false)
    queue.withdrawActive()
    expect(renders.length).toBeGreaterThan(0)
  })
})
