/** Pure transcript formatting: tool views, usage, notices, and previews. */

import { describe, expect, it } from 'vitest'
import { diffLines, hunks } from '../src/diff.ts'
import {
  EMPTY_USAGE,
  addUsage,
  contentText,
  describeFailure,
  diffRows,
  formatTokens,
  formatUsage,
  parseArguments,
  previewLines,
  toolCallText,
  toolResultLines,
  turnEndNotice,
} from '../src/transcript.ts'

describe('diff', () => {
  it('aligns changed lines and marks a new file as all additions', () => {
    expect(diffLines('a\nb\nc\n', 'a\nx\nc\nd')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'context', text: 'c' },
      { kind: 'added', text: 'd' },
    ])
    expect(diffLines(null, 'one\ntwo')).toEqual([{ kind: 'added', text: 'one' }, { kind: 'added', text: 'two' }])
    expect(diffLines('', '')).toEqual([])
    expect(diffLines('gone', '')).toEqual([{ kind: 'removed', text: 'gone' }])
  })

  it('prefers a removal over an addition when both keep the alignment', () => {
    expect(diffLines('a\nb', 'b\na')).toEqual([
      { kind: 'removed', text: 'a' },
      { kind: 'context', text: 'b' },
      { kind: 'added', text: 'a' },
    ])
  })

  it('falls back to a whole-file replacement above the alignment budget', () => {
    const big = Array.from({ length: 2100 }, (_, index) => `line ${String(index)}`).join('\n')
    const rows = diffLines(big, `${big}\nmore`)
    expect(rows.filter(row => row.kind === 'context')).toHaveLength(0)
    expect(rows.filter(row => row.kind === 'removed')).toHaveLength(2100)
    expect(rows.filter(row => row.kind === 'added')).toHaveLength(2101)
  })

  it('keeps hunks with surrounding context and one gap marker per elision', () => {
    const rows = diffLines('1\n2\n3\n4\n5\n6\n7\n8\n9', '1\n2\n3\nX\n5\n6\n7\n8\nY')
    expect(hunks(rows, 1).map(row => row === undefined ? '…' : `${row.kind[0]!}${row.text}`))
      .toEqual(['…', 'c3', 'r4', 'aX', 'c5', '…', 'c8', 'r9', 'aY'])
  })
})

describe('transcript', () => {
  it('extracts text and summarizes other blocks', () => {
    expect(contentText([
      { type: 'text', text: 'hello' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'image', mimeType: 'image/png', data: 'x' } as never,
    ])).toBe('hello\n[image]')
  })

  it('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(12345)).toBe('12k')
    expect(formatTokens(2_500_000)).toBe('2.5M')
  })

  it('folds usage and formats the footer summary', () => {
    expect(formatUsage(EMPTY_USAGE)).toBe('')
    const once = addUsage(EMPTY_USAGE, { inputTokens: 100, outputTokens: 20 })
    expect(formatUsage(once)).toBe('↑100 ↓20 ctx 100')
    const twice = addUsage(once, { inputTokens: 150, outputTokens: 30, cacheReadTokens: 900 })
    expect(twice).toEqual({ inputTokens: 250, outputTokens: 50, cacheReadTokens: 900, lastInputTokens: 1050 })
    expect(formatUsage(twice)).toBe('↑250 ↓50 cache 900 ctx 1.1k')
  })

  it('maps every turn-end reason to a notice', () => {
    expect(turnEndNotice({ kind: 'completed' })).toBeUndefined()
    expect(turnEndNotice({ kind: 'aborted', reason: { kind: 'user' } })).toBe('turn stopped')
    expect(turnEndNotice({ kind: 'blocked' })).toContain('blocked')
    expect(turnEndNotice({ kind: 'error', error: { code: 'X', message: 'why' } })).toBe('turn failed: X: why')
    expect(turnEndNotice({ kind: 'max-tokens' })).toContain('ceiling')
    expect(turnEndNotice({ kind: 'interrupted' })).toContain('interrupted')
    expect(() => turnEndNotice({ kind: 'unknown' } as never)).toThrow()
  })

  it('describes any failure value', () => {
    expect(describeFailure(new Error('boom'))).toBe('boom')
    expect(describeFailure('plain')).toBe('plain')
    expect(describeFailure(42)).toBe('42')
  })

  it('parses arguments leniently', () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 })
    expect(parseArguments('{oops')).toBeUndefined()
  })

  it('renders call text from each view and from raw arguments', () => {
    expect(toolCallText('{}', undefined)).toEqual({ title: '', lines: [] })
    expect(toolCallText('', undefined)).toEqual({ title: '', lines: [] })
    expect(toolCallText('{"a": 1}', undefined)).toEqual({ title: '', lines: ['{"a":1}'] })
    expect(toolCallText('{bad', undefined)).toEqual({ title: '', lines: ['{bad'] })
    expect(toolCallText('{}', { card: 'generic', title: 'Read x', content: [{ type: 'text', text: 'a\nb' }] }))
      .toEqual({ title: 'Read x', lines: ['a', 'b'] })
    expect(toolCallText('{}', { card: 'generic', title: 'Read x' })).toEqual({ title: 'Read x', lines: [] })
    expect(toolCallText('{}', { card: 'terminal', title: 'ls', description: 'list', cwd: '/w' }))
      .toEqual({ title: 'ls', lines: ['list', 'cwd: /w'] })
    expect(toolCallText('{}', { card: 'terminal', title: 'ls' })).toEqual({ title: 'ls', lines: [] })
    expect(toolCallText('{}', { card: 'diff', title: 'Edit', diffs: [{ path: 'f.ts', oldText: 'a\n', newText: 'b\n' }] }))
      .toEqual({ title: 'Edit', lines: ['f.ts', '- a', '+ b'] })
    expect(() => toolCallText('{}', { card: 'other' } as never)).toThrow()
  })

  it('renders result rows from each view and from raw content', () => {
    const text = [{ type: 'text' as const, text: 'raw\n\nout' }]
    expect(toolResultLines(undefined, text)).toEqual(['raw', 'out'])
    expect(toolResultLines({ card: 'generic' }, text)).toEqual(['raw', 'out'])
    expect(toolResultLines({ card: 'generic', content: [{ type: 'text', text: 'own' }] }, text)).toEqual(['own'])
    expect(toolResultLines({ card: 'terminal', output: 'a\nb\n\n', exitCode: 0 }, text)).toEqual(['a', 'b'])
    expect(toolResultLines({ card: 'terminal', exitCode: 3, signal: 'SIGKILL' }, text)).toEqual(['exit 3', 'signal SIGKILL'])
    expect(toolResultLines({ card: 'diff', diffs: [{ path: 'p', oldText: null, newText: 'n' }] }, text)).toEqual(['p', '+ n'])
    expect(toolResultLines({
      card: 'search', shape: 'matches', truncated: true, total: 9,
      files: [{ path: 'a.ts', matches: [{ lineNumber: 3, line: 'hit' }] }],
    }, text)).toEqual(['a.ts:3: hit', '… 9 total'])
    expect(toolResultLines({ card: 'search', shape: 'paths', truncated: false, total: 1, paths: ['x'] }, text)).toEqual(['x'])
    expect(toolResultLines({ card: 'read', path: 'f', offset: 0, totalLines: 1, lines: [{ number: 7, text: 'code' }] }, text))
      .toEqual(['   7│ code'])
    expect(toolResultLines({ card: 'web', kind: 'fetch', url: 'https://x', statusCode: 200, truncated: false }, text))
      .toEqual(['https://x (200)'])
    expect(toolResultLines({
      card: 'web', kind: 'search', truncated: false, answer: 'ans',
      sources: [{ url: 'https://a', title: 'A' }, { url: 'https://b' }],
    }, text)).toEqual(['ans', 'A — https://a', 'https://b'])
    expect(toolResultLines({ card: 'web', kind: 'search', truncated: false, sources: [] }, text)).toEqual([])
    expect(() => toolResultLines({ card: 'other' } as never, text)).toThrow()
  })

  it('renders diff rows with gap markers', () => {
    expect(diffRows({ path: 'p', oldText: '1\n2\n3\n4\n5\n6\n7', newText: '1\n2\n3\n4\n5\n6\nX' }))
      .toEqual(['  …', '  5', '  6', '- 7', '+ X'])
  })

  it('cuts a body to its preview unless expanded', () => {
    const lines = ['a', 'b', 'c', 'd']
    expect(previewLines(lines, 4, false)).toEqual(lines)
    expect(previewLines(lines, 3, false)).toEqual(['a', 'b', 'c', '… 1 more line (Ctrl+O expands)'])
    expect(previewLines(lines, 2, false)).toEqual(['a', 'b', '… 2 more lines (Ctrl+O expands)'])
    expect(previewLines(lines, 1, true)).toEqual(lines)
  })
})
