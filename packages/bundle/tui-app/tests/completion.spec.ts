/** Editor completion: slash commands on the first token and `@` references anywhere. */

import { describe, expect, it } from 'vitest'
import { editorCompletion, type ReferenceItem } from '../src/completion.ts'

const references: ReferenceItem[] = [
  { mention: '@src/app.ts', label: 'src/app.ts', description: 'file' },
  { mention: '@"session:session-1"', label: 'Older chat' },
]
const queries: { query: string; quoted: boolean }[] = []
const provider = editorCompletion({
  commands: () => [
    { name: 'help', description: 'Show help' },
    { name: 'model', description: 'Pick a model' },
  ],
  references: (query, quoted) => {
    queries.push({ query, quoted })
    return Promise.resolve(query === 'none' ? [] : references)
  },
})
const options = { signal: new AbortController().signal }

describe('editor completion', () => {
  it('suggests commands for the first token of the first line only', async () => {
    await expect(provider.getSuggestions(['/'], 0, 1, options)).resolves.toEqual({
      prefix: '/',
      items: [
        { value: '/help', label: '/help', description: 'Show help' },
        { value: '/model', label: '/model', description: 'Pick a model' },
      ],
    })
    await expect(provider.getSuggestions(['/mo'], 0, 3, options)).resolves.toEqual({
      prefix: '/mo',
      items: [{ value: '/model', label: '/model', description: 'Pick a model' }],
    })
    await expect(provider.getSuggestions(['/zzz'], 0, 4, options)).resolves.toBeNull()
    await expect(provider.getSuggestions(['/help now'], 0, 9, options)).resolves.toBeNull()
    await expect(provider.getSuggestions(['text', '/he'], 1, 3, options)).resolves.toBeNull()
    await expect(provider.getSuggestions(['hello'], 0, 5, options)).resolves.toBeNull()
    await expect(provider.getSuggestions([], 0, 0, options)).resolves.toBeNull()
  })

  it('offers references for the @ token under the cursor, on any line', async () => {
    queries.length = 0
    await expect(provider.getSuggestions(['first', 'see @src/a'], 1, 10, options)).resolves.toEqual({
      prefix: '@src/a',
      items: [
        { value: '@src/app.ts', label: 'src/app.ts', description: 'file' },
        { value: '@"session:session-1"', label: 'Older chat' },
      ],
    })
    await expect(provider.getSuggestions(['@"old'], 0, 5, options)).resolves.toMatchObject({ prefix: '@"old' })
    await expect(provider.getSuggestions(['@none'], 0, 5, options)).resolves.toBeNull()
    expect(queries).toEqual([
      { query: 'src/a', quoted: false },
      { query: 'old', quoted: true },
      { query: 'none', quoted: false },
    ])
  })

  it('replaces the typed prefix with the completion and a trailing space', () => {
    expect(provider.applyCompletion(['/mo tail'], 0, 3, { value: '/model', label: '/model' }, '/mo'))
      .toEqual({ lines: ['/model  tail'], cursorLine: 0, cursorCol: 7 })
    expect(provider.applyCompletion([], 0, 0, { value: '/help', label: '/help' }, ''))
      .toEqual({ lines: ['/help '], cursorLine: 0, cursorCol: 6 })
    expect(provider.applyCompletion(['a', 'see @src/a'], 1, 10, { value: '@src/app.ts', label: 'src/app.ts' }, '@src/a'))
      .toEqual({ lines: ['a', 'see @src/app.ts '], cursorLine: 1, cursorCol: 16 })
  })
})
