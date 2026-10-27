/**
 * Structured JSON output for terminal cards. Valid JSON objects and arrays
 * become tree rows with token ranges; the palette colors those ranges without
 * changing the plain rows used for wrapping and navigation.
 * @module @deepseek-ai/dsh-tui-app/json-tree
 */

import type { Palette, Style } from './style.ts'

/** A value produced by `JSON.parse`. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Semantic token roles in a JSON tree row. */
export type JsonRowTone = 'guide' | 'key' | 'index' | 'string' | 'number' | 'boolean' | 'null' | 'empty'

/** One token's UTF-16 range in a plain JSON tree row. */
export interface JsonRowSpan {
  start: number
  end: number
  tone: JsonRowTone
}

/** The colored tokens in one JSON tree row. */
export interface JsonRowStyle {
  spans: readonly JsonRowSpan[]
}

/** Plain JSON tree rows and their aligned token ranges. */
export interface JsonTreeBody {
  lines: string[]
  json: JsonRowStyle[]
}

/** One run of text in a row being built. */
interface Segment {
  text: string
  tone?: JsonRowTone
}

/** An object key or array index before a value. */
interface Label {
  text: string
  tone: 'key' | 'index'
}

/** Build one plain row and its token ranges from ordered segments. */
function row(segments: readonly Segment[]): { text: string; style: JsonRowStyle } {
  let text = ''
  const spans: JsonRowSpan[] = []
  for (const segment of segments) {
    const start = text.length
    text += segment.text
    if (segment.tone !== undefined) spans.push({ start, end: text.length, tone: segment.tone })
  }
  return { text, style: { spans } }
}

/** The indentation a nested value's children continue from its branch. */
function childPrefix(prefix: string, connector: '├─ ' | '╰─ '): string {
  return connector === '├─ ' ? `${prefix}│  ` : `${prefix}   `
}

/** Entries and container kind of an object or array. */
function containerEntries(value: JsonValue[] | { [key: string]: JsonValue }): {
  array: boolean
  entries: readonly (readonly [string, JsonValue])[]
} {
  const array = Array.isArray(value)
  const entries: readonly (readonly [string, JsonValue])[] = array
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value)
  return { array, entries }
}

/** Append one labeled value and, for a nonempty container, its descendants. */
function appendNested(
  rows: { text: string; style: JsonRowStyle }[],
  value: JsonValue,
  label: Label,
  prefix: string,
  connector: '├─ ' | '╰─ ',
): void {
  const guide = `${prefix}${connector}`
  const labelSegment: Segment[] = [{ text: label.text, tone: label.tone }, { text: ':' }]
  if (typeof value === 'object' && value !== null) {
    const { array, entries } = containerEntries(value)
    if (entries.length === 0) {
      const empty = array ? '(empty array)' : '(empty object)'
      rows.push(row([{ text: guide, tone: 'guide' }, ...labelSegment, { text: ' ' }, { text: empty, tone: 'empty' }]))
      return
    }
    rows.push(row([{ text: guide, tone: 'guide' }, ...labelSegment]))
    const nested = childPrefix(prefix, connector)
    entries.forEach(([key, item], index) => {
      appendNested(rows, item, { text: array ? `[${key}]` : key, tone: array ? 'index' : 'key' }, nested, index === entries.length - 1 ? '╰─ ' : '├─ ')
    })
    return
  }
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value)
  const tone: JsonRowTone = typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'null'
  rows.push(row([{ text: guide, tone: 'guide' }, ...labelSegment, { text: ' ' }, { text, tone }]))
}

/**
 * Format a complete JSON object or array as a tree without object and array
 * braces. Strings remain JSON-quoted and escaped; empty containers name their
 * type. Other JSON values, malformed JSON, and mixed text return undefined.
 * @param text - the complete output text to parse.
 * @returns aligned plain rows and token ranges, or undefined to keep the original output.
 */
export function jsonTreeText(text: string): JsonTreeBody | undefined {
  let value: JsonValue
  try {
    value = JSON.parse(text) as JsonValue
  } catch {
    // Non-JSON output keeps its original rows.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { array, entries } = containerEntries(value)
  if (entries.length === 0) {
    const empty = row([{ text: array ? '(empty array)' : '(empty object)', tone: 'empty' }])
    return { lines: [empty.text], json: [empty.style] }
  }
  const rows: { text: string; style: JsonRowStyle }[] = []
  entries.forEach(([key, item], index) => {
    appendNested(rows, item, { text: array ? `[${key}]` : key, tone: array ? 'index' : 'key' }, '', index === entries.length - 1 ? '╰─ ' : '├─ ')
  })
  return { lines: rows.map(item => item.text), json: rows.map(item => item.style) }
}

/**
 * Color JSON token ranges and dim non-JSON shell-output rows. JSON tree rows
 * carry no code spans, so their ranges always refer to unstyled plain text.
 * @param rows - rows to paint.
 * @param json - JSON token ranges aligned with `rows`; absent entries are not JSON.
 * @param shellOutput - whether each non-JSON row is shell output to dim.
 * @param palette - active terminal palette.
 * @returns styled rows, with input rows left unchanged when no role applies.
 */
export function paintJsonRows(
  rows: readonly string[],
  json: readonly (JsonRowStyle | undefined)[] | undefined,
  shellOutput: readonly boolean[] | undefined,
  palette: Palette,
): string[] {
  const tone: Record<JsonRowTone, Style> = {
    guide: palette.dim,
    key: palette.tool,
    index: palette.heading,
    string: palette.success,
    number: palette.warning,
    boolean: palette.link,
    null: palette.dim,
    empty: palette.dim,
  }
  return rows.map((rowText, index) => {
    const spans = json?.[index]?.spans
    if (spans === undefined) return shellOutput?.[index] === true ? palette.dim(rowText) : rowText
    let painted = ''
    let offset = 0
    for (const span of spans) {
      painted += rowText.slice(offset, span.start)
      painted += tone[span.tone](rowText.slice(span.start, span.end))
      offset = span.end
    }
    return painted + rowText.slice(offset)
  })
}
