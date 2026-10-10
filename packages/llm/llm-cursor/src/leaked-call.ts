/**
 * Recover harness tool calls that a Cursor model wrote as text. Kimi models on
 * Cursor sometimes emit their native tool-call markup
 * (`<|open|>toolscall tool="CallDynamicTool" index="1"<|sep|>…<|close|>tools<|sep|>`)
 * that Cursor's server does not parse: the markup arrives as `textDelta` and
 * the turn ends without an exec, so the call never runs.
 *
 * @module @deepseek-ai/dsh-llm-cursor/leaked-call
 */

import { DYNAMIC_TOOL_CALL, MCP_PROMPT_TOOL_PREFIX, MCP_PROVIDER_IDENTIFIER } from './protocol.ts'

/** Opening of leaked tool-call markup; text from its first occurrence is withheld until the turn ends. */
export const LEAKED_CALLS_MARKER = '<|open|>tools'

/** One harness tool call recovered from leaked markup. */
export interface LeakedToolCall {
  /** Harness tool name, without the `mcp_dsh_` prefix. */
  toolName: string
  /** Decoded tool arguments. */
  arguments: Record<string, unknown>
}

/**
 * Where a text block stops being safe to stream: the first
 * {@link LEAKED_CALLS_MARKER}, or the start of a trailing partial marker.
 * The result never decreases as the text grows, so a caller may pass the
 * previous result as `from`.
 * @param text - text block so far.
 * @param from - offset already known to precede any marker.
 * @returns the length of the prefix that cannot belong to leaked markup.
 */
export function leakedMarkupStart(text: string, from = 0): number {
  const found = text.indexOf(LEAKED_CALLS_MARKER, from)
  if (found >= 0) return found
  for (let start = Math.max(from, text.length - LEAKED_CALLS_MARKER.length + 1); start < text.length; start += 1) {
    if (LEAKED_CALLS_MARKER.startsWith(text.slice(start))) return start
  }
  return text.length
}

const CALL_OPEN = /^(?:<\|open\|>)?call tool="([^"]*)"(?: index="\d+")?<\|sep\|>/
const ARGUMENT_OPEN = /^<\|open\|>argument key="([^"]*)" type="([^"]*)"<\|sep\|>/
const ARGUMENT_CLOSE = '<|close|>argument<|sep|>'
const CALL_CLOSE = '<|close|>call<|sep|>'
const CALLS_CLOSE = '<|close|>tools<|sep|>'

function decodeArgument(type: string, raw: string): { value: unknown } | undefined {
  if (type === 'string') return { value: raw }
  try {
    return { value: JSON.parse(raw) }
  } catch (_notJson) {
    // A non-string argument that is not JSON makes the markup unrecoverable.
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function harnessCall(tool: string, args: Record<string, unknown>, toolNames: ReadonlySet<string>): LeakedToolCall | undefined {
  if (tool !== DYNAMIC_TOOL_CALL || args['namespace'] !== MCP_PROVIDER_IDENTIFIER) return undefined
  const named = args['toolName']
  if (typeof named !== 'string') return undefined
  const toolName = named.startsWith(MCP_PROMPT_TOOL_PREFIX) ? named.slice(MCP_PROMPT_TOOL_PREFIX.length) : named
  const callArguments = args['arguments'] ?? {}
  if (!toolNames.has(toolName) || !isRecord(callArguments)) return undefined
  return { toolName, arguments: callArguments }
}

/**
 * Parse text that starts at {@link LEAKED_CALLS_MARKER} into harness tool
 * calls. Every call must be a complete `CallDynamicTool` call in namespace
 * `dsh` naming an advertised harness tool, and only whitespace may follow the
 * markup; anything else returns `undefined` so the caller keeps the text.
 * @param text - withheld text, starting at the marker.
 * @param toolNames - harness tool names advertised on the Run.
 * @returns the recovered calls in order, or `undefined`.
 */
export function parseLeakedToolCalls(text: string, toolNames: ReadonlySet<string>): LeakedToolCall[] | undefined {
  if (!text.startsWith(LEAKED_CALLS_MARKER)) return undefined
  let rest = text.slice(LEAKED_CALLS_MARKER.length)
  const calls: LeakedToolCall[] = []
  while (true) {
    rest = rest.startsWith('<|sep|>') ? rest.slice('<|sep|>'.length) : rest
    const call = CALL_OPEN.exec(rest)
    if (call === null) return undefined
    rest = rest.slice(call[0].length)
    const args: Record<string, unknown> = {}
    let argument = ARGUMENT_OPEN.exec(rest)
    while (argument !== null) {
      rest = rest.slice(argument[0].length)
      const end = rest.indexOf(ARGUMENT_CLOSE)
      if (end < 0) return undefined
      // oxlint-disable-next-line typescript/no-non-null-assertion -- both groups are mandatory in ARGUMENT_OPEN
      const decoded = decodeArgument(argument[2]!, rest.slice(0, end))
      if (decoded === undefined) return undefined
      // oxlint-disable-next-line typescript/no-non-null-assertion -- both groups are mandatory in ARGUMENT_OPEN
      args[argument[1]!] = decoded.value
      rest = rest.slice(end + ARGUMENT_CLOSE.length)
      argument = ARGUMENT_OPEN.exec(rest)
    }
    if (!rest.startsWith(CALL_CLOSE)) return undefined
    rest = rest.slice(CALL_CLOSE.length)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the group is mandatory in CALL_OPEN
    const recovered = harnessCall(call[1]!, args, toolNames)
    if (recovered === undefined) return undefined
    calls.push(recovered)
    if (rest.startsWith(CALLS_CLOSE)) rest = rest.slice(CALLS_CLOSE.length)
    if (rest.trim().length === 0) return calls
  }
}
