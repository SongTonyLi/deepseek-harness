/**
 * Shared path resolution and regular-file validation for model-facing read tools.
 * @module @deepseek-ai/dsh-tool-fs/src/read-target
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { sessionResolveOptions } from './session-cwd.ts'

/**
 * Refuse a target the calling session's sandbox hides from reads: a path
 * outside the read scope of `ctx.sandbox`, or a hidden secret file. Tools
 * that read, edit, or overwrite (and so present) existing content call it
 * after resolution and before any stat, so a refusal reveals nothing about
 * the file.
 * @param ctx - the plugin context; reads are unconfined without `ctx.sandboxPolicy`.
 * @param exec - the current tool execution, supplying the session.
 * @param target - the resolved target.
 * @param mode - the call's approved escalation mode, when one applies.
 * @throws {FsError} `FS_SANDBOX_DENIED` when the target is outside the read scope.
 */
export function assertSandboxReadable(ctx: Context, exec: ToolExecution, target: FsTarget, mode?: SandboxMode): void {
  const policy = ctx.get('sandboxPolicy')
  const session = exec.agent?.session
  if (policy === undefined || policy.canRead(ctx.fs.processPath(target), {
    ...session === undefined ? {} : { session },
    ...mode === undefined ? {} : { mode },
  })) return
  throw new FsError(`cannot read "${target.displayPath}": the sandbox hides this path from this session`, 'FS_SANDBOX_DENIED')
}

/**
 * Resolve a model-supplied path, observe absence, and require a regular file.
 * @param ctx - the plugin context providing filesystem resolution and observation events.
 * @param exec - the current tool execution, including session cwd and cancellation.
 * @param requestedPath - the raw path supplied to the tool.
 * @returns the resolved target and its single stat result.
 */
export async function resolveRegularReadTarget(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
): Promise<{ target: FsTarget; info: FsInfo }> {
  const target = await ctx.fs.resolve(requestedPath, sessionResolveOptions(exec))
  assertSandboxReadable(ctx, exec, target)
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (info.type !== 'file') {
    throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  return { target, info }
}
