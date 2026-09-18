/** Walking the transcript from the keyboard: the regions, the inspector, the page, and the in-place gutter. */

import { describe, expect, it } from 'vitest'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { KEY, bench, type Bench } from './bench.ts'

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
    expect(screen).toContain('← 1 call · 2 result →')
    expect(screen).toContain('clean tree')
    expect(screen).toContain('↑ ↓ sections · ← → parts · Enter page · Esc back')
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

  it('keeps Shift+Up and Shift+Down walking the transcript instead of jumping', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.up)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 1 · bash · call')
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('2/3 · turn 1 · reply')
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    const back = await test.screen()
    expect(back).toContain('3/3 · turn 1 · bash · call')
    expect(back).toContain('↑ ↓ sections')
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

  it('opens the focused section as a page and comes back to it', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('↑ ↓ scroll · Enter, Esc, or ← returns')
    expect(test.terminal.text()).toContain('weighing it up')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(await test.screen()).toContain('2/3 · turn 1 · reasoning')
  })

  it('returns to the editor on Esc and on Ctrl+C, and keeps every other key to itself', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftUp)
    for (const char of 'zzz') test.terminal.type(char)
    test.terminal.type(KEY.ctrlO)
    test.terminal.type(KEY.tab)
    await test.settle()
    expect(test.calls.followups).toHaveLength(1)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(await test.screen()).not.toContain('↑ ↓ sections')
    prompt(test, 'back to typing')
    await test.settle()
    expect(test.calls.followups.map(message => message.content).at(-1)).toEqual([{ type: 'text', text: 'back to typing' }])

    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.terminal.text()).toContain('press Ctrl+C again to quit')
    expect(await test.screen()).not.toContain('↑ ↓ sections')
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
    expect(await test.screen()).toContain('← 1 sandbox · 2 git →')
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

  it('says so when the transcript has nothing to inspect yet', async () => {
    const test = await bench()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(test.terminal.text()).toContain('nothing in the transcript to inspect yet')
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
    expect(test.terminal.text()).toContain('nothing in the transcript to inspect yet')
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

describe('the region stack', () => {
  it('reaches the panel and then the bar below the newest block, and comes back up', async () => {
    const test = await conversation({ subagents: () => Promise.resolve([CHILD]) })
    const kid = await test.createChild({ id: 'session-kid' })
    kid.setStatus('running')
    test.tick()
    await test.settle()
    expect(test.terminal.text()).toContain('subagents · 1 listed')

    test.terminal.type(KEY.shiftUp)
    test.terminal.type(KEY.down)
    await test.settle()
    expect(test.terminal.text()).toContain('↑ ↓ select · Enter details · Esc back')
    test.terminal.type(KEY.down)
    await test.settle()
    expect(test.terminal.text()).toContain('← → select · ↑ ↓ regions · Enter details · Esc back')
    // Down at the bar is the bottom of the stack.
    test.terminal.type(KEY.down)
    await test.settle()
    expect(test.terminal.text()).toContain('← → select · ↑ ↓ regions · Enter details · Esc back')
    test.terminal.type(KEY.up)
    await test.settle()
    expect(test.terminal.text()).toContain('↑ ↓ select · Enter details · Esc back')
    test.terminal.type(KEY.up)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 1 · bash · result')

    // Shift+Up at the panel jumps to the conversation, and Esc leaves for the editor.
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 1 · bash · result')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.escape)
    await test.settle()
    prompt(test, 'back to typing')
    await test.settle()
    expect(test.calls.followups.map(message => message.content).at(-1)).toEqual([{ type: 'text', text: 'back to typing' }])
  })

  it('reaches the bar directly when no panel is drawn, from the editor and from the transcript', async () => {
    const test = await conversation()
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('← → select · ↑ ↓ regions · Enter details · Esc back')
    test.terminal.type(KEY.up)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 1 · bash · result')
    test.terminal.type(KEY.down)
    await test.settle()
    expect(test.terminal.text()).toContain('← → select · ↑ ↓ regions · Enter details · Esc back')
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('3/3 · turn 1 · bash · result')
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('← → select · ↑ ↓ regions · Enter details · Esc back')
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
    test.terminal.type(KEY.shiftUp)
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
  it('holds the window a page opened, so closing it leaves the block behind the window unmarked', async () => {
    const test = await tallConversation()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(test.terminal.text()).toContain('┃ - reply line 0')
    const before = test.terminal.written.length

    test.terminal.type(KEY.enter)
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    // The page moved the renderer's window past the block, and the shorter
    // frame the closed page leaves does not bring it back.
    expect(test.terminal.text()).toContain('· reply · off screen')
    expect(test.terminal.written.slice(before)).not.toContain(CLEAR_SCROLLBACK)
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
