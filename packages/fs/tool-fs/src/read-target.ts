/**
 * Shared path resolution, sandbox read authorization, and regular-file
 * validation for model-facing read tools.
 * @module @deepseek-ai/dsh-tool-fs/src/read-target
 */

import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { isHiddenIn, isReadableIn, matchesNameGlob } from '@deepseek-ai/dsh-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { sessionResolveOptions } from './session-cwd.ts'

/**
 * Refuse a target the calling session's sandbox hides from reads: a path
 * outside the read scope of `ctx.sandbox`, or a hidden secret file. `edit`
 * and `write`, which present existing content, call it after resolution and
 * before any stat, so a refusal reveals nothing about the file; reaching
 * outside the workspace there takes a `danger-full-access` escalation.
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

/** The model-facing refusal for a path the sandbox read scope excludes. */
function hiddenMessage(displayPath: string): string {
  return `cannot read "${displayPath}": the sandbox hides this path from this session`
}

/**
 * Whether `path` lies under `root` by spelling alone. No filesystem call
 * runs, so a path that only symlinks or `..` traversal would place under the
 * root reads as outside.
 */
function isLexicallyUnder(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel.split(/[\\/]/u)[0] !== '..')
}

/**
 * Ask the user once to let this call read a path outside the sandbox read
 * scope. Only `allowed-once` returns; every other outcome, a missing approval
 * service, and an agentless call throw before the path is read.
 * @param ctx - the plugin context resolving the optional `approval` service.
 * @param exec - the current tool execution, supplying the agent, call id, and signal.
 * @param path - the host path shown to the user and recorded in the audit reason.
 * @param displayPath - the path rendered in model-facing refusals.
 * @param toolName - the reading tool's name, recorded on the approval request.
 */
async function approveOutsideRead(ctx: Context, exec: ToolExecution, path: string, displayPath: string, toolName: string): Promise<void> {
  const approval = ctx.get('approval')
  const unavailable = `${hiddenMessage(displayPath)}, and no user approval is available to read it`
  if (approval === undefined || exec.agent === undefined) throw new FsError(unavailable, 'FS_SANDBOX_DENIED')
  const outcome = await approval.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason: `read outside the sandbox read scope: ${path}`,
    displayReason: {
      en: `Allow reading this file outside the session workspace once: ${path}`,
      zh: `允许本次读取会话工作区之外的文件：${path}`,
    },
    signal: exec.signal,
  })
  switch (outcome) {
    case 'allowed-once':
      return
    case 'rejected':
      throw new FsError(`cannot read "${displayPath}": the user declined access to this path outside the session workspace; do not retry or work around it`, 'FS_SANDBOX_DENIED')
    case 'cancelled':
      throw new FsError(`cannot read "${displayPath}": approval to read this path outside the session workspace was cancelled`, 'FS_SANDBOX_DENIED')
    case 'unavailable':
      throw new FsError(unavailable, 'FS_SANDBOX_DENIED')
    /* v8 ignore next 4 -- ApprovalOutcome is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const unknown: never = outcome
      throw new Error(`unreachable approval outcome: ${String(unknown)}`)
    }
  }
}

/**
 * Resolve a model-supplied path and authorize one read of it under the
 * calling session's sandbox read scope. A path inside the scope reads without
 * asking, and a hidden secret file is refused without asking. Any other path
 * asks the user through `ctx.approval`; only `allowed-once` lets this one call
 * read it, and the grant widens neither the session's read scope nor what
 * confined commands can see.
 *
 * A path whose spelling leaves the scope roots, or that contains a `..`
 * segment, is asked about before `ctx.fs.resolve` canonicalizes it, so the
 * Harness makes no filesystem call on an external path the user has not
 * approved. A path spelled inside the roots resolves first; when its
 * canonical identity leaves the scope (a symlink in the workspace), the ask
 * follows resolution. Either way the hidden-name check repeats on the
 * canonical path, and the ask precedes every stat and read.
 * @param ctx - the plugin context; reads are unconfined without `ctx.sandboxPolicy`.
 * @param exec - the current tool execution, supplying the session, agent, call id, and signal.
 * @param requestedPath - the raw path supplied to the tool.
 * @param toolName - the reading tool's name, recorded on the approval request.
 * @returns the resolved target, authorized for this call.
 * @throws {FsError} `FS_SANDBOX_DENIED` when the path is hidden, the user does
 *   not grant the outside read, or no approval channel can ask.
 */
export async function resolveAuthorizedReadTarget(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
  toolName: string,
): Promise<FsTarget> {
  const options = sessionResolveOptions(exec)
  const policy = ctx.get('sandboxPolicy')
  const session = exec.agent?.session
  const request = session === undefined ? {} : { session }
  const scope = policy?.readScope(request)
  if (policy === undefined || scope === undefined) return ctx.fs.resolve(requestedPath, options)

  const spelled = resolve(options.cwd ?? policy.resolve(request).workspaceRoot, requestedPath)
  const spelledInside = !requestedPath.split(/[\\/]/u).includes('..')
    && scope.roots.some(root => isLexicallyUnder(spelled, root))
  let approved = false
  if (!spelledInside) {
    if (scope.hiddenNames.some(glob => matchesNameGlob(basename(spelled), glob))) {
      throw new FsError(hiddenMessage(requestedPath), 'FS_SANDBOX_DENIED')
    }
    await approveOutsideRead(ctx, exec, spelled, requestedPath, toolName)
    approved = true
  }

  const target = await ctx.fs.resolve(requestedPath, options)
  const path = ctx.fs.processPath(target)
  if (isReadableIn(path, scope)) return target
  if (isHiddenIn(path, scope)) throw new FsError(hiddenMessage(target.displayPath), 'FS_SANDBOX_DENIED')
  if (!approved) await approveOutsideRead(ctx, exec, path, target.displayPath, toolName)
  return target
}

/**
 * Resolve and authorize a model-supplied path (see
 * {@link resolveAuthorizedReadTarget}), observe absence, and require a
 * regular file.
 * @param ctx - the plugin context providing filesystem resolution and observation events.
 * @param exec - the current tool execution, including session cwd and cancellation.
 * @param requestedPath - the raw path supplied to the tool.
 * @param toolName - the reading tool's name, recorded on an approval request.
 * @returns the resolved target and its single stat result.
 */
export async function resolveRegularReadTarget(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
  toolName: string,
): Promise<{ target: FsTarget; info: FsInfo }> {
  const target = await resolveAuthorizedReadTarget(ctx, exec, requestedPath, toolName)
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
