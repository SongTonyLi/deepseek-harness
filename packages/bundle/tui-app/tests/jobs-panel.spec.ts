/** The background-jobs line, `/jobs` rows, detail page, and settlement line as pure text. */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { JobId, type JobView } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JOB_DETAIL_OUTPUT_ROWS, jobChoice, jobDetailRows, renderJobsLine, settledToast } from '../src/jobs-panel.ts'
import { createPalette } from '../src/style.ts'

const palette = createPalette(false)

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: JobId('tool-1'),
    kind: 'tool',
    label: 'bash npm test',
    owner: SessionId('session-1'),
    status: 'running',
    startedAt: 1_000,
    output: { total: 0, earliest: 0 },
    ...overrides,
  }
}

describe('jobs panel text', () => {
  it('draws one line for the live jobs only, and nothing while none runs', () => {
    const jobs = [
      job(),
      job({ id: JobId('bash-2'), kind: 'bash', label: 'sleep 20\n&& echo done', status: 'stopping', startedAt: 51_000 }),
      job({ id: JobId('tool-3'), status: 'completed', finishedAt: 5_000 }),
    ]
    expect(renderJobsLine(jobs, { palette, now: 65_000, width: 100 }))
      .toBe('◇ 2 in background · tool-1 bash npm test 1m04s · bash-2 sleep 20 && echo done 14s · /jobs')
    expect(renderJobsLine([jobs[2]!], { palette, now: 65_000, width: 100 })).toBe('')
  })

  it('cuts the line to the width and keeps the command that lists every job', () => {
    const line = renderJobsLine([job({ label: 'x'.repeat(80) })], { palette, now: 1_000, width: 40 })
    expect(line).toMatch(/…(?:\u001b\[0m)? · \/jobs$/u)
    expect(visibleWidth(line)).toBeLessThanOrEqual(40)
  })

  it('describes a picker row by status, elapsed time, and label', () => {
    expect(jobChoice(job({ status: 'failed', finishedAt: 3_000, detail: 'exit code: 2' }), 90_000))
      .toEqual({ value: 'tool-1', label: 'tool-1', description: 'failed · 2s · bash npm test' })
  })

  it('pages the status, the label, the start, the progress, and the output tail', () => {
    expect(jobDetailRows(job({ progress: 'phase 2/3' }), [{ at: 0, text: 'one\n' }, { at: 4, text: 'two\n' }], 3_000)).toEqual([
      'running · 2s',
      'bash npm test',
      'started 1970-01-01 00:00 UTC',
      'phase 2/3',
      '',
      'output',
      'one',
      'two',
    ])
    const long = Array.from({ length: JOB_DETAIL_OUTPUT_ROWS + 5 }, (_, index) => `row ${String(index)}`).join('\n')
    const rows = jobDetailRows(job({ status: 'killed', detail: 'stopped by the user', finishedAt: 2_000 }), [{ at: 0, text: long }], 9_000)
    expect(rows[0]).toBe('killed · stopped by the user · 1s')
    expect(rows).toContain(`output · last ${String(JOB_DETAIL_OUTPUT_ROWS)} of ${String(JOB_DETAIL_OUTPUT_ROWS + 5)} lines`)
    expect(rows.at(-1)).toBe(`row ${String(JOB_DETAIL_OUTPUT_ROWS + 4)}`)
    expect(rows).not.toContain('row 4')
  })

  it('says whether output may still come when a job wrote none', () => {
    expect(jobDetailRows(job(), [], 1_000).at(-1)).toBe('no output yet')
    expect(jobDetailRows(job({ status: 'completed', finishedAt: 1_000 }), [], 1_000).at(-1)).toBe('no output')
  })

  it('names the settlement, and whether the Agent hears of it', () => {
    expect(settledToast(job({ status: 'completed' }), true)).toBe('◇ tool-1 completed · bash npm test · agent notified')
    expect(settledToast(job({ status: 'killed' }), false)).toBe('◇ tool-1 killed · bash npm test')
  })
})
