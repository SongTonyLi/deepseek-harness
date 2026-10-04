/** Working-indicator frames, activity and tool-family mapping, wall-clock steps, phase stagger, and the activity-word shimmer. */

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

/** Every animation the terminal draws: the activity statuses and the tool families. */
const ALL_SPINNERS: ReadonlyArray<readonly [string, SpinnerFrames]> = [
  ...Object.entries(ACTIVITY_SPINNERS),
  ...Object.entries(TOOL_SPINNERS),
]

/** Flower glyphs used by the tool-family animations. */
const FLOWERS = new Set(['✾', '✿', '❀', '❁', '⚘', '⁕', '❦', '❧', '❅', '❆'])

/** Bloom glyphs: teardrop, pinwheel, and asterisk forms. */
const BLOOMS = new Set(['✢', '✽', '❋', '✤', '✲', '✱', '❃', '✣', '❊', '❉', '✥', '✼', '✻', '❈', '✺'])

/** Star glyphs used by the tool-family animations. */
const STARS = new Set(['✧', '✸', '✹', '✩', '✭', '✮', '❂', '⋆', '✵', '✶', '✷', '✦', '✪', '✫', '☆', '✬', '★', '✰', '∗', '⁎', '⚝', '⚹', '✯'])

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

  it('gives every tool family eight different frames and no glyph another family draws', () => {
    const seen = new Set<string>()
    for (const [name, frames] of Object.entries(TOOL_SPINNERS)) {
      expect(new Set(frames).size, name).toBe(SPINNER_CYCLE)
      for (const frame of frames) {
        expect(seen.has(frame), `${name} ${frame}`).toBe(false)
        seen.add(frame)
      }
    }
  })

  it('mixes a flower, a bloom, and a star in every tool family', () => {
    for (const [name, frames] of Object.entries(TOOL_SPINNERS)) {
      const kinds = { flower: 0, bloom: 0, star: 0 }
      for (const frame of frames) {
        if (FLOWERS.has(frame)) kinds.flower += 1
        else if (BLOOMS.has(frame)) kinds.bloom += 1
        else if (STARS.has(frame)) kinds.star += 1
        else expect(frame, `${name} has a frame outside the flower, bloom, and star glyphs`).toBe('')
      }
      expect(kinds.flower, name).toBeGreaterThan(0)
      expect(kinds.bloom, name).toBeGreaterThan(0)
      expect(kinds.star, name).toBeGreaterThan(0)
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
    expect(spinnerFrame(TOOL_SPINNERS.shell, 0, 100, 3)).toBe(TOOL_SPINNERS.shell[3])
    expect(spinnerFrame(TOOL_SPINNERS.shell, 400, 100, 3)).toBe(TOOL_SPINNERS.shell[7])
    expect(spinnerFrame(TOOL_SPINNERS.shell, 500, 100, 3)).toBe(TOOL_SPINNERS.shell[0])
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
      ['ask_user_question', 'other'],
      ['exit_plan_mode', 'other'],
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
  it('starts the first indicator on the clock', () => {
    expect(staggerPhase([])).toBe(0)
  })

  it('spreads indicators as far apart as the cycle allows', () => {
    expect(staggerPhase([0])).toBe(4)
    expect(staggerPhase([0, 4])).toBe(2)
    expect(staggerPhase([0, 4, 2])).toBe(6)
    expect(staggerPhase([3])).toBe(7)
  })

  it('gives each of the first eight indicators a phase of its own, where no two draw the same glyph', () => {
    const phases: number[] = []
    for (let count = 0; count < SPINNER_CYCLE; count += 1) phases.push(staggerPhase(phases))
    expect(new Set(phases).size).toBe(SPINNER_CYCLE)
    for (const [name, frames] of Object.entries(TOOL_SPINNERS)) {
      for (let phase = 0; phase < SPINNER_CYCLE; phase += 1) {
        for (let other = 0; other < SPINNER_CYCLE; other += 1) {
          expect(sharedInstants(frames, phase, other), `${name} ${String(phase)} beside ${String(other)}`).toBe(phase === other ? SPINNER_CYCLE : 0)
        }
      }
    }
  })

  it('takes the lowest phase the fewest indicators hold once every phase is held', () => {
    const full = Array.from({ length: SPINNER_CYCLE }, (_, index) => index)
    expect(staggerPhase(full)).toBe(0)
    expect(staggerPhase([...full, 0])).toBe(1)
    expect(staggerPhase([...full, 0, 1])).toBe(2)
    expect(staggerPhase([...full, 1])).toBe(0)
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
    expect(shimmer(on, 'éa', 0, 100)).toBe(`${on.bold('é')}a`)
  })

  it('returns the text unchanged on a disabled palette', () => {
    expect(shimmer(createPalette(false), 'calling bash', 200, 100)).toBe('calling bash')
  })
})
