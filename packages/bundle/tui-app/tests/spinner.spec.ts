/** Working-indicator frames, label and tool mapping, wall-clock steps, same-family stagger, and the activity-word shimmer. */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import {
  ACTIVITY_SPINNERS,
  COMPACTING_ACTIVITY,
  SPINNER_CYCLE,
  TOOL_SPINNERS,
  activityStatus,
  callingActivity,
  isCallingActivity,
  shimmer,
  spinnerFrame,
  staggerPhase,
  toolFamily,
  type ActivityStatus,
  type SpinnerFrames,
  type ToolFamily,
} from '../src/spinner.ts'
import { createPalette } from '../src/style.ts'
import { TODO_GLYPH } from '../src/todos.ts'

/** Every animation the terminal draws, activity statuses and tool families alike. */
const ALL_SPINNERS: ReadonlyArray<readonly [string, SpinnerFrames]> = [
  ...Object.entries(ACTIVITY_SPINNERS),
  ...Object.entries(TOOL_SPINNERS),
]

/** The tool families whose frames read the same forwards and backwards. */
const PALINDROMIC: readonly ToolFamily[] = ['edit', 'todo', 'waiting']

/**
 * The instants of one cycle at which two indicators of `frames` draw the same glyph.
 * @param frames - the animation both draw.
 * @param phase - the first indicator's phase.
 * @param other - the second indicator's phase.
 * @returns how many of the cycle's frame periods they coincide in.
 */
function sharedInstants(frames: SpinnerFrames, phase: number, other: number): number {
  let count = 0
  for (let step = 0; step < SPINNER_CYCLE; step += 1) {
    if (spinnerFrame(frames, step * 100, 100, phase) === spinnerFrame(frames, step * 100, 100, other)) count += 1
  }
  return count
}

describe('spinner frames', () => {
  it('gives every animation one cycle of one-column frames, each different from the next', () => {
    expect(SPINNER_CYCLE).toBe(8)
    for (const [, frames] of ALL_SPINNERS) {
      expect(frames).toHaveLength(SPINNER_CYCLE)
      for (const [index, frame] of frames.entries()) {
        expect(visibleWidth(frame)).toBe(1)
        expect(frame).not.toMatch(/\p{Emoji}/u)
        expect(frame).not.toBe(frames[(index + 1) % SPINNER_CYCLE])
      }
    }
  })

  it('draws braille on the activity line alone', () => {
    const braille = /^[⠀-⣿]$/u
    for (const frames of Object.values(ACTIVITY_SPINNERS)) {
      for (const frame of frames) expect(frame).toMatch(braille)
    }
    const cardAndBoard = [...Object.values(TOOL_SPINNERS).flat(), ...Object.values(TODO_GLYPH)]
    for (const glyph of cardAndBoard) expect(glyph).not.toMatch(braille)
  })

  it('gives no two tool families a glyph in common', () => {
    const families = Object.entries(TOOL_SPINNERS)
    for (const [index, [name, frames]] of families.entries()) {
      for (const [other, otherFrames] of families.slice(index + 1)) {
        const theirs = new Set<string>(otherFrames)
        expect(frames.filter(frame => theirs.has(frame)), `${name} and ${other}`).toEqual([])
      }
    }
  })

  it('steps one frame per period of wall clock and wraps after the last', () => {
    const frames = ACTIVITY_SPINNERS.thinking
    expect(spinnerFrame(frames, 0, 100)).toBe('⠙')
    expect(spinnerFrame(frames, 99, 100)).toBe('⠙')
    expect(spinnerFrame(frames, 100, 100)).toBe('⠸')
    expect(spinnerFrame(frames, 700, 100)).toBe('⠋')
    expect(spinnerFrame(frames, 800, 100)).toBe('⠙')
    expect(spinnerFrame(frames, 239, 120)).toBe('⠸')
    expect(spinnerFrame(frames, 240, 120)).toBe('⢰')
  })

  it('runs a phase that many frames ahead of the clock', () => {
    const frames = TOOL_SPINNERS.shell
    expect(spinnerFrame(frames, 0, 100, 3)).toBe(frames[3])
    expect(spinnerFrame(frames, 400, 100, 3)).toBe(frames[7])
    expect(spinnerFrame(frames, 500, 100, 3)).toBe(frames[0])
  })

  it('keeps the beat when the activity changes animation', () => {
    for (const step of [0, 3, 7]) {
      const now = step * 100 + 50
      for (const frames of Object.values(ACTIVITY_SPINNERS)) {
        expect(spinnerFrame(frames, now, 100)).toBe(frames[step])
      }
    }
  })
})

describe('spinner mapping', () => {
  it('names a tool call on the activity line until its name arrives', () => {
    expect(callingActivity(undefined)).toBe('calling')
    expect(callingActivity('')).toBe('calling')
    expect(callingActivity('bash')).toBe('calling bash')
    expect(isCallingActivity('calling')).toBe(true)
    expect(isCallingActivity('calling bash')).toBe(true)
    expect(isCallingActivity('callings')).toBe(false)
    expect(isCallingActivity('thinking')).toBe(false)
  })

  it('maps each activity label to its status, and a tool call to calling whichever tool it names', () => {
    const cases: ReadonlyArray<readonly [string, ActivityStatus]> = [
      ['thinking', 'thinking'],
      ['writing', 'writing'],
      ['calling', 'calling'],
      ['calling bash', 'calling'],
      ['calling edit', 'calling'],
      ['calling todo_write', 'calling'],
      ['calling plugin_manager', 'calling'],
      ['retrying (1/5) in 4s · RATE_LIMIT: busy', 'retrying'],
      [COMPACTING_ACTIVITY, 'compacting'],
      ['', 'thinking'],
      ['compacting context', 'thinking'],
    ]
    for (const [label, status] of cases) {
      expect(activityStatus(label), label).toBe(status)
    }
  })

  it('maps each tool to its family, and a tool with none to other', () => {
    const cases: ReadonlyArray<readonly [string, ToolFamily]> = [
      ['bash', 'shell'],
      ['pwsh', 'shell'],
      ['run_code', 'shell'],
      ['terminal_send', 'shell'],
      ['edit', 'edit'],
      ['write', 'edit'],
      ['str_replace_editor', 'edit'],
      ['read', 'search'],
      ['read_image', 'search'],
      ['glob', 'search'],
      ['grep', 'search'],
      ['lsp', 'search'],
      ['skill', 'search'],
      ['web_fetch', 'search'],
      ['web_search', 'search'],
      ['load_workspace_dependencies', 'search'],
      ['list_subagent_models', 'search'],
      ['session_search', 'search'],
      ['cordis_inspect_query', 'search'],
      ['list_mcp_resources', 'search'],
      ['read_mcp_resource', 'search'],
      ['subagent', 'subagent'],
      ['subagent_fork', 'subagent'],
      ['send_message', 'subagent'],
      ['interrupt_agent', 'subagent'],
      ['list_agents', 'subagent'],
      ['ralph', 'subagent'],
      ['workflow', 'subagent'],
      ['spawn_teammate', 'subagent'],
      ['wait_agent', 'subagent'],
      ['team_task_create', 'subagent'],
      ['todo_write', 'todo'],
      ['create_goal', 'todo'],
      ['get_goal', 'todo'],
      ['update_goal', 'todo'],
      ['schedule_create', 'todo'],
      ['ask_user_question', 'waiting'],
      ['exit_plan_mode', 'waiting'],
      ['plugin_manager', 'other'],
      ['present', 'other'],
      ['job_output', 'other'],
    ]
    for (const [name, family] of cases) {
      expect(toolFamily(name), name).toBe(family)
    }
  })
})

describe('staggerPhase', () => {
  it('starts the first indicator of an animation on the clock', () => {
    for (const frames of Object.values(TOOL_SPINNERS)) expect(staggerPhase(frames, [])).toBe(0)
  })

  it('spreads indicators of a family with distinct frames as far apart as the cycle allows', () => {
    const frames = TOOL_SPINNERS.shell
    expect(staggerPhase(frames, [0])).toBe(4)
    expect(staggerPhase(frames, [0, 4])).toBe(2)
    expect(staggerPhase(frames, [0, 4, 2])).toBe(6)
    expect(staggerPhase(frames, [3])).toBe(7)
    for (const name of ['shell', 'search', 'subagent', 'other'] as const) {
      const distinct = TOOL_SPINNERS[name]
      for (let phase = 0; phase < SPINNER_CYCLE; phase += 1) {
        for (let other = 0; other < SPINNER_CYCLE; other += 1) {
          expect(sharedInstants(distinct, phase, other), `${name} ${String(phase)} ${String(other)}`).toBe(phase === other ? SPINNER_CYCLE : 0)
        }
      }
    }
  })

  it('keeps a palindromic family an odd number of frames away, where its glyphs never coincide', () => {
    for (const name of PALINDROMIC) {
      const frames = TOOL_SPINNERS[name]
      for (let other = 0; other < SPINNER_CYCLE; other += 1) {
        const phase = staggerPhase(frames, [other])
        expect((phase - other + SPINNER_CYCLE) % 2, `${name} beside ${String(other)}`).toBe(1)
        expect(sharedInstants(frames, phase, other)).toBe(0)
        expect(sharedInstants(frames, (other + 2) % SPINNER_CYCLE, other)).toBeGreaterThan(0)
      }
      expect(staggerPhase(frames, [0])).toBe(3)
    }
  })

  it('takes the phase that coincides least when every phase coincides with some indicator', () => {
    const frames = TOOL_SPINNERS.edit
    const taken = [0, 3]
    const phase = staggerPhase(frames, taken)
    const shared = (candidate: number): number => taken.reduce((sum, other) => sum + sharedInstants(frames, candidate, other), 0)
    expect(phase).toBe(5)
    expect(shared(phase)).toBe(2)
    for (let candidate = 0; candidate < SPINNER_CYCLE; candidate += 1) {
      expect(shared(candidate)).toBeGreaterThanOrEqual(shared(phase))
    }
    const full = Array.from({ length: SPINNER_CYCLE }, (_, index) => index)
    expect(staggerPhase(TOOL_SPINNERS.shell, full)).toBe(0)
  })
})

describe('shimmer', () => {
  it('sweeps a bold character with plain neighbours across dim text, one character per period', () => {
    const on = createPalette(true)
    expect(shimmer(on, 'thinking', 0, 100)).toBe(`${on.bold('t')}h${on.dim('inking')}`)
    expect(shimmer(on, 'thinking', 300, 100)).toBe(`${on.dim('th')}i${on.bold('n')}k${on.dim('ing')}`)
    expect(shimmer(on, 'thinking', 360, 120)).toBe(shimmer(on, 'thinking', 300, 100))
    expect(visibleWidth(shimmer(on, 'thinking', 300, 100))).toBe(8)
  })

  it('rests past the end of the word before the next pass', () => {
    const on = createPalette(true)
    expect(shimmer(on, 'go', 400, 100)).toBe(on.dim('go'))
    expect(shimmer(on, 'go', 800, 100)).toBe(`${on.bold('g')}o`)
  })

  it('sweeps whole graphemes, so a combined character is never split', () => {
    const on = createPalette(true)
    expect(shimmer(on, 'éa', 0, 100)).toBe(`${on.bold('é')}a`)
  })

  it('returns the text unchanged on a disabled palette', () => {
    expect(shimmer(createPalette(false), 'calling bash', 200, 100)).toBe('calling bash')
  })
})
