/** Structured JSON rows and their terminal colors. */

import { describe, expect, it } from 'vitest'
import { jsonTreeText, paintJsonRows } from '../src/json-tree.ts'
import { createPalette } from '../src/style.ts'

const nestedJson = JSON.stringify({
  status: 'ok',
  files: [
    { path: 'a.ts', size: 12 },
    { path: 'b.ts', size: null },
  ],
  enabled: true,
  empty: {},
  list: [],
})

describe('JSON tree output', () => {
  it('renders nested objects and arrays as an indented key-value tree', () => {
    expect(jsonTreeText(nestedJson)?.lines).toEqual([
      '├─ status: "ok"',
      '├─ files:',
      '│  ├─ [0]:',
      '│  │  ├─ path: "a.ts"',
      '│  │  ╰─ size: 12',
      '│  ╰─ [1]:',
      '│     ├─ path: "b.ts"',
      '│     ╰─ size: null',
      '├─ enabled: true',
      '├─ empty: (empty object)',
      '╰─ list: (empty array)',
    ])
    expect(jsonTreeText('[{"a":1},2]')?.lines).toEqual([
      '├─ [0]:',
      '│  ╰─ a: 1',
      '╰─ [1]: 2',
    ])
    expect(jsonTreeText('{}')?.lines).toEqual(['(empty object)'])
    expect(jsonTreeText('[]')?.lines).toEqual(['(empty array)'])
  })

  it('leaves malformed, mixed, and scalar text unchanged', () => {
    expect(jsonTreeText('{"a":')).toBeUndefined()
    expect(jsonTreeText('{"a":1}\nlogs')).toBeUndefined()
    expect(jsonTreeText('"text"')).toBeUndefined()
    expect(jsonTreeText('1')).toBeUndefined()
    expect(jsonTreeText('true')).toBeUndefined()
    expect(jsonTreeText('null')).toBeUndefined()
  })

  it('colors guides, keys, indices, and scalar values by role', () => {
    const tree = jsonTreeText(nestedJson)
    if (tree === undefined) throw new Error('expected JSON tree')
    const palette = createPalette(true)
    const painted = paintJsonRows(tree.lines, tree.json, undefined, palette)
    expect(painted[0]).toBe(`${palette.dim('├─ ')}${palette.tool('status')}: ${palette.success('"ok"')}`)
    expect(painted[2]).toBe(`${palette.dim('│  ├─ ')}${palette.heading('[0]')}:`)
    expect(painted[4]).toBe(`${palette.dim('│  │  ╰─ ')}${palette.tool('size')}: ${palette.warning('12')}`)
    expect(painted[7]).toBe(`${palette.dim('│     ╰─ ')}${palette.tool('size')}: ${palette.dim('null')}`)
    expect(painted[8]).toBe(`${palette.dim('├─ ')}${palette.tool('enabled')}: ${palette.link('true')}`)
    expect(painted[9]).toBe(`${palette.dim('├─ ')}${palette.tool('empty')}: ${palette.dim('(empty object)')}`)
    expect(paintJsonRows(tree.lines, tree.json, undefined, createPalette(false))).toEqual(tree.lines)
  })

  it('dims only non-JSON shell output rows', () => {
    const palette = createPalette(true)
    expect(paintJsonRows(['$ echo hi', 'hi'], undefined, [false, true], palette)).toEqual(['$ echo hi', palette.dim('hi')])
    expect(paintJsonRows(['plain'], undefined, undefined, palette)).toEqual(['plain'])
  })
})
