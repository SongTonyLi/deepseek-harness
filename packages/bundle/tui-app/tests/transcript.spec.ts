/** Pure transcript formatting: tool views, usage, notices, and previews. */

import { describe, expect, it } from 'vitest'
import { diffLines, hunks } from '../src/diff.ts'
import {
  EMPTY_USAGE,
  addUsage,
  cardHeadline,
  contentText,
  describeFailure,
  diffRows,
  formatElapsed,
  formatTimestamp,
  formatTokens,
  estimateTokens,
  formatLiveUsage,
  formatUsage,
  foldRows,
  withLiveUsage,
  paintCodeRows,
  isSubagentTool,
  parseArguments,
  subagentRowFacts,
  toolCallText,
  toolResultBody,
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

describe('formatElapsed', () => {
  it('counts whole seconds up to a minute, starting at zero', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(999)).toBe('0s')
    expect(formatElapsed(8000)).toBe('8s')
    expect(formatElapsed(59_999)).toBe('59s')
  })

  it('pads the smaller unit once a larger one leads', () => {
    expect(formatElapsed(60_000)).toBe('1m00s')
    expect(formatElapsed(72_400)).toBe('1m12s')
    expect(formatElapsed(3_599_000)).toBe('59m59s')
  })

  it('drops the seconds past an hour and keeps counting hours', () => {
    expect(formatElapsed(3_600_000)).toBe('1h00m')
    expect(formatElapsed(3_840_000)).toBe('1h04m')
    expect(formatElapsed(94_020_000)).toBe('26h07m')
  })

  it('reads a clock that moved backwards as no time at all', () => {
    expect(formatElapsed(-5000)).toBe('0s')
  })
})

describe('formatTimestamp', () => {
  it('dates a recorded moment to the minute in UTC', () => {
    expect(formatTimestamp(Date.UTC(2026, 1, 3, 14, 25, 30))).toBe('2026-02-03 14:25')
    expect(formatTimestamp(0)).toBe('1970-01-01 00:00')
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
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(12_345)).toBe('12.3k')
    expect(formatTokens(141_100)).toBe('141.1k')
    expect(formatTokens(54_000)).toBe('54k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(2_500_000)).toBe('2.5M')
    expect(formatTokens(1_200_000_000)).toBe('1.2B')
  })

  it('folds usage and formats the footer summary', () => {
    expect(formatUsage(EMPTY_USAGE)).toBe('')
    const once = addUsage(EMPTY_USAGE, { inputTokens: 100, outputTokens: 20 })
    expect(formatUsage(once)).toBe('↑100 ↓20 ctx 100')
    const twice = addUsage(once, { inputTokens: 150, outputTokens: 30, cacheReadTokens: 900 })
    expect(twice).toEqual({ inputTokens: 250, outputTokens: 50, cacheReadTokens: 900, lastInputTokens: 1050 })
    expect(formatUsage(twice)).toBe('↑250 ↓50 cache 900 ctx 1.1k')
  })

  it('estimates tokens from streamed characters and formats a live call', () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(-8)).toBe(0)
    expect(estimateTokens(4)).toBe(1)
    expect(estimateTokens(5)).toBe(2)
    expect(formatLiveUsage(undefined)).toBe('')
    expect(formatLiveUsage({ inputTokens: 0, outputTokens: 0 })).toBe('')
    expect(formatLiveUsage({ inputTokens: 1200, outputTokens: 0 })).toBe('↑1.2k tokens')
    expect(formatLiveUsage({ inputTokens: 0, outputTokens: 34 })).toBe('↓34 tokens')
    expect(formatLiveUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 })).toBe('↑1k ↓20 tokens')
    expect(formatLiveUsage({ inputTokens: 10, outputTokens: 4, cacheWriteTokens: 90 })).toBe('↑100 ↓4 tokens')
    expect(withLiveUsage(EMPTY_USAGE, undefined)).toEqual(EMPTY_USAGE)
    expect(withLiveUsage(EMPTY_USAGE, { inputTokens: 100, outputTokens: 20 })).toEqual({
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, lastInputTokens: 100,
    })
    expect(withLiveUsage(EMPTY_USAGE, { inputTokens: 0, outputTokens: 8 })).toEqual({
      inputTokens: 0, outputTokens: 8, cacheReadTokens: 0, lastInputTokens: 0,
    })
  })

  it('maps every turn-end reason to a notice', () => {
    expect(turnEndNotice({ kind: 'completed' })).toBeUndefined()
    expect(turnEndNotice({ kind: 'aborted', reason: { kind: 'user' } })).toBe('turn stopped')
    expect(turnEndNotice({ kind: 'blocked' })).toContain('blocked')
    expect(turnEndNotice({ kind: 'error', error: { code: 'X', message: 'why' } })).toBe('turn failed: X: why')
    expect(turnEndNotice({ kind: 'max-tokens' })).toContain('ceiling')
    expect(turnEndNotice({ kind: 'interrupted' })).toContain('interrupted')
    // TurnEndReason is merge-extensible: a backend-added kind still names itself.
    expect(turnEndNotice({ kind: 'forked' } as never)).toBe('turn ended: forked')
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
    expect(toolCallText('{}', undefined, 'read')).toEqual({ title: '', lines: [] })
    expect(toolCallText('', undefined, 'read')).toEqual({ title: '', lines: [] })
    expect(toolCallText('{"a": 1}', undefined, 'read')).toEqual({ title: '', lines: ['{"a":1}'] })
    expect(toolCallText('{bad', undefined, 'read')).toEqual({ title: '', lines: ['{bad'] })
    // The headline drops the tool name the card's header already draws.
    expect(toolCallText('{}', { card: 'generic', title: 'Read x', content: [{ type: 'text', text: 'a\nb' }] }, 'read'))
      .toEqual({ title: 'x', lines: ['a', 'b'] })
    expect(toolCallText('{}', { card: 'generic', title: 'Read x' }, 'grep')).toEqual({ title: 'Read x', lines: [] })
    // The command is the card's `$` row alone: the headline carries the
    // call's summary, so the header never repeats the command.
    expect(toolCallText('{}', { card: 'terminal', title: 'ls', description: 'list', cwd: '/w' }, 'bash'))
      .toEqual({
        title: 'list',
        lines: ['$ ls', 'cwd: /w'],
        code: [{ lang: 'shellscript', prefix: '$ ', source: 'ls' }, undefined],
      })
    expect(toolCallText('{}', { card: 'terminal', title: 'ls' }, 'bash')).toEqual({
      title: '',
      lines: ['$ ls'],
      code: [{ lang: 'shellscript', prefix: '$ ', source: 'ls' }],
    })
    expect(toolCallText('{}', { card: 'terminal', title: '' }, 'bash')).toEqual({ title: '', lines: [] })
    expect(toolCallText('{}', { card: 'diff', title: 'Edit', diffs: [{ path: 'f.ts', oldText: 'a\n', newText: 'b\n' }] }, 'edit'))
      .toEqual({
        title: '',
        lines: ['f.ts', '- a', '+ b'],
        // The path row is not code; the changed rows carry the file's own
        // language from its extension, behind the sign the card draws.
        code: [undefined, { lang: 'ts', prefix: '- ', source: 'a' }, { lang: 'ts', prefix: '+ ', source: 'b' }],
        // Only the changed rows are marked, which is what the card boxes.
        diff: [undefined, 'removed', 'added'],
      })
    expect(() => toolCallText('{}', { card: 'other' } as never, 'read')).toThrow()
  })

  it('drops a tool name the headline repeats, and only a whole one', () => {
    expect(cardHeadline('read', 'Read src/app.ts (1 - 20)')).toBe('src/app.ts (1 - 20)')
    expect(cardHeadline('grep', 'Grep needle in /repo')).toBe('needle in /repo')
    // An underscored name matches the words a presenter writes it as.
    expect(cardHeadline('web_search', 'Web search for margins')).toBe('for margins')
    expect(cardHeadline('read', 'Read')).toBe('')
    // A headline that merely starts with the same letters keeps them.
    expect(cardHeadline('read', 'Reader notes')).toBe('Reader notes')
    expect(cardHeadline('read', 'Open src/app.ts')).toBe('Open src/app.ts')
    expect(cardHeadline('', 'Read x')).toBe('Read x')
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

  it('leads diff rows with their file lines when the diff names where each side starts', () => {
    // Old lines 8-10 become new lines 8-10 with the middle one replaced; the
    // removed row keeps its old line and the added row takes the new one.
    expect(diffRows({ path: 'p', oldText: 'a\nb\nc', newText: 'a\nB\nB2\nc', oldStart: 8, newStart: 8 }))
      .toEqual([' 8   a', ' 9 - b', ' 9 + B', '10 + B2', '11   c'])
    // An insertion into an empty file only numbers the new side.
    expect(diffRows({ path: 'p', oldText: null, newText: 'x', newStart: 1 })).toEqual(['1 + x'])
    // The gap marker lines up under the signs.
    expect(diffRows({ path: 'p', oldText: '1\n2\n3\n4\n5\n6\n7', newText: '1\n2\n3\n4\n5\n6\nX', oldStart: 1, newStart: 1 }))
      .toEqual(['    …', '5   5', '6   6', '7 - 7', '7 + X'])
    // A deletion of a whole file only numbers the old side.
    expect(diffRows({ path: 'p', oldText: 'gone', newText: '', oldStart: 3 })).toEqual(['3 - gone'])
    // A side with no start leaves its rows' numbers blank.
    expect(diffRows({ path: 'p', oldText: 'a\nb', newText: 'a', oldStart: 5 })).toEqual(['    a', '6 - b'])
  })

  it('carries the code span behind read and diff rows, and none behind the rest', () => {
    const text = [{ type: 'text' as const, text: 'raw' }]
    expect(toolResultBody({ card: 'read', path: 'f', offset: 0, totalLines: 2, lang: 'py', lines: [{ number: 7, text: 'x = 1' }, { number: 8, text: '' }] }, text))
      .toEqual({
        lines: ['   7│ x = 1', '   8│ '],
        code: [{ lang: 'py', prefix: '   7│ ', source: 'x = 1' }, { lang: 'py', prefix: '   8│ ', source: '' }],
      })
    // No language hint on the read, no span: the rows draw plain.
    expect(toolResultBody({ card: 'read', path: 'f', offset: 0, totalLines: 1, lines: [{ number: 1, text: 'plain' }] }, text))
      .toEqual({ lines: ['   1│ plain'] })
    // A gap marker and a path row are not code; a dotfile has no language.
    expect(toolResultBody({ card: 'diff', diffs: [{ path: 'a/b.rs', oldText: '1\n2\n3\n4\n5\n6\n7', newText: '1\n2\n3\n4\n5\n6\nX' }] }, text).code)
      .toEqual([undefined, undefined, { lang: 'rs', prefix: '  ', source: '5' }, { lang: 'rs', prefix: '  ', source: '6' }, { lang: 'rs', prefix: '- ', source: '7' }, { lang: 'rs', prefix: '+ ', source: 'X' }])
    expect(toolResultBody({ card: 'diff', diffs: [{ path: '.gitignore', oldText: null, newText: 'lib\n' }] }, text))
      .toEqual({ lines: ['.gitignore', '+ lib'], code: [undefined, undefined], diff: [undefined, 'added'] })
    expect(toolResultBody({ card: 'terminal', output: 'a' }, text)).toEqual({ lines: ['a'] })
  })

  it('paints consecutive spans of one language as one block and leaves the rest plain', () => {
    const asked: [string, string | undefined][] = []
    const highlight = {
      lines: (code: string, lang: string | undefined) => {
        asked.push([code, lang])
        // A grammar that is still loading answers nothing for `py`; a count
        // that does not match the rows is refused too.
        if (lang === 'py') return undefined
        if (lang === 'md') return ['too', 'many', 'rows']
        return code.split('\n').map(line => `<${line}>`)
      },
    }
    const lines = ['f.ts', '- a', '+ b', '  …', '  c', 'g.py', '+ d', '# h']
    const code = [
      undefined, { lang: 'ts', prefix: '- ', source: 'a' }, { lang: 'ts', prefix: '+ ', source: 'b' }, undefined,
      { lang: 'ts', prefix: '  ', source: 'c' }, undefined, { lang: 'py', prefix: '+ ', source: 'd' }, { lang: 'md', prefix: '', source: '# h' },
    ]
    expect(paintCodeRows(lines, code, highlight)).toEqual(['f.ts', '- <a>', '+ <b>', '  …', '  <c>', 'g.py', '+ d', '# h'])
    expect(asked).toEqual([['a\nb', 'ts'], ['c', 'ts'], ['d', 'py'], ['# h', 'md']])
    // Without spans or without a highlighter the rows come back as given.
    expect(paintCodeRows(lines, undefined, highlight)).toEqual(lines)
    expect(paintCodeRows(lines, code, undefined)).toEqual(lines)
  })

  it('cuts rows to a maximum and names what one fold left out', () => {
    const lines = ['a', 'b', 'c', 'd']
    const marker = (hidden: number): string => `${String(hidden)} left`
    expect(foldRows(lines, 4, marker)).toEqual(lines)
    expect(foldRows(lines, 2, marker)).toEqual(['a', 'b', '2 left'])
  })

  it('names the subagent tools by the browser\'s rule', () => {
    expect(isSubagentTool('subagent')).toBe(true)
    expect(isSubagentTool('subagent_explore')).toBe(true)
    expect(isSubagentTool('subagents')).toBe(false)
    expect(isSubagentTool('read')).toBe(false)
  })

  it('reads a subagent row from the description, the requested model, and the background mode', () => {
    expect(subagentRowFacts({ description: 'Explore order services', prompt: 'p', model: 'deepseek-chat', run_in_background: true }))
      .toEqual({ description: 'Explore order services', meta: ['deepseek-chat', 'background'] })
    expect(subagentRowFacts({ description: 'Rank endpoints', model: '', run_in_background: false }))
      .toEqual({ description: 'Rank endpoints', meta: [] })
    expect(subagentRowFacts(undefined)).toEqual({ description: '', meta: [] })
    expect(subagentRowFacts({ description: 7 })).toEqual({ description: '', meta: [] })
  })
})
