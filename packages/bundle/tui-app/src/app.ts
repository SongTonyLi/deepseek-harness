/**
 * The interactive terminal application over one live Agent: it renders the
 * durable session log and the live assistant stream into a pi-tui tree,
 * turns keystrokes into agent input, and answers the approval and
 * user-questions seams for that agent.
 * @module @deepseek-ai/dsh-tui-app/app
 */

import {
  Container,
  Editor,
  Loader,
  Text,
  TuiMainScreen,
  matchesKey,
  type Terminal,
} from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { assertNever } from '@deepseek-ai/dsh-util-values'
// Empty type imports carry the Context merges for the services this app reads through `ctx.get`.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { AssistantBlock, NoticeBlock, ToolBlock, UserBlock, type BlockTheme } from './blocks.ts'
import { slashCommandCompletion, type CompletableCommand } from './completion.ts'
import { ApprovalPrompt, ModalQueue, PickPrompt, QuestionPrompt, type PickItem } from './prompts.ts'
import { editorTheme, type Palette } from './style.ts'
import {
  EMPTY_USAGE,
  addUsage,
  contentText,
  describeFailure,
  formatUsage,
  parseArguments,
  toolCallText,
  toolResultLines,
  turnEndNotice,
  type UsageTotals,
} from './transcript.ts'

/** A second Ctrl+C inside this window quits. */
const QUIT_DOUBLE_PRESS_MS = 600

/** What the application needs from its host. */
export interface TuiAppDeps {
  /** The plugin context carrying the core services and live event feeds. */
  ctx: Context
  /** The one Agent this terminal drives. */
  agent: Agent
  /** The Agent's installed model selection; `/model` writes `current`. */
  selection: ModelSelectionRef
  /** The terminal the tree renders into; tests substitute a fake. */
  terminal: Terminal
  palette: Palette
  /** Collapsed tool-card body rows. */
  toolPreviewLines: number
  /** The workspace root shown in the footer. */
  cwd: string
  /**
   * Drop the host's reference to terminal input after the terminal stops. The
   * quit key arrives through a stdin read that pi-tui pauses from inside that
   * same read callback, and Node keeps a paused pipe referenced until its next
   * read or EOF; releasing it lets the process exit once the tree is disposed.
   */
  releaseInput(): void
  /** Called once after the terminal is released; the host flushes and exits. */
  onQuit(): void
}

/** The terminal's own commands, handled before the shared command registry. */
const LOCAL_COMMANDS: readonly CompletableCommand[] = [
  { name: 'help', description: 'Show commands and keys' },
  { name: 'model', description: 'Pick the model for the next request (/model provider/model)' },
  { name: 'tools', description: 'Expand or collapse every tool card' },
  { name: 'quit', description: 'Save the session and exit' },
]

/** Tone of a notice row. */
type Tone = 'dim' | 'error' | 'success'

/** The interactive terminal application; one instance per process. */
export class TuiApp {
  private readonly tui: TuiMainScreen
  private readonly header: Text
  private readonly chat = new Container()
  private readonly statusSlot = new Container()
  private readonly loader: Loader
  private readonly modalSlot = new Container()
  private readonly editor: Editor
  private readonly footer: Text
  private readonly modals: ModalQueue
  private readonly theme: BlockTheme
  private readonly toolBlocks = new Map<ToolCallId, ToolBlock>()
  private readonly toolArguments = new Map<ToolCallId, unknown>()
  private readonly submittedIds = new Set<string>()
  private readonly disposers: (() => void)[] = []
  private streaming: AssistantBlock | undefined
  private toolsExpanded = false
  private usage: UsageTotals = EMPTY_USAGE
  private lastCtrlC = 0
  private stopped = false

  constructor(private readonly deps: TuiAppDeps) {
    const palette = deps.palette
    this.theme = { palette, toolPreviewLines: deps.toolPreviewLines }
    this.tui = new TuiMainScreen(deps.terminal)
    this.header = new Text('', 0, 0)
    this.loader = new Loader(this.tui, palette.accent, palette.dim, 'thinking')
    this.editor = new Editor(this.tui, editorTheme(palette), { paddingX: 1 })
    this.editor.setAutocompleteProvider(slashCommandCompletion(() => this.completableCommands()))
    this.editor.onSubmit = (text) => { this.onSubmit(text) }
    this.footer = new Text('', 0, 0)
    this.modals = new ModalQueue({ tui: this.tui, slot: this.modalSlot, focusAfter: this.editor })
    for (const child of [this.header, this.chat, this.statusSlot, this.modalSlot, this.editor, this.footer]) {
      this.tui.addChild(child)
    }
  }

  /**
   * Take over the terminal, subscribe to the Agent, and optionally submit a
   * first prompt.
   * @param history - the persisted events of a resumed session, drawn before live input.
   * @param initialPrompt - a prompt submitted as soon as the terminal is up.
   */
  start(history: readonly SessionEvent[], initialPrompt: string | undefined): void {
    const { ctx, agent, palette } = this.deps
    this.header.setText(`${palette.bold(palette.accent('dsh'))} ${palette.dim(`· session ${agent.session.id} · /help for commands`)}`)
    this.refreshFooter()
    for (const event of history) this.onSessionEvent(agent.session, event)
    this.disposers.push(
      ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) }),
      ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
        if (subject !== agent) return
        this.onStreamFrame(frame)
      }),
      ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject !== agent) return
        this.setWorking(status === 'running')
      }),
      ctx.on('approval/request', (request, next) => {
        if (request.agent !== agent) return next()
        return this.askApproval(request.toolName, request.reason, request.signal)
      }),
      ctx.on('user-questions/request', (request, next) => {
        if (request.agent !== agent) return next()
        return this.askQuestions(request.questions, request.signal)
      }),
      this.tui.addInputListener(data => this.onKey(data)),
    )
    this.deps.terminal.setTitle(`dsh · ${this.deps.cwd}`)
    this.tui.setFocus(this.editor)
    this.tui.start()
    if (agent.status === 'running') this.setWorking(true)
    if (initialPrompt !== undefined) this.submit(initialPrompt)
  }

  /** Release the terminal and tell the host to exit; later calls are no-ops. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const dispose of this.disposers.splice(0)) dispose()
    this.modals.withdrawActive()
    this.loader.stop()
    this.tui.stop()
    this.deps.releaseInput()
    this.deps.onQuit()
  }

  private completableCommands(): CompletableCommand[] {
    const registry = this.deps.ctx.get('commands')
    const shared = registry?.list(this.deps.agent) ?? []
    return [...LOCAL_COMMANDS, ...shared.map(command => ({ name: command.name, description: command.description }))]
  }

  private notice(text: string, tone: Tone = 'dim'): void {
    this.chat.addChild(new NoticeBlock(this.theme, text, tone))
    this.tui.requestRender()
  }

  private setWorking(working: boolean): void {
    if (working) {
      if (this.statusSlot.children.length === 0) {
        this.statusSlot.addChild(this.loader)
        this.loader.start()
      }
    } else if (this.statusSlot.children.length > 0) {
      this.loader.stop()
      this.statusSlot.removeChild(this.loader)
      this.loader.setMessage('thinking')
    }
    this.tui.requestRender()
  }

  private refreshFooter(): void {
    const palette = this.deps.palette
    const selection = this.currentSelection()
    const parts = [`${selection.provider}/${selection.model}`]
    const usage = formatUsage(this.usage)
    if (usage !== '') parts.push(usage)
    parts.push(this.deps.cwd)
    const hints = 'Enter sends · Esc stops the turn · Ctrl+O tool output · Ctrl+C twice quits'
    this.footer.setText(`${palette.dim(parts.join(' · '))}\n${palette.dim(hints)}`)
    this.tui.requestRender()
  }

  private currentSelection(): ModelSelection {
    const { selection, agent } = this.deps
    const selected = selection.current ?? agent.session.requestHeader()?.config
    if (selected !== undefined) return selected
    return { provider: agent.options.provider ?? 'default', model: agent.options.model ?? 'default' }
  }

  // ── keyboard ────────────────────────────────────────────────────────────

  private onKey(data: string): { consume: true } | undefined {
    if (this.modals.isActive()) {
      if (!matchesKey(data, 'ctrl+c')) return undefined
      this.modals.withdrawActive()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+c')) {
      const now = Date.now()
      if (now - this.lastCtrlC < QUIT_DOUBLE_PRESS_MS) {
        this.stop()
        return { consume: true }
      }
      this.lastCtrlC = now
      this.editor.setText('')
      this.notice('press Ctrl+C again to quit')
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+d')) {
      if (this.editor.getText() === '') this.stop()
      return { consume: true }
    }
    if (matchesKey(data, 'escape') && !this.editor.isShowingAutocomplete()) {
      if (this.deps.agent.status === 'running') {
        this.deps.agent.cancel({ kind: 'user' })
        this.notice('stopping the turn…')
      }
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+o')) {
      this.toggleTools()
      return { consume: true }
    }
    return undefined
  }

  private toggleTools(): void {
    this.toolsExpanded = !this.toolsExpanded
    for (const block of this.toolBlocks.values()) block.setExpanded(this.toolsExpanded)
    this.tui.requestRender()
  }

  private onSubmit(raw: string): void {
    const text = raw.trim()
    if (text === '') return
    this.editor.setText('')
    this.editor.addToHistory(text)
    if (text.startsWith('/')) {
      void this.runCommand(text)
      return
    }
    this.submit(text)
  }

  private submit(text: string): void {
    const { agent } = this.deps
    const message: UserMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    this.submittedIds.add(message.id)
    this.chat.addChild(new UserBlock(this.theme, text))
    if (agent.status === 'running') {
      agent.steer(message)
      this.notice('queued for the next step of the running turn')
    } else {
      agent.followup(message)
    }
    this.tui.requestRender()
  }

  // ── commands ────────────────────────────────────────────────────────────

  private async runCommand(line: string): Promise<void> {
    const space = line.indexOf(' ')
    const name = (space === -1 ? line : line.slice(0, space)).slice(1).toLowerCase()
    const argument = space === -1 ? '' : line.slice(space + 1).trim()
    switch (name) {
      case 'help':
        this.showHelp()
        return
      case 'quit':
      case 'exit':
        this.stop()
        return
      case 'tools':
        this.toggleTools()
        return
      case 'model':
        await this.chooseModel(argument)
        return
      default:
        await this.runSharedCommand(line, name)
    }
  }

  private showHelp(): void {
    const palette = this.deps.palette
    const rows = this.completableCommands().map(command => `/${command.name.padEnd(12)} ${palette.dim(command.description)}`)
    const keys = [
      'Enter sends · Shift+Enter inserts a newline · Up/Down recall history',
      'Esc stops the running turn · Ctrl+O expands or collapses tool output',
      'Ctrl+C clears the input (twice quits) · Ctrl+D on an empty input quits',
    ]
    this.chat.addChild(new Text([...rows, '', ...keys.map(palette.dim)].join('\n'), 0, 1))
    this.tui.requestRender()
  }

  private async runSharedCommand(line: string, name: string): Promise<void> {
    const registry = this.deps.ctx.get('commands')
    if (registry === undefined) {
      this.notice(`unknown command /${name}`, 'error')
      return
    }
    try {
      const execution = await registry.execute(this.deps.agent, line, [], new AbortController().signal)
      if (execution === undefined) {
        this.notice(`unknown command /${name}`, 'error')
        return
      }
      const result = execution.result
      if (result.kind === 'error') this.notice(`/${name}: ${result.text}`, 'error')
      else this.notice(result.text === undefined ? `/${name} done` : `/${name}: ${result.text}`, 'success')
    } catch (error: unknown) {
      this.notice(`/${name} failed: ${describeFailure(error)}`, 'error')
    }
  }

  private async chooseModel(argument: string): Promise<void> {
    let next: ModelSelection | undefined
    if (argument !== '') {
      const slash = argument.indexOf('/')
      if (slash <= 0 || slash === argument.length - 1) {
        this.notice('usage: /model <provider>/<model>', 'error')
        return
      }
      next = { provider: argument.slice(0, slash), model: argument.slice(slash + 1) }
    } else {
      const items = await this.modelItems()
      if (items.length === 0) {
        this.notice('no models are available from the composed providers', 'error')
        return
      }
      const picked = await this.modals.run(new PickPrompt(this.deps.palette, 'Model for the next request', items))
      if (picked === undefined) return
      const slash = picked.value.indexOf('/')
      next = { provider: picked.value.slice(0, slash), model: picked.value.slice(slash + 1) }
    }
    this.deps.selection.current = next
    this.notice(`model: ${next.provider}/${next.model} from the next request`, 'success')
    this.refreshFooter()
  }

  private async modelItems(): Promise<PickItem[]> {
    const llm = this.deps.ctx.get('llm')
    if (llm === undefined) return []
    const items: PickItem[] = []
    for (const provider of llm.listProviders()) {
      let models
      try {
        models = await llm.listModels(provider.id)
      } catch (error: unknown) {
        this.notice(`${provider.id}: ${describeFailure(error)}`, 'error')
        continue
      }
      for (const model of models) {
        items.push({
          value: `${provider.id}/${model.id}`,
          label: `${provider.id}/${model.id}`,
          ...model.description === undefined ? {} : { description: model.description },
        })
      }
    }
    return items
  }

  // ── seams ───────────────────────────────────────────────────────────────

  private async askApproval(toolName: string, reason: string | undefined, signal: AbortSignal | undefined): Promise<ApprovalOutcome> {
    const outcome = await this.modals.run(new ApprovalPrompt(this.deps.palette, toolName, reason), signal)
    const tone: Tone = outcome === 'allowed-once' ? 'success' : 'dim'
    this.notice(`${toolName}: ${outcome === 'allowed-once' ? 'allowed once' : outcome}`, tone)
    return outcome
  }

  private async askQuestions(
    questions: readonly AskUserQuestionItem[],
    signal: AbortSignal | undefined,
  ): Promise<AskUserQuestionAnswer> {
    const answers: AskUserQuestionAnswer['answers'] = []
    for (const question of questions) {
      const answer = await this.modals.run(new QuestionPrompt(this.deps.palette, question), signal)
      if (answer === null) throw new Error('the question was dismissed')
      answers.push(answer)
    }
    return { answers }
  }

  // ── live stream ─────────────────────────────────────────────────────────

  private streamingBlock(): AssistantBlock {
    if (this.streaming === undefined) {
      this.streaming = new AssistantBlock(this.theme)
      this.chat.addChild(this.streaming)
    }
    return this.streaming
  }

  private onStreamFrame(frame: AssistantStreamFrame): void {
    switch (frame.type) {
      case 'start':
        this.streaming = undefined
        return
      case 'chunk': {
        const chunk = frame.chunk
        switch (chunk.type) {
          case 'text-delta':
            if (chunk.text !== '') this.streamingBlock().appendText(chunk.text)
            break
          case 'reasoning-delta':
            if (chunk.text !== '') this.streamingBlock().appendReasoning(chunk.text)
            break
          case 'tool-call-delta':
            if (chunk.name !== undefined) this.loader.setMessage(`calling ${chunk.name}`)
            break
          case 'block-start':
          case 'block-end':
          case 'usage':
          case 'finish':
            break
          /* v8 ignore next -- closed-union exhaustiveness guard */
          default:
            assertNever(chunk, 'tui stream chunk')
        }
        this.tui.requestRender()
        return
      }
      case 'end':
        // An abandoned attempt keeps what it streamed; the retry starts a new block.
        this.streaming = undefined
        this.tui.requestRender()
        return
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(frame, 'tui stream frame')
    }
  }

  // ── durable log ─────────────────────────────────────────────────────────

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (session !== this.deps.agent.session) return
    switch (event.type) {
      case 'user/message':
        this.onUserMessage(event.data)
        break
      case 'assistant/message': {
        const { message, usage, interrupted } = event.data
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
        this.streamingBlock().commit(text, reasoning, interrupted === true)
        this.streaming = undefined
        if (usage !== undefined) {
          this.usage = addUsage(this.usage, usage)
          this.refreshFooter()
        }
        break
      }
      case 'tool/call': {
        const { callId, name, arguments: argumentsJson } = event.data
        const args = parseArguments(argumentsJson)
        this.toolArguments.set(callId, args)
        const block = new ToolBlock(this.theme, name, toolCallText(argumentsJson, this.presentCall(name, args)))
        block.setExpanded(this.toolsExpanded)
        this.toolBlocks.set(callId, block)
        this.chat.addChild(block)
        break
      }
      case 'tool/result': {
        const [result] = event.data.message.content
        const block = this.toolBlocks.get(result.toolCallId)
        if (block === undefined) break
        const isError = result.isError === true
        const view = this.presentResult(block.name, this.toolArguments.get(result.toolCallId), result.content, isError, event.data.meta)
        block.setResult(toolResultLines(view, result.content), isError)
        this.loader.setMessage('thinking')
        break
      }
      case 'turn/end': {
        const notice = turnEndNotice(event.data.reason)
        if (notice !== undefined) this.notice(notice, event.data.reason.kind === 'error' ? 'error' : 'dim')
        break
      }
      default:
        return
    }
    this.tui.requestRender()
  }

  private onUserMessage(message: UserMessage): void {
    const source = message.source
    if (source.kind === 'user') {
      if (this.submittedIds.has(message.id)) return
      this.chat.addChild(new UserBlock(this.theme, contentText(message.content)))
      return
    }
    // Injected context (instructions, catalogs, runtime snapshots) is model-facing
    // and drawn nowhere; a plugin notice carries a one-line account for the user.
    if (source.kind === 'plugin' && source.form === 'notice') {
      this.chat.addChild(new NoticeBlock(this.theme, source.summary))
    }
  }

  private presentCall(name: string, args: unknown): ToolCallView | undefined {
    const definition = this.deps.ctx.get('tools')?.get(name, this.deps.agent)
    if (definition?.presentCall === undefined) return undefined
    try {
      return definition.presentCall(args)
    } catch {
      // A presenter that throws on replayed arguments falls back to the generic card.
      return undefined
    }
  }

  private presentResult(
    name: string,
    args: unknown,
    content: UserMessage['content'],
    isError: boolean,
    meta: SessionEvent<'tool/result'>['data']['meta'],
  ): ToolResultView | undefined {
    const definition = this.deps.ctx.get('tools')?.get(name, this.deps.agent)
    if (definition?.presentResult === undefined) return undefined
    try {
      return definition.presentResult(args, { content, isError, ...meta === undefined ? {} : { meta } })
    } catch {
      // Same fallback as the call presenter: the raw result text still renders.
      return undefined
    }
  }
}
