/**
 * Terminal rows for the browser's settings, plugins, subagents, deliverables,
 * and turn-outline pages. Each reader resolves its service through `ctx.get`
 * and throws an `Error` naming the absent service; the app prints the message.
 * @module @deepseek-ai/dsh-tui-app/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { pluginFiberPhase } from '@deepseek-ai/dsh-host-plugin-inventory'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-turn-outline'
import type { SettingsDescriptor, SettingsProvider } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subagent'
import type { PresentedFile } from '@deepseek-ai/dsh-tool-present/types'

/** Two-space indentation per nesting level. */
function indent(depth: number): string {
  return '  '.repeat(depth)
}

/** The settings service, or a printable error naming its absence. */
function requireSettings(ctx: Context): SettingsProvider {
  const settings = ctx.get('settings')
  if (settings === undefined) throw new Error('settings are not mounted in this profile')
  return settings
}

/** One namespace's redacted descriptor, or a printable error when it is not registered. */
function requireDescriptor(settings: SettingsProvider, ns: string): SettingsDescriptor {
  const descriptor = settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === ns)
  if (descriptor === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
  return descriptor
}

/**
 * One row per registered settings namespace: the namespace, its revision,
 * whether the stored user section overrides anything, and when its owner
 * applies changes.
 * @param ctx - plugin context carrying the optional settings service.
 * @returns the rows in registration order.
 * @throws {Error} when no settings service is mounted.
 */
export function listSettings(ctx: Context): string[] {
  return requireSettings(ctx).describe({ redactSecrets: true }).map((descriptor) => {
    const overridden = Object.keys(descriptor.user ?? {}).length > 0
    return `${descriptor.ns}  rev ${String(descriptor.revision)}  ${overridden ? 'user-overridden' : 'inherited'}  applies ${descriptor.applies}`
  })
}

/**
 * Pretty-printed JSON of one namespace's resolved value with every secret
 * field removed, followed by one row per secret slot stating whether it holds
 * a value.
 * @param ctx - plugin context carrying the optional settings service.
 * @param ns - the registered namespace to show.
 * @returns the JSON lines, then the secret-slot rows.
 * @throws {Error} when no settings service is mounted or `ns` is not registered.
 */
export function showSetting(ctx: Context, ns: string): string[] {
  const descriptor = requireDescriptor(requireSettings(ctx), ns)
  const rows = JSON.stringify(descriptor.value, null, 2).split('\n')
  for (const secret of descriptor.secrets ?? []) {
    rows.push(`secret ${secret.path.join('.')}: ${secret.set ? 'set' : 'unset'}`)
  }
  return rows
}

/**
 * Write one field of a namespace's user section through a path-addressed
 * `set` against the revision read at call time. `rawValue` is parsed as JSON
 * when it is valid JSON and stored as a string otherwise; an empty `path`
 * addresses the section root, which then requires a JSON object.
 * @param ctx - plugin context carrying the optional settings service.
 * @param ns - the registered namespace to edit.
 * @param path - dot-separated field path (`api.timeoutMs`), or `''` for the root.
 * @param rawValue - the typed value, JSON or plain text.
 * @returns a confirmation row naming the namespace, path, and stored value.
 * @throws {Error} when no settings service is mounted or `ns` is not registered.
 */
export async function setSetting(ctx: Context, ns: string, path: string, rawValue: string): Promise<string> {
  const settings = requireSettings(ctx)
  const { revision } = requireDescriptor(settings, ns)
  const value = parseSettingValue(rawValue)
  const parts = path === '' ? [] : path.split('.')
  await settings.mutate(ns, [{ op: 'set', path: parts, value }], revision)
  return `settings ${ns}: set ${path === '' ? '(root)' : path} = ${JSON.stringify(value)}`
}

/** JSON when the text parses, otherwise the text itself. */
function parseSettingValue(rawValue: string): unknown {
  try {
    return JSON.parse(rawValue) as unknown
  } catch {
    // Only a SyntaxError from malformed JSON reaches here; plain text is a valid string value.
    return rawValue
  }
}

/**
 * Empty one namespace's user section so every field re-inherits its
 * composition base and schema default.
 * @param ctx - plugin context carrying the optional settings service.
 * @param ns - the registered namespace to reset.
 * @returns a confirmation row.
 * @throws {Error} when no settings service is mounted or `ns` is not registered.
 */
export async function resetSetting(ctx: Context, ns: string): Promise<string> {
  const settings = requireSettings(ctx)
  const { revision } = requireDescriptor(settings, ns)
  await settings.replace(ns, {}, revision)
  return `settings ${ns}: reset to defaults`
}

/**
 * One row per non-group Loader entry: entry id, module name, effective
 * enablement, and the root Fiber phase (`none` without a live root Fiber).
 * @param ctx - plugin context carrying the optional Cordis Loader.
 * @returns the rows in Loader order.
 * @throws {Error} when no Loader is mounted.
 */
export function listPlugins(ctx: Context): string[] {
  const loader = ctx.get('loader')
  if (loader === undefined) throw new Error('the plugin loader is not mounted in this profile')
  const rows: string[] = []
  for (const entry of loader.entries()) {
    if (entry.options.group) continue
    const phase = pluginFiberPhase(entry.fiber?.state)
    rows.push(`${entry.id}  ${entry.options.name}  ${entry.disabled ? 'disabled' : 'enabled'}  ${phase ?? 'none'}`)
  }
  return rows
}

/**
 * Every session-backed subagent below one session in pre-order, one row each,
 * indented by tree depth: the child session id (usable with `/sessions` and
 * `--resume`), its activity, mode, and label; a diagnostic candidate shows its
 * reason instead.
 * @param ctx - plugin context carrying the optional subagent runtime.
 * @param sessionId - the root session whose descendants are listed.
 * @param signal - cancels the listing.
 * @returns the rows, empty when the session has no subagents.
 * @throws {Error} when no subagent runtime is mounted.
 */
export async function listSubagents(ctx: Context, sessionId: SessionId, signal: AbortSignal): Promise<string[]> {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) throw new Error('subagents are not mounted in this profile')
  const entries = await subagents.listDescendants(sessionId, signal)
  return entries.map((entry) => {
    const prefix = `${indent(entry.depth - 1)}${entry.id}`
    if (entry.kind === 'diagnostic') return `${prefix}  ${entry.reason}`
    const label = entry.label === undefined ? '' : `  ${entry.label}`
    return `${prefix}  ${entry.activity}  ${entry.mode}${label}`
  })
}

/**
 * Files the model declared through the present tool, folded from the
 * session's `deliverables/presented` events and grouped under one `turn N`
 * heading per turn in log order.
 * @param ctx - plugin context carrying the optional session query engine.
 * @param sessionId - the session whose log is read.
 * @param signal - cancels a cold log read.
 * @returns the heading and file rows, empty when nothing was presented.
 * @throws {Error} when no session query engine is mounted.
 */
export async function listDeliverables(ctx: Context, sessionId: SessionId, signal: AbortSignal): Promise<string[]> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) throw new Error('the session query engine is not mounted in this profile')
  using observation = await query.observeSession(sessionId, { signal, projectionMode: 'none' })
  const turns = new Map<number, PresentedFile[]>()
  for (const event of observation.events) {
    if (event.type !== 'deliverables/presented') continue
    const files = turns.get(event.data.turn) ?? []
    files.push(...event.data.files)
    turns.set(event.data.turn, files)
  }
  const rows: string[] = []
  for (const [turn, files] of turns) {
    rows.push(`turn ${String(turn)}`)
    for (const file of files) {
      rows.push(`${indent(1)}${file.path}${file.description === undefined ? '' : `  ${file.description}`}`)
    }
  }
  return rows
}

/**
 * The session's turn outline: one numbered row per started turn with its
 * prompt preview, followed by an indented response preview once the turn
 * ended with assistant text.
 * @param ctx - plugin context carrying the optional projection registry.
 * @param session - the live session whose outline is read.
 * @returns the rows, empty before the first turn starts.
 * @throws {Error} when no projection registry is mounted or the `turnOutline` unit is not registered.
 */
export function sessionOutline(ctx: Context, session: Session): string[] {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) throw new Error('session projections are not mounted in this profile')
  const outline = projections.snapshot(session, ['turnOutline']).values.turnOutline
  if (outline === undefined) throw new Error('the turnOutline projection is not registered in this profile')
  const rows: string[] = []
  for (const entry of outline) {
    rows.push(`${String(entry.turn)}. ${entry.prompt === '' ? '(no prompt)' : entry.prompt}`)
    if (entry.response !== '') rows.push(`${indent(1)}→ ${entry.response}`)
  }
  return rows
}
