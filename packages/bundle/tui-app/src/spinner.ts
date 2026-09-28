/**
 * Working indicators: one single-column animation per scenario, so the
 * glyph itself names the work — reasoning churns, streaming text blooms,
 * commands and edits set a diamond, reads pulse a lens,
 * delegation dives, todo items blink a dot, waits turn a clock, and tools
 * with no family orbit the moon — plus the shimmer the working spinner's
 * activity word carries.
 *
 * Pure. Frame lookups read a wall-clock instant the caller passes in, so
 * every surface drawing at the same moment draws the same frame, and the
 * application owns the tick that redraws them.
 * @module @deepseek-ai/dsh-tui-app/spinner
 */

import type { LoaderIndicatorOptions } from '@earendil-works/pi-tui'
import { isSubagentTool } from './transcript.ts'
import type { Palette } from './style.ts'

/**
 * The frames each scenario cycles through, every frame one column wide like
 * the glyph it replaces. A presentation choice of this terminal surface, not
 * a deployment setting.
 */
export const SPINNER_FRAMES = {
  /** Model reasoning with no visible text yet: the braille circle pi-tui's working spinner draws. */
  thinking: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  /** Visible text streaming in: a small asterisk grows and settles as words land. */
  writing: ['·', '✣', '✳', '✦', '✽', '✤'],
  /** A tool with no family of its own: the moon orbiting. */
  calling: ['◐', '◓', '◑', '◒'],
  /** Command execution: the same diamond animation as file edits. */
  shell: ['◇', '◈', '◆', '◈'],
  /** Reading and searching: a lens pulsing into focus. */
  search: ['○', '◉', '●', '◉'],
  /** File mutation: a diamond setting solid. */
  edit: ['◇', '◈', '◆', '◈'],
  /** Delegation to a child agent: dots diving deeper. */
  subagent: ['⠁', '⠃', '⠇', '⠷', '⠿', '⠷', '⠇', '⠃'],
  /** Todo progress: a dot blinking in place. */
  todo: ['·', ' '],
  /** Waiting on a retry delay or a human answer: a clock turning. */
  waiting: ['◷', '◶', '◵', '◴'],
  /** Condensing older history into a summary: a column of dots settling down and filling back up. */
  compacting: ['⣿', '⣶', '⣤', '⣀', '⣤', '⣶'],
} as const

/** One animation of {@link SPINNER_FRAMES}, named by the scenario that draws it. */
export type SpinnerKind = keyof typeof SPINNER_FRAMES

/** How long one spinner frame or shimmer step is drawn, in milliseconds; pi-tui's working spinner period. */
export const SPINNER_MS = 80

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
 * Tool-name prefixes per spinner family, checked after the exact sets above.
 * An MCP or custom tool that keeps its family's prefix inherits the animation.
 */
const TOOL_PREFIXES: ReadonlyArray<readonly [string, SpinnerKind]> = [
  ['terminal_', 'shell'],
  ['session_', 'search'],
  ['cordis_inspect_', 'search'],
  ['list_mcp_', 'search'],
  ['read_mcp_', 'search'],
  ['team_task_', 'subagent'],
  ['schedule_', 'todo'],
]

/** The word that opens the working spinner's tool-call label. */
const CALLING_WORD = 'calling '

/** The word that opens a scheduled model-request retry notice. */
const RETRYING_WORD = 'retrying'

/** The working spinner's label while a compaction condenses history. */
export const COMPACTING_ACTIVITY = 'compacting'

/**
 * The spinner frame drawn at one instant.
 * @param now - the current time in milliseconds.
 * @param kind - the scenario whose frames are drawn; `thinking` draws the braille circle.
 * @returns one frame of that scenario.
 */
export function spinnerFrame(now: number, kind: SpinnerKind = 'thinking'): string {
  const frames = SPINNER_FRAMES[kind]
  const index = Math.floor(now / SPINNER_MS) % frames.length
  /* v8 ignore next -- the modulo keeps the index inside the frame list */
  return frames[index] ?? frames[0]
}

/**
 * The animation a running tool card draws for `name`.
 * @param name - the tool the model called.
 * @returns the tool family's animation, or `calling` for a tool with no family.
 */
export function spinnerKindForTool(name: string): SpinnerKind {
  if (SHELL_TOOLS.has(name)) return 'shell'
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (isSubagentTool(name) || SUBAGENT_TOOLS.has(name)) return 'subagent'
  if (TODO_TOOLS.has(name)) return 'todo'
  if (WAITING_TOOLS.has(name)) return 'waiting'
  for (const [prefix, kind] of TOOL_PREFIXES) {
    if (name.startsWith(prefix)) return kind
  }
  return 'calling'
}

/**
 * The animation the working spinner draws for its activity word.
 * @param activity - `thinking`, `writing`, `calling` / `calling <name>`, `compacting`, or a retry notice.
 * @returns the activity's animation; a `calling <name>` label mirrors the
 * named tool's card, and anything unrecognized draws `thinking` like the
 * loader's initial word.
 */
export function spinnerKindForActivity(activity: string): SpinnerKind {
  if (activity === 'thinking') return 'thinking'
  if (activity === 'writing') return 'writing'
  if (activity === 'calling') return 'calling'
  if (activity.startsWith(CALLING_WORD)) return spinnerKindForTool(activity.slice(CALLING_WORD.length))
  if (activity.startsWith(RETRYING_WORD)) return 'waiting'
  if (activity === COMPACTING_ACTIVITY) return 'compacting'
  return 'thinking'
}

/**
 * The pi-tui loader indicator that draws `kind`. Every kind shares
 * {@link SPINNER_MS} so the shimmer, which steps once per that period of wall
 * clock, advances one step per loader frame whatever the animation.
 * @param kind - the scenario whose frames the loader draws.
 * @returns the loader's frames and frame interval.
 */
export function loaderIndicator(kind: SpinnerKind): LoaderIndicatorOptions {
  return { frames: [...SPINNER_FRAMES[kind]], intervalMs: SPINNER_MS }
}

/**
 * Draw `text` dim with a bright highlight sweeping across it, one character
 * per {@link SPINNER_MS}: the character under the sweep is bold, its
 * neighbours are drawn at the plain foreground, and the sweep rests for
 * {@link SHIMMER_GAP} steps past the end before starting again.
 * @param palette - the palette the sweep is drawn with; a disabled palette returns `text` unchanged.
 * @param text - the plain text to draw.
 * @param now - the current time in milliseconds.
 * @returns the styled text, the same visible width as `text`.
 */
export function shimmer(palette: Palette, text: string, now: number): string {
  const chars = Array.from(new Intl.Segmenter().segment(text), part => part.segment)
  const at = Math.floor(now / SPINNER_MS) % (chars.length + SHIMMER_GAP)
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
