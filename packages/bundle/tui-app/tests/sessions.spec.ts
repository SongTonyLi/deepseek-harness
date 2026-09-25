/** The `/sessions` and `/resume` list: root sessions newest first with cached or live titles. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { describeSession, listSessionChoices } from '../src/sessions.ts'

const signal = new AbortController().signal

function record(id: string, createdAt: number, extra: Record<string, unknown> = {}): unknown {
  return { header: { id, createdAt, cwd: '/work', ...extra }, live: false, persisted: true }
}

describe('listSessionChoices', () => {
  it('returns nothing without a query engine', async () => {
    await expect(listSessionChoices(new Context(), 'session-a' as SessionId, signal)).resolves.toEqual([])
  })

  it('lists sessions and forks newest first with live or cached titles, hides subagents, and marks the current one', async () => {
    const ctx = new Context()
    let titleReads = 0
    ctx.provide('sessionQuery', {
      listSessions: () => Promise.resolve([
        record('session-a', 10),
        record('session-child', 30, { parentSession: 'session-a' }),
        record('session-sub', 40, { origin: 'subagent' }),
        record('session-b', 20),
        record('session-c', 15),
      ]),
      readTitleSnapshots: () => {
        titleReads += 1
        return Promise.reject(new Error('listSessionChoices must not load session logs for titles'))
      },
    } as never)
    ctx.provide('sessions', {
      get: (id: string) => id === 'session-child' ? { id } : undefined,
    } as never)
    ctx.provide('sessionProjections', {
      snapshot: () => ({ values: { title: 'Live title' } }),
    } as never)
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: (header: SessionHeader) => (
        header.id === 'session-b' ? { values: { title: 'Cached' } } : undefined
      ),
      cachedPredecessorTitle: (header: SessionHeader) => (
        header.id === 'session-c' ? { values: { title: 'Predecessor' } } : undefined
      ),
    } as never)
    const choices = await listSessionChoices(ctx, 'session-a' as SessionId, signal)
    expect(titleReads).toBe(0)
    expect(choices).toEqual([
      { id: 'session-child', title: 'Live title', cwd: '/work', createdAt: 30, current: false },
      { id: 'session-b', title: 'Cached', cwd: '/work', createdAt: 20, current: false },
      { id: 'session-c', title: 'Predecessor', cwd: '/work', createdAt: 15, current: false },
      { id: 'session-a', title: undefined, cwd: '/work', createdAt: 10, current: true },
    ])
  })

  it('falls through an empty live title to the cache, and treats a blank cache row as missing', async () => {
    const ctx = new Context()
    ctx.provide('sessionQuery', {
      listSessions: () => Promise.resolve([record('session-live', 2), record('session-blank', 1)]),
    } as never)
    ctx.provide('sessions', {
      get: (id: string) => id === 'session-live' ? { id } : undefined,
    } as never)
    ctx.provide('sessionProjections', {
      snapshot: () => ({ values: { title: null } }),
    } as never)
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: (header: SessionHeader) => (
        header.id === 'session-live'
          ? { values: { title: 'From cache' } }
          : { values: { title: '' } }
      ),
      cachedPredecessorTitle: () => undefined,
    } as never)
    await expect(listSessionChoices(ctx, 'session-blank' as SessionId, signal)).resolves.toEqual([
      { id: 'session-live', title: 'From cache', cwd: '/work', createdAt: 2, current: false },
      { id: 'session-blank', title: undefined, cwd: '/work', createdAt: 1, current: true },
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
