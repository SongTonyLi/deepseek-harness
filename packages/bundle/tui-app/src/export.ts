/**
 * `/export`: the same session-log ZIP the browser downloads, written to a
 * local directory through the export package's archive helpers.
 * @module @deepseek-ai/dsh-tui-app/export
 */

import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
} from '@deepseek-ai/dsh-session-log-export'

/**
 * Write the session tree (the session, its sub-sessions, and attachments) as
 * a ZIP archive into `directory`.
 * @param ctx - plugin context carrying the query, persistence, and attachment services.
 * @param sessionId - the session to export.
 * @param directory - the directory the archive is written into.
 * @param signal - cancels the export.
 * @returns the archive's absolute path.
 * @throws when a required service is not composed or the session has no persisted log.
 */
export async function exportSessionZip(ctx: Context, sessionId: SessionId, directory: string, signal: AbortSignal): Promise<string> {
  const deps = sessionLogExportDeps(ctx)
  if (deps.sessionQuery === undefined || deps.sessionPersistence === undefined || deps.attachments === undefined) {
    throw new Error('export needs the session query, persistence, and attachment services')
  }
  const ready = { ...deps, sessionQuery: deps.sessionQuery, sessionPersistence: deps.sessionPersistence, attachments: deps.attachments }
  await flushLiveSessionLog(deps, sessionId, signal)
  const root = await readSessionLogText(deps.sessionPersistence, sessionId, signal)
  if (root === undefined) throw new Error(`session ${sessionId} has no persisted log to export`)
  const path = join(directory, sessionLogZipFilename(sessionId))
  const archive = streamSessionLogZip(ready, root, sessionId, true, DEFAULT_SESSION_LOG_COMPRESSION_LEVEL, signal)
  // Node's stream typings narrow BYOB reads to ArrayBuffer-backed views; the ZIP stream only yields plain chunks.
  await pipeline(Readable.fromWeb(archive as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(path), { signal })
  return path
}
