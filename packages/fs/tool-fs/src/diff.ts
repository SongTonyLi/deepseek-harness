/**
 * Result-time contextual diff presentation for write and edit. Storage returns before/after
 * text; this model-facing layer derives one three-line-context card per applied hunk.
 * @module @deepseek-ai/dsh-tool-fs/src/diff
 */

import { structuredPatch } from 'diff'
import type { FileDiff } from '@deepseek-ai/dsh-tools'

/** Context lines shown on each side of an applied hunk. */
export const DIFF_CONTEXT = 3

/**
 * The `write`/`edit` tools' private `tool/result` `meta` payload: the applied
 * contextual-diff hunks, and for `write` whether the call created or updated
 * the file, which tells an empty hunk list of a create from one of an
 * unchanged overwrite. Attached opaquely (as `unknown`) on the tool result and
 * persisted with the session log — it must be JSON-serializable (the session
 * validates this at `append`), so `presentResult` reproduces the diff card on
 * replay. The producing tool owns and narrows this opaque shape.
 */
export type FsDiffMeta = { diffs: FileDiff[]; operation?: 'create' | 'update' }

/**
 * Compute one {@link FileDiff} per hunk between `before` and `after`, each carrying the
 * applied change plus {@link DIFF_CONTEXT} context lines. Pure insertions use `oldText: null`,
 * patch-only no-newline markers are omitted, and scattered replacements remain separate hunks.
 * Each side that holds lines carries the 1-based file line it starts at.
 *
 * @param path - the path stamped on every produced diff (the model-facing `file_path`; the
 *   bridge relativizes it).
 * @param before - the file text before the change (the backend's LF-normalized diff basis).
 * @param after - the file text after the change, on the same basis.
 * @returns one diff per applied hunk, in file order; empty when the texts are identical.
 */
export function computeHunkDiffs(path: string, before: string, after: string): FileDiff[] {
  const patch = structuredPatch('', '', before, after, undefined, undefined, { context: DIFF_CONTEXT })
  const diffs: FileDiff[] = []
  for (const hunk of patch.hunks) {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const line of hunk.lines) {
      // The unified-diff marker for a missing trailing newline annotates the
      // patch, not the content — skip it so it never leaks into a diff block.
      if (line.startsWith('\\')) continue
      const text = line.slice(1)
      if (line.startsWith('-')) {
        oldLines.push(text)
      } else if (line.startsWith('+')) {
        newLines.push(text)
      } else {
        // A context (unchanged) line appears on both sides.
        oldLines.push(text)
        newLines.push(text)
      }
    }
    diffs.push({
      path,
      oldText: oldLines.length > 0 ? oldLines.join('\n') : null,
      newText: newLines.join('\n'),
      ...oldLines.length > 0 ? { oldStart: hunk.oldStart } : {},
      ...newLines.length > 0 ? { newStart: hunk.newStart } : {},
    })
  }
  return diffs
}

/** A {@link FileDiff} with no key for an absent start, which JSON metadata requires. */
type FileDiffJson = Omit<FileDiff, 'oldStart' | 'newStart'> & ({ oldStart: number } | { oldStart?: never }) & ({ newStart: number } | { newStart?: never })

/**
 * One {@link FileDiff} as `tool/result` metadata carries it: JSON with no key
 * for a start the hunk has no line for.
 * @param diff - one computed hunk.
 * @returns the same hunk as a JSON object.
 */
export function diffJson(diff: FileDiff): FileDiffJson {
  const { path, oldText, newText, oldStart, newStart } = diff
  return {
    path,
    oldText,
    newText,
    ...oldStart === undefined ? {} : { oldStart },
    ...newStart === undefined ? {} : { newStart },
  }
}

/** Whether `value` is a valid {@link FileDiff} (defensive narrowing from opaque `meta`). */
function isFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, oldText, newText, oldStart, newStart } = value as Record<string, unknown>
  return typeof path === 'string'
    && (oldText === null || typeof oldText === 'string')
    && typeof newText === 'string'
    && (oldStart === undefined || isLineNumber(oldStart))
    && (newStart === undefined || isLineNumber(newStart))
}

/** Whether `value` is a 1-based integer file line. */
function isLineNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/**
 * Narrow opaque live or replayed result metadata to non-empty file diffs. Malformed metadata
 * returns `undefined` so presentation can fall back instead of throwing during replay.
 * @param meta - result metadata.
 * @returns validated hunks, or `undefined` for absent or malformed data.
 */
export function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every(isFileDiff)) return undefined
  return diffs
}
