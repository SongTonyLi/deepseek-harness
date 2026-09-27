/**
 * The bound session's background jobs as terminal text: the one live line
 * drawn above the editor while a job runs, the `/jobs` picker rows, the
 * detail page one entered job prints, and the transient line a settlement
 * shows. Everything here is pure: jobs, output, and the clock arrive as
 * inputs.
 * @module @deepseek-ai/dsh-tui-app/jobs-panel
 */

import { truncateToWidth } from '@earendil-works/pi-tui'
import type { JobChunk, JobView } from '@deepseek-ai/dsh-jobs'
import type { Palette } from './style.ts'
import { formatElapsed, formatTimestamp } from './transcript.ts'

/** Glyph the live line and a moved call's card lead with: the hollow form of the tool card's `◆`. */
export const BACKGROUND_GLYPH = '◇'

/** What separates two facts on one line. */
const SEPARATOR = ' · '

/** The key the running spinner names while a foreground call can be moved. */
export const BACKGROUND_KEY_HINT = 'Ctrl+B background'

/** What the `/jobs` picker says between its heading and its rows. */
export const JOBS_PICKER_HINT = 'Enter shows the output · Ctrl+K stops the highlighted job'

/**
 * Output rows a detail page keeps from the end of a job's retained output.
 * The page scrolls, but a job can retain far more output than anyone reads
 * on one page; the full stream stays with the job. A presentation choice of
 * this terminal surface, not a deployment setting.
 */
export const JOB_DETAIL_OUTPUT_ROWS = 200

/**
 * Whether a job is still running or stopping.
 * @param job - the job.
 * @returns true until the job settles.
 */
export function isLive(job: Pick<JobView, 'status'>): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/**
 * How long a job has run: until now while live, until it settled otherwise.
 * @param job - the job.
 * @param now - the wall clock.
 * @returns the formatted elapsed time.
 */
export function jobElapsed(job: Pick<JobView, 'startedAt' | 'finishedAt'>, now: number): string {
  return formatElapsed((job.finishedAt ?? now) - job.startedAt)
}

/**
 * The one line drawn above the editor while a background job runs: the live
 * count, each job's id, label, and elapsed time, and the command that lists
 * them, cut to the width.
 * @param jobs - the bound session's background jobs, in registration order.
 * @param render - the palette, the wall clock, and the columns the line fits.
 * @returns the dim line, or the empty string while no job runs.
 */
export function renderJobsLine(jobs: readonly JobView[], render: { palette: Palette; now: number; width: number }): string {
  const live = jobs.filter(isLive)
  if (live.length === 0) return ''
  const { palette } = render
  const count = `${String(live.length)} in background`
  const entries = live.map(job => `${job.id} ${oneLine(job.label)} ${jobElapsed(job, render.now)}`)
  const text = [count, ...entries].join(SEPARATOR)
  const tail = `${SEPARATOR}/jobs`
  const room = Math.max(1, render.width - 2 - tail.length)
  return `${palette.accent(BACKGROUND_GLYPH)} ${palette.dim(`${truncateToWidth(text, room, '…')}${tail}`)}`
}

/**
 * One `/jobs` picker row.
 * @param job - the job.
 * @param now - the wall clock.
 * @returns the id as the label, and status, elapsed time, and job label as the description.
 */
export function jobChoice(job: JobView, now: number): { value: string; label: string; description: string } {
  return {
    value: job.id,
    label: job.id,
    description: [job.status, jobElapsed(job, now), oneLine(job.label)].join(SEPARATOR),
  }
}

/**
 * The detail page of one job: its status line, label, start, and the tail
 * of its retained output.
 * @param job - the job.
 * @param chunks - the retained output chunks, in offset order.
 * @param now - the wall clock.
 * @returns the page rows.
 */
export function jobDetailRows(job: JobView, chunks: readonly JobChunk[], now: number): string[] {
  const status = [job.status, ...job.detail === undefined ? [] : [job.detail], jobElapsed(job, now)].join(SEPARATOR)
  const rows = [status, job.label, `started ${formatTimestamp(job.startedAt)} UTC`]
  if (job.progress !== undefined) rows.push(job.progress)
  const output = chunks.map(chunk => chunk.text).join('').replace(/\n$/u, '')
  if (output === '') {
    rows.push('', isLive(job) ? 'no output yet' : 'no output')
    return rows
  }
  const lines = output.split('\n')
  const kept = lines.slice(-JOB_DETAIL_OUTPUT_ROWS)
  rows.push('', kept.length < lines.length ? `output · last ${String(kept.length)} of ${String(lines.length)} lines` : 'output')
  rows.push(...kept)
  return rows
}

/**
 * The transient line one settlement shows.
 * @param job - the settled job.
 * @param notified - whether a completion notice goes to the Agent.
 * @returns the line.
 */
export function settledToast(job: JobView, notified: boolean): string {
  const parts = [`${BACKGROUND_GLYPH} ${job.id} ${job.status}`, oneLine(job.label)]
  if (notified) parts.push('agent notified')
  return parts.join(SEPARATOR)
}

/**
 * A label on one line.
 * @param label - the job label, which a command can spread over lines.
 * @returns the label with each line break as one space.
 */
function oneLine(label: string): string {
  return label.replace(/\s*\n\s*/gu, ' ')
}
