/**
 * Live tool-argument lines. Incomplete JSON keys contribute nothing; a
 * completed content key is a size, not the text.
 * @module @deepseek-ai/dsh-tui-app/stream-args
 */

import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { jsonTreeText, type JsonRowStyle } from './json-tree.ts'

/** Keys whose completed text is shown as a size, not as the text itself. */
const SIZED_KEYS = ['content', 'old_string', 'new_string'] as const

/** A generic card's raw input rows, with token ranges when they are a JSON tree. */
export interface RawInputBody {
  lines: string[]
  json?: JsonRowStyle[]
}

/**
 * Rows for a generic card's raw input when the presenter supplied no content.
 * A todo list becomes one status line per item. A string is the program or path.
 * Any other object or array is drawn as a JSON tree.
 * @param value - the presenter's raw input.
 * @returns the rows, empty when the value is absent or an empty string.
 */
export function rawInputBody(value: unknown): RawInputBody {
  const lines = textLines(value)
  if (lines !== undefined) return { lines }
  const text = jsonText(value)
  if (text === undefined) return { lines: [] }
  return jsonTreeText(text) ?? { lines: [text] }
}

/** Rows for raw input that is text, a scalar, a todo list, or a string list; undefined for any other value. */
function textLines(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (typeof value === 'string') return value === '' ? [] : value.split('\n')
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  const todos = todoLines(value)
  if (todos !== undefined) return todos
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return value.flatMap(item => item === '' ? [] : item.split('\n'))
  }
  return undefined
}

/** `JSON.stringify` yields undefined for values with no JSON form, which its declared return type omits. */
function jsonText(value: unknown): string | undefined {
  return JSON.stringify(value)
}

/** One status line per todo item, or undefined when the value is not a todo list. */
function todoLines(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const lines: string[] = []
  const items: readonly unknown[] = value
  for (const item of items) {
    if (typeof item !== 'object' || item === null) return undefined
    if (!('content' in item) || !('status' in item)) return undefined
    if (typeof item.content !== 'string' || typeof item.status !== 'string') return undefined
    lines.push(`${item.status}  ${item.content}`)
  }
  return lines
}

/**
 * The object of keys whose delimiters have arrived. Incomplete keys are omitted.
 * @param partial - the live argument parser.
 * @returns the object, or undefined when no key is complete.
 */
export function completedArguments(partial: PartialArguments): Record<string, unknown> | undefined {
  const record: Record<string, unknown> = {}
  let any = false
  for (const key of partial.keys()) {
    if (!partial.complete(key)) continue
    const value = partial.value(key)
    if (value !== undefined) {
      record[key] = value
      any = true
      continue
    }
    const text = partial.text(key)
    if (text !== undefined) {
      record[key] = text
      any = true
    }
  }
  return any ? record : undefined
}

/**
 * Path, description, command, and size lines from keys that are already complete.
 * An incomplete key contributes nothing.
 * @param partial - the live argument parser.
 * @returns the lines.
 */
export function streamedArgumentLines(partial: PartialArguments): string[] {
  const lines: string[] = []
  const path = partial.complete('file_path')
    ? partial.text('file_path')
    : partial.complete('path') ? partial.text('path') : undefined
  if (path !== undefined && path !== '') lines.push(path)
  const command = partial.complete('command') ? partial.text('command') : undefined
  if (command !== undefined && command !== '') lines.push(command)
  const description = partial.complete('description') ? partial.text('description') : undefined
  if (description !== undefined && description !== '') {
    const first = description.split('\n')[0]
    if (first !== undefined && first !== '') lines.push(first)
  }
  for (const key of SIZED_KEYS) {
    if (!partial.complete(key)) continue
    const length = partial.stringLength(key)
    if (length === undefined || length === 0) continue
    lines.push(`${key} ${String(Math.max(1, Math.ceil(length / 1024)))} KB`)
  }
  return lines
}
