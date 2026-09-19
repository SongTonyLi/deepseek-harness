/**
 * Modal prompts the terminal shows above the editor — the approval and
 * user-questions seams, list pickers, and read-only detail pages — and the
 * queue that shows them one at a time.
 * @module @deepseek-ai/dsh-tui-app/prompts
 */

import { Input, Markdown, SelectList, Text, fuzzyFilter, matchesKey, wrapTextWithAnsi, type Component, type SelectItem, type SelectListLayoutOptions, type TUI } from '@earendil-works/pi-tui'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { planReviewOptions, type AskUserQuestionAnswerItem, type AskUserQuestionItem, type AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions'
import { typedText } from './keys.ts'
import { markdownTheme, selectListTheme, type Palette } from './style.ts'
import { foldRows } from './transcript.ts'

/** Rows a select list shows before scrolling. */
const SELECT_MAX_VISIBLE = 8
/** Call-detail rows an approval shows before folding the rest into a count. */
const APPROVAL_DETAIL_MAX_ROWS = 12

/**
 * The trailing row an approval's folded call detail carries.
 * @param hidden - rows left out.
 * @returns the marker row.
 */
function approvalFoldMarker(hidden: number): string {
  return `… ${String(hidden)} more line${hidden === 1 ? '' : 's'}`
}

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

/**
 * A heading, optional dim indented body rows, then a select list; subclasses
 * map the chosen row and the cancel key to a value.
 */
abstract class ListPrompt<T> implements ModalPrompt<T> {
  readonly settled: Promise<T>
  private readonly settlement = new Settlement<T>()
  private readonly heading: Text
  private list: SelectList

  constructor(
    protected readonly palette: Palette,
    heading: string,
    private readonly body: readonly string[],
    items: SelectItem[],
    private readonly choose: (item: SelectItem) => T,
    private readonly cancel: () => T,
    private readonly layout?: SelectListLayoutOptions,
  ) {
    this.settled = this.settlement.settled
    this.heading = new Text(heading, 0, 0)
    this.list = this.listOver(items)
  }

  /**
   * A select list over `items` wired to this prompt's settlement. `SelectList`
   * takes its rows at construction and exposes no way to replace them, so a
   * different row set means a different list.
   * @param items - the rows to show.
   * @returns the list, highlighting its first row.
   */
  private listOver(items: SelectItem[]): SelectList {
    const list = new SelectList(items, SELECT_MAX_VISIBLE, selectListTheme(this.palette), this.layout)
    list.onSelect = (item) => { this.settlement.settle(this.choose(item)) }
    list.onCancel = () => { this.settlement.settle(this.cancel()) }
    return list
  }

  /**
   * Show `items` instead of the current rows, highlighting the first one.
   * @param items - the rows to show.
   */
  protected setRows(items: SelectItem[]): void {
    this.list = this.listOver(items)
  }

  /**
   * Settle from outside the list, for withdrawal.
   * @param value - the outcome.
   */
  protected settle(value: T): void {
    this.settlement.settle(value)
  }

  /**
   * Open the list on one row instead of the first.
   * @param index - the row to highlight.
   */
  protected highlight(index: number): void {
    this.list.setSelectedIndex(index)
  }

  /**
   * The row the highlight sits on.
   * @returns that row, or null while the list shows no row.
   */
  protected selected(): SelectItem | null {
    return this.list.getSelectedItem()
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
    const inner = Math.max(1, width - 2)
    const body = this.body.flatMap(line => wrapTextWithAnsi(this.palette.dim(line), inner).map(part => `  ${part}`))
    return ['', ...this.heading.render(width), ...body, ...this.listLines(width)]
  }

  /**
   * The lines under the body rows: the select list, which a subclass may
   * precede or replace.
   * @param width - the terminal width.
   * @returns the rendered lines.
   */
  protected listLines(width: number): string[] {
    return this.list.render(width)
  }
}

/**
 * Approval question: allow this one tool call or reject it; Escape rejects.
 * `detail` is the call's pre-rendered rows, the same text the tool card
 * shows, drawn dim under the heading and folded past {@link APPROVAL_DETAIL_MAX_ROWS}.
 */
export class ApprovalPrompt extends ListPrompt<ApprovalOutcome> {
  constructor(palette: Palette, toolName: string, reason: string | undefined, detail: readonly string[] = []) {
    const title = `${palette.warning('?')} ${palette.bold(`Allow ${toolName}?`)}`
    super(
      palette,
      reason === undefined ? title : `${title}\n${palette.dim(reason)}`,
      foldRows(detail, APPROVAL_DETAIL_MAX_ROWS, approvalFoldMarker),
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

/** What a picker shows beyond its rows. */
export interface PickOptions {
  /** Dim rows drawn between the heading and the list. */
  body?: readonly string[]
  /** The row value in force: the list opens on that row and marks it. */
  current?: string
  /**
   * How each row splits its width between the label and the description; the
   * list's own defaults when absent, which cut a label past 30 columns to keep
   * the description column aligned.
   */
  layout?: SelectListLayoutOptions
  /**
   * Answer `Ctrl+S` with the highlighted row while the picker stays open;
   * absent, the key does nothing here.
   * @param item - the highlighted row.
   */
  onSave?: (item: PickItem) => void
}

/** Marks the row a picker opened on, so it stays visible after the highlight moves. */
const CURRENT_MARK = ' ✓'

/** What the filter line says while the query is empty. */
const FILTER_HINT = 'type to filter · Enter selects · Esc cancels'

/**
 * The text a picker row is matched against.
 * @param row - the row.
 * @returns the label and description joined, so one query can span both.
 */
function rowText(row: SelectItem): string {
  return row.description === undefined ? row.label : `${row.label} ${row.description}`
}

/**
 * A generic list picker (models, sessions) with a type-to-filter query.
 * Printable keys extend the query, Backspace drops its last character, and
 * Ctrl+U clears it; Escape clears a non-empty query and settles undefined
 * once the query is empty. The visible rows are the query's fuzzy matches
 * against each row's label and description, best match first; the row in
 * force keeps its mark and stays highlighted only while the query is empty.
 * `Ctrl+S` hands the highlighted row to `onSave` without closing the picker.
 */
export class PickPrompt extends ListPrompt<PickItem | undefined> {
  /** Every row in declared order, without the mark, as matched against. */
  private readonly rows: readonly SelectItem[]
  /** The same rows with the in-force one marked, shown while the query is empty. */
  private readonly markedRows: readonly SelectItem[]
  /** Index of the row in force, or -1 when no row is. */
  private readonly inForce: number
  /** What the user has typed, empty until the first printable key. */
  private query = ''
  /** The rows the list shows: all of them, or the query's matches. */
  private visible: readonly SelectItem[]
  /** What `Ctrl+S` does with the highlighted row, when the caller gave it a meaning. */
  private readonly onSave: ((item: PickItem) => void) | undefined

  constructor(palette: Palette, title: string, private readonly items: readonly PickItem[], options: PickOptions = {}) {
    const rows = items.map((item): SelectItem => ({ ...item }))
    const inForce = items.findIndex(item => item.value === options.current)
    const markedRows = rows.map((row, index) => index === inForce ? { ...row, label: `${row.label}${CURRENT_MARK}` } : row)
    super(
      palette,
      `${palette.accent('?')} ${palette.bold(title)}`,
      options.body ?? [],
      [...markedRows],
      row => items.find(item => item.value === row.value),
      () => undefined,
      options.layout,
    )
    this.rows = rows
    this.markedRows = markedRows
    this.inForce = inForce
    this.visible = markedRows
    this.onSave = options.onSave
    if (inForce > 0) this.highlight(inForce)
  }

  /**
   * Apply `query` and rebuild the visible rows from it.
   * @param query - the new query; an empty one restores the declared order, the mark, and the row in force.
   */
  private setQuery(query: string): void {
    if (query === this.query) return
    this.query = query
    this.visible = query === '' ? this.markedRows : fuzzyFilter([...this.rows], query, rowText)
    this.setRows([...this.visible])
    if (query === '' && this.inForce > 0) this.highlight(this.inForce)
  }

  withdraw(): void {
    this.settle(undefined)
  }

  override handleInput(data: string): void {
    if (matchesKey(data, 'escape') && this.query !== '') {
      this.setQuery('')
      return
    }
    if (matchesKey(data, 'backspace')) {
      this.setQuery(this.query.slice(0, -1))
      return
    }
    if (matchesKey(data, 'ctrl+u')) {
      this.setQuery('')
      return
    }
    if (matchesKey(data, 'ctrl+s')) {
      const row = this.selected()
      const item = row === null ? undefined : this.items.find(candidate => candidate.value === row.value)
      if (item !== undefined) this.onSave?.(item)
      return
    }
    const typed = typedText(data)
    if (typed === undefined) {
      super.handleInput(data)
      return
    }
    this.setQuery(this.query + typed)
  }

  protected override listLines(width: number): string[] {
    const filter = this.query === ''
      ? FILTER_HINT
      : `filter: ${this.query} · ${String(this.visible.length)}/${String(this.rows.length)}`
    const shown = this.query !== '' && this.visible.length === 0
      ? [this.palette.dim(`  no row matches "${this.query}"`)]
      : super.listLines(width)
    return [this.palette.dim(filter), ...shown]
  }
}

/** Detail rows a read-only page draws at once; the rest wait behind a scroll. */
const DETAIL_MAX_VISIBLE = 16

/** The keys a read-only detail page answers, drawn dim under its rows. */
const DETAIL_HINT = '↑ ↓ scroll · Enter, Esc, or ← returns'

/**
 * A read-only page over rows the caller already rendered: an accented
 * heading, the rows wrapped to the terminal width, and the hint line. `Up`
 * and `Down` move one row, `PageUp` and `PageDown` a full page, and the hint
 * line carries the first visible row and the total once the rows pass
 * {@link DETAIL_MAX_VISIBLE}. `Enter`, `Escape`, and `Left` settle it; every
 * other key is ignored.
 */
export class DetailPrompt implements ModalPrompt<void> {
  readonly settled: Promise<void>
  private readonly settlement = new Settlement<void>()
  private readonly heading: Text
  /** Index of the first visible wrapped row. */
  private offset = 0
  /** Wrapped rows the last render produced, which bounds scrolling; 0 before the first render. */
  private total = 0

  constructor(private readonly palette: Palette, heading: string, private readonly rows: readonly string[]) {
    this.settled = this.settlement.settled
    this.heading = new Text(palette.bold(palette.accent(heading)), 0, 0)
  }

  /**
   * The largest first-visible row index; 0 while every row fits at once.
   * @returns the index scrolling stops at.
   */
  private maxOffset(): number {
    return Math.max(0, this.total - DETAIL_MAX_VISIBLE)
  }

  /**
   * Move the visible window, stopping at both ends.
   * @param step - rows to move by; negative scrolls toward the first row.
   */
  private scroll(step: number): void {
    this.offset = Math.max(0, Math.min(this.offset + step, this.maxOffset()))
  }

  withdraw(): void {
    this.settlement.settle()
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'up')) this.scroll(-1)
    else if (matchesKey(data, 'down')) this.scroll(1)
    else if (matchesKey(data, 'pageUp')) this.scroll(-DETAIL_MAX_VISIBLE)
    else if (matchesKey(data, 'pageDown')) this.scroll(DETAIL_MAX_VISIBLE)
    else if (matchesKey(data, 'enter') || matchesKey(data, 'escape') || matchesKey(data, 'left')) this.settlement.settle()
  }

  invalidate(): void {
    this.heading.invalidate()
  }

  render(width: number): string[] {
    const wrapped = this.rows.flatMap(row => wrapTextWithAnsi(row, Math.max(1, width)))
    this.total = wrapped.length
    // A wider terminal wraps fewer rows, which can leave the offset past the end.
    this.offset = Math.min(this.offset, this.maxOffset())
    const position = this.maxOffset() === 0 ? '' : ` · (${String(this.offset + 1)}/${String(this.total)})`
    return [
      '',
      ...this.heading.render(width),
      ...wrapped.slice(this.offset, this.offset + DETAIL_MAX_VISIBLE),
      this.palette.dim(`${DETAIL_HINT}${position}`),
    ]
  }
}

/** The `ask_user_question` answer for one question, or null when withdrawn. */
export type QuestionResult = AskUserQuestionAnswerItem | null

/** Marker value of the free-text row. */
const CUSTOM_VALUE = '\u0000custom'
/** Marker value of the multi-select confirmation row. */
const DONE_VALUE = '\u0000done'
/** Marker value of the plan-review row that returns the user to the composer. */
const DISCUSS_VALUE = '\u0000discuss'

/**
 * A plan-review row: the fixed verdict label, with the asker's option text as
 * the description so the user sees what the answer carries.
 * @param label - the row label.
 * @param option - the asker's option the row answers with.
 * @returns the row.
 */
function verdictRow(label: string, option: AskUserQuestionOption): SelectItem {
  const description = option.description ?? (option.label === label ? undefined : option.label)
  return { value: option.label, label, ...description === undefined ? {} : { description } }
}

/**
 * One `ask_user_question` item: its options as a list, plus a free-text row,
 * with `detail` rendered as Markdown under the question. Multi-select toggles
 * with Space and confirms through the `Done` row; a question with no options
 * opens straight into free text, and Escape there returns to the one-row list
 * where a second Escape dismisses the question. A plan-review question shows
 * the plan and offers Approve, Decline (when the asker offered a second
 * option), and Discuss; the verdicts answer with the asker's option label and
 * Discuss dismisses the question so the user can reply in the composer.
 */
export class QuestionPrompt implements ModalPrompt<QuestionResult> {
  readonly settled: Promise<QuestionResult>
  private readonly settlement = new Settlement<QuestionResult>()
  private readonly heading: Text
  private readonly detail: Markdown | undefined
  private readonly list: SelectList
  private readonly input = new Input()
  private readonly selected = new Set<string>()
  private typing: boolean

  constructor(private readonly palette: Palette, private readonly question: AskUserQuestionItem) {
    this.settled = this.settlement.settled
    const header = question.header === undefined ? '' : `${palette.dim(question.header)}\n`
    this.heading = new Text(`${header}${palette.warning('?')} ${palette.bold(question.question)}`, 0, 0)
    this.detail = question.detail === undefined ? undefined : new Markdown(question.detail, 0, 0, markdownTheme(palette))
    const options = question.options ?? []
    this.typing = options.length === 0
    const review = planReviewOptions(question)
    const items: SelectItem[] = []
    if (review === undefined) {
      for (const { label, description } of options) {
        items.push({ value: label, label, ...description === undefined ? {} : { description } })
      }
      items.push({ value: CUSTOM_VALUE, label: 'Type an answer…' })
      if (question.multiSelect === true) items.push({ value: DONE_VALUE, label: 'Done', description: 'confirm the selection' })
    } else {
      items.push(verdictRow('Approve', review.approve))
      if (review.decline !== undefined) items.push(verdictRow('Decline', review.decline))
      items.push({ value: DISCUSS_VALUE, label: 'Discuss', description: 'reply in the composer instead' })
    }
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
    if (value === DISCUSS_VALUE) {
      this.settlement.settle(null)
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
    this.detail?.invalidate()
    this.list.invalidate()
    this.input.invalidate()
  }

  render(width: number): string[] {
    const lines = ['', ...this.heading.render(width)]
    if (this.detail !== undefined) lines.push('', ...this.detail.render(width), '')
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
