/**
 * Session facts the terminal shows and switches between: the persisted
 * session list with titles, and the label rows of the `/sessions` and
 * `/resume` picker.
 * @module @deepseek-ai/dsh-tui-app/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-title/types'
import { formatTimestamp } from './transcript.ts'

/** One switchable session as the picker shows it. */
export interface SessionChoice {
  id: SessionId
  /** The session's latest title, when one was generated or set. */
  title: string | undefined
  cwd: string | undefined
  createdAt: number
  /** Whether the session is the one the terminal drives right now. */
  current: boolean
}

/**
 * List persisted sessions newest first, with their titles; subagent sessions are excluded.
 *
 * Titles come from the live `title` projection or the durable projection
 * cache, the same values the browser list uses. The picker does not load
 * session logs, so a large corpus stays a listing of headers plus cached
 * rows. A session whose title is not yet cached shows its id until a later
 * listing after the cache has the row.
 *
 * @param ctx - plugin context carrying the session query engine.
 * @param currentId - the session the terminal drives, marked in the result.
 * @param signal - cancels the listing.
 * @returns the choices, or an empty list when no query engine is composed.
 */
export async function listSessionChoices(ctx: Context, currentId: SessionId, signal: AbortSignal): Promise<SessionChoice[]> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return []
  const records = (await query.listSessions(signal))
    // Forks keep their parent lineage and stay listed; only subagent sessions are hidden, as in the browser sidebar.
    .filter(record => record.header.origin === undefined)
    .sort((left, right) => right.header.createdAt - left.header.createdAt)
  return records.map(record => ({
    id: record.header.id,
    title: sessionListTitle(ctx, record.header),
    cwd: record.header.cwd,
    createdAt: record.header.createdAt,
    current: record.header.id === currentId,
  }))
}

/**
 * The picker row for one session: title or id, then the workspace and date.
 * @param choice - the session.
 * @returns the label and description.
 */
export function describeSession(choice: SessionChoice): { label: string; description: string } {
  const parts = [formatTimestamp(choice.createdAt)]
  if (choice.cwd !== undefined) parts.push(choice.cwd)
  if (choice.current) parts.push('current')
  return { label: choice.title ?? choice.id, description: parts.join(' · ') }
}

/**
 * Latest title for a listed session without reading its log.
 * @param ctx - plugin context carrying live projections and the optional cache.
 * @param header - the listed session's header.
 * @returns the title text, or undefined when neither source has one.
 */
function sessionListTitle(ctx: Context, header: SessionHeader): string | undefined {
  const live = ctx.get('sessions')?.get(header.id)
  if (live !== undefined) {
    const title = ctx.get('sessionProjections')?.snapshot(live, ['title']).values.title
    if (typeof title === 'string' && title !== '') return title
  }
  const cache = ctx.get('sessionProjectionCache')
  const cached = cache?.cachedSnapshot(header) ?? cache?.cachedPredecessorTitle(header)
  const title = cached?.values.title
  return typeof title === 'string' && title !== '' ? title : undefined
}
