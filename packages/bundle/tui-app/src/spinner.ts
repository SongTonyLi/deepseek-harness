/**
 * Working indicators: a braille status glyph and a shimmer on the activity
 * line above the prompt, flower, bloom, and star glyphs on running tool
 * cards, folded subagent rows, running workflow members, and the activity
 * board's in-progress todo rows, and a pulsing diamond on running workflow runs.
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
 * The animation a running tool card draws, by tool family; a folded subagent
 * row draws `subagent`, and the activity board's in-progress todo rows draw
 * `todo`. Each cycle mixes flowers, blooms, and stars. No frame is braille,
 * no two families share a glyph, and the eight frames of one family all
 * differ, so two indicators of that family at different phases never draw the
 * same glyph at the same instant. A presentation choice of this terminal
 * surface, not a deployment setting.
 */
export const TOOL_SPINNERS = {
  /** Command execution: four-pointed stars, teardrop blooms, and florettes. */
  shell: ['✧', '✢', '✽', '✿', '❋', '✸', '❀', '✹'],
  /** File mutation: florettes between outlined stars and an open bloom. */
  edit: ['✩', '✤', '✾', '❁', '✭', '✮', '❂', '✲'],
  /** Reading and searching: flowers and an open bloom among stars. */
  search: ['⋆', '✱', '✵', '⚘', '❃', '✶', '⁕', '✷'],
  /** Delegation, a folded subagent row included: floral hearts, pinwheel blooms, and stars. */
  subagent: ['✦', '✣', '❊', '❦', '❉', '✪', '✫', '❧'],
  /** Planning and scheduling, and an in-progress todo row: a florette, teardrop blooms, and stars. */
  todo: ['☆', '✥', '✼', '❅', '✻', '✬', '★', '✰'],
  /** A tool with no family of its own: a sparkle and a florette among stars. */
  other: ['∗', '❈', '⁎', '❆', '⚝', '✺', '⚹', '✯'],
} as const satisfies Record<string, SpinnerFrames>

/**
 * The animation a running workflow run's header draws in place of its static
 * `◇`: a diamond filling, blooming, and emptying again. Its running members
 * spin in the `subagent` family of {@link TOOL_SPINNERS}, each a phase ahead
 * of the member before it. A presentation choice of this terminal surface,
 * not a deployment setting.
 */
export const WORKFLOW_SPINNER: SpinnerFrames = ['◇', '◈', '◆', '❖', '◆', '◈', '◇', '◊']

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
 * The phase a new indicator spins at beside the indicators of the same
 * animation already spinning. Every {@link TOOL_SPINNERS} animation uses
 * eight different frames, so two indicators of one family at different phases
 * never draw the same glyph. A phase no indicator holds is taken, the one
 * farthest from its nearest neighbour first and the lowest on a tie; once
 * every phase is held, the lowest phase held by the fewest indicators.
 * @param taken - the phases of the indicators of that animation spinning now, one per indicator.
 * @returns a phase from 0 to {@link SPINNER_CYCLE} - 1.
 */
export function staggerPhase(taken: readonly number[]): number {
  let best = 0
  let fewest = Number.POSITIVE_INFINITY
  let widest = -1
  for (let phase = 0; phase < SPINNER_CYCLE; phase += 1) {
    let holders = 0
    let gap: number = SPINNER_CYCLE
    for (const other of taken) {
      if (other === phase) holders += 1
      const distance = Math.abs(phase - other)
      gap = Math.min(gap, distance, SPINNER_CYCLE - distance)
    }
    if (holders < fewest || (holders === fewest && gap > widest)) {
      best = phase
      fewest = holders
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
