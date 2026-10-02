/**
 * Working indicators: a braille status glyph and a shimmer on the activity
 * line above the prompt, and tool-family glyphs on running cards and on the
 * activity board's in-progress todo rows.
 *
 * Pure. Every animation has {@link SPINNER_CYCLE} frames, and a frame lookup
 * reads a wall-clock instant and a frame period the caller passes in, so
 * every surface drawn at the same moment steps at the same instant and the
 * application owns the one tick that redraws them. Only the activity line
 * draws braille, so its glyph never repeats a card's; indicators of one card
 * family spin at different phases ({@link staggerPhase}).
 * @module @deepseek-ai/dsh-tui-app/spinner
 */

import { isSubagentTool } from './transcript.ts'
import type { Palette } from './style.ts'

/**
 * One working animation: eight frames, each one column wide like the glyph
 * it replaces, and every two adjacent frames, the last and the first
 * included, different.
 */
export type SpinnerFrames = readonly [string, string, string, string, string, string, string, string]

/** Frames in every working animation; one cycle lasts this many frame periods. */
export const SPINNER_CYCLE: SpinnerFrames['length'] = 8

/**
 * The activity line's animation for each working status. Every glyph is
 * braille and no card or todo row draws braille. A presentation choice of
 * this terminal surface, not a deployment setting.
 */
export const ACTIVITY_SPINNERS = {
  /** Model reasoning, and any label with no status of its own: three dots circling the cell. */
  thinking: ['⠙', '⠸', '⢰', '⣠', '⣄', '⡆', '⠇', '⠋'],
  /** Visible reply text streaming in: lines filling the cell, then streaming up out of it. */
  writing: ['⠉', '⠛', '⠿', '⣿', '⣶', '⣤', '⣀', '⣉'],
  /** A tool call streamed or running, whichever tool it names: one dot orbiting the cell. */
  calling: ['⠁', '⠈', '⠐', '⠠', '⢀', '⡀', '⠄', '⠂'],
  /** A scheduled model-request retry: a bar sliding down the cell and back. */
  retrying: ['⠉', '⠛', '⠶', '⣤', '⣀', '⣤', '⠶', '⠛'],
  /** Condensing older history into a summary: a full cell settling and refilling. */
  compacting: ['⣿', '⣷', '⣶', '⣦', '⣤', '⣦', '⣶', '⣷'],
} as const satisfies Record<string, SpinnerFrames>

/** One status of the activity line, named by what the agent is doing. */
export type ActivityStatus = keyof typeof ACTIVITY_SPINNERS

/**
 * The animation a running tool card's glyph cycles through, by tool family;
 * the activity board's in-progress todo rows draw the `todo` family. No two
 * families share a glyph. A presentation choice of this terminal surface,
 * not a deployment setting.
 */
export const TOOL_SPINNERS = {
  /** Command execution: a block turning around the cell. */
  shell: ['▖', '▌', '▘', '▀', '▝', '▐', '▗', '▄'],
  /** File mutation: a diamond setting solid. */
  edit: ['⋄', '◇', '◈', '◆', '❖', '◆', '◈', '◇'],
  /** Reading and searching: a lens focusing. */
  search: ['·', '∘', '◌', '○', '◍', '◎', '◉', '●'],
  /** Delegation to a child agent, a folded subagent row included: a pointer turning. */
  subagent: ['▲', '◥', '►', '◢', '▼', '◣', '◄', '◤'],
  /** Planning and scheduling, and an in-progress todo row: a bar rising and falling. */
  todo: ['▁', '▂', '▃', '▅', '▇', '▅', '▃', '▂'],
  /** Waiting on a human answer: a shade breathing in and out. */
  waiting: [' ', '░', '▒', '▓', '█', '▓', '▒', '░'],
  /** A tool with no family of its own: a star blooming. */
  other: ['✧', '✦', '✶', '✷', '✸', '✹', '✺', '✻'],
} as const satisfies Record<string, SpinnerFrames>

/** One tool family of {@link TOOL_SPINNERS}. */
export type ToolFamily = keyof typeof TOOL_SPINNERS

/** Blank steps between two shimmer passes, so the sweep pauses past the word's end. */
const SHIMMER_GAP = 6

/** Tool names that execute commands. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh', 'run_code'])

/** Tool names that mutate files. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['edit', 'write', 'str_replace_editor'])

/** Tool names that read or search, beyond the `TOOL_PREFIXES` below. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'lsp',
  'skill',
  'web_fetch',
  'web_search',
  'load_workspace_dependencies',
  'list_subagent_models',
])

/** Tool names that delegate or steer a child agent, beyond `subagent` itself. */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  'send_message',
  'interrupt_agent',
  'list_agents',
  'ralph',
  'workflow',
  'spawn_teammate',
  'wait_agent',
])

/** Tool names that plan or schedule work. */
const TODO_TOOLS: ReadonlySet<string> = new Set(['todo_write', 'create_goal', 'get_goal', 'update_goal'])

/** Tool names that wait on a human answer. */
const WAITING_TOOLS: ReadonlySet<string> = new Set(['ask_user_question', 'exit_plan_mode'])

/**
 * Tool-name prefixes per family, checked after the exact sets above. An MCP
 * or custom tool that keeps its family's prefix inherits the animation.
 */
const TOOL_PREFIXES: ReadonlyArray<readonly [string, ToolFamily]> = [
  ['terminal_', 'shell'],
  ['session_', 'search'],
  ['cordis_inspect_', 'search'],
  ['list_mcp_', 'search'],
  ['read_mcp_', 'search'],
  ['team_task_', 'subagent'],
  ['schedule_', 'todo'],
]

/** The activity line's label while a compaction condenses history. */
export const COMPACTING_ACTIVITY = 'compacting'

/**
 * The activity line's label for a streamed or executing tool call.
 * @param name - the tool name when one is known.
 * @returns `calling <name>`, or `calling` when the name has not arrived.
 */
export function callingActivity(name: string | undefined): string {
  return name ? `calling ${name}` : 'calling'
}

/**
 * Whether the activity line already names a tool call.
 * @param activity - the activity line's current label.
 * @returns true for `calling` and `calling <name>`.
 */
export function isCallingActivity(activity: string): boolean {
  return activity === 'calling' || activity.startsWith('calling ')
}

/**
 * The status the activity line animates for its label.
 * @param activity - the label: `thinking`, `writing`, `calling` or
 * `calling <name>`, a scheduled retry starting with `retrying`, or
 * {@link COMPACTING_ACTIVITY}.
 * @returns the label's status; `calling` whichever tool the label names, and
 * `thinking` for any other label.
 */
export function activityStatus(activity: string): ActivityStatus {
  if (activity === 'writing') return 'writing'
  if (isCallingActivity(activity)) return 'calling'
  if (activity.startsWith('retrying')) return 'retrying'
  if (activity === COMPACTING_ACTIVITY) return 'compacting'
  return 'thinking'
}

/**
 * The family whose animation a running tool card draws for `name`.
 * @param name - the tool the model called.
 * @returns the tool's family, or `other` for a tool with no family.
 */
export function toolFamily(name: string): ToolFamily {
  if (SHELL_TOOLS.has(name)) return 'shell'
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (isSubagentTool(name) || SUBAGENT_TOOLS.has(name)) return 'subagent'
  if (TODO_TOOLS.has(name)) return 'todo'
  if (WAITING_TOOLS.has(name)) return 'waiting'
  for (const [prefix, family] of TOOL_PREFIXES) {
    if (name.startsWith(prefix)) return family
  }
  return 'other'
}

/**
 * The frame an indicator draws at one instant. The frame index advances
 * once per `periodMs` of wall clock, so indicators drawn at the same instant
 * step together, and a change of animation keeps the beat.
 * @param frames - the animation drawn.
 * @param now - the current time in milliseconds.
 * @param periodMs - how long each frame lasts, in milliseconds; positive.
 * @param phase - how many frames the indicator runs ahead of the clock, from 0 to {@link SPINNER_CYCLE} - 1.
 * @returns the frame at that instant.
 */
export function spinnerFrame(frames: SpinnerFrames, now: number, periodMs: number, phase = 0): string {
  const index = (Math.floor(now / periodMs) + phase) % SPINNER_CYCLE
  /* v8 ignore next -- the modulo keeps the index inside the frame list */
  return frames[index] ?? frames[0]
}

/**
 * At how many of a cycle's instants two indicators of `frames`, `shift`
 * frames apart, draw the same glyph.
 * @param frames - the animation both indicators draw.
 * @param shift - the first indicator's phase minus the second's.
 * @returns a count from 0 to {@link SPINNER_CYCLE}.
 */
function coincidences(frames: SpinnerFrames, shift: number): number {
  let count = 0
  for (const [index, frame] of frames.entries()) {
    if (frame === frames[(((index + shift) % SPINNER_CYCLE) + SPINNER_CYCLE) % SPINNER_CYCLE]) count += 1
  }
  return count
}

/**
 * The phase a new indicator of `frames` spins at beside the indicators of
 * the same animation already spinning: a phase whose glyph differs from each
 * of theirs at every instant while one is left, otherwise the phase whose
 * glyph coincides with theirs at the fewest instants of a cycle. Ties go to
 * the phase farthest from its nearest neighbour, then to the lowest. An
 * animation whose frames are all distinct leaves every phase no indicator
 * holds; a palindromic one leaves only the phases an odd number of frames
 * away from each.
 * @param frames - the animation the new indicator draws.
 * @param taken - the phases of the indicators of `frames` spinning now, one per indicator.
 * @returns a phase from 0 to {@link SPINNER_CYCLE} - 1.
 */
export function staggerPhase(frames: SpinnerFrames, taken: readonly number[]): number {
  let best = 0
  let fewest = Number.POSITIVE_INFINITY
  let widest = -1
  for (let phase = 0; phase < SPINNER_CYCLE; phase += 1) {
    let matches = 0
    let gap: number = SPINNER_CYCLE
    for (const other of taken) {
      matches += coincidences(frames, phase - other)
      const distance = Math.abs(phase - other)
      gap = Math.min(gap, distance, SPINNER_CYCLE - distance)
    }
    if (matches < fewest || (matches === fewest && gap > widest)) {
      best = phase
      fewest = matches
      widest = gap
    }
  }
  return best
}

/**
 * Draw `text` dim with a bright highlight sweeping across it, one character
 * per `periodMs`: the character under the sweep is bold, its neighbours are
 * drawn at the plain foreground, and the sweep rests for {@link SHIMMER_GAP}
 * steps past the end before starting again.
 * @param palette - the palette the sweep is drawn with; a disabled palette returns `text` unchanged.
 * @param text - the plain text to draw.
 * @param now - the current time in milliseconds.
 * @param periodMs - how long the sweep rests on each character, in milliseconds; positive.
 * @returns the styled text, the same visible width as `text`.
 */
export function shimmer(palette: Palette, text: string, now: number, periodMs: number): string {
  const chars = Array.from(new Intl.Segmenter().segment(text), part => part.segment)
  const at = Math.floor(now / periodMs) % (chars.length + SHIMMER_GAP)
  const tone = (index: number): 'bright' | 'plain' | 'dim' => {
    const distance = Math.abs(index - at)
    return distance === 0 ? 'bright' : distance === 1 ? 'plain' : 'dim'
  }
  let out = ''
  let run = ''
  let current: ReturnType<typeof tone> | undefined
  const flush = (): void => {
    if (current === undefined || run === '') return
    out += current === 'bright' ? palette.bold(run) : current === 'plain' ? run : palette.dim(run)
    run = ''
  }
  for (const [index, char] of chars.entries()) {
    const next = tone(index)
    if (next !== current) {
      flush()
      current = next
    }
    run += char
  }
  flush()
  return out
}
