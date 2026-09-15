/**
 * Modal prompts the agent raises through the approval and user-questions
 * seams, and the queue that shows them one at a time above the editor.
 * @module @deepseek-ai/dsh-tui-app/prompts
 */

import { Input, SelectList, Text, matchesKey, wrapTextWithAnsi, type Component, type SelectItem, type TUI } from '@earendil-works/pi-tui'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { selectListTheme, type Palette } from './style.ts'

/** Rows a select list shows before scrolling. */
const SELECT_MAX_VISIBLE = 8

/** A prompt that settles with a value once the user answers or the asker withdraws it. */
export interface ModalPrompt<T> extends Component {
  /** The user's answer, or the withdrawal value. */
  readonly settled: Promise<T>
  /** Withdraw the prompt when it is still open. */
  withdraw(): void
}

/** One settlement slot: the first value wins, later values are ignored. */
class Settlement<T> {
  readonly settled: Promise<T>
  private resolve!: (value: T) => void
  private open = true

  constructor() {
    this.settled = new Promise<T>((resolve) => { this.resolve = resolve })
  }

  /**
   * Settle with `value` unless already settled.
   * @param value - the outcome.
   */
  settle(value: T): void {
    if (!this.open) return
    this.open = false
    this.resolve(value)
  }
}

/** A heading over a select list; subclasses map the chosen row and the cancel key to a value. */
abstract class ListPrompt<T> implements ModalPrompt<T> {
  readonly settled: Promise<T>
  private readonly settlement = new Settlement<T>()
  private readonly heading: Text
  private readonly list: SelectList

  constructor(palette: Palette, heading: string, items: SelectItem[], choose: (item: SelectItem) => T, cancel: () => T) {
    this.settled = this.settlement.settled
    this.heading = new Text(heading, 0, 0)
    this.list = new SelectList(items, SELECT_MAX_VISIBLE, selectListTheme(palette))
    this.list.onSelect = (item) => { this.settlement.settle(choose(item)) }
    this.list.onCancel = () => { this.settlement.settle(cancel()) }
  }

  /**
   * Settle from outside the list, for withdrawal.
   * @param value - the outcome.
   */
  protected settle(value: T): void {
    this.settlement.settle(value)
  }

  abstract withdraw(): void

  handleInput(data: string): void {
    this.list.handleInput(data)
  }

  invalidate(): void {
    this.heading.invalidate()
    this.list.invalidate()
  }

  render(width: number): string[] {
    return ['', ...this.heading.render(width), ...this.list.render(width)]
  }
}

/** Approval question: allow this one tool call or reject it; Escape rejects. */
export class ApprovalPrompt extends ListPrompt<ApprovalOutcome> {
  constructor(palette: Palette, toolName: string, reason: string | undefined) {
    const title = `${palette.warning('?')} ${palette.bold(`Allow ${toolName}?`)}`
    super(
      palette,
      reason === undefined ? title : `${title}\n${palette.dim(reason)}`,
      [
        { value: 'allowed-once', label: 'Allow once', description: 'run this call' },
        { value: 'rejected', label: 'Reject', description: 'the tool call fails and the model is told' },
      ],
      item => item.value as ApprovalOutcome,
      () => 'rejected',
    )
  }

  withdraw(): void {
    this.settle('cancelled')
  }
}

/** A picker row. */
export interface PickItem {
  value: string
  label: string
  description?: string
}

/** A generic list picker (models, sessions); Escape settles undefined. */
export class PickPrompt extends ListPrompt<PickItem | undefined> {
  constructor(palette: Palette, title: string, items: readonly PickItem[]) {
    super(palette, `${palette.accent('?')} ${palette.bold(title)}`, [...items], item => item, () => undefined)
  }

  withdraw(): void {
    this.settle(undefined)
  }
}

/** The `ask_user_question` answer for one question, or null when withdrawn. */
export type QuestionResult = AskUserQuestionAnswerItem | null

/** Marker value of the free-text row. */
const CUSTOM_VALUE = '\u0000custom'
/** Marker value of the multi-select confirmation row. */
const DONE_VALUE = '\u0000done'

/**
 * One `ask_user_question` item: its options as a list, plus a free-text row.
 * Multi-select toggles with Space and confirms through the `Done` row; a
 * question with no options opens straight into free text, and Escape there
 * returns to the one-row list where a second Escape dismisses the question.
 */
export class QuestionPrompt implements ModalPrompt<QuestionResult> {
  readonly settled: Promise<QuestionResult>
  private readonly settlement = new Settlement<QuestionResult>()
  private readonly heading: Text
  private readonly list: SelectList
  private readonly input = new Input()
  private readonly selected = new Set<string>()
  private typing: boolean

  constructor(private readonly palette: Palette, private readonly question: AskUserQuestionItem) {
    this.settled = this.settlement.settled
    const header = question.header === undefined ? '' : `${palette.dim(question.header)}\n`
    const detail = question.detail === undefined ? '' : `\n${palette.dim(question.detail)}`
    this.heading = new Text(`${header}${palette.warning('?')} ${palette.bold(question.question)}${detail}`, 0, 0)
    const options = question.options ?? []
    this.typing = options.length === 0
    const items = options.map(option => ({
      value: option.label,
      label: option.label,
      ...option.description === undefined ? {} : { description: option.description },
    }))
    items.push({ value: CUSTOM_VALUE, label: 'Type an answer…' })
    if (question.multiSelect === true) items.push({ value: DONE_VALUE, label: 'Done', description: 'confirm the selection' })
    this.list = new SelectList(items, SELECT_MAX_VISIBLE, selectListTheme(palette))
    this.list.onSelect = (item) => { this.choose(item.value) }
    this.list.onCancel = () => { this.settlement.settle(null) }
    this.input.onSubmit = (value) => {
      const custom = value.trim()
      if (custom === '') return
      this.settlement.settle({ id: this.question.id, selected: [...this.selected], custom })
    }
    this.input.onEscape = () => { this.typing = false }
  }

  private choose(value: string): void {
    if (value === CUSTOM_VALUE) {
      this.typing = true
      return
    }
    if (value === DONE_VALUE) {
      this.settlement.settle({ id: this.question.id, selected: [...this.selected] })
      return
    }
    if (this.question.multiSelect === true) {
      if (this.selected.has(value)) this.selected.delete(value)
      else this.selected.add(value)
      return
    }
    this.settlement.settle({ id: this.question.id, selected: [value] })
  }

  withdraw(): void {
    this.settlement.settle(null)
  }

  handleInput(data: string): void {
    if (this.typing) {
      this.input.handleInput(data)
      return
    }
    // Space toggles the highlighted option of a multi-select without leaving the list.
    if (this.question.multiSelect === true && matchesKey(data, 'space')) {
      const item = this.list.getSelectedItem()
      /* v8 ignore next -- the unfiltered list always has a highlighted row */
      if (item !== null) this.choose(item.value)
      return
    }
    this.list.handleInput(data)
  }

  invalidate(): void {
    this.heading.invalidate()
    this.list.invalidate()
    this.input.invalidate()
  }

  render(width: number): string[] {
    const lines = ['', ...this.heading.render(width)]
    if (this.question.multiSelect === true && this.selected.size > 0) {
      lines.push(...wrapTextWithAnsi(this.palette.dim(`selected: ${[...this.selected].join(', ')}`), width))
    }
    if (this.typing) {
      this.input.focused = true
      lines.push(...this.input.render(width))
      lines.push(this.palette.dim('Enter answers · Esc back to the options'))
    } else {
      lines.push(...this.list.render(width))
      if (this.question.multiSelect === true) lines.push(this.palette.dim('Space toggles · Enter on Done confirms · Esc cancels'))
    }
    return lines
  }
}

/** Where prompts mount and who gets focus back. */
export interface ModalHost {
  tui: TUI
  /** The container between the transcript and the editor that prompts render in. */
  slot: { addChild(component: Component): void; removeChild(component: Component): void }
  /** The component that regains focus after the last prompt closes. */
  focusAfter: Component
}

/** Continuation of the queue chain after a turn settles either way. */
function settledTurn(): undefined {
  return undefined
}

/**
 * Serialize prompts: one is visible and focused at a time, later ones wait
 * their turn, and an abort signal withdraws a waiting or visible prompt.
 */
export class ModalQueue {
  private chain: Promise<unknown> = Promise.resolve()
  private active: ModalPrompt<unknown> | undefined

  constructor(private readonly host: ModalHost) {}

  /**
   * Whether a prompt currently owns the keyboard.
   * @returns true while a prompt is visible and focused.
   */
  isActive(): boolean {
    return this.active !== undefined
  }

  /**
   * Show `prompt` once earlier prompts have settled.
   * @param prompt - the prompt to show.
   * @param signal - withdraws the prompt when aborted.
   * @returns the prompt's settled value.
   */
  run<T>(prompt: ModalPrompt<T>, signal?: AbortSignal): Promise<T> {
    const onAbort = (): void => { prompt.withdraw() }
    signal?.addEventListener('abort', onAbort, { once: true })
    const turn = this.chain.then(async () => {
      if (signal?.aborted === true) prompt.withdraw()
      this.active = prompt
      this.host.slot.addChild(prompt)
      this.host.tui.setFocus(prompt)
      this.host.tui.requestRender()
      try {
        return await prompt.settled
      } finally {
        signal?.removeEventListener('abort', onAbort)
        this.host.slot.removeChild(prompt)
        this.active = undefined
        this.host.tui.setFocus(this.host.focusAfter)
        this.host.tui.requestRender()
      }
    })
    this.chain = turn.then(settledTurn, settledTurn)
    return turn
  }

  /** Withdraw the visible prompt, if any. */
  withdrawActive(): void {
    this.active?.withdraw()
  }
}
