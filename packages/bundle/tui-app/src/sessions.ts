/**
 * Session facts the terminal shows and switches between: the persisted
 * session list with titles, and the label rows of the `/sessions` and
 * `/resume` picker.
 * @module @deepseek-ai/dsh-tui-app/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
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
  const titles = await query.readTitleSnapshots(records.map(record => record.header.id), signal)
  return records.map((record, index) => {
    const observed = titles[index]
    const title = observed?.status === 'fulfilled' ? observed.value.title?.title : undefined
    return {
      id: record.header.id,
      title,
      cwd: record.header.cwd,
      createdAt: record.header.createdAt,
      current: record.header.id === currentId,
    }
  })
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
