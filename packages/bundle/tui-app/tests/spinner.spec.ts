/** Working-indicator frames, scenario mapping, and the activity-word shimmer. */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { SPINNER_FRAMES, SPINNER_MS, loaderIndicator, shimmer, spinnerFrame, spinnerKindForActivity, spinnerKindForTool, type SpinnerKind } from '../src/spinner.ts'
import { createPalette } from '../src/style.ts'

describe('spinner', () => {
  it('steps one braille frame per period and wraps after the last', () => {
    expect(spinnerFrame(0)).toBe('⠋')
    expect(spinnerFrame(SPINNER_MS - 1)).toBe('⠋')
    expect(spinnerFrame(SPINNER_MS)).toBe('⠙')
    expect(spinnerFrame(SPINNER_MS * 9)).toBe('⠏')
    expect(spinnerFrame(SPINNER_MS * 10)).toBe('⠋')
  })

  it('uses the reference glyph cycle while writing', () => {
    expect(SPINNER_FRAMES.writing).toEqual(['·', '✣', '✳', '✦', '✽', '✤'])
    expect(spinnerFrame(SPINNER_MS * 5, 'writing')).toBe('✤')
    expect(spinnerFrame(SPINNER_MS * 6, 'writing')).toBe('·')
  })

  it('uses the edit glyph cycle for shell activity', () => {
    expect(SPINNER_FRAMES.shell).toEqual(SPINNER_FRAMES.edit)
  })

  it('blinks a filled circle for todo activity', () => {
    expect(SPINNER_FRAMES.todo).toEqual(['●', ' '])
    expect(spinnerFrame(0, 'todo')).toBe('●')
    expect(spinnerFrame(SPINNER_MS, 'todo')).toBe(' ')
    expect(spinnerFrame(SPINNER_MS * 2, 'todo')).toBe('●')
  })

  it('draws the default kind without one and cycles every other kind', () => {
    expect(spinnerFrame(0, 'thinking')).toBe(spinnerFrame(0))
    const kinds = Object.keys(SPINNER_FRAMES) as SpinnerKind[]
    expect(kinds.length).toBeGreaterThan(1)
    for (const kind of kinds) {
      const frames = SPINNER_FRAMES[kind]
      for (const [step, frame] of frames.entries()) {
        expect(spinnerFrame(SPINNER_MS * step, kind)).toBe(frame)
      }
      expect(spinnerFrame(SPINNER_MS * frames.length, kind)).toBe(frames[0])
    }
  })

  it('keeps every frame one column wide, like the glyph it replaces', () => {
    for (const frames of Object.values(SPINNER_FRAMES)) {
      for (const frame of frames) {
        expect(visibleWidth(frame)).toBe(1)
      }
    }
  })

  it('maps each tool family to its own animation', () => {
    const cases: ReadonlyArray<readonly [string, SpinnerKind]> = [
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
      ['plugin_manager', 'calling'],
      ['present', 'calling'],
      ['job_output', 'calling'],
    ]
    for (const [name, kind] of cases) {
      expect(spinnerKindForTool(name)).toBe(kind)
    }
  })

  it('uses rotating dots for every working activity without changing the cycle', () => {
    for (const activity of ['thinking', 'writing', 'calling', 'calling bash', 'calling glob',
      'calling edit', 'calling plugin_manager', 'compacting', 'retrying (1/5) in 4s · RATE_LIMIT: busy', '']) {
      expect(spinnerKindForActivity(activity)).toBe('thinking')
      expect(loaderIndicator(spinnerKindForActivity(activity)).frames).toEqual([...SPINNER_FRAMES.thinking])
    }
  })

  it('holds tool-family glyphs for the caller-selected slower period', () => {
    expect(spinnerFrame(0, 'shell', 160)).toBe('◇')
    expect(spinnerFrame(80, 'shell', 160)).toBe('◇')
    expect(spinnerFrame(160, 'shell', 160)).toBe('◈')
    expect(spinnerFrame(640, 'shell', 160)).toBe('◇')
  })

  it('hands the loader fresh frames on the shared period', () => {
    const indicator = loaderIndicator('shell')
    expect(indicator).toEqual({ frames: ['◇', '◈', '◆', '◈'], intervalMs: SPINNER_MS })
    expect(indicator.frames).not.toBe(SPINNER_FRAMES.shell)
  })

  it('sweeps a bold character with plain neighbours across dim text', () => {
    const on = createPalette(true)
    expect(shimmer(on, 'thinking', 0)).toBe(`${on.bold('t')}h${on.dim('inking')}`)
    expect(shimmer(on, 'thinking', SPINNER_MS * 3)).toBe(`${on.dim('th')}i${on.bold('n')}k${on.dim('ing')}`)
    expect(visibleWidth(shimmer(on, 'thinking', SPINNER_MS * 3))).toBe(8)
  })

  it('rests past the end of the word before the next pass', () => {
    const on = createPalette(true)
    expect(shimmer(on, 'go', SPINNER_MS * 4)).toBe(on.dim('go'))
    expect(shimmer(on, 'go', SPINNER_MS * 8)).toBe(`${on.bold('g')}o`)
  })

  it('sweeps whole graphemes, so a combined character is never split', () => {
    const on = createPalette(true)
    expect(shimmer(on, 'e\u0301a', 0)).toBe(`${on.bold('e\u0301')}a`)
  })

  it('returns the text unchanged on a disabled palette', () => {
    expect(shimmer(createPalette(false), 'calling bash', SPINNER_MS * 2)).toBe('calling bash')
  })
})
