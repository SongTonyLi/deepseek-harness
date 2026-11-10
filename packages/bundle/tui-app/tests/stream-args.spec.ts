/** Generic raw-input rows and the live argument rows a tool card can show. */

import { describe, expect, it } from 'vitest'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { jsonTreeText } from '../src/json-tree.ts'
import { rawInputBody, streamedArgumentLines } from '../src/stream-args.ts'

describe('raw input body', () => {
  it('renders absent, scalar, script, todo, and list values as plain rows', () => {
    expect(rawInputBody(undefined)).toEqual({ lines: [] })
    expect(rawInputBody('')).toEqual({ lines: [] })
    expect(rawInputBody('return 1\nreturn 2')).toEqual({ lines: ['return 1', 'return 2'] })
    // A string is the program or path itself, even when it parses as JSON.
    expect(rawInputBody('{"a":1}')).toEqual({ lines: ['{"a":1}'] })
    expect(rawInputBody(0)).toEqual({ lines: ['0'] })
    expect(rawInputBody(false)).toEqual({ lines: ['false'] })
    expect(rawInputBody([
      { content: 'read the log', status: 'pending' },
      { content: 'write the note', status: 'done' },
    ])).toEqual({ lines: ['pending  read the log', 'done  write the note'] })
    expect(rawInputBody([])).toEqual({ lines: [] })
    expect(rawInputBody(['keep\nme', '', 'tail'])).toEqual({ lines: ['keep', 'me', 'tail'] })
    expect(rawInputBody([''])).toEqual({ lines: [] })
    expect(rawInputBody(null)).toEqual({ lines: ['null'] })
    expect(rawInputBody(Symbol('skip'))).toEqual({ lines: [] })
  })

  it('draws an object or a list that is not todos or strings as a JSON tree', () => {
    const script = rawInputBody({ script: 'return 1' })
    expect(script.lines).toEqual(['╰─ script: "return 1"'])
    expect(script.json).toEqual(jsonTreeText('{"script":"return 1"}')?.json)
    expect(rawInputBody([null]).lines).toEqual(['╰─ [0]: null'])
    expect(rawInputBody([{ content: 'only' }]).lines).toEqual(['╰─ [0]:', '   ╰─ content: "only"'])
    expect(rawInputBody([{ status: 'pending' }]).lines).toEqual(['╰─ [0]:', '   ╰─ status: "pending"'])
    expect(rawInputBody([{ content: 1, status: 'pending' }]).lines).toEqual(['╰─ [0]:', '   ├─ content: 1', '   ╰─ status: "pending"'])
    expect(rawInputBody([{ content: 'read', status: 1 }]).lines).toEqual(['╰─ [0]:', '   ├─ content: "read"', '   ╰─ status: 1'])
    expect(rawInputBody([1, 'text']).lines).toEqual(['├─ [0]: 1', '╰─ [1]: "text"'])
    expect(rawInputBody({}).lines).toEqual(['(empty object)'])
  })
})

describe('streamed argument lines', () => {
  it('shows a finished path, command, description, and sized text', () => {
    const sized = 'x'.repeat(1025)
    expect(streamedArgumentLines(PartialArguments.fromObject({
      file_path: 'src/app.ts',
      command: 'pnpm test',
      description: 'run the suite\nthen stop',
      content: 'hello',
      new_string: sized,
    }))).toEqual([
      'src/app.ts',
      'pnpm test',
      'run the suite',
      'content 1 KB',
      `new_string ${String(Math.ceil(sized.length / 1024))} KB`,
    ])
  })

  it('uses path when file_path is absent and skips empty or unfinished keys', () => {
    expect(streamedArgumentLines(PartialArguments.fromObject({ path: 'src/a.ts' }))).toEqual(['src/a.ts'])
    expect(streamedArgumentLines(PartialArguments.fromObject({
      file_path: '',
      path: 'ignored.ts',
      command: '',
      description: '',
      content: '',
    }))).toEqual([])
    expect(streamedArgumentLines(PartialArguments.fromObject({
      file_path: 1,
      path: 'ignored.ts',
      command: 1,
      description: 1,
      content: 1,
      old_string: 1,
      new_string: 1,
    }))).toEqual([])
    expect(streamedArgumentLines(PartialArguments.fromObject({
      path: '',
      description: '\nkept out',
    }))).toEqual([])
    expect(streamedArgumentLines(PartialArguments.fromText('{"command":"echo'))).toEqual([])
    expect(streamedArgumentLines(PartialArguments.fromObject({}))).toEqual([])
  })

  it('shows the path once it is complete, then a content size that grows while the text arrives', () => {
    const partial = new PartialArguments()
    const rows: string[][] = []
    const content = 'x'.repeat(3000)
    for (const delta of ['{"file_', 'path":"src/', 'gen.ts"', ',"content":"', content.slice(0, 500), content.slice(500, 1500), content.slice(1500), '"}']) {
      partial.append(delta)
      rows.push(streamedArgumentLines(partial))
    }
    expect(rows).toEqual([
      [],
      [],
      ['src/gen.ts'],
      ['src/gen.ts'],
      ['src/gen.ts', 'content 1 KB'],
      ['src/gen.ts', 'content 2 KB'],
      ['src/gen.ts', 'content 3 KB'],
      ['src/gen.ts', 'content 3 KB'],
    ])
  })

  it('shows a command as soon as its key closes, before the JSON does', () => {
    const partial = new PartialArguments()
    partial.append('{"command":"pnpm test","timeout":')
    expect(streamedArgumentLines(partial)).toEqual(['pnpm test'])
  })
})
