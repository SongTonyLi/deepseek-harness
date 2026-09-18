/**
 * Project logged system prompts and injected user-role messages into the
 * compact titles and navigable sections the terminal transcript walks.
 *
 * Compaction replacements, tool results, and the user's own prompts are not
 * context: those have their own blocks. An empty system-prompt rendering logs
 * that no prompt is in force and is omitted here.
 * @module @deepseek-ai/dsh-tui-app/context
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SectionKind, SectionPart } from './navigation.ts'
import { contentText } from './transcript.ts'

/** Producer-declared forms this surface presents structurally. */
const KNOWN_FORMS = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'] as const

/** One of {@link KNOWN_FORMS}. */
type KnownForm = (typeof KNOWN_FORMS)[number]

/** Compact title and the sections the inspector and `Enter` open. */
export interface ContextProjection {
  /** Form and producer, a notice summary, or `system prompt` / `system prompt update`. */
  readonly title: string
  /** The model-facing rows, one part per snapshot contribution when those are recorded. */
  readonly parts: readonly SectionPart[]
}

/**
 * Project one nonempty system prompt into a transcript section.
 * @param text - the rendered prompt; `''` means no prompt is in force.
 * @param update - whether a nonempty prompt already appeared in this transcript.
 * @returns the section, or undefined when `text` is empty.
 */
export function systemPromptView(text: string, update: boolean): ContextProjection | undefined {
  if (text === '') return undefined
  return {
    title: update ? 'system prompt update' : 'system prompt',
    parts: [{ kind: 'system', rows: text.split('\n') }],
  }
}

/**
 * Project one injected `user/message` into a transcript section.
 * @param source - the message's durable source.
 * @param content - the model-facing blocks.
 * @returns the section, or undefined when this message is not injected context.
 */
export function injectedContextView(source: unknown, content: readonly ContentBlock[]): ContextProjection | undefined {
  const record = recordOf(source)
  const kind = stringField(record, 'kind')
  if (record === undefined || kind === undefined) return undefined
  if (kind === 'user' || kind === 'tool' || kind === 'model') return undefined
  if (kind === 'plugin' && stringField(record, 'plugin') === 'compact') return undefined
  const form = knownForm(stringField(record, 'form'))
  const producer = producerOf(record, kind)
  return {
    title: titled(form, producer, stringField(record, 'summary')),
    parts: form === 'snapshot' ? snapshotParts(record, content) : [{ kind: partKind(form), rows: rowsOf(content) }],
  }
}

/**
 * Narrow a value to a string-keyed record.
 * @param value - a durable source or a snapshot entry.
 * @returns the record, or undefined when the value is not one.
 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Read a nonempty string field.
 * @param record - the record to read, or undefined.
 * @param key - the field name.
 * @returns the field, or undefined when it is missing or empty.
 */
function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Collect nonempty named strings from an array field, first-seen order.
 * @param record - the source record.
 * @param member - the array field.
 * @param key - the entry field that names the item.
 * @returns the labels.
 */
function labelsIn(record: Record<string, unknown> | undefined, member: string, key: string): string[] {
  const list = record?.[member]
  if (!Array.isArray(list)) return []
  const labels: string[] = []
  for (const entry of list) {
    const label = stringField(recordOf(entry), key)
    if (label !== undefined && !labels.includes(label)) labels.push(label)
  }
  return labels
}

/**
 * Name the producer a durable source identifies.
 * @param record - the source record.
 * @param kind - the source kind, already read.
 * @returns a label the heading can show.
 */
function producerOf(record: Record<string, unknown>, kind: string): string {
  switch (kind) {
    case 'plugin':
      return stringField(record, 'plugin') ?? kind
    case 'skill-invocation':
      return stringField(record, 'name') ?? kind
    case 'session-reference': {
      const labels = labelsIn(record, 'references', 'label')
      return labels.length > 0 ? labels.join(', ') : kind
    }
    case 'agent-instructions': {
      const paths = labelsIn(record, 'changes', 'path')
      return paths.length > 0 ? paths.join(', ') : kind
    }
    default:
      return kind
  }
}

/**
 * Narrow a logged form to one this surface presents structurally.
 * @param form - the source's `form` field.
 * @returns the form, or undefined for an absent or unknown value.
 */
function knownForm(form: string | undefined): KnownForm | undefined {
  return form !== undefined && (KNOWN_FORMS as readonly string[]).includes(form)
    ? form as KnownForm
    : undefined
}

/**
 * The section kind that matches a known form, or `context` for an opaque body.
 * @param form - the known form, or undefined.
 * @returns the kind.
 */
function partKind(form: KnownForm | undefined): SectionKind {
  return form ?? 'context'
}

/**
 * Compose the compact title from form, producer, and an optional notice summary.
 * @param form - the known form, or undefined.
 * @param producer - the producer label.
 * @param summary - a notice's one-line account, when present.
 * @returns the title.
 */
function titled(form: KnownForm | undefined, producer: string, summary: string | undefined): string {
  if (form === 'notice') return summary === undefined ? `notice · ${producer}` : `notice · ${summary}`
  return form === undefined ? producer : `${form} · ${producer}`
}

/**
 * The assembled snapshot as one part, used when named contributions are
 * absent or unreadable so the model-facing text is never dropped.
 * @param content - the assembled blocks.
 * @returns one snapshot part.
 */
function assembledSnapshot(content: readonly ContentBlock[]): SectionPart[] {
  return [{ kind: 'snapshot', rows: rowsOf(content) }]
}

/**
 * Split a snapshot into one part per named contribution.
 *
 * The list is all-or-nothing: one unreadable entry means the assembled
 * text is the part, matching how a partial list would hide the only
 * complete account of what the model read.
 * @param record - the source record, which may carry `sections`.
 * @param content - the assembled model-facing blocks, used when sections are absent or unreadable.
 * @returns the parts.
 */
function snapshotParts(record: Record<string, unknown>, content: readonly ContentBlock[]): SectionPart[] {
  const list = record.sections
  if (!Array.isArray(list) || list.length === 0) return assembledSnapshot(content)
  const parts: SectionPart[] = []
  for (const entry of list) {
    const item = recordOf(entry)
    if (item === undefined) return assembledSnapshot(content)
    const name = stringField(item, 'name')
    if (name === undefined || typeof item.text !== 'string') return assembledSnapshot(content)
    parts.push({ kind: 'snapshot', label: name, rows: rowsOfText(item.text) })
  }
  return parts
}

/**
 * The model-facing blocks as source rows.
 * @param content - the content blocks.
 * @returns the rows; one blank row when there is no text, so the keyboard still has a section.
 */
function rowsOf(content: readonly ContentBlock[]): string[] {
  return rowsOfText(contentText(content))
}

/**
 * Split text into source rows.
 * @param text - the model-facing text.
 * @returns the rows; one blank row when `text` is empty.
 */
function rowsOfText(text: string): string[] {
  return text === '' ? [''] : text.split('\n')
}
