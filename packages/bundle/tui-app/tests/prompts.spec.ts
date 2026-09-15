/** Modal prompts settle once, and the queue shows one at a time. */

import { describe, expect, it } from 'vitest'
import { Container, type TUI } from '@earendil-works/pi-tui'
import { ApprovalPrompt, ModalQueue, PickPrompt, QuestionPrompt } from '../src/prompts.ts'
import { createPalette } from '../src/style.ts'
import { KEY } from './bench.ts'

const palette = createPalette(false)

describe('prompts', () => {
  it('settles an approval once and ignores later answers', async () => {
    const prompt = new ApprovalPrompt(palette, 'bash', undefined)
    expect(prompt.render(40).join('\n')).toContain('Allow bash?')
    prompt.handleInput(KEY.enter)
    await expect(prompt.settled).resolves.toBe('allowed-once')
    prompt.withdraw()
    prompt.handleInput(KEY.down)
    prompt.handleInput(KEY.enter)
    prompt.invalidate()
    await expect(prompt.settled).resolves.toBe('allowed-once')
  })

  it('settles a question once', async () => {
    const prompt = new QuestionPrompt(palette, { id: 'q', question: 'Pick', options: [{ label: 'a' }] })
    prompt.handleInput(KEY.enter)
    await expect(prompt.settled).resolves.toEqual({ id: 'q', selected: ['a'] })
    prompt.withdraw()
    prompt.invalidate()
    await expect(prompt.settled).resolves.toEqual({ id: 'q', selected: ['a'] })
  })

  it('settles a pick once', async () => {
    const prompt = new PickPrompt(palette, 'Model', [{ value: 'p/m', label: 'p/m', description: 'big' }])
    expect(prompt.render(40).join('\n')).toContain('p/m')
    prompt.handleInput(KEY.enter)
    await expect(prompt.settled).resolves.toEqual({ value: 'p/m', label: 'p/m', description: 'big' })
    prompt.withdraw()
    prompt.invalidate()
    const cancelled = new PickPrompt(palette, 'Model', [])
    cancelled.handleInput(KEY.escape)
    await expect(cancelled.settled).resolves.toBeUndefined()
  })

  it('shows queued prompts in order and restores focus afterwards', async () => {
    const focused: unknown[] = []
    const renders: number[] = []
    const slot = new Container()
    const editor = new Container()
    const tui = {
      setFocus: (component: unknown) => { focused.push(component) },
      requestRender: () => { renders.push(1) },
    } as unknown as TUI
    const queue = new ModalQueue({ tui, slot, focusAfter: editor })
    expect(queue.isActive()).toBe(false)
    const first = new ApprovalPrompt(palette, 'a', undefined)
    const second = new ApprovalPrompt(palette, 'b', undefined)
    const firstDone = queue.run(first)
    const secondDone = queue.run(second)
    await Promise.resolve()
    expect(queue.isActive()).toBe(true)
    expect(slot.children).toEqual([first])
    expect(focused).toEqual([first])
    queue.withdrawActive()
    await expect(firstDone).resolves.toBe('cancelled')
    await Promise.resolve()
    await Promise.resolve()
    expect(slot.children).toEqual([second])
    expect(focused).toEqual([first, editor, second])
    second.handleInput(KEY.enter)
    await expect(secondDone).resolves.toBe('allowed-once')
    expect(slot.children).toEqual([])
    expect(queue.isActive()).toBe(false)
    queue.withdrawActive()
    expect(renders.length).toBeGreaterThan(0)
  })
})
