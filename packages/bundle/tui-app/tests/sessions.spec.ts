/** The `/sessions` list: root sessions newest first, titles folded from the query engine. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describeSession, listSessionChoices } from '../src/sessions.ts'

const signal = new AbortController().signal

function record(id: string, createdAt: number, extra: Record<string, unknown> = {}): unknown {
  return { header: { id, createdAt, cwd: '/work', ...extra }, live: false, persisted: true }
}

describe('listSessionChoices', () => {
  it('returns nothing without a query engine', async () => {
    await expect(listSessionChoices(new Context(), 'session-a' as SessionId, signal)).resolves.toEqual([])
  })

  it('lists sessions and forks newest first with their titles, hides subagents, and marks the current one', async () => {
    const ctx = new Context()
    const asked: unknown[] = []
    ctx.provide('sessionQuery', {
      listSessions: () => Promise.resolve([
        record('session-a', 10),
        record('session-child', 30, { parentSession: 'session-a' }),
        record('session-sub', 40, { origin: 'subagent' }),
        record('session-b', 20),
      ]),
      readTitleSnapshots: (ids: SessionId[]) => {
        asked.push(ids)
        return Promise.resolve([
          { status: 'fulfilled', value: { title: { title: 'Newer' } } },
          { status: 'fulfilled', value: {} },
          { status: 'rejected', reason: new Error('gone') },
        ])
      },
    } as never)
    const choices = await listSessionChoices(ctx, 'session-a' as SessionId, signal)
    expect(asked).toEqual([['session-child', 'session-b', 'session-a']])
    expect(choices).toEqual([
      { id: 'session-child', title: 'Newer', cwd: '/work', createdAt: 30, current: false },
      { id: 'session-b', title: undefined, cwd: '/work', createdAt: 20, current: false },
      { id: 'session-a', title: undefined, cwd: '/work', createdAt: 10, current: true },
    ])
  })
})

describe('describeSession', () => {
  it('labels by title or id and lists the date, workspace, and current marker', () => {
    expect(describeSession({ id: 'session-a' as SessionId, title: 'Chat', cwd: '/work', createdAt: Date.UTC(2026, 8, 15, 9, 30), current: true }))
      .toEqual({ label: 'Chat', description: '2026-09-15 09:30 · /work · current' })
    expect(describeSession({ id: 'session-b' as SessionId, title: undefined, cwd: undefined, createdAt: 0, current: false }))
      .toEqual({ label: 'session-b', description: '1970-01-01 00:00' })
  })
})
