/**
 * Terminal rows for the browser's settings, plugins, subagents, deliverables,
 * changed-files, and turn-outline pages, and the plugin-management verbs the
 * browser's Plugins page offers. Each reader resolves its service through
 * `ctx.get` and throws an `Error` naming the absent service; the app prints
 * the message. `subagentDetail` is the exception: it returns that message as a
 * row.
 * @module @deepseek-ai/dsh-tui-app/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { pluginFiberPhase } from '@deepseek-ai/dsh-host-plugin-inventory'
import type { BundleInfo, ChangeResult, PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-title/types'
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-turn-outline'
import type { SettingsDescriptor, SettingsForms } from '@deepseek-ai/dsh-settings'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { PresentedFile } from '@deepseek-ai/dsh-tool-present/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { WorkspaceChanges, WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes'
import { describeFailure, formatTimestamp } from './transcript.ts'

/**
 * Turns and presented files a subagent detail page lists in full; the rest of
 * each list folds into one `… <n> more …` row.
 */
const SUBAGENT_DETAIL_LIMIT = 8

/** Two-space indentation per nesting level. */
function indent(depth: number): string {
  return '  '.repeat(depth)
}

/** The settings service, or a printable error naming its absence. */
function requireSettings(ctx: Context): SettingsForms {
  const settings = ctx.get('settings')
  if (settings === undefined) throw new Error('settings are not mounted in this profile')
  return settings
}

/** One namespace's redacted descriptor, or a printable error when it is not registered. */
function requireDescriptor(settings: SettingsForms, ns: string): SettingsDescriptor {
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

/** One `/subagents` picker row over a descendant listing entry. */
export interface SubagentChoice {
  /** The descendant session id; the picker row value. */
  id: SessionId
  /** Root-relative depth, 1 for a direct child. */
  depth: number
  /** Row label: the depth indent, then the durable label when the entry has one, else the id. */
  label: string
  /** Row description: activity, mode, the id when the label already shows one, or the diagnostic reason. */
  description: string
  /** Whether session details can be read for this row; false for a `diagnostic` entry. */
  enterable: boolean
}

/**
 * One descendant listing entry as a picker row: the child session id (usable
 * with `/sessions` and `--resume`), its activity, mode, and label, or a
 * diagnostic candidate's reason. The live panel enters the same row.
 * @param entry - the listing entry.
 * @returns the row; `enterable` is false exactly for a diagnostic entry.
 */
export function subagentChoice(entry: SubagentDescendantListEntry): SubagentChoice {
  const prefix = indent(entry.depth - 1)
  switch (entry.kind) {
    case 'child': {
      const parts: string[] = [entry.activity, entry.mode]
      // The label took the id's place in the row label, so the description carries it.
      if (entry.label !== undefined) parts.push(entry.id)
      return {
        id: entry.id,
        depth: entry.depth,
        label: `${prefix}${entry.label ?? entry.id}`,
        description: parts.join(' · '),
        enterable: true,
      }
    }
    case 'diagnostic':
      return {
        id: entry.id,
        depth: entry.depth,
        label: `${prefix}${entry.id}`,
        description: entry.reason,
        enterable: false,
      }
    default:
      return assertNever(entry, 'tui subagent list entry')
  }
}

/**
 * Every session-backed subagent below one session in pre-order as picker rows.
 * @param ctx - plugin context carrying the optional subagent runtime.
 * @param sessionId - the root session whose descendants are listed.
 * @param signal - cancels the listing.
 * @returns one choice per descendant in listing order, empty when the session has no subagents.
 * @throws {Error} when no subagent runtime is mounted.
 */
export async function listSubagentChoices(ctx: Context, sessionId: SessionId, signal: AbortSignal): Promise<SubagentChoice[]> {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) throw new Error('subagents are not mounted in this profile')
  return (await subagents.listDescendants(sessionId, signal)).map(subagentChoice)
}

/**
 * The rows shown when the user enters one subagent picker row: the row's own
 * label and description, the session's creation time and workspace, its
 * title, its turn outline, and the files it presented. Turns and presented
 * files each stop at {@link SUBAGENT_DETAIL_LIMIT} entries and fold the rest
 * into one counting row; a fact this profile keeps no projection or header
 * field for is skipped.
 *
 * Reading the session never throws here: a row that is not `enterable`, an
 * absent session query engine, and a failed read each return explanatory
 * rows instead.
 * @param ctx - plugin context carrying the optional session query engine.
 * @param choice - the entered picker row.
 * @param signal - cancels a cold log read.
 * @returns the detail rows; never empty.
 */
export async function subagentDetail(ctx: Context, choice: SubagentChoice, signal: AbortSignal): Promise<string[]> {
  if (!choice.enterable) return [choice.id, `unreadable subagent session: ${choice.description}`]
  const query = ctx.get('sessionQuery')
  if (query === undefined) return [`cannot read ${choice.id}: the session query engine is not mounted in this profile`]
  try {
    using observation = await query.observeSession(choice.id, { signal, projectionMode: 'all' })
    // The row label carries the tree indent; one session's details show no tree.
    const rows = [choice.label.slice(indent(choice.depth - 1).length), choice.description]
    rows.push(`created: ${formatTimestamp(observation.header.createdAt)}`)
    const { cwd } = observation.header
    if (cwd !== undefined) rows.push(`workspace: ${cwd}`)
    const values = observation.projections?.values
    const title = values?.title
    if (title !== undefined && title !== null) rows.push(`title: ${title}`)
    rows.push(...foldDetailRows(values?.turnOutline ?? [], outlineRows, 'turn'))
    rows.push(...foldDetailRows(presentedPaths(observation.events), path => [`presented: ${path}`], 'file'))
    return rows
  } catch (error: unknown) {
    return [`cannot read ${choice.id}: ${describeFailure(error)}`]
  }
}

/** Every presented path in log order, one entry per file of every `deliverables/presented` event. */
function presentedPaths(events: readonly SessionEvent[]): string[] {
  const paths: string[] = []
  for (const event of events) {
    if (event.type !== 'deliverables/presented') continue
    for (const file of event.data.files) paths.push(file.path)
  }
  return paths
}

/** The leading entries rendered in full, then one row counting the entries left out. */
function foldDetailRows<T>(entries: readonly T[], render: (entry: T) => string[], noun: string): string[] {
  const rows = entries.slice(0, SUBAGENT_DETAIL_LIMIT).flatMap(render)
  const hidden = Math.max(0, entries.length - SUBAGENT_DETAIL_LIMIT)
  if (hidden > 0) rows.push(`… ${String(hidden)} more ${noun}${hidden === 1 ? '' : 's'}`)
  return rows
}

/** One outline entry: the numbered prompt, then the indented response once the turn ended with text. */
function outlineRows(entry: TurnOutlineEntry): string[] {
  const rows = [`${String(entry.turn)}. ${entry.prompt === '' ? '(no prompt)' : entry.prompt}`]
  if (entry.response !== '') rows.push(`${indent(1)}→ ${entry.response}`)
  return rows
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
  return outline.flatMap(outlineRows)
}

/** One `/changes` picker row: a file one turn changed, addressed as the Host serves its comparison. */
export interface ChangeChoice {
  /** The file's index in the turn's summary; the picker row value. */
  index: number
  /** The `workspace/changes` event sequence the summary is served for. */
  seq: number
  /** Row label: the file's display path. */
  label: string
  /** Row description: the line counts, or why the file has none. */
  description: string
}

/** The changed files of one turn as picker rows under the turn's totals. */
export interface TurnChanges {
  /** Heading: the turn, its changed-file total, and its line totals. */
  heading: string
  /** One row per listed file in display order; fewer than the total once the recorder's cap cut the list. */
  choices: ChangeChoice[]
}

/** The workspace-changes service, or a printable error naming its absence. */
function requireWorkspaceChanges(ctx: Context): WorkspaceChanges {
  const changes = ctx.get('workspaceChanges')
  if (changes === undefined) throw new Error('workspace changes are not recorded in this profile')
  return changes
}

/** `N file` or `N files`. */
function fileCount(total: number): string {
  return `${String(total)} file${total === 1 ? '' : 's'}`
}

/**
 * The files one turn changed, as `/changes` picker rows: the latest
 * `workspace/changes` announcement of `turn`, or of the newest announced turn
 * when `turn` is undefined, resolved through the Host's summary.
 * @param ctx - plugin context carrying the optional workspace-changes service and session query engine.
 * @param sessionId - the session whose log is read.
 * @param turn - the turn to list, or undefined for the latest announced one.
 * @param signal - cancels a cold log read.
 * @returns the rows under the turn's totals, or undefined when no such turn was announced.
 * @throws {Error} when either service is not mounted, or when the Host no longer holds the announced summary.
 */
export async function listTurnChanges(
  ctx: Context,
  sessionId: SessionId,
  turn: number | undefined,
  signal: AbortSignal,
): Promise<TurnChanges | undefined> {
  const changes = requireWorkspaceChanges(ctx)
  const query = ctx.get('sessionQuery')
  if (query === undefined) throw new Error('the session query engine is not mounted in this profile')
  using observation = await query.observeSession(sessionId, { signal, projectionMode: 'none' })
  let announced: { seq: number; turn: number } | undefined
  // The latest announcement of a turn replaces its earlier ones, so the last
  // matching event is the one whose summary the Host still serves.
  for (const event of observation.events) {
    if (event.type !== 'workspace/changes') continue
    if (turn !== undefined && event.data.turn !== turn) continue
    announced = { seq: event.seq, turn: event.data.turn }
  }
  if (announced === undefined) return undefined
  const summary = changes.summary(sessionId, announced.seq)
  if (summary === undefined) throw new Error(`the changed files of turn ${String(announced.turn)} are no longer held by this host`)
  const listed = summary.files.length === summary.total ? '' : ` (${String(summary.files.length)} listed)`
  return {
    heading: `turn ${String(summary.turn)} · ${fileCount(summary.total)}${listed} · +${String(summary.added)} −${String(summary.deleted)}`,
    choices: summary.files.map((file, index) => ({
      index,
      seq: announced.seq,
      label: file.display,
      description: file.binary === true ? 'binary' : file.oversized === true ? 'oversized' : `+${String(file.added)} −${String(file.deleted)}`,
    })),
  }
}

/**
 * The one-row notice a `workspace/changes` event prints once its summary is read.
 * @param summary - the announced turn's summary.
 * @returns the turn's file and line totals, naming `/changes` for the files.
 */
export function changesNotice(summary: WorkspaceChangesSummary): string {
  return `turn ${String(summary.turn)} changed ${fileCount(summary.total)} (+${String(summary.added)} −${String(summary.deleted)}) · /changes`
}

/**
 * The comparison one `/changes` row opens: the file's turn-start and turn-end
 * contents as unified hunks in the tool cards' diff row form, `@@` headers
 * between them and `…` where hunks are apart.
 * @param ctx - plugin context carrying the optional workspace-changes service.
 * @param sessionId - the session the summary belongs to.
 * @param choice - the entered picker row.
 * @param signal - cancels the snapshot reads.
 * @returns the rows; explanatory rows when no lines can be shown.
 * @throws {Error} when the service is not mounted or a snapshot read fails.
 */
export async function changeDiffRows(ctx: Context, sessionId: SessionId, choice: ChangeChoice, signal: AbortSignal): Promise<string[]> {
  const diff = await requireWorkspaceChanges(ctx).diff(sessionId, choice.seq, choice.index, signal)
  if (diff === undefined) return [`${choice.label}: the comparison is no longer held by this host`]
  switch (diff.kind) {
    case 'binary':
      return [`${diff.display}: binary content, no line comparison`]
    case 'oversized':
      return [`${diff.display}: larger than the comparison limit, no line comparison`]
    case 'text': {
      const rows: string[] = []
      if (!diff.before) rows.push('new file')
      if (!diff.after) rows.push('deleted')
      if (diff.coarse) rows.push('comparison timed out: every line is shown as replaced')
      if (diff.hunks.length === 0) rows.push('no line changes')
      diff.hunks.forEach((hunk, index) => {
        if (index > 0) rows.push('  …')
        rows.push(`@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`)
        // Each hunk line keeps its `+`, `-`, or space; the card form puts one
        // space after it.
        for (const line of hunk.lines) rows.push(`${line.slice(0, 1)} ${line.slice(1)}`)
      })
      return rows
    }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return assertNever(diff, 'tui workspace file diff')
  }
}

/** The plugin manager, or a printable error naming its absence. */
function requirePluginManager(ctx: Context): PluginManager {
  const manager = ctx.get('pluginManager')
  if (manager === undefined) throw new Error('plugin management is not mounted in this profile')
  return manager
}

/**
 * One row per bundle the profile can manage: name, version, enablement, how
 * the profile holds it, whether it can be removed, and its management error.
 * @param ctx - plugin context carrying the optional plugin manager.
 * @returns the rows in the manager's order.
 * @throws {Error} when no plugin manager is mounted.
 */
export async function listBundles(ctx: Context): Promise<string[]> {
  return (await requirePluginManager(ctx).listBundles()).map(bundleRow)
}

/** One bundle's facts, two spaces apart. */
function bundleRow(bundle: BundleInfo): string {
  const held = bundle.installed ? 'installed' : bundle.optional ? 'optional' : 'shipped'
  const facts = [bundle.name, bundle.version ?? '-', bundle.enabled ? 'enabled' : 'disabled', held]
  if (bundle.removable) facts.push('removable')
  if (bundle.readOnlyReason !== undefined) facts.push(`read-only (${bundle.readOnlyReason})`)
  if (bundle.error !== undefined) facts.push(`error ${bundle.error.code}`)
  return facts.join('  ')
}

/**
 * Switch one plugin entry or one bundle on or off in the profile's persistent
 * composition. A target naming a plugin entry id changes that entry;
 * otherwise it names a bundle.
 * @param ctx - plugin context carrying the optional plugin manager.
 * @param target - a plugin entry id or a bundle name.
 * @param enabled - the wanted state.
 * @returns a confirmation row: the persisted change and how it applied.
 * @throws {Error} when no plugin manager is mounted, when `target` names neither, or when the change failed.
 */
export async function setPluginEnabled(ctx: Context, target: string, enabled: boolean): Promise<string> {
  const manager = requirePluginManager(ctx)
  const plugin = (await manager.listPlugins()).find(candidate => candidate.entryId === target)
  if (plugin !== undefined) return reportChange(await manager.setPluginEnabled(plugin.entryId, enabled))
  const bundle = (await manager.listBundles()).find(candidate => candidate.name === target)
  if (bundle !== undefined) return reportChange(await manager.setBundleEnabled(bundle.name, enabled))
  throw new Error(`"${target}" is neither a plugin entry nor a bundle of this profile`)
}

/**
 * Install one bundle into the profile and enable it.
 * @param ctx - plugin context carrying the optional plugin manager.
 * @param spec - what pnpm should add: a registry name, a path, a git address, or a tarball.
 * @returns a confirmation row: the installation and how it applied.
 * @throws {Error} when no plugin manager is mounted or the installation failed.
 */
export async function installBundle(ctx: Context, spec: string): Promise<string> {
  return reportChange(await requirePluginManager(ctx).installBundle(spec))
}

/**
 * Remove one installed bundle from the profile.
 * @param ctx - plugin context carrying the optional plugin manager.
 * @param name - the bundle's package name.
 * @returns a confirmation row: the removal and how it applied.
 * @throws {Error} when no plugin manager is mounted or the removal failed.
 */
export async function removeBundle(ctx: Context, name: string): Promise<string> {
  return reportChange(await requirePluginManager(ctx).removeBundle(name))
}

/** One row over a change result; a failed change is thrown so the surface prints the row as an error. */
function reportChange(result: ChangeResult): string {
  const facts = [`${result.stage} ${result.target}: ${result.changed ? result.application : `unchanged, ${result.application}`}`]
  if (result.bundle !== undefined && result.bundle !== result.target) facts.push(`bundle ${result.bundle}`)
  if (result.error !== undefined) {
    facts.push(result.error.diagnostic === undefined ? result.error.code : `${result.error.code}: ${result.error.diagnostic}`)
  }
  if (result.pendingBuilds !== undefined && result.pendingBuilds.length > 0) {
    facts.push(`scripts awaiting approval: ${result.pendingBuilds.join(', ')}`)
  }
  if (result.warnings !== undefined) facts.push(...result.warnings)
  const text = facts.join(' · ')
  if (result.application === 'failed') throw new Error(text)
  return text
}
