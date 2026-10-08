/** Generic raw-input lines and the live argument rows a tool card can show. */

import { describe, expect, it } from 'vitest'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { completedArguments, rawInputLines, streamedArgumentLines } from '../src/stream-args.ts'

describe('raw input lines', () => {
  it('renders absent, scalar, script, todo, and list values', () => {
    expect(rawInputLines(undefined)).toEqual([])
    expect(rawInputLines('')).toEqual([])
    expect(rawInputLines('return 1\nreturn 2')).toEqual(['return 1', 'return 2'])
    expect(rawInputLines(0)).toEqual(['0'])
    expect(rawInputLines(false)).toEqual(['false'])
    expect(rawInputLines([
      { content: 'read the log', status: 'pending' },
      { content: 'write the note', status: 'done' },
    ])).toEqual(['pending  read the log', 'done  write the note'])
    expect(rawInputLines([])).toEqual([])
    expect(rawInputLines(['keep\nme', '', 'tail'])).toEqual(['keep', 'me', 'tail'])
    expect(rawInputLines([''])).toEqual([])
    expect(rawInputLines({ script: 'return 1' })).toEqual(['{"script":"return 1"}'])
    expect(rawInputLines(null)).toEqual(['null'])
    expect(rawInputLines(Symbol('skip'))).toEqual([])
  })

  it('falls through when a list is not todos or strings', () => {
    expect(rawInputLines([null])).toEqual(['[null]'])
    expect(rawInputLines([{ content: 'only' }])).toEqual(['[{"content":"only"}]'])
    expect(rawInputLines([{ status: 'pending' }])).toEqual(['[{"status":"pending"}]'])
    expect(rawInputLines([{ content: 1, status: 'pending' }])).toEqual(['[{"content":1,"status":"pending"}]'])
    expect(rawInputLines([{ content: 'read', status: 1 }])).toEqual(['[{"content":"read","status":1}]'])
    expect(rawInputLines([1, 'text'])).toEqual(['[1,"text"]'])
  })
})

describe('completed arguments', () => {
  it('keeps closed values and strings and skips open or empty keys', () => {
    expect(completedArguments(PartialArguments.fromObject({}))).toBeUndefined()
    expect(completedArguments(PartialArguments.fromText('{"file_path":"src'))).toBeUndefined()
    expect(completedArguments(PartialArguments.fromObject({
      script: 'return 1',
      count: 2,
      ghost: undefined,
    }))).toEqual({ script: 'return 1', count: 2 })
    expect(completedArguments(PartialArguments.fromText('{"count":2,"file_path":"src'))).toEqual({ count: 2 })
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
})
