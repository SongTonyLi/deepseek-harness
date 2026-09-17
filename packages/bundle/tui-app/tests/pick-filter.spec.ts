/** A picker's type-to-filter query narrows, orders, and restores its rows. */

import { describe, expect, it } from 'vitest'
import { PickPrompt, type PickItem } from '../src/prompts.ts'
import { createPalette } from '../src/style.ts'
import { KEY } from './bench.ts'

const palette = createPalette(false)

/** Keys the query reads, as the raw bytes a terminal sends. */
const BACKSPACE = '\u007f'
const CTRL_U = '\u0015'
/** Kitty CSI-u encodings of plain `c` and `h`, sent by terminals in disambiguate mode. */
const KITTY_C = '\u001b[99u'
const KITTY_H = '\u001b[104u'

/** What the filter line says while the query is empty. */
const HINT = 'type to filter · Enter selects · Esc cancels'

const models: PickItem[] = [
  { value: 'anthropic/claude-haiku', label: 'anthropic/claude-haiku', description: 'fast tool use' },
  { value: 'deepseek/deepseek-chat', label: 'deepseek/deepseek-chat', description: 'general chat model' },
  { value: 'deepseek/deepseek-reasoner', label: 'deepseek/deepseek-reasoner', description: 'thinking model' },
  { value: 'openai/gpt-5', label: 'openai/gpt-5', description: 'frontier model' },
  { value: 'local/llama', label: 'local/llama' },
]

const WIDTH = 60

/** The drawn lines: a blank, the heading, any body rows, the filter line, then the rows. */
const screen = (prompt: PickPrompt): string[] => prompt.render(WIDTH).map(line => line.trimEnd())

/** The filter line of a picker drawn without body rows. */
const filterLine = (prompt: PickPrompt): string => screen(prompt)[2]!

/** The first column of each line under the filter line: a row label with `→` when highlighted, or the whole line. */
const rows = (prompt: PickPrompt): string[] => screen(prompt).slice(3).map(line => line.trim().split(/ {2,}/u)[0]!)

/** Type `text` one character at a time, as a terminal delivers it. */
const type = (prompt: PickPrompt, text: string): void => {
  for (const character of text) prompt.handleInput(character)
}

describe('pick filter', () => {
  it('narrows the rows to the query and highlights the best match', () => {
    const prompt = new PickPrompt(palette, 'Model', models)
    expect(filterLine(prompt)).toBe(HINT)
    expect(rows(prompt)[0]).toBe('→ anthropic/claude-haiku')
    type(prompt, 'chat')
    expect(filterLine(prompt)).toBe('filter: chat · 2/5')
    expect(rows(prompt)).toEqual(['→ deepseek/deepseek-chat', 'anthropic/claude-haiku'])
  })

  it('matches whitespace- and slash-separated tokens across the label and the description', () => {
    const spaced = new PickPrompt(palette, 'Model', models)
    type(spaced, 'dsk chat')
    expect(rows(spaced)).toEqual(['→ deepseek/deepseek-chat'])
    const slashed = new PickPrompt(palette, 'Model', models)
    type(slashed, 'deepseek/chat')
    expect(rows(slashed)).toEqual(['→ deepseek/deepseek-chat'])
    const digits = new PickPrompt(palette, 'Model', models)
    type(digits, 'gpt5')
    expect(rows(digits)).toEqual(['→ openai/gpt-5'])
    const described = new PickPrompt(palette, 'Model', models)
    type(described, 'deepseek thinking')
    expect(rows(described)).toEqual(['→ deepseek/deepseek-reasoner'])
    const undescribed = new PickPrompt(palette, 'Model', models)
    type(undescribed, 'llama')
    expect(rows(undescribed)).toEqual(['→ local/llama'])
  })

  it('reads printable keys sent as Kitty CSI-u sequences', () => {
    const prompt = new PickPrompt(palette, 'Model', models)
    prompt.handleInput(KITTY_C)
    prompt.handleInput(KITTY_H)
    expect(filterLine(prompt)).toBe('filter: ch · 2/5')
  })

  it('restores rows as Backspace shortens the query and Ctrl+U clears it', () => {
    const prompt = new PickPrompt(palette, 'Model', models)
    type(prompt, 'deepseek chat')
    expect(rows(prompt)).toEqual(['→ deepseek/deepseek-chat'])
    for (let press = 0; press < 5; press += 1) prompt.handleInput(BACKSPACE)
    expect(filterLine(prompt)).toBe('filter: deepseek · 2/5')
    expect(rows(prompt)).toEqual(['→ deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'])
    prompt.handleInput(CTRL_U)
    expect(filterLine(prompt)).toBe(HINT)
    expect(rows(prompt)).toHaveLength(models.length)
  })

  it('clears a non-empty query on Escape and cancels once the query is empty', async () => {
    const prompt = new PickPrompt(palette, 'Model', models)
    type(prompt, 'gpt')
    expect(rows(prompt)).toEqual(['→ openai/gpt-5'])
    prompt.handleInput(KEY.escape)
    expect(filterLine(prompt)).toBe(HINT)
    expect(rows(prompt)).toHaveLength(models.length)
    prompt.handleInput(KEY.escape)
    await expect(prompt.settled).resolves.toBeUndefined()
  })

  it('settles the highlighted filtered row with the item it came from', async () => {
    const prompt = new PickPrompt(palette, 'Model', models, { current: 'openai/gpt-5' })
    type(prompt, 'model')
    expect(rows(prompt)).toEqual(['→ openai/gpt-5', 'deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'])
    prompt.handleInput(KEY.down)
    prompt.handleInput(KEY.enter)
    await expect(prompt.settled).resolves
      .toEqual({ value: 'deepseek/deepseek-chat', label: 'deepseek/deepseek-chat', description: 'general chat model' })
  })

  it('marks and preselects the row in force only while the query is empty', () => {
    const prompt = new PickPrompt(palette, 'Model', models, { current: 'deepseek/deepseek-reasoner' })
    const opened = [
      'anthropic/claude-haiku',
      'deepseek/deepseek-chat',
      '→ deepseek/deepseek-reasoner ✓',
      'openai/gpt-5',
      'local/llama',
    ]
    expect(rows(prompt)).toEqual(opened)
    type(prompt, 'deepseek')
    expect(rows(prompt)).toEqual(['→ deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'])
    prompt.handleInput(CTRL_U)
    expect(rows(prompt)).toEqual(opened)
  })

  it('draws a dim row naming the query when no row matches', () => {
    const prompt = new PickPrompt(palette, 'Model', models)
    type(prompt, 'zzz')
    expect(filterLine(prompt)).toBe('filter: zzz · 0/5')
    expect(rows(prompt)).toEqual(['no row matches "zzz"'])
    const colored = new PickPrompt(createPalette(true), 'Model', models)
    colored.handleInput('z')
    expect(colored.render(WIDTH).slice(2, 4)).toEqual(['\u001b[2mfilter: z · 0/5\u001b[22m', '\u001b[2m  no row matches "z"\u001b[22m'])
  })

  it('keeps the scrolling window when a query rebuilds the list', () => {
    const many: PickItem[] = Array.from({ length: 12 }, (_, index) => ({ value: `p/m-${index}`, label: `p/m-${index}` }))
    const prompt = new PickPrompt(palette, 'Model', many)
    const opened = rows(prompt)
    expect(opened).toHaveLength(9)
    expect(opened.at(-1)).toBe('(1/12)')
    type(prompt, 'm')
    expect(filterLine(prompt)).toBe('filter: m · 12/12')
    const filtered = rows(prompt)
    expect(filtered).toHaveLength(9)
    expect(filtered[0]).toBe('→ p/m-0')
    expect(filtered.at(-1)).toBe('(1/12)')
  })

  it('draws the filter line under the body rows and leaves the other keys to the list', () => {
    const prompt = new PickPrompt(palette, 'Effort', models, { body: ['current: High'] })
    expect(screen(prompt).slice(0, 4)).toEqual(['', '? Effort', '  current: High', HINT])
    prompt.handleInput(KEY.down)
    prompt.handleInput(KEY.down)
    expect(screen(prompt)[6]!.trim()).toMatch(/^→ deepseek\/deepseek-reasoner/u)
    prompt.handleInput(BACKSPACE)
    expect(screen(prompt)[6]!.trim()).toMatch(/^→ deepseek\/deepseek-reasoner/u)
    prompt.handleInput(KEY.up)
    expect(screen(prompt)[5]!.trim()).toMatch(/^→ deepseek\/deepseek-chat/u)
  })
})
