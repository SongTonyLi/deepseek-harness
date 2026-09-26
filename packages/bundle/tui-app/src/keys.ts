/**
 * The key model: which action one press names in the region that holds the
 * keyboard, what one press types, how long a focus handoff silences the
 * editor's `Escape`, and the words every surface uses to name a key - the
 * legend each region degrades through, the entry keys the status bar
 * reserves, and the lines `/help` lists per region.
 *
 * Pure. It reads key bytes and returns actions, so the application owns every
 * effect and the whole map is decided without a terminal, a palette, or a
 * clock.
 * @module @deepseek-ai/dsh-tui-app/keys
 */

import { decodeKittyPrintable, matchesKey, type KeyId } from '@earendil-works/pi-tui'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { MoveTarget, TranscriptAxis } from './navigation.ts'

/**
 * Which region owns the keyboard. They stack in the order the screen draws
 * them - the transcript blocks, the queued-prompt panel while it is drawn,
 * the editor, the subagent panel's rows while it is drawn, and the status
 * bar's segments.
 */
export type FocusRegion = 'editor' | 'transcript' | 'queue' | 'panel' | 'bar'

/**
 * How long an `Escape` that only handed the keyboard back silences the
 * editor's own `Escape`. A habitual second press lands inside this window and
 * does nothing at all, so leaving a region, a page, or a picker can never stop
 * a running turn. A debounce of one human double press, not a deployment
 * setting.
 */
export const ESCAPE_HANDOFF_MS = 750

/**
 * What one movement key steps along: the four axes of the transcript, plus
 * the one axis each region under the editor has.
 */
export type MoveAxis =
  | TranscriptAxis
  /** A pending prompt. */
  | 'prompt'
  /** A drawn subagent panel row. */
  | 'row'
  /** A status bar segment. */
  | 'segment'

/** What one key press means in the region that holds the keyboard. */
export type KeyAction =
  /**
   * Give the keyboard to the named region. Only the two regions a key names
   * directly appear here; `Up` and `Down` name a direction instead, because
   * what they reach depends on what is drawn.
   */
  | { kind: 'focus'; region: 'transcript' | 'bar' }
  /**
   * Leave this region along the stack: the editor in either direction, the
   * status bar upwards.
   */
  | { kind: 'leave'; direction: 'up' | 'down' }
  /** Give the keyboard to the next region drawn around the editor, or the previous one. */
  | { kind: 'cycle'; step: 1 | -1 }
  /** Step the region's own selection. */
  | { kind: 'move'; axis: MoveAxis; to: MoveTarget }
  /** Open what this region's `Enter` leads to. */
  | { kind: 'open' }
  /** Fold or unfold the block the transcript focus holds. */
  | { kind: 'fold' }
  /** Fold or unfold every tool card and context block at once. */
  | { kind: 'fold-all' }
  /** Read the transcript full screen. */
  | { kind: 'reader' }
  /** Leave this region, or arm and then stop the running turn from the editor. */
  | { kind: 'escape' }
  /** Steer the running turn with the editor's text. */
  | { kind: 'steer' }
  /** Act on the pending prompt held by the queue panel. */
  | { kind: 'queue'; action: 'steer' | 'inject' | 'edit' }
  /**
   * Revise the newest pending prompt in the editor; answered only on an empty
   * input while a prompt waits, and otherwise left to the editor's history.
   */
  | { kind: 'edit-latest' }
  /** Open the current model's reasoning-effort picker. */
  | { kind: 'effort' }
  /** Browse the agent's todo list, as `/todos` does. */
  | { kind: 'todos' }
  /** Return from a subagent view to the session it was opened from, as `/parent` does. */
  | { kind: 'parent' }
  /** List the commands and keys, as `/help` does; typed as `?` while the input holds text. */
  | { kind: 'help' }
  /** Draw the whole screen again from scratch. */
  | { kind: 'redraw' }
  /** Type these characters at the editor's caret, wherever the keyboard was. */
  | { kind: 'type'; text: string }

/** Characters a typed key never carries: C0 controls, DEL, and C1 controls. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

/**
 * The text one key press types.
 * @param data - the bytes the terminal sent.
 * @returns the characters to type, or undefined for control keys and escape sequences.
 */
export function typedText(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data)
  if (kitty !== undefined) return kitty
  return CONTROL_CHARACTERS.test(data) ? undefined : data
}

/**
 * The legend of each region, in declared degradation steps: the widest first,
 * every next one narrower, the last the shortest form that still names the way
 * back to the input. One grammar throughout - the keys the region answers,
 * then where `Esc` goes - so a legend is read the same way on every surface.
 * The editor draws no legend of its own: the unfocused status bar names the
 * keys that leave it.
 */
export const HINTS: Record<FocusRegion, readonly string[]> = {
  editor: [],
  transcript: [
    '↑↓ sections · ←→ parts · Space folds · Ctrl+G reader · Esc input',
    '↑↓ ←→ · Space folds · Esc input',
    'Esc input',
  ],
  queue: [
    '↑↓ select · Enter steer · E edit · I inject · Esc input',
    '↑↓ · Enter steer · E edit · Esc input',
    'Esc input',
  ],
  panel: ['↑↓ children · Enter opens · Tab regions · Esc input', '↑↓ children · Esc input', 'Esc input'],
  bar: ['←→ segments · Enter details · Tab regions · Esc input', '←→ segments · Esc input', 'Esc input'],
}

/**
 * The regions in the order `/help` lists them: the input first, because it is
 * where every other region is reached from and returned to. The screen stacks
 * them in another order, which {@link FocusRegion} states and the `Tab` walk
 * follows over the regions drawn right now.
 */
export const FOCUS_REGIONS: readonly FocusRegion[] = ['editor', 'transcript', 'queue', 'panel', 'bar']

/** What each region is called where it is named rather than drawn. */
export const REGION_LABELS: Record<FocusRegion, string> = {
  editor: 'input',
  transcript: 'conversation',
  queue: 'follow-ups',
  panel: 'subagent panel',
  bar: 'status bar',
}

/** The two keys that leave the input when no follow-up waits. */
const ENTRY_KEYS = 'Shift+↑ read · Shift+↓ status'

/** The same pair while follow-ups wait: Shift+↑ selects one instead of reading. */
const QUEUE_ENTRY_KEYS = 'Shift+↑ select · Shift+↓ status'

/**
 * The keys the unfocused follow-ups list names: ↑ on an empty input revises
 * the newest follow-up, and Shift+↑ is the direction out of the input toward
 * whatever sits above it.
 */
export const QUEUE_ENTRY_HINT = '↑ edit · Shift+↑ select'

/** Whether the follow-ups list is drawn above the editor right now. */
export interface EntryDrawn {
  /** True while a prompt waits in the boxed list above the input. */
  readonly queue?: boolean
}

/**
 * The entry keys the unfocused status bar reserves before any fact is placed,
 * in declared degradation steps. Both directions are named: reaching the
 * conversation or a waiting follow-up, and reaching the bar, are the two
 * ways out of the input, and a key nobody can see is a key nobody presses.
 * @param drawn - whether follow-ups sit above the editor, which Shift+↑ enters.
 * @returns the widest pair first, then the compact form.
 */
export function entryHints(drawn: EntryDrawn = {}): readonly string[] {
  return [drawn.queue === true ? QUEUE_ENTRY_KEYS : ENTRY_KEYS, 'Shift+↑↓ nav']
}

/**
 * The entry keys with no follow-up waiting, the pair `/help` lists and the
 * unfocused bar draws by default.
 */
export const ENTRY_HINTS: readonly string[] = entryHints()

/**
 * The widest legend step of one region.
 * @param region - the region holding the keyboard.
 * @returns the step a surface draws when the width holds it, and the empty
 * string for the editor, which draws no legend.
 */
export function widestHint(region: FocusRegion): string {
  return HINTS[region][0] ?? ''
}

/**
 * What `/help` lists per region: the legend the region draws, then the coarse
 * keys no legend has room for. The legends are read from {@link HINTS} rather
 * than written again, so a surface and `/help` can never name a key
 * differently. The editor draws no legend, so its own keys are listed here and
 * nowhere else. This is the screen's summary, not the complete map; the
 * package README carries every binding.
 */
export const KEY_LINES: Record<FocusRegion, readonly string[]> = {
  editor: [
    'Enter sends · Shift+Enter newline · ↑↓ history · Ctrl+S steers',
    'Shift+Tab effort list · Shift+←→ words',
    '@ completes paths and sessions · / completes commands · Tab takes one',
    '!cmd runs here · the next prompt can read it · !!cmd stays local',
    `${ENTRY_KEYS} · Ctrl+G reader`,
    'While follow-ups wait: ↑ on an empty input edits the newest · Shift+↑ selects one',
    'Ctrl+O folds every tool card and context row',
    'Ctrl+T todos · Ctrl+P parent session · Ctrl+L redraw · ? keys',
    'Esc arms the stop · Esc again stops the turn',
    'Ctrl+C clears the input, twice quits · Ctrl+D quits an empty input',
  ],
  transcript: [
    widestHint('transcript'),
    'Shift+↑↓ blocks · PgUp PgDn turns · Home End ends · Tab regions · Enter reads',
  ],
  queue: [widestHint('queue')],
  panel: [widestHint('panel')],
  bar: [widestHint('bar')],
}

/** `Escape`, which every region answers. */
const ESCAPE: KeyAction = { kind: 'escape' }

/** `Ctrl+O`, which every region answers. */
const FOLD_ALL: KeyAction = { kind: 'fold-all' }

/** `Ctrl+G`, which every region answers. */
const READER: KeyAction = { kind: 'reader' }

/** `Enter` on the held section, row, or segment. */
const OPEN: KeyAction = { kind: 'open' }

/**
 * What one key press means where the keyboard is.
 *
 * `Escape`, `Ctrl+O`, `Ctrl+G`, `Ctrl+T`, `Ctrl+P`, and `Ctrl+L` mean the
 * same thing everywhere and are answered first. Everything else is the region's own.
 * @param region - the region holding the keyboard.
 * @param data - the raw key bytes.
 * @returns the action to apply, or undefined when this region claims nothing
 * for the key: the editor lets pi-tui's own editor have it, and a docked
 * region consumes it without effect.
 */
export function resolveKey(region: FocusRegion, data: string): KeyAction | undefined {
  if (matchesKey(data, 'escape')) return ESCAPE
  if (matchesKey(data, 'ctrl+o')) return FOLD_ALL
  if (matchesKey(data, 'ctrl+g')) return READER
  if (matchesKey(data, 'ctrl+t')) return { kind: 'todos' }
  if (matchesKey(data, 'ctrl+p')) return { kind: 'parent' }
  if (matchesKey(data, 'ctrl+l')) return { kind: 'redraw' }
  switch (region) {
    case 'editor':
      return editorKey(data)
    case 'transcript':
      return transcriptKey(data)
    case 'queue':
      return queueKey(data)
    case 'panel':
      return panelKey(data)
    case 'bar':
      return barKey(data)
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(region, 'tui focus region')
  }
}

/**
 * What one key means while the editor holds the keyboard. Shift+Up and
 * Shift+Down leave along the stack: the application lands on the first
 * drawn region in that direction — follow-ups or the conversation above,
 * the subagent panel or the status bar below. `Up` is offered to the newest
 * follow-up first, and reaches the editor's history when none is taken.
 * @param data - the raw key bytes.
 * @returns the action, or undefined for every key pi-tui's editor owns.
 */
function editorKey(data: string): KeyAction | undefined {
  if (matchesKey(data, 'up')) return { kind: 'edit-latest' }
  if (matchesKey(data, 'shift+up')) return { kind: 'leave', direction: 'up' }
  if (matchesKey(data, 'shift+down')) return { kind: 'leave', direction: 'down' }
  if (matchesKey(data, 'ctrl+s')) return { kind: 'steer' }
  if (matchesKey(data, 'shift+tab')) return { kind: 'effort' }
  if (data === '?') return { kind: 'help' }
  return undefined
}

/** One key and what it steps, in the region whose table carries it. */
interface MoveBinding {
  /** The key identifier pi-tui matches the press against. */
  readonly key: KeyId
  /** What the press steps along. */
  readonly axis: MoveAxis
  /** Which way along it. */
  readonly to: MoveTarget
}

/**
 * The transcript's movement keys: the arrows step one section and one part,
 * the shift arrows a whole block and the ends of the held block, `PageUp` and
 * `PageDown` a turn, and `Home` and `End` the ends of the transcript.
 */
const TRANSCRIPT_MOVES: readonly MoveBinding[] = [
  { key: 'up', axis: 'section', to: 'previous' },
  { key: 'down', axis: 'section', to: 'next' },
  { key: 'shift+up', axis: 'block', to: 'previous' },
  { key: 'shift+down', axis: 'block', to: 'next' },
  { key: 'pageUp', axis: 'turn', to: 'previous' },
  { key: 'pageDown', axis: 'turn', to: 'next' },
  { key: 'home', axis: 'section', to: 'first' },
  { key: 'end', axis: 'section', to: 'last' },
  { key: 'left', axis: 'part', to: 'previous' },
  { key: 'right', axis: 'part', to: 'next' },
  { key: 'shift+left', axis: 'part', to: 'first' },
  { key: 'shift+right', axis: 'part', to: 'last' },
]

/** The pending-prompt panel's movement keys. */
const QUEUE_MOVES: readonly MoveBinding[] = [
  { key: 'up', axis: 'prompt', to: 'previous' },
  { key: 'down', axis: 'prompt', to: 'next' },
  { key: 'home', axis: 'prompt', to: 'first' },
  { key: 'end', axis: 'prompt', to: 'last' },
]

/**
 * The subagent panel's movement keys. The panel lists at most six rows, so
 * every coarse key means the same thing there: its first row or its last.
 */
const PANEL_MOVES: readonly MoveBinding[] = [
  { key: 'up', axis: 'row', to: 'previous' },
  { key: 'down', axis: 'row', to: 'next' },
  { key: 'shift+up', axis: 'row', to: 'first' },
  { key: 'home', axis: 'row', to: 'first' },
  { key: 'pageUp', axis: 'row', to: 'first' },
  { key: 'shift+down', axis: 'row', to: 'last' },
  { key: 'end', axis: 'row', to: 'last' },
  { key: 'pageDown', axis: 'row', to: 'last' },
]

/** The status bar's movement keys, along its one axis of segments. */
const BAR_MOVES: readonly MoveBinding[] = [
  { key: 'left', axis: 'segment', to: 'previous' },
  { key: 'right', axis: 'segment', to: 'next' },
  { key: 'shift+left', axis: 'segment', to: 'first' },
  { key: 'home', axis: 'segment', to: 'first' },
  { key: 'pageUp', axis: 'segment', to: 'first' },
  { key: 'shift+right', axis: 'segment', to: 'last' },
  { key: 'end', axis: 'segment', to: 'last' },
  { key: 'pageDown', axis: 'segment', to: 'last' },
]

/**
 * What one press moves, in one region's table.
 * @param data - the raw key bytes.
 * @param bindings - the region's movement keys.
 * @returns the movement action, or undefined when the table has no binding for the key.
 */
function moveKey(data: string, bindings: readonly MoveBinding[]): KeyAction | undefined {
  const binding = bindings.find(candidate => matchesKey(data, candidate.key))
  return binding === undefined ? undefined : { kind: 'move', axis: binding.axis, to: binding.to }
}

/**
 * `Tab` and `Shift+Tab`, which every region under the editor reads as the
 * walk between the regions that are drawn.
 * @param data - the raw key bytes.
 * @returns the cycling action, or undefined for any other key.
 */
function cycleKey(data: string): KeyAction | undefined {
  if (matchesKey(data, 'tab')) return { kind: 'cycle', step: 1 }
  if (matchesKey(data, 'shift+tab')) return { kind: 'cycle', step: -1 }
  return undefined
}

/**
 * What one key means while the transcript holds the keyboard. `Space` is the
 * one printable key the transcript keeps for itself: folding the held block is
 * its primary verb, and a leading space would be trimmed off a prompt anyway.
 * @param data - the raw key bytes.
 * @returns the action, or undefined for a key the transcript consumes without effect.
 */
function transcriptKey(data: string): KeyAction | undefined {
  const move = moveKey(data, TRANSCRIPT_MOVES)
  if (move !== undefined) return move
  if (matchesKey(data, 'enter')) return OPEN
  if (matchesKey(data, 'space')) return { kind: 'fold' }
  return cycleKey(data) ?? typeKey(data)
}

/**
 * What one key means while the follow-ups panel holds the keyboard.
 * @param data - the raw key bytes.
 * @returns the action, or undefined for a key the panel consumes without effect.
 */
function queueKey(data: string): KeyAction | undefined {
  const move = moveKey(data, QUEUE_MOVES)
  if (move !== undefined) return move
  if (matchesKey(data, 'enter')) return { kind: 'queue', action: 'steer' }
  if (data === 's' || data === 'S') return { kind: 'queue', action: 'steer' }
  if (data === 'i' || data === 'I') return { kind: 'queue', action: 'inject' }
  if (data === 'e' || data === 'E') return { kind: 'queue', action: 'edit' }
  return cycleKey(data) ?? typeKey(data)
}

/**
 * What one key means while the subagent panel holds the keyboard.
 * @param data - the raw key bytes.
 * @returns the action, or undefined for a key the panel consumes without effect.
 */
function panelKey(data: string): KeyAction | undefined {
  const move = moveKey(data, PANEL_MOVES)
  if (move !== undefined) return move
  if (matchesKey(data, 'enter') || matchesKey(data, 'right')) return OPEN
  return cycleKey(data) ?? typeKey(data)
}

/**
 * What one key means while the status bar holds the keyboard. The bar is the
 * bottom of the stack, so `Up` leaves it and `Down` does nothing.
 * @param data - the raw key bytes.
 * @returns the action, or undefined for a key the bar consumes without effect.
 */
function barKey(data: string): KeyAction | undefined {
  const move = moveKey(data, BAR_MOVES)
  if (move !== undefined) return move
  if (matchesKey(data, 'up')) return { kind: 'leave', direction: 'up' }
  // The bar sits below every other region, so the shift up and down arrows
  // name one instead of walking its segments, which `Left` and `Right` do
  // and which the shift left and right arrows take to their ends.
  if (matchesKey(data, 'shift+up')) return { kind: 'focus', region: 'transcript' }
  if (matchesKey(data, 'shift+down')) return { kind: 'focus', region: 'bar' }
  if (matchesKey(data, 'enter')) return OPEN
  return cycleKey(data) ?? typeKey(data)
}

/**
 * The printable law: a key that types something hands the keyboard back to
 * the editor and lands at its caret.
 * @param data - the raw key bytes.
 * @returns the typing action, or undefined for a key that types nothing.
 */
function typeKey(data: string): KeyAction | undefined {
  const text = typedText(data)
  return text === undefined ? undefined : { kind: 'type', text }
}
