/** Recovery of harness tool calls a Cursor model wrote as text. */
import { describe, expect, it } from 'vitest'
import { LEAKED_CALLS_MARKER, leakedMarkupStart, parseLeakedToolCalls } from '../src/leaked-call.ts'

const TOOLS = new Set(['bash', 'read'])

function argument(key: string, type: string, value: string): string {
  return `<|open|>argument key="${key}" type="${type}"<|sep|>${value}<|close|>argument<|sep|>`
}

function call(args: string, header = 'call tool="CallDynamicTool" index="1"'): string {
  return `${header}<|sep|>${args}<|close|>call<|sep|>`
}

function dynamicArgs(toolName: string, value: string): string {
  return argument('namespace', 'string', 'dsh') + argument('toolName', 'string', toolName) + argument('arguments', 'object', value)
}

/** Markup as kimi-k3-high leaked it through Cursor on 2026-10-10. */
const LEAKED = `<|open|>tools${call(dynamicArgs('bash', '{"description": "Show full pip install output", "command": "python3 -m pip install pypdf 2>&1"}'))}<|close|>tools<|sep|>`

describe('leakedMarkupStart', () => {
  it('withholds from the marker or a trailing partial marker', () => {
    expect(leakedMarkupStart('plain text')).toBe(10)
    expect(leakedMarkupStart(`ok ${LEAKED}`)).toBe(3)
    expect(leakedMarkupStart('ok <|op')).toBe(3)
    expect(leakedMarkupStart('ok <')).toBe(3)
    expect(leakedMarkupStart('ok <|opx')).toBe(8)
    expect(leakedMarkupStart(LEAKED_CALLS_MARKER, 0)).toBe(0)
  })

  it('searches only after the offset it is given', () => {
    expect(leakedMarkupStart('ab<|open|>tools', 2)).toBe(2)
    expect(leakedMarkupStart('abcdef', 4)).toBe(6)
  })
})

describe('parseLeakedToolCalls', () => {
  it('recovers the CallDynamicTool call Kimi leaked', () => {
    expect(parseLeakedToolCalls(LEAKED, TOOLS)).toEqual([{
      toolName: 'bash',
      arguments: { description: 'Show full pip install output', command: 'python3 -m pip install pypdf 2>&1' },
    }])
  })

  it('recovers several calls, tolerates separators, a missing closer, and trailing whitespace', () => {
    const text = `<|open|>tools<|sep|>${call(dynamicArgs('read', '{"path":"a"}'), '<|open|>call tool="CallDynamicTool"')}`
      + `<|sep|>${call(dynamicArgs('mcp_dsh_bash', '{"command":"ls"}'), '<|open|>call tool="CallDynamicTool" index="2"')}\n `
    expect(parseLeakedToolCalls(text, TOOLS)).toEqual([
      { toolName: 'read', arguments: { path: 'a' } },
      { toolName: 'bash', arguments: { command: 'ls' } },
    ])
  })

  it('treats omitted arguments as an empty object', () => {
    const text = `<|open|>tools${call(argument('namespace', 'string', 'dsh') + argument('toolName', 'string', 'bash'))}`
    expect(parseLeakedToolCalls(text, TOOLS)).toEqual([{ toolName: 'bash', arguments: {} }])
  })

  it.each([
    ['text that does not start at the marker', `x${LEAKED}`],
    ['a missing call header', '<|open|>toolsnope'],
    ['an unterminated argument', '<|open|>toolscall tool="CallDynamicTool"<|sep|><|open|>argument key="namespace" type="string"<|sep|>dsh'],
    ['a non-JSON object argument', `<|open|>tools${call(dynamicArgs('bash', '{not json'))}`],
    ['a missing call closer', `<|open|>toolscall tool="CallDynamicTool"<|sep|>${dynamicArgs('bash', '{}')}<|close|>tools<|sep|>`],
    ['another Cursor tool', `<|open|>tools${call(dynamicArgs('bash', '{}'), 'call tool="Shell"')}`],
    ['another namespace', `<|open|>tools${call(argument('namespace', 'string', 'cursor') + argument('toolName', 'string', 'bash'))}`],
    ['a non-string toolName', `<|open|>tools${call(argument('namespace', 'string', 'dsh') + argument('toolName', 'number', '3'))}`],
    ['an unadvertised tool', `<|open|>tools${call(dynamicArgs('write', '{}'))}`],
    ['non-object arguments', `<|open|>tools${call(dynamicArgs('bash', '[1]'))}`],
    ['text after the markup', `${LEAKED} done`],
  ])('keeps the text for %s', (_case, text) => {
    expect(parseLeakedToolCalls(text, TOOLS)).toBeUndefined()
  })
})
