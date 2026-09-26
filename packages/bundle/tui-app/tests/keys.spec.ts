/** The key model: what each region claims, what a press types, and the legends. */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import {
  ENTRY_HINTS,
  QUEUE_ENTRY_HINT,
  entryHints,
  ESCAPE_HANDOFF_MS,
  FOCUS_REGIONS,
  HINTS,
  KEY_LINES,
  REGION_LABELS,
  resolveKey,
  typedText,
  widestHint,
  type FocusRegion,
  type KeyAction,
} from '../src/keys.ts'
import { KEY } from './bench.ts'

/**
 * The action one key names in one region.
 * @param region - the region holding the keyboard.
 * @param data - the raw key bytes.
 * @returns the action, or undefined when the region claims nothing.
 */
function key(region: FocusRegion, data: string): KeyAction | undefined {
  return resolveKey(region, data)
}

/** Every region, so a key can be asked of all of them at once. */
const REGIONS: readonly FocusRegion[] = ['editor', 'transcript', 'queue', 'panel', 'bar']

describe('the keys every region answers', () => {
  it('reads Escape, Ctrl+O, and Ctrl+G the same way wherever the keyboard is', () => {
    for (const region of REGIONS) {
      expect(key(region, KEY.escape)).toEqual({ kind: 'escape' })
      expect(key(region, KEY.ctrlO)).toEqual({ kind: 'fold-all' })
      expect(key(region, KEY.ctrlG)).toEqual({ kind: 'reader' })
    }
  })
})

describe('the editor', () => {
  it('leaves the input along the stack in either direction', () => {
    expect(key('editor', KEY.shiftUp)).toEqual({ kind: 'leave', direction: 'up' })
    expect(key('editor', KEY.shiftDown)).toEqual({ kind: 'leave', direction: 'down' })
  })

  it('claims steering, the newest follow-up, and the effort picker', () => {
    expect(key('editor', KEY.ctrlS)).toEqual({ kind: 'steer' })
    expect(key('editor', KEY.up)).toEqual({ kind: 'edit-latest' })
    expect(key('editor', KEY.shiftTab)).toEqual({ kind: 'effort' })
    expect(key('editor', '\u001b[9;2u')).toEqual({ kind: 'effort' })
  })

  it('claims nothing pi-tui\'s own editor answers', () => {
    for (const data of [KEY.down, KEY.left, KEY.right, KEY.shiftLeft, KEY.shiftRight, KEY.enter, KEY.tab, KEY.space, KEY.home, KEY.end, 'a']) {
      expect(key('editor', data)).toBeUndefined()
    }
  })
})

describe('the transcript', () => {
  it('walks sections with the arrows and parts with Left and Right', () => {
    expect(key('transcript', KEY.up)).toEqual({ kind: 'move', axis: 'section', to: 'previous' })
    expect(key('transcript', KEY.down)).toEqual({ kind: 'move', axis: 'section', to: 'next' })
    expect(key('transcript', KEY.left)).toEqual({ kind: 'move', axis: 'part', to: 'previous' })
    expect(key('transcript', KEY.right)).toEqual({ kind: 'move', axis: 'part', to: 'next' })
  })

  it('jumps a block, a turn, and to either end', () => {
    expect(key('transcript', KEY.shiftUp)).toEqual({ kind: 'move', axis: 'block', to: 'previous' })
    expect(key('transcript', KEY.shiftDown)).toEqual({ kind: 'move', axis: 'block', to: 'next' })
    expect(key('transcript', KEY.pageUp)).toEqual({ kind: 'move', axis: 'turn', to: 'previous' })
    expect(key('transcript', KEY.pageDown)).toEqual({ kind: 'move', axis: 'turn', to: 'next' })
    expect(key('transcript', KEY.home)).toEqual({ kind: 'move', axis: 'section', to: 'first' })
    expect(key('transcript', KEY.end)).toEqual({ kind: 'move', axis: 'section', to: 'last' })
    expect(key('transcript', KEY.shiftLeft)).toEqual({ kind: 'move', axis: 'part', to: 'first' })
    expect(key('transcript', KEY.shiftRight)).toEqual({ kind: 'move', axis: 'part', to: 'last' })
  })

  it('opens the held section on Enter, keeps Space for the held block, and cycles regions with Tab', () => {
    expect(key('transcript', KEY.enter)).toEqual({ kind: 'open' })
    expect(key('transcript', KEY.space)).toEqual({ kind: 'fold' })
    expect(key('transcript', KEY.tab)).toEqual({ kind: 'cycle', step: 1 })
    expect(key('transcript', KEY.shiftTab)).toEqual({ kind: 'cycle', step: -1 })
  })

  it('types every other printable key back into the editor', () => {
    expect(key('transcript', 'z')).toEqual({ kind: 'type', text: 'z' })
    expect(key('transcript', KEY.digit1)).toEqual({ kind: 'type', text: '1' })
    // Ctrl+S steers from the editor and types nothing, so the transcript
    // consumes it without effect.
    expect(key('transcript', KEY.ctrlS)).toBeUndefined()
  })
})

describe('the queued-prompt panel', () => {
  it('walks prompts and applies its three commands', () => {
    expect(key('queue', KEY.up)).toEqual({ kind: 'move', axis: 'prompt', to: 'previous' })
    expect(key('queue', KEY.down)).toEqual({ kind: 'move', axis: 'prompt', to: 'next' })
    expect(key('queue', KEY.home)).toEqual({ kind: 'move', axis: 'prompt', to: 'first' })
    expect(key('queue', KEY.end)).toEqual({ kind: 'move', axis: 'prompt', to: 'last' })
    expect(key('queue', KEY.enter)).toEqual({ kind: 'queue', action: 'steer' })
    expect(key('queue', 's')).toEqual({ kind: 'queue', action: 'steer' })
    expect(key('queue', 'I')).toEqual({ kind: 'queue', action: 'inject' })
    expect(key('queue', 'e')).toEqual({ kind: 'queue', action: 'edit' })
  })

  it('cycles regions and types other printable keys back into the editor', () => {
    expect(key('queue', KEY.tab)).toEqual({ kind: 'cycle', step: 1 })
    expect(key('queue', KEY.shiftTab)).toEqual({ kind: 'cycle', step: -1 })
    expect(key('queue', 'q')).toEqual({ kind: 'type', text: 'q' })
  })
})

describe('the subagent panel', () => {
  it('walks its rows, reaches their ends, and opens one', () => {
    expect(key('panel', KEY.up)).toEqual({ kind: 'move', axis: 'row', to: 'previous' })
    expect(key('panel', KEY.down)).toEqual({ kind: 'move', axis: 'row', to: 'next' })
    expect(key('panel', KEY.enter)).toEqual({ kind: 'open' })
    for (const data of [KEY.shiftUp, KEY.home, KEY.pageUp]) {
      expect(key('panel', data)).toEqual({ kind: 'move', axis: 'row', to: 'first' })
    }
    for (const data of [KEY.shiftDown, KEY.end, KEY.pageDown]) {
      expect(key('panel', data)).toEqual({ kind: 'move', axis: 'row', to: 'last' })
    }
  })

  it('cycles regions with Tab, types a printable key back into the editor, and consumes the rest', () => {
    expect(key('panel', KEY.tab)).toEqual({ kind: 'cycle', step: 1 })
    expect(key('panel', KEY.shiftTab)).toEqual({ kind: 'cycle', step: -1 })
    expect(key('panel', 'q')).toEqual({ kind: 'type', text: 'q' })
    expect(key('panel', KEY.left)).toBeUndefined()
  })
})

describe('the status bar', () => {
  it('walks its segments with the arrows and reaches their ends', () => {
    expect(key('bar', KEY.left)).toEqual({ kind: 'move', axis: 'segment', to: 'previous' })
    expect(key('bar', KEY.right)).toEqual({ kind: 'move', axis: 'segment', to: 'next' })
    for (const data of [KEY.shiftLeft, KEY.home, KEY.pageUp]) {
      expect(key('bar', data)).toEqual({ kind: 'move', axis: 'segment', to: 'first' })
    }
    for (const data of [KEY.shiftRight, KEY.end, KEY.pageDown]) {
      expect(key('bar', data)).toEqual({ kind: 'move', axis: 'segment', to: 'last' })
    }
  })

  it('leaves upwards, opens a segment, cycles regions, and is the bottom of the stack', () => {
    expect(key('bar', KEY.up)).toEqual({ kind: 'leave', direction: 'up' })
    expect(key('bar', KEY.enter)).toEqual({ kind: 'open' })
    expect(key('bar', KEY.down)).toBeUndefined()
    expect(key('bar', KEY.tab)).toEqual({ kind: 'cycle', step: 1 })
    expect(key('bar', KEY.shiftTab)).toEqual({ kind: 'cycle', step: -1 })
    expect(key('bar', KEY.shiftUp)).toEqual({ kind: 'focus', region: 'transcript' })
    expect(key('bar', KEY.shiftDown)).toEqual({ kind: 'focus', region: 'bar' })
  })

  it('types a printable key back into the editor', () => {
    expect(key('bar', 'x')).toEqual({ kind: 'type', text: 'x' })
  })
})

describe('what one press types', () => {
  it('takes printable characters, including a space and a wide grapheme', () => {
    expect(typedText('a')).toBe('a')
    expect(typedText(' ')).toBe(' ')
    expect(typedText('漢')).toBe('漢')
  })

  it('takes nothing from control keys, DEL, C1 controls, or an escape sequence', () => {
    for (const data of [KEY.escape, KEY.enter, KEY.tab, KEY.ctrlC, '\u007f', '\u0085', KEY.up, KEY.pageDown]) {
      expect(typedText(data)).toBeUndefined()
    }
  })

  it('decodes a Kitty printable report', () => {
    expect(typedText('\u001b[97;1u')).toBe('a')
  })
})

describe('the legends', () => {
  it('declares each region\'s steps widest first', () => {
    for (const region of REGIONS) {
      const steps = HINTS[region]
      for (let index = 1; index < steps.length; index += 1) {
        expect(visibleWidth(steps[index] ?? '')).toBeLessThan(visibleWidth(steps[index - 1] ?? ''))
      }
    }
  })

  it('ends every docked legend on the way back to the input, and gives the editor none', () => {
    expect(widestHint('transcript')).toBe('↑↓ sections · ←→ parts · Space folds · Ctrl+G reader · Esc input')
    expect(widestHint('queue')).toBe('↑↓ select · Enter steer · E edit · I inject · Esc input')
    expect(widestHint('panel')).toBe('↑↓ children · Enter opens · Tab regions · Esc input')
    expect(widestHint('bar')).toBe('←→ segments · Enter details · Tab regions · Esc input')
    expect(widestHint('editor')).toBe('')
    for (const region of ['transcript', 'queue', 'panel', 'bar'] as const) {
      expect(HINTS[region].at(-1)).toBe('Esc input')
    }
  })

  it('opens each region\'s help lines with the legend that region draws', () => {
    for (const region of REGIONS) {
      // `/help` lists the states in the order the screen stacks them.
      expect(FOCUS_REGIONS).toContain(region)
      expect(REGION_LABELS[region]).not.toBe('')
    }
    expect(FOCUS_REGIONS).toEqual(['editor', 'transcript', 'queue', 'panel', 'bar'])
    // A docked region's help row opens with the very legend it draws, so the
    // two can never drift apart.
    for (const region of ['transcript', 'queue', 'panel', 'bar'] as const) {
      expect(KEY_LINES[region][0]).toBe(widestHint(region))
    }
    // The editor draws none, so its keys are listed only here, the entry keys
    // included exactly as the unfocused bar reserves them.
    expect(KEY_LINES.editor.some(line => line.startsWith(ENTRY_HINTS[0] as string))).toBe(true)
    expect(KEY_LINES.editor).toContain('While follow-ups wait: ↑ on an empty input edits the newest · Shift+↑ selects one')
  })

  it('rewrites Shift+↑ on the unfocused bar while follow-ups wait', () => {
    expect(ENTRY_HINTS[0]).toBe('Shift+↑ read · Shift+↓ status')
    expect(entryHints({ queue: true })[0]).toBe('Shift+↑ select · Shift+↓ status')
    expect(QUEUE_ENTRY_HINT).toBe('↑ edit · Shift+↑ select')
    expect(entryHints()).toEqual(ENTRY_HINTS)
  })
})

describe('the handoff window', () => {
  it('is long enough for a habitual double press and short enough to stay out of the way', () => {
    expect(ESCAPE_HANDOFF_MS).toBe(750)
  })
})
