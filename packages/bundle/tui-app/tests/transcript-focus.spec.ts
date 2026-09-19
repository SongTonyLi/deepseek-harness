/** Walking the transcript from the keyboard: the regions, the inspector, the page, and the in-place gutter. */

import { describe, expect, it } from 'vitest'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { FADE_TICK_MS } from '../src/fade.ts'
import { ESCAPE_HANDOFF_MS } from '../src/keys.ts'
import { LANDING_TICKS, READER_CLOSE_TICKS, READER_OPEN_TICKS, SEGMENT_TICKS, STEP_TICKS } from '../src/motion.ts'
import { BENCH_NOW, KEY, bench, type Bench } from './bench.ts'

/** The scrollback-clear sequence pi-tui writes on a full redraw. */
const CLEAR_SCROLLBACK = '[3J'

/**
 * Submit one prompt from the editor.
 * @param test - the running bench.
 * @param text - the prompt text.
 */
function prompt(test: Bench, text: string): void {
  for (const char of text) test.terminal.type(char)
  test.terminal.type(KEY.enter)
}

/**
 * Submit one command line from the editor.
 * @param terminal - the fake terminal.
 * @param text - the line to type.
 */
function typeLine(terminal: { type(data: string): void }, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

/**
 * A bench with one prompt, one reply carrying reasoning, and one finished tool
 * card, which is three navigable blocks.
 * @param options - bench options, e.g. a subagent listing.
 * @returns the running bench.
 */
async function conversation(options: Parameters<typeof bench>[0] = {}): Promise<Bench> {
  const test = await bench(options)
  prompt(test, 'read the spec')
  test.appendAssistant([{ type: 'reasoning', text: 'weighing it up' }, { type: 'text', text: 'done' }])
  test.appendToolCall('call-1', 'bash', { command: 'git status' })
  test.appendToolResult('call-1', [{ type: 'text', text: 'clean tree' }])
  await test.settle()
  return test
}

describe('walking the transcript', () => {
  it('enters on the newest block, draws the inspector, and marks the block in place', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain('3/3 · turn 1 · bash · result')
    // Read mode is new geometry at a fixed place: a frame, a chip, and one
    // border down the left of everything the pane draws.
    expect(screen).toContain(' ● READ ')
    expect(screen).toContain('╭')
    expect(screen).toContain('│ ← 1 call · [2 result] →')
    expect(screen).toContain('│ clean tree')
    expect(screen).toContain('╰ ↑↓ sections · ←→ parts · Space folds · Ctrl+G reader · Esc input')
    // The card itself carries the gutter, accented on the focused result rows.
    expect(screen).toContain('┃   │ clean tree')
    expect(screen).not.toContain('off screen')
  })

  it('walks every section with Up and Down and stays inside a block with Left and Right', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 1 · bash · result')
    test.terminal.type(KEY.up)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 1 · bash · call')
    test.terminal.type(KEY.up)
    await test.settle()
    expect(await test.screen()).toContain('2/3 · turn 1 · reply')
    test.terminal.type(KEY.up)
    await test.settle()
    const reasoning = await test.screen()
    expect(reasoning).toContain('2/3 · turn 1 · reasoning')
    expect(reasoning).toContain('┃ weighing it up')
    test.terminal.type(KEY.up)
    await test.settle()
    expect(await test.screen()).toContain('1/3 · turn 0 · you')
    // The oldest section is the end of the walk, and a prompt has one part.
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.left)
    test.terminal.type(KEY.right)
    await test.settle()
    const oldest = await test.screen()
    expect(oldest).toContain('1/3 · turn 0 · you')
    expect(oldest).not.toContain('← 1 you →')
    test.terminal.type(KEY.down)
    await test.settle()
    expect(await test.screen()).toContain('2/3 · turn 1 · reasoning')
    test.terminal.type(KEY.right)
    await test.settle()
    expect(await test.screen()).toContain('2/3 · turn 1 · reply')
  })

  it('jumps a whole block with Shift+Up and Shift+Down, landing on its first section', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 1 · bash · result')
    // A block step skips the sections of the block it leaves, so one press
    // reaches the message rather than its second half.
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('2/3 · turn 1 · reasoning')
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('1/3 · turn 0 · you')
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    const back = await test.screen()
    expect(back).toContain('2/3 · turn 1 · reasoning')
    expect(back).toContain('↑↓ sections')
  })

  it('reaches either end of the transcript with Home and End, and the previous turn with PageUp', async () => {
    const test = await bench()
    prompt(test, 'read the spec')
    test.appendAssistant([{ type: 'text', text: 'first done' }])
    prompt(test, 'now ship it')
    test.appendAssistant([{ type: 'text', text: 'second done' }])
    await test.settle()
    test.terminal.type(KEY.shiftUp)
    for (let index = 0; index < 3; index += 1) test.terminal.type(KEY.up)
    await test.settle()
    expect(await test.screen()).toContain('1/4 · turn 0 · you')
    // One press returns to the newest section, and one reaches the oldest.
    test.terminal.type(KEY.end)
    await test.settle()
    expect(await test.screen()).toContain('4/4 · turn 2 · reply')
    test.terminal.type(KEY.home)
    await test.settle()
    expect(await test.screen()).toContain('1/4 · turn 0 · you')
    test.terminal.type(KEY.end)
    test.terminal.type(KEY.pageUp)
    await test.settle()
    // The turn before the newest one starts at its own prompt.
    expect(await test.screen()).toContain('1/4 · turn 0 · you')
    test.terminal.type(KEY.pageDown)
    await test.settle()
    expect(await test.screen()).toContain('3/4 · turn 1 · you')
  })

  it('focuses reasoning on a tool-call step that has no visible reply', async () => {
    const test = await bench()
    prompt(test, 'inspect it')
    test.appendAssistant([{ type: 'reasoning', text: 'planning the call' }])
    test.appendToolCall('call-1', 'bash', { command: 'git status' })
    test.appendToolResult('call-1', [{ type: 'text', text: 'clean' }])
    await test.settle()
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.up)
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain('2/3 · turn 1 · reasoning')
    expect(screen).toContain('planning the call')
    expect(screen).not.toContain('2/3 · turn 1 · reply')
  })

  it('opens the focused section in the reader and comes back to it', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.enter)
    await test.settle()
    const reading = await test.screen()
    // The reader shows the held section in full, and the other sections of
    // its turn under their own headers.
    expect(reading).toContain(' ● READER ')
    expect(reading).toContain('✻ reasoning · turn 1')
    expect(reading).toContain('weighing it up')
    expect(reading).toContain('¶ reply · turn 1')
    expect(reading).toContain('⚒ bash · call · turn 1')
    expect(reading).toContain('⚒ bash · result · turn 1')
    expect(reading).toContain('↑↓ scrolls')
    test.terminal.type(KEY.escape)
    await test.settle()
    // Esc returns to the conversation on the section last read, with the
    // gutter back on its block.
    const back = await test.screen()
    expect(back).toContain('2/3 · turn 1 · reasoning')
    expect(back).toContain('┃ weighing it up')
    expect(back).not.toContain(' ● READER ')
  })

  it('opens on the held section from the conversation and closes to the input on Ctrl+G', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    const reading = await test.screen()
    expect(reading).toContain(' ● READER ')
    // The walk had reached the reasoning, which is the section the reader opens on.
    expect(reading).toContain('✻ reasoning · turn 1')
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    const back = await test.screen()
    expect(back).not.toContain(' ● READER ')
    expect(back).not.toContain('↑↓ sections')
    prompt(test, 'back to typing')
    await test.settle()
    expect(test.calls.followups.map(message => message.content).at(-1)).toEqual([{ type: 'text', text: 'back to typing' }])
  })

  it('types a printable key back into the editor, and returns there on Esc and on Ctrl+C', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    // A printable key hands the keyboard back and lands at the caret; Space
    // and Ctrl+O stay with the transcript.
    for (const char of 'zzz') test.terminal.type(char)
    await test.settle()
    expect(await test.screen()).not.toContain('↑↓ sections')
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.ctrlO)
    test.terminal.type(KEY.space)
    await test.settle()
    expect(await test.screen()).toContain('↑↓ sections')
    expect(test.calls.followups).toHaveLength(1)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(await test.screen()).not.toContain('↑↓ sections')
    prompt(test, ' back to typing')
    await test.settle()
    expect(test.calls.followups.map(message => message.content).at(-1)).toEqual([{ type: 'text', text: 'zzz back to typing' }])

    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.terminal.text()).toContain('press Ctrl+C again to quit')
    expect(await test.screen()).not.toContain('↑↓ sections')
  })

  it('walks system prompts and injected context, and Left/Right walk snapshot contributions in full', async () => {
    const history = [
      { type: 'system/message', seq: 0, time: 1, data: { turn: 0, step: 1, message: createSystemMessage('You are the agent.', 'system-prompt') } },
      { type: 'user/message', seq: 1, time: 1, data: createUserMessage({ content: [{ type: 'text', text: '# AGENTS.md' }], source: { kind: 'plugin', plugin: 'agent-instructions', form: 'instructions' } }) },
      { type: 'user/message', seq: 2, time: 1, data: createUserMessage({
        content: [{ type: 'text', text: 'assembled' }],
        source: { kind: 'plugin', plugin: 'workspace', form: 'snapshot', sections: [
          { name: 'sandbox', text: 'allow python' },
          { name: 'git', text: 'clean tree' },
        ] },
      }) },
    ] as never[]
    const test = await bench({ history })
    await test.settle()
    const drawn = test.terminal.text()
    expect(drawn).toContain('You are the agent.')
    expect(drawn).toContain('# AGENTS.md')
    expect(drawn).toContain('allow python')
    expect(drawn).toContain('clean tree')
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 0 · snapshot · workspace · git')
    expect(await test.screen()).toContain('clean tree')
    expect(await test.screen()).toContain('← 1 sandbox · [2 git] →')
    test.terminal.type(KEY.left)
    await test.settle()
    const sandbox = await test.screen()
    expect(sandbox).toContain('sandbox')
    expect(sandbox).toContain('allow python')
    test.terminal.type(KEY.up)
    await test.settle()
    expect(await test.screen()).toContain('instructions · agent-instructions')
    expect(await test.screen()).toContain('# AGENTS.md')
    test.terminal.type(KEY.up)
    await test.settle()
    const system = await test.screen()
    expect(system).toContain('system prompt')
    expect(system).toContain('You are the agent.')
    expect(system).not.toContain('system prompt update')
  })

  it('says so when the transcript has nothing to read yet', async () => {
    const test = await bench()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(test.terminal.text()).toContain('nothing in the transcript to read yet')
    prompt(test, 'hello')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'hello' }]])
  })

  it('drops the remembered focus when the terminal binds another session', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 1 · bash · result')
    test.terminal.type(KEY.escape)
    prompt(test, '/new')
    await test.settle()
    expect(test.terminal.text()).toContain('session-opened-1')
    // The blocks the cursor named went with the previous session.
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(test.terminal.text()).toContain('nothing in the transcript to read yet')
  })

  it('grows the focused section as the reply streams and as the result lands', async () => {
    const test = await bench()
    test.stream.start()
    test.stream.chunk({ type: 'text-delta', index: 0, text: 'first half ' })
    await test.settle()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('first half')
    test.stream.chunk({ type: 'text-delta', index: 0, text: 'second half' })
    await test.settle()
    expect(await test.screen()).toContain('first half second half')

    test.appendToolCall('call-2', 'bash', { command: 'ls' })
    await test.settle()
    test.terminal.type(KEY.down)
    await test.settle()
    expect(await test.screen()).toContain('bash · running')
    test.appendToolResult('call-2', [{ type: 'text', text: 'one file' }])
    await test.settle()
    test.terminal.type(KEY.right)
    await test.settle()
    const landed = await test.screen()
    expect(landed).toContain('bash · result')
    expect(landed).toContain('one file')
  })
})

/** One resident child, which is what makes the subagent panel draw a row. */
const CHILD: SubagentDescendantListEntry = {
  kind: 'child',
  id: 'session-kid',
  parentId: 'session-tui-test',
  depth: 1,
  mode: 'one-shot',
  activity: 'running',
} as SubagentDescendantListEntry

describe('the region stack around the editor', () => {
  it('walks down through the editor into the panel and the bar, and back up the same way', async () => {
    const test = await conversation({ subagents: () => Promise.resolve([CHILD]) })
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    test.tick()
    await test.settle()
    expect(test.terminal.text()).toContain('subagents · 1 listed')

    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 1 · bash · result')
    // The editor is drawn between the conversation and the panel, so the walk
    // stops there: what is typed next lands at the caret.
    test.terminal.type(KEY.down)
    await test.settle()
    const editor = await test.screen()
    expect(editor).not.toContain('3/3 · turn 1 · bash · result')
    expect(editor).not.toContain('↑↓ children · Enter details · Tab regions · Esc input')
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('↑↓ children · Enter details · Tab regions · Esc input')
    test.terminal.type(KEY.down)
    await test.settle()
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    // Down at the bar is the bottom of the stack.
    test.terminal.type(KEY.down)
    await test.settle()
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    test.terminal.type(KEY.up)
    await test.settle()
    expect(test.terminal.text()).toContain('↑↓ children · Enter details · Tab regions · Esc input')
    // Up on the panel's first row reaches the editor, and Shift+Up from there
    // comes back to the section the walk was left on.
    test.terminal.type(KEY.up)
    await test.settle()
    expect(await test.screen()).not.toContain('↑↓ children · Enter details · Tab regions · Esc input')
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 1 · bash · result')

    test.terminal.type(KEY.escape)
    await test.settle()
    prompt(test, 'back to typing')
    await test.settle()
    expect(test.calls.followups.map(message => message.content).at(-1)).toEqual([{ type: 'text', text: 'back to typing' }])
  })

  it('puts the caret back in the editor below the newest section, ready for the next character', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.down)
    await test.settle()
    for (const char of 'typed') test.terminal.type(char)
    await test.settle()
    expect(await test.screen()).not.toContain('3/3 · turn 1 · bash · result')
    prompt(test, ' here')
    await test.settle()
    expect(test.calls.followups.map(message => message.content).at(-1)).toEqual([{ type: 'text', text: 'typed here' }])
  })

  it('reaches the bar directly when no panel is drawn, and leaves it for the editor', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    // With no panel between them, the bar sits directly under the editor.
    test.terminal.type(KEY.up)
    await test.settle()
    expect(await test.screen()).not.toContain('←→ segments · Enter details · Tab regions · Esc input')
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 1 · bash · result')
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')
  })

  it('returns to the section the walk was left on, and to the newest after a session switch', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    for (let index = 0; index < 2; index += 1) test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('1/3 · turn 0 · you')
    test.terminal.type(KEY.escape)
    await test.settle()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    // The walk resumes where it stopped, not at the newest section again.
    expect(await test.screen()).toContain('1/3 · turn 0 · you')

    test.terminal.type(KEY.escape)
    prompt(test, '/new')
    await test.settle()
    prompt(test, 'a fresh prompt')
    prompt(test, 'and another')
    await test.settle()
    // The section the previous session was left on went with its blocks.
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('2/2 · turn 0 · you')
  })
})

describe('Esc and the running turn', () => {
  /**
   * A bench with a turn running, one prompt to read, one listed child, and one
   * todo, so every region and both kinds of prompt can take the keyboard.
   * @returns the running bench.
   */
  async function running(): Promise<Bench> {
    const test = await bench({
      running: true,
      subagents: () => Promise.resolve([CHILD]),
      projections: {
        snapshot: () => ({ asOfSeq: 1, values: { todos: [{ content: 'read the spec', status: 'pending' }] } }),
        onChanged: () => () => {},
      },
    })
    prompt(test, 'read the spec')
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    test.tick()
    await test.settle()
    return test
  }

  it('returns to the editor from every region without a second press reaching the turn', async () => {
    for (const enter of [[KEY.shiftUp], [KEY.shiftDown], [KEY.shiftDown, KEY.shiftDown]]) {
      const test = await running()
      for (const key of enter) test.terminal.type(key)
      await test.settle()
      test.terminal.type(KEY.escape)
      test.terminal.type(KEY.escape)
      await test.settle()
      expect(test.calls.cancels).toBe(0)
      expect(test.terminal.text()).not.toContain('press Esc again to stop turn')
      // Back at the input, where the next prompt is exactly what is typed.
      prompt(test, 'still typing')
      await test.settle()
      expect(test.calls.followups.map(message => message.content).at(-1)).toEqual([{ type: 'text', text: 'still typing' }])
    }
  })

  it('arms the handoff once, by the press that left the region, wherever it came from', async () => {
    // A fixed instant for the press that hands the keyboard back, so the
    // window is measured from it rather than from whatever the setup left on
    // the bench clock.
    const left = BENCH_NOW + 10_000
    for (const enter of [[KEY.shiftUp], [KEY.shiftDown], [KEY.shiftDown, KEY.shiftDown], [KEY.ctrlG, KEY.escape]]) {
      const test = await running()
      for (const key of enter) test.terminal.type(key)
      await test.settle()
      test.setNow(left)
      test.terminal.type(KEY.escape)
      // Presses that land in the editor inside the window do nothing at all,
      // and extend it by nothing either.
      test.setNow(left + ESCAPE_HANDOFF_MS - 1)
      test.terminal.type(KEY.escape)
      await test.settle()
      expect(test.calls.cancels).toBe(0)
      expect(test.terminal.text()).not.toContain('press Esc again to stop turn')
      test.setNow(left + ESCAPE_HANDOFF_MS)
      test.terminal.type(KEY.escape)
      await test.settle()
      expect(test.calls.cancels).toBe(0)
      expect(test.terminal.text()).toContain('press Esc again to stop turn')
      test.terminal.type(KEY.escape)
      expect(test.calls.cancels).toBe(1)
    }
  })

  it('keeps the turn alive when Esc closed a picker or a details page', async () => {
    const test = await running()
    typeLine(test.terminal, '/todos')
    await test.settle()
    expect(test.terminal.text()).toContain('read the spec')
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.calls.cancels).toBe(0)

    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain(' ● READER ')
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.calls.cancels).toBe(0)
  })

  it('types a printable key back into the editor from the panel and from the bar', async () => {
    const test = await running()
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('↑↓ children · Enter details · Tab regions · Esc input')
    test.terminal.type('p')
    await test.settle()
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.down)
    await test.settle()
    expect(test.terminal.text()).toContain('←→ segments · Enter details · Tab regions · Esc input')
    test.terminal.type('b')
    await test.settle()
    prompt(test, 'ar')
    await test.settle()
    expect(test.calls.followups.map(message => message.content).at(-1)).toEqual([{ type: 'text', text: 'pbar' }])
  })
})

describe('the in-place gutter inside the repaint window', () => {
  it('marks a block the renderer can still reach, says so when it cannot, and never clears the scrollback', async () => {
    const test = await bench()
    test.terminal.rows = 14
    for (let index = 0; index < 8; index += 1) prompt(test, `prompt number ${String(index)}`)
    await test.settle()
    const before = test.terminal.written.length

    // The newest block sits at the bottom of the frame, well inside the window.
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(test.terminal.text()).toContain('┃ › prompt number 7')
    expect(test.terminal.text()).not.toContain('off screen')

    // The oldest block is above the last `rows` lines, so it cannot be marked.
    for (let index = 0; index < 7; index += 1) test.terminal.type(KEY.up)
    await test.settle()
    expect(test.terminal.text()).toContain('1/8 · turn 0 · you · off screen')
    expect(test.terminal.text()).not.toContain('┃ › prompt number 0')

    // A marked block loses the mark in the frame that pushes it out of reach.
    test.terminal.type(KEY.escape)
    prompt(test, 'one more prompt')
    await test.settle()
    // Shift+Up resumes on the oldest block, where this walk stopped; End
    // brings the focus back to the newest one in one press.
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.end)
    await test.settle()
    expect(test.terminal.text()).toContain('┃ › one more prompt')
    for (let index = 0; index < 6; index += 1) test.appendAssistant([{ type: 'text', text: `reply ${String(index)}` }])
    await test.settle()
    expect(test.terminal.text()).toContain('9/15 · turn 0 · you · off screen')

    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
  })
})

/** A reply whose page is far taller than one inspector preview row. */
const LONG_REPLY = Array.from({ length: 20 }, (_, index) => `- reply line ${String(index)}`).join('\n')

/**
 * A transcript taller than the terminal: ten prompts and one long reply, with
 * the focused block still inside the renderer's repaint window.
 * @param options - bench options, e.g. a subagent listing.
 * @returns the running bench.
 */
async function tallConversation(options: Parameters<typeof bench>[0] = {}): Promise<Bench> {
  const test = await bench({ focusPreviewLines: 1, ...options })
  test.terminal.rows = 36
  for (let index = 0; index < 10; index += 1) prompt(test, `prompt number ${String(index)}`)
  test.appendAssistant([{ type: 'text', text: LONG_REPLY }])
  await test.settle()
  return test
}

describe('the in-place gutter after the frame shrank', () => {
  it('keeps the mark across the reader, which costs the conversation no line', async () => {
    const test = await tallConversation()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(test.terminal.text()).toContain('┃ - reply line 0')
    const before = test.terminal.written.length

    test.terminal.type(KEY.enter)
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    // The reader composites into the viewport instead of growing the frame,
    // so the renderer's boundary is where it was and the block is still marked.
    // The written check comes first: `screen()` resizes, which redraws in full.
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
    expect(await test.screen()).toContain('┃ - reply line 0')
  })

  it('marks the block again when Esc unmounted the inspector and Shift+Up brings it back', async () => {
    const test = await tallConversation()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    const before = test.terminal.written.length

    test.terminal.type(KEY.escape)
    await test.settle()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(test.terminal.text()).toContain('┃ - reply line 0')
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
  })

  it('walks on without clearing the scrollback when the turn ends and the spinner leaves', async () => {
    const test = await tallConversation({ running: true })
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    const before = test.terminal.written.length

    test.setStatus('idle')
    await test.settle()
    for (let index = 0; index < 8; index += 1) test.terminal.type(KEY.up)
    await test.settle()
    expect(test.terminal.text()).toContain('off screen')
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
  })

  it('walks on without clearing the scrollback when a panel row leaves', async () => {
    let listed: readonly SubagentDescendantListEntry[] = [CHILD]
    const test = await tallConversation({ subagents: () => Promise.resolve(listed) })
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    test.tick()
    await test.settle()
    expect(test.terminal.text()).toContain('subagents · 1 listed')
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    const before = test.terminal.written.length

    listed = []
    test.tick()
    await test.settle()
    test.terminal.type(KEY.up)
    await test.settle()
    expect(test.terminal.text()).toContain('10/11 · turn 0 · you')
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
  })
})

describe('the framed inspector', () => {
  /** A system prompt far longer than any preview budget. */
  const LONG_PROMPT = Array.from({ length: 20 }, (_, index) => `rule ${String(index)}`).join('\n')

  it('folds a long system prompt and takes the frame down with the mode', async () => {
    const history = [
      { type: 'system/message', seq: 0, time: 1, data: { turn: 0, step: 1, message: createSystemMessage(LONG_PROMPT, 'system-prompt') } },
    ] as never[]
    const test = await bench({ history, focusPreviewLines: 3, contextPreviewLines: 4 })
    test.terminal.rows = 20
    await test.settle()
    // The conversation draws the head of the injection and names the key that
    // opens the rest; the walk still reads every model-facing row.
    expect(test.terminal.text()).toContain('rule 3')
    expect(test.terminal.text()).not.toContain('rule 19')
    expect(test.terminal.text()).toContain('… 16 more rows · Ctrl+O expands')
    const before = test.terminal.written.length

    test.terminal.type(KEY.shiftUp)
    await test.settle()
    const drawn = test.terminal.text()
    expect(drawn).toContain(' ● READ ')
    expect(drawn).toContain('1/1 · turn 0 · system prompt')
    expect(drawn).toMatch(/… \d+ more rows · Ctrl\+G reads it/u)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
    // No mode, no frame.
    expect(await test.screen()).not.toContain(' ● READ ')
  })
})

describe('folding the block the focus holds', () => {
  /** A system prompt far longer than any fold budget. */
  const LONG_PROMPT = Array.from({ length: 20 }, (_, index) => `rule ${String(index)}`).join('\n')

  /**
   * A bench whose oldest block is one long folded injection.
   * @param options - bench options, e.g. the fold budget or the terminal height.
   * @returns the running bench.
   */
  async function injected(options: Parameters<typeof bench>[0] = {}): Promise<Bench> {
    const history = [
      { type: 'system/message', seq: 0, time: 1, data: { turn: 0, step: 1, message: createSystemMessage(LONG_PROMPT, 'system-prompt') } },
    ] as never[]
    return bench({ history, focusPreviewLines: 2, contextPreviewLines: 4, ...options })
  }

  it('turns the held block in place with Space and never clears the scrollback', async () => {
    const test = await injected()
    await test.settle()
    const before = test.terminal.written.length

    test.terminal.type(KEY.shiftUp)
    await test.settle()
    // The block holds the focus, so its marker names the key that opens it.
    expect(test.terminal.text()).toContain('… 16 more rows · Space expands')

    test.terminal.type(KEY.space)
    await test.settle()
    expect(test.terminal.text()).toContain('rule 19')

    test.terminal.type(KEY.space)
    await test.settle()
    // Both presses rewrote the block where it stands, inside the window.
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
    const folded = await test.screen()
    expect(folded).not.toContain('rule 19')
    expect(folded).toContain('… 16 more rows · Space expands')
  })

  it('keeps what one block draws across a trip through the input', async () => {
    const test = await injected()
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.space)
    await test.settle()
    expect(await test.screen()).toContain('rule 19')
    test.terminal.type(KEY.escape)
    await test.settle()
    // The block owns its own state: leaving the conversation does not fold it.
    expect(await test.screen()).toContain('rule 19')
  })

  it('opens a block above the repaint window in the reader instead of rewriting it', async () => {
    const test = await injected({ contextPreviewLines: 2, toastMs: 5000 })
    test.terminal.rows = 14
    for (let index = 0; index < 8; index += 1) prompt(test, `prompt number ${String(index)}`)
    await test.settle()
    const before = test.terminal.written.length

    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.home)
    await test.settle()
    expect(test.terminal.text()).toContain('1/9 · turn 0 · system prompt · off screen')

    test.terminal.type(KEY.space)
    await test.settle()
    expect(test.terminal.text()).toContain('above the repaint window · opened in the reader')
    // The reader reaches rows the folded block above the window never drew.
    expect(test.terminal.text()).toContain('rule 9')
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
    test.terminal.type(KEY.escape)
    await test.settle()
    // The conversation itself kept what it draws.
    expect(await test.screen()).not.toContain('rule 9')
  })

  it('draws the folded block on a terminal too narrow for its marker', async () => {
    const test = await injected()
    await test.settle()
    test.terminal.resize(30)
    await test.settle()
    // pi-tui stops the terminal and throws on a line wider than the screen, so
    // the marker the gutter shifts must wrap rather than run over the edge.
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.space)
    test.terminal.type(KEY.space)
    await test.settle()
    // The marker wrapped, so no row ran over the edge.
    expect(test.terminal.text()).toContain('│   … 16 more rows · Space')
    expect(test.terminal.text()).toContain('│   expands')
  })

  it('consumes Space on a block that does not fold', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.home)
    await test.settle()
    expect(await test.screen()).toContain('1/3 · turn 0 · you')
    test.terminal.type(KEY.space)
    await test.settle()
    const after = await test.screen()
    // The prompt is one section with nothing to fold, and the key never
    // reaches the input: no space is typed there.
    expect(after).toContain('1/3 · turn 0 · you')
    expect(after).not.toContain('above the repaint window')
    prompt(test, 'back to typing')
    await test.settle()
    expect(test.calls.followups.map(message => message.content).at(-1)).toEqual([{ type: 'text', text: 'back to typing' }])
  })
})

describe('the coarse walk and the scrollback', () => {
  it('jumps blocks, turns, ends, and regions on a tall transcript without clearing the scrollback', async () => {
    const test = await tallConversation({ subagents: () => Promise.resolve([CHILD]) })
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    test.tick()
    await test.settle()
    expect(test.terminal.text()).toContain('subagents · 1 listed')
    const before = test.terminal.written.length

    test.terminal.type(KEY.shiftUp)
    await test.settle()
    for (const walk of [
      KEY.home, KEY.pageDown, KEY.pageUp, KEY.end,
      KEY.shiftUp, KEY.shiftDown, KEY.shiftLeft, KEY.shiftRight,
      KEY.tab, KEY.tab, KEY.tab, KEY.shiftTab,
      KEY.up, KEY.down, KEY.escape,
    ]) {
      test.terminal.type(walk)
      await test.settle()
    }
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
  })
})

describe('the reader and the scrollback', () => {
  /** Every key the reader answers, in one walk through its turn list, its query line, and the turn beside them. */
  const READER_WALK = [
    KEY.left, KEY.up, KEY.down, KEY.home, KEY.end, KEY.pageUp, KEY.pageDown,
    KEY.slash, 'r', 'e', KEY.backspace, KEY.ctrlU, 'a', KEY.escape, KEY.escape,
    KEY.enter, KEY.down, KEY.up, KEY.pageDown, KEY.pageUp, KEY.home, KEY.end,
    KEY.tab, KEY.shiftTab, KEY.right,
  ]

  it('opens, walks, and closes over a short transcript without clearing the scrollback', async () => {
    const test = await conversation()
    const before = test.terminal.written.length
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    for (const key of READER_WALK) test.terminal.type(key)
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    // No `screen()` inside the measured walk: a resize redraws in full.
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
    expect(await test.screen()).not.toContain(' ● READER ')
  })

  it('opens, walks, and closes over a transcript far taller than the terminal', async () => {
    const test = await tallConversation()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    const before = test.terminal.written.length
    test.terminal.type(KEY.enter)
    await test.settle()
    for (const key of READER_WALK) test.terminal.type(key)
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
  })

  it('opens after the frame shrank, where the renderer can no longer repaint the viewport top', async () => {
    const test = await tallConversation()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    // Esc unmounts the inspector, so the frame shrinks and the top of the
    // viewport falls out of the renderer's reach.
    test.terminal.type(KEY.escape)
    await test.settle()
    const before = test.terminal.written.length
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    for (const key of READER_WALK) test.terminal.type(key)
    await test.settle()
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
    // The reader drew, and the conversation is back afterwards.
    expect(test.terminal.text()).toContain(' ● READER ')
    expect(await test.screen()).not.toContain(' ● READER ')
  })

  it('covers the whole viewport after the frame shrank under it', async () => {
    const test = await tallConversation()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    // Esc unmounts the inspector, so the frame shrinks and the top of the
    // viewport falls out of the renderer's own reach.
    test.terminal.type(KEY.escape)
    await test.settle()
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    // pi-tui composites an overlay into the frame's last `rows` lines, so a
    // reader that covers the terminal owns every one of them: the blank rows
    // the frame gained put the viewport's top back within reach.
    const viewport = (await test.screen()).split('\n').slice(-test.terminal.rows)
    expect(viewport[0]).toContain(' ● READER ')
    expect(viewport.at(-1)).toContain('╰')
  })

  it('steps aside for a seam the agent is blocked on and comes back over the same conversation', async () => {
    const test = await tallConversation()
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.enter)
    await test.settle()
    const before = test.terminal.written.length

    const asked = test.ctx.waterfall(
      'approval/request',
      { agent: test.agent, toolName: 'bash', reason: 'writes outside the workspace' },
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    await test.settle()
    // The prompt is never buried: the reader gave the screen up for it.
    expect(test.terminal.written.slice(before)).toContain('Allow bash?')
    const answered = test.terminal.written.length
    test.terminal.type(KEY.enter)
    await expect(asked).resolves.toBe('allowed-once')
    await test.settle()
    // The seam is settled, so the reader has the screen and the keyboard back.
    expect(test.terminal.written.slice(answered)).toContain(' ● READER ')
    test.terminal.type(KEY.escape)
    await test.settle()
    // Stepping aside and back is two overlay transitions over a transcript far
    // taller than the terminal, and neither rewrites a line above the window.
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
    expect(await test.screen()).toContain(' ● READ ')
  })
})

describe('the floating line and the scrollback', () => {
  it('opens and closes over a short transcript without clearing the scrollback', async () => {
    const test = await bench({ toastMs: 900 })
    await test.settle()
    const before = test.terminal.written.length
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.terminal.text()).toContain('press Ctrl+C again to quit')
    // The short frame the overlay padded to the terminal height shrinks again
    // when the line comes down.
    test.runTick(FADE_TICK_MS, 900)
    await test.settle()
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
  })

  it('prints into the conversation instead when the viewport top left the repaint window', async () => {
    const test = await tallConversation({ toastMs: 900 })
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    const before = test.terminal.written.length

    // Ctrl+C unmounts the inspector, and the shorter frame leaves the top of
    // the viewport above the renderer's boundary: the line cannot float there.
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.terminal.text()).toContain('press Ctrl+C again to quit')
    test.runTick(FADE_TICK_MS, 900)
    await test.settle()
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
    // The conversation took the line, which is why it is still drawn once a
    // floating one would have come down.
    expect(await test.screen()).toContain('press Ctrl+C again to quit')
  })

  it('walks the transcript with a line floating and never clears the scrollback', async () => {
    const test = await tallConversation({ toastMs: 5000 })
    const before = test.terminal.written.length
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.terminal.text()).toContain('press Ctrl+C again to quit')
    test.terminal.type(KEY.shiftUp)
    for (let index = 0; index < 8; index += 1) test.terminal.type(KEY.up)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
  })
})

describe('the chrome motions', () => {
  /**
   * One complete repaint at a fixed width, so two captures are comparable.
   * `Bench.screen` alternates the width, which would make every frame differ.
   * @param test - the running bench.
   * @returns the frame as the terminal received it, and with its escape
   * sequences stripped.
   */
  async function paint(test: Bench): Promise<{ raw: string; shown: string }> {
    test.terminal.resize(96)
    await test.settle()
    test.terminal.output = ''
    test.terminal.resize(100)
    await test.settle()
    return { raw: test.terminal.output, shown: test.terminal.text() }
  }

  /**
   * A conversation on a terminal that draws motion, with every card fade of
   * the replayed history already settled, so the next armed tick is the one a
   * key press starts.
   * @param options - bench options on top of the colored terminal.
   * @returns the running bench.
   */
  async function moving(options: Parameters<typeof bench>[0] = {}): Promise<Bench> {
    const test = await conversation({ color: true, ...options })
    test.runTick(FADE_TICK_MS, 5_000)
    await test.settle()
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
    return test
  }

  /** The peak of a lift: the one moment a piece of chrome is drawn bold. */
  const PEAK = '\u001b[1m\u001b[36m'

  /** How long a landing lasts on the bench's own fade period. */
  const LANDING_MS = LANDING_TICKS * FADE_TICK_MS

  /** Half of the reader's growth, where its legend is up and its title is not. */
  const HALF_OPEN_MS = (READER_OPEN_TICKS / 2) * FADE_TICK_MS

  it('lifts the inspector frame on the landing and settles it on the same lines', async () => {
    const test = await moving()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    // The landing arms the one fade tick and draws the frame above the accent
    // it settles at.
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)
    const landing = await paint(test)
    expect(landing.raw).toContain(`${PEAK}\u001b[36m╭`)
    expect(landing.shown).toContain(' ● READ ')

    test.runTick(FADE_TICK_MS, LANDING_MS)
    await test.settle()
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
    const settled = await paint(test)
    expect(settled.raw).not.toBe(landing.raw)
    expect(settled.raw).not.toContain(`${PEAK}\u001b[36m╭`)
    expect(settled.raw).toContain('\u001b[36m╭')
    // Nothing moves again on its own: the frame the motion settled on is the
    // frame ten minutes later draws.
    test.setNow(BENCH_NOW + 10 * 60_000)
    expect((await paint(test)).raw).toBe(settled.raw)
  })

  it('draws the same lines on every frame of a landing, whatever the level', async () => {
    const test = await moving()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    const frames = new Set<string>()
    for (let step = 0; step <= LANDING_TICKS; step += 1) {
      frames.add((await paint(test)).shown)
      test.runTick(FADE_TICK_MS)
      await test.settle()
    }
    // A motion changes what a line is drawn with, never how many lines the
    // docked chrome takes: every docked row raises the repaint boundary.
    expect(frames.size).toBe(1)
  })

  it('lifts the gutter of the section a step reaches, and only the gutter', async () => {
    const test = await moving()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    test.runTick(FADE_TICK_MS, LANDING_MS)
    await test.settle()
    test.terminal.type(KEY.up)
    await test.settle()
    const stepping = await paint(test)
    // The step lifts the mark where it landed, and the frame is settled
    // again: the walk went on from the landing that brought it here.
    expect(stepping.raw).toContain(`${PEAK}\u001b[36m┃ `)
    expect(stepping.raw).not.toContain(`${PEAK}\u001b[36m╭`)
    test.runTick(FADE_TICK_MS, STEP_TICKS * FADE_TICK_MS)
    await test.settle()
    const settled = await paint(test)
    expect(settled.raw).toContain('\u001b[36m┃ ')
    expect(settled.raw).not.toContain(`${PEAK}\u001b[36m┃ `)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('runs no motion and arms no tick at all under reduced motion', async () => {
    const test = await conversation({ color: true, reducedMotion: true })
    await test.settle()
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    // Read mode is drawn exactly as it settles, and a session that asked for
    // no motion arms no timer for one.
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
    const landed = await paint(test)
    expect(landed.shown).toContain(' ● READ ')
    expect(landed.raw).not.toContain(`${PEAK}\u001b[36m╭`)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.enter)
    await test.settle()
    // The reader opens whole rather than growing into place.
    expect((await paint(test)).shown).toContain(' ● READER ')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('grows the reader into place from its bottom rule and shrinks it away again', async () => {
    const test = await moving()
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    const growing = (await paint(test)).shown
    // The overlay is anchored at the bottom of the viewport, so the reveal
    // draws the rows it has where they will settle: the bottom rule is in
    // place first and the top rule arrives last.
    expect(growing).toContain('╰')
    expect(growing).not.toContain('↑↓ scrolls')
    expect(growing).not.toContain(' ● READER ')

    test.runTick(FADE_TICK_MS, HALF_OPEN_MS)
    await test.settle()
    const half = (await paint(test)).shown
    expect(half).toContain('↑↓ scrolls')
    expect(half).not.toContain(' ● READER ')

    test.runTick(FADE_TICK_MS, READER_OPEN_TICKS * FADE_TICK_MS)
    await test.settle()
    expect((await paint(test)).shown).toContain(' ● READER ')

    test.terminal.type(KEY.escape)
    await test.settle()
    test.runTick(FADE_TICK_MS)
    await test.settle()
    // The reader comes down from the top, and the keyboard is already back in
    // the conversation: nothing waits for the motion.
    const shrinking = (await paint(test)).shown
    expect(shrinking).not.toContain(' ● READER ')
    expect(shrinking).toContain('↑↓ scrolls')

    test.runTick(FADE_TICK_MS, READER_CLOSE_TICKS * FADE_TICK_MS)
    await test.settle()
    const back = (await paint(test)).shown
    expect(back).not.toContain('↑↓ scrolls')
    expect(back).toContain('3/3 · turn 1 · bash · result')
    // The conversation took the keyboard back, so its own landing is still
    // moving; once that settles too, nothing holds the tick.
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)
    test.runTick(FADE_TICK_MS, LANDING_MS)
    await test.settle()
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('walks, reads, and settles every motion on a tall transcript without clearing the scrollback', async () => {
    const test = await tallConversation({ color: true })
    test.runTick(FADE_TICK_MS, 5_000)
    await test.settle()
    const before = test.terminal.written.length

    /**
     * Let one motion run to its end, one period at a time.
     * @param ticks - the periods the motion lasts.
     */
    const run = async (ticks: number): Promise<void> => {
      for (let step = 0; step <= ticks; step += 1) {
        test.runTick(FADE_TICK_MS)
        await test.settle()
      }
    }
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    await run(LANDING_TICKS)
    for (const key of [KEY.up, KEY.up, KEY.left, KEY.pageUp, KEY.end]) {
      test.terminal.type(key)
      await test.settle()
      await run(STEP_TICKS)
    }
    test.terminal.type(KEY.enter)
    await test.settle()
    await run(READER_OPEN_TICKS)
    test.terminal.type(KEY.escape)
    await test.settle()
    await run(READER_CLOSE_TICKS)
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.right)
    await test.settle()
    await run(SEGMENT_TICKS)
    // Every frame of every reveal and every lift was written differentially.
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
  })

  it('takes a shrinking reader down at once when the keyboard moves again', async () => {
    const test = await moving()
    test.terminal.type(KEY.ctrlG)
    test.terminal.type(KEY.escape)
    await test.settle()
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    // pi-tui hands the key stream back to an overlay it still holds a focus
    // restore for, so a reader that is still shrinking goes when the focus
    // moves again.
    const moved = await paint(test)
    expect(moved.shown).toContain('←→ segments · Enter details')
    expect(moved.shown).not.toContain(' ● READER ')
  })

  it('types into the editor while the reader it just left is still shrinking', async () => {
    const test = await moving()
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    test.runTick(FADE_TICK_MS, READER_OPEN_TICKS * FADE_TICK_MS)
    await test.settle()
    // `Ctrl+G` hands the keyboard back to the editor and leaves the pane
    // shrinking; the first character takes the pane down and lands at the
    // caret rather than reaching the overlay pi-tui still holds a restore for.
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    for (const char of 'hello') test.terminal.type(char)
    await test.settle()
    const typed = await paint(test)
    expect(typed.shown).toContain('hello')
    expect(typed.shown).not.toContain(' ● READER ')
  })

  it('shrinks a reader away over a short conversation without clearing the scrollback', async () => {
    const test = await moving()
    const before = test.terminal.written.length
    test.terminal.type(KEY.ctrlG)
    await test.settle()
    for (let step = 0; step <= READER_OPEN_TICKS; step += 1) {
      test.runTick(FADE_TICK_MS)
      await test.settle()
    }
    test.terminal.type(KEY.escape)
    await test.settle()
    for (let step = 0; step <= READER_CLOSE_TICKS; step += 1) {
      test.runTick(FADE_TICK_MS)
      await test.settle()
    }
    // The frame the overlay padded to the terminal height shrinks back through
    // the renderer's deleted-lines path, on the reveal as on the way down.
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
    expect(await test.screen()).not.toContain(' ● READER ')
  })
})
