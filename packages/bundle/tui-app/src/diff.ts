/**
 * Line diff for tool cards: a longest-common-subsequence alignment of old and
 * new text, bounded so a huge file falls back to a plain replacement view.
 * @module @deepseek-ai/dsh-tui-app/diff
 */

/** One aligned diff row. */
export interface DiffLine {
  kind: 'context' | 'added' | 'removed'
  text: string
}

/** The kind of a changed diff row: the rows a card frames in a colored box. */
export type DiffMark = Exclude<DiffLine['kind'], 'context'>

/** Above this many old×new line pairs the quadratic alignment is skipped. */
const MAX_ALIGNMENT_CELLS = 4_000_000

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Align `oldText` against `newText` line by line.
 * @param oldText - the previous file content, or null when the file is new.
 * @param newText - the new file content.
 * @returns the rows in display order; a new file yields only added rows.
 */
export function diffLines(oldText: string | null, newText: string): DiffLine[] {
  const next = splitLines(newText)
  if (oldText === null) return next.map(text => ({ kind: 'added', text }))
  const previous = splitLines(oldText)
  if (previous.length * next.length > MAX_ALIGNMENT_CELLS) {
    return [
      ...previous.map((text): DiffLine => ({ kind: 'removed', text })),
      ...next.map((text): DiffLine => ({ kind: 'added', text })),
    ]
  }
  // lcs[i * cols + j] = LCS length of previous[i..] against next[j..]. Every
  // index read below is inside the allocated table, so the reads are asserted.
  const cols = next.length + 1
  const lcs = new Uint32Array((previous.length + 1) * cols)
  for (let i = previous.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      lcs[i * cols + j] = previous[i] === next[j]
        ? (lcs[(i + 1) * cols + j + 1] as number) + 1
        : Math.max(lcs[(i + 1) * cols + j] as number, lcs[i * cols + j + 1] as number)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < previous.length && j < next.length) {
    if (previous[i] === next[j]) {
      out.push({ kind: 'context', text: previous[i] as string })
      i++
      j++
    } else if ((lcs[(i + 1) * cols + j] as number) >= (lcs[i * cols + j + 1] as number)) {
      out.push({ kind: 'removed', text: previous[i] as string })
      i++
    } else {
      out.push({ kind: 'added', text: next[j] as string })
      j++
    }
  }
  for (; i < previous.length; i++) out.push({ kind: 'removed', text: previous[i] as string })
  for (; j < next.length; j++) out.push({ kind: 'added', text: next[j] as string })
  return out
}

/**
 * Keep changed rows plus `context` unchanged rows around each change, so a
 * card shows the hunks rather than the whole file.
 * @param lines - the aligned rows.
 * @param context - unchanged rows kept on each side of a change.
 * @returns the rows to display, with an `undefined` gap marker where rows were elided.
 */
export function hunks<T extends DiffLine>(lines: readonly T[], context: number): (T | undefined)[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === 'context') return
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true
  })
  const out: (T | undefined)[] = []
  let gap = false
  lines.forEach((line, index) => {
    if (keep[index] === true) {
      out.push(line)
      gap = false
    } else if (!gap) {
      out.push(undefined)
      gap = true
    }
  })
  return out
}
