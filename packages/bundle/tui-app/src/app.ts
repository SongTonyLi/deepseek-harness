/**
 * The interactive terminal application: it renders the durable session log
 * and the live assistant stream of one Agent at a time into a pi-tui tree,
 * turns keystrokes into agent input, answers the approval and user-questions
 * seams for that Agent, and switches between sessions through its host.
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
import type { AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference'
import { ReasoningEffortId, createUserMessage, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { assertNever } from '@deepseek-ai/dsh-util-values'
// Empty type imports carry the Context merges for the services this app reads through `ctx.get`.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { attachLocalFile, type PendingAttachment } from './attach.ts'
import { AssistantBlock, NoticeBlock, ToolBlock, UserBlock, type BlockTheme } from './blocks.ts'
import { editorCompletion, type CompletableCommand, type ReferenceItem } from './completion.ts'
import { exportSessionZip } from './export.ts'
import { ApprovalPrompt, ModalQueue, PickPrompt, QuestionPrompt, type PickItem } from './prompts.ts'
import { describeSession, listSessionChoices } from './sessions.ts'
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

/** One Agent the terminal drives, with the facts the host resolved for it. */
export interface BoundSession {
  agent: Agent
  /** The Agent's installed model selection; `/model` writes `current`. */
  selection: ModelSelectionRef
  /** Persisted events drawn before live input; empty for a fresh session. */
  history: readonly SessionEvent[]
  /** Release the Agent when the terminal moves to another session or quits. */
  dispose(): Promise<void>
}

/** The host's session operations; each returns a session the terminal can bind. */
export interface SessionHost {
  /** Start a fresh session. */
  create(): Promise<BoundSession>
  /** Resume a persisted session. */
  resume(id: SessionId): Promise<BoundSession>
  /** Fork a session at its last completed turn into a new session. */
  fork(id: SessionId): Promise<BoundSession>
}

/** What the application needs from its host. */
export interface TuiAppDeps {
  /** The plugin context carrying the core services and live event feeds. */
  ctx: Context
  host: SessionHost
  /** The session the terminal starts on. */
  initial: BoundSession
  /** The terminal the tree renders into; tests substitute a fake. */
  terminal: Terminal
  palette: Palette
  /** Collapsed tool-card body rows. */
  toolPreviewLines: number
  /** The workspace root shown in the footer and used for relative attachment and export paths. */
  cwd: string
  /**
   * Drop the host's reference to terminal input after the terminal stops. The
   * quit key arrives through a stdin read that pi-tui pauses from inside that
   * same read callback, and Node keeps a paused pipe referenced until its next
   * read or EOF; releasing it lets the process exit once the tree is disposed.
   */
  releaseInput(): void
  /** Called once after the terminal is released with the session still bound; the host flushes and exits. */
  onQuit(bound: BoundSession): void
}

/** The terminal's own commands, handled before the shared command registry. */
const LOCAL_COMMANDS: readonly CompletableCommand[] = [
  { name: 'help', description: 'Show commands and keys' },
  { name: 'model', description: 'Pick the model and reasoning effort for the next request (/model provider/model, /model save)' },
  { name: 'sessions', description: 'Switch to another session' },
  { name: 'new', description: 'Start a new session' },
  { name: 'fork', description: 'Fork this session at its last completed turn' },
  { name: 'title', description: 'Rename this session (/title <text>)' },
  { name: 'attach', description: 'Attach a file or image to the next prompt (/attach <path>, /attach clear)' },
  { name: 'queue', description: 'Show or clear the messages queued for the Agent (/queue clear)' },
  { name: 'skills', description: 'List the skills the Agent can load' },
  { name: 'signin', description: 'Sign in to a provider' },
  { name: 'export', description: 'Write this session log as a ZIP archive (/export [directory])' },
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
  private pending: PendingAttachment[] = []
  private bound: BoundSession
  private streaming: AssistantBlock | undefined
  private toolsExpanded = false
  private usage: UsageTotals = EMPTY_USAGE
  private lastCtrlC = 0
  private stopped = false

  constructor(private readonly deps: TuiAppDeps) {
    const palette = deps.palette
    this.bound = deps.initial
    this.theme = { palette, toolPreviewLines: deps.toolPreviewLines }
    this.tui = new TuiMainScreen(deps.terminal)
    this.header = new Text('', 0, 0)
    this.loader = new Loader(this.tui, palette.accent, palette.dim, 'thinking')
    this.editor = new Editor(this.tui, editorTheme(palette), { paddingX: 1 })
    this.editor.setAutocompleteProvider(editorCompletion({
      commands: () => this.completableCommands(),
      references: (query, quoted, signal) => this.references(query, quoted, signal),
    }))
    this.editor.onSubmit = (text) => { this.onSubmit(text) }
    this.footer = new Text('', 0, 0)
    this.modals = new ModalQueue({ tui: this.tui, slot: this.modalSlot, focusAfter: this.editor })
    for (const child of [this.header, this.chat, this.statusSlot, this.modalSlot, this.editor, this.footer]) {
      this.tui.addChild(child)
    }
  }

  private get agent(): Agent {
    return this.bound.agent
  }

  /**
   * Take over the terminal, subscribe to the Agent, and optionally submit a
   * first prompt.
   * @param initialPrompt - a prompt submitted as soon as the terminal is up.
   */
  start(initialPrompt: string | undefined): void {
    const { ctx } = this.deps
    this.disposers.push(
      ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) }),
      ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
        if (subject !== this.agent) return
        this.onStreamFrame(frame)
      }),
      ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject !== this.agent) return
        this.setWorking(status === 'running')
      }),
      ctx.on('approval/request', (request, next) => {
        if (request.agent !== this.agent) return next()
        return this.askApproval(request.toolName, request.reason, request.signal)
      }),
      ctx.on('user-questions/request', (request, next) => {
        if (request.agent !== this.agent) return next()
        return this.askQuestions(request.questions, request.signal)
      }),
      this.tui.addInputListener(data => this.onKey(data)),
    )
    this.deps.terminal.setTitle(`dsh · ${this.deps.cwd}`)
    this.tui.setFocus(this.editor)
    this.tui.start()
    this.bind(this.bound)
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
    this.deps.onQuit(this.bound)
  }

  // ── session binding ─────────────────────────────────────────────────────

  /** Draw `next` as the terminal's session: clear the transcript and replay its history. */
  private bind(next: BoundSession): void {
    this.bound = next
    this.chat.clear()
    this.toolBlocks.clear()
    this.toolArguments.clear()
    this.submittedIds.clear()
    this.streaming = undefined
    this.usage = EMPTY_USAGE
    this.pending = []
    this.setWorking(next.agent.status === 'running')
    for (const event of next.history) this.onSessionEvent(next.agent.session, event)
    this.refreshHeader()
    this.refreshFooter()
  }

  /**
   * Move the terminal to the session `open` resolves, releasing the current one.
   * @param open - the host operation that yields the next session.
   * @param verb - what the notice calls the move.
   */
  private async switchSession(open: () => Promise<BoundSession>, verb: string): Promise<void> {
    if (this.agent.status === 'running') {
      this.notice('stop the running turn (Esc) before switching sessions', 'error')
      return
    }
    let next: BoundSession
    try {
      next = await open()
    } catch (error: unknown) {
      this.notice(`${verb} failed: ${describeFailure(error)}`, 'error')
      return
    }
    const previous = this.bound
    this.bind(next)
    this.notice(`${verb}: session ${next.agent.session.id}`, 'success')
    try {
      await previous.dispose()
    } catch (error: unknown) {
      this.notice(`releasing the previous session failed: ${describeFailure(error)}`, 'error')
    }
  }

  private completableCommands(): CompletableCommand[] {
    const registry = this.deps.ctx.get('commands')
    const shared = registry?.list(this.agent) ?? []
    return [...LOCAL_COMMANDS, ...shared.map(command => ({ name: command.name, description: command.description }))]
  }

  private async references(query: string, quoted: boolean, signal: AbortSignal): Promise<ReferenceItem[]> {
    const { ctx } = this.deps
    const items: ReferenceItem[] = []
    const files = ctx.get('fileReferences')
    if (files !== undefined) {
      for (const candidate of await files.list(this.agent, query, signal)) {
        const mention = formatFileMention(candidate, quoted)
        if (mention === undefined) continue
        items.push({ mention, label: candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path, description: candidate.kind })
      }
    }
    const sessions = ctx.get('sessionReferenceResolver')
    if (sessions !== undefined) {
      for (const candidate of await sessions.listCandidates(this.agent, query, undefined, signal)) {
        items.push({
          mention: formatSessionReferenceMention({ sessionId: candidate.sessionId, label: candidate.label }),
          label: candidate.label,
          description: `session${candidate.cwd === undefined ? '' : ` · ${candidate.cwd}`}`,
        })
      }
    }
    return items
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

  private refreshHeader(): void {
    const palette = this.deps.palette
    const session = this.agent.session
    const title = this.deps.ctx.get('sessionTitle')?.get(session)?.title
    const name = title === undefined ? `session ${session.id}` : `${title} ${palette.dim(`(${session.id})`)}`
    this.header.setText(`${palette.bold(palette.accent('dsh'))} ${palette.dim('·')} ${name} ${palette.dim('· /help for commands')}`)
    this.tui.requestRender()
  }

  private refreshFooter(): void {
    const palette = this.deps.palette
    const selection = this.currentSelection()
    const parts = [`${selection.provider}/${selection.model}`]
    if (selection.reasoningEffort !== undefined) parts.push(`effort ${selection.reasoningEffort}`)
    const permission = this.deps.ctx.get('permissionPresets')?.current(this.agent.session)
    if (permission !== undefined) parts.push(`permission ${permission}`)
    const usage = formatUsage(this.usage)
    if (usage !== '') parts.push(usage)
    parts.push(this.deps.cwd)
    if (this.pending.length > 0) parts.push(`${String(this.pending.length)} attached`)
    const hints = 'Enter sends · Esc stops the turn · Ctrl+O tool output · Ctrl+C twice quits'
    this.footer.setText(`${palette.dim(parts.join(' · '))}\n${palette.dim(hints)}`)
    this.tui.requestRender()
  }

  private currentSelection(): ModelSelection {
    const { selection, agent } = this.bound
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
      if (this.agent.status === 'running') {
        this.agent.cancel({ kind: 'user' })
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
    const agent = this.agent
    const attachments = this.pending.splice(0)
    const message: UserMessage = createUserMessage({
      content: [...attachments.map(attachment => attachment.block), { type: 'text', text }],
      source: { kind: 'user' },
    })
    this.submittedIds.add(message.id)
    const shown = attachments.length === 0 ? text : `${text}\n${attachments.map(attachment => `[${attachment.block.type}: ${attachment.name}]`).join(' ')}`
    this.chat.addChild(new UserBlock(this.theme, shown))
    if (agent.status === 'running') {
      agent.steer(message)
      this.notice('queued for the next step of the running turn')
    } else {
      agent.followup(message)
    }
    this.refreshFooter()
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
      case 'sessions':
        await this.chooseSession()
        return
      case 'new':
        await this.switchSession(() => this.deps.host.create(), 'new session')
        return
      case 'fork':
        await this.switchSession(() => this.deps.host.fork(this.agent.session.id), 'forked')
        return
      case 'title':
        this.renameSession(argument)
        return
      case 'attach':
        await this.attach(argument)
        return
      case 'queue':
        this.showQueue(argument)
        return
      case 'skills':
        await this.showSkills()
        return
      case 'signin':
        await this.signIn(argument)
        return
      case 'export':
        await this.exportSession(argument)
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
      '@ completes workspace paths and sessions · / completes commands',
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
      const execution = await registry.execute(this.agent, line, [], new AbortController().signal)
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
    this.refreshFooter()
  }

  private async chooseModel(argument: string): Promise<void> {
    const { selection } = this.bound
    if (argument === 'save') {
      const defaults = this.deps.ctx.get('agentDefaultModel')
      /* v8 ignore next 4 -- the runner injects the default-model service; only teardown can remove it */
      if (defaults === undefined) {
        this.notice('no default model service is composed', 'error')
        return
      }
      const current = this.currentSelection()
      await defaults.saveSelection(current)
      this.notice(`default model saved: ${current.provider}/${current.model}`, 'success')
      return
    }
    let next: ModelSelection | undefined
    if (argument !== '') {
      const slash = argument.indexOf('/')
      if (slash <= 0 || slash === argument.length - 1) {
        this.notice('usage: /model <provider>/<model> · /model save', 'error')
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
    const effort = await this.chooseEffort(next)
    if (effort === null) return
    selection.current = effort === undefined ? next : { ...next, reasoningEffort: effort }
    this.notice(`model: ${next.provider}/${next.model}${effort === undefined ? '' : ` · effort ${effort}`} from the next request`, 'success')
    this.refreshFooter()
  }

  /**
   * Offer the model's reasoning efforts when it declares more than one.
   * @returns the chosen effort, undefined for the provider default, or null when dismissed.
   */
  private async chooseEffort(model: ModelSelection): Promise<ReasoningEffortId | undefined | null> {
    const llm = this.deps.ctx.get('llm')
    if (llm === undefined) return undefined
    let efforts
    try {
      efforts = (await llm.resolveModelInfo(model.provider, model.model)).reasoning?.efforts ?? []
    } catch (error: unknown) {
      this.notice(`${model.provider}/${model.model}: ${describeFailure(error)}`, 'error')
      return undefined
    }
    if (efforts.length < 2) return undefined
    const items: PickItem[] = [
      { value: '', label: 'provider default' },
      ...efforts.map(effort => ({
        value: effort.id,
        label: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    ]
    const picked = await this.modals.run(new PickPrompt(this.deps.palette, `Reasoning effort for ${model.model}`, items))
    if (picked === undefined) return null
    return picked.value === '' ? undefined : ReasoningEffortId(picked.value)
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

  private async chooseSession(): Promise<void> {
    const choices = await listSessionChoices(this.deps.ctx, this.agent.session.id, new AbortController().signal)
    if (choices.length === 0) {
      this.notice('no persisted sessions are listed by the composed query engine', 'error')
      return
    }
    const items = choices.map((choice): PickItem => ({ value: choice.id, ...describeSession(choice) }))
    const picked = await this.modals.run(new PickPrompt(this.deps.palette, 'Switch to a session', items))
    if (picked === undefined || picked.value === this.agent.session.id) return
    await this.switchSession(() => this.deps.host.resume(picked.value as SessionId), 'resumed')
  }

  private renameSession(title: string): void {
    const titles = this.deps.ctx.get('sessionTitle')
    if (titles === undefined) {
      this.notice('no session title service is composed', 'error')
      return
    }
    if (title === '') {
      const current = titles.get(this.agent.session)?.title
      this.notice(current === undefined ? 'this session has no title yet; /title <text> sets one' : `title: ${current}`)
      return
    }
    try {
      titles.rename(this.agent.session, title)
    } catch (error: unknown) {
      this.notice(`rename failed: ${describeFailure(error)}`, 'error')
    }
  }

  private async attach(argument: string): Promise<void> {
    if (argument === '' ) {
      this.notice(this.pending.length === 0
        ? 'nothing attached; /attach <path> attaches a file or image to the next prompt'
        : `attached: ${this.pending.map(attachment => attachment.name).join(', ')}`)
      return
    }
    if (argument === 'clear') {
      this.pending = []
      this.notice('attachments cleared')
      this.refreshFooter()
      return
    }
    const store = this.deps.ctx.get('attachments')
    if (store === undefined) {
      this.notice('no attachment store is composed', 'error')
      return
    }
    try {
      const pending = await attachLocalFile(store, this.deps.cwd, argument)
      this.pending.push(pending)
      this.notice(`attached ${pending.block.type} ${pending.name}; it goes with the next prompt`, 'success')
    } catch (error: unknown) {
      this.notice(`attach failed: ${describeFailure(error)}`, 'error')
    }
    this.refreshFooter()
  }

  private showQueue(argument: string): void {
    const inbox = this.agent.inbox
    if (argument === 'clear') {
      inbox.clear()
      this.notice('queue cleared', 'success')
      return
    }
    const rows = [
      ...inbox.nextTurn.map(message => `next turn: ${contentText(message.content)}`),
      ...inbox.nextStep.map(message => `next step: ${contentText(message.content)}`),
    ]
    this.notice(rows.length === 0 ? 'nothing is queued' : rows.join('\n'))
  }

  private async showSkills(): Promise<void> {
    const skills = this.deps.ctx.get('skills')
    if (skills === undefined) {
      this.notice('no skill catalog is composed', 'error')
      return
    }
    const palette = this.deps.palette
    const summaries = await skills.list()
    if (summaries.length === 0) {
      this.notice('no skills are available')
      return
    }
    this.chat.addChild(new Text(summaries.map(skill => `${palette.bold(skill.name)} ${palette.dim(skill.description)}`).join('\n'), 0, 1))
    this.tui.requestRender()
  }

  private async signIn(argument: string): Promise<void> {
    const authorization = this.deps.ctx.get('authorization')
    if (authorization === undefined) {
      this.notice('no sign-in flows are composed', 'error')
      return
    }
    const entries = authorization.list()
    if (entries.length === 0) {
      this.notice('no provider offers a sign-in flow')
      return
    }
    let key = argument
    if (key === '') {
      const picked = await this.modals.run(new PickPrompt(this.deps.palette, 'Sign in to', entries.map(entry => ({
        value: entry.key,
        label: entry.label,
        description: entry.methods.map(method => method.label).join(', '),
      }))))
      if (picked === undefined) return
      key = picked.value
    }
    const entry = entries.find(candidate => candidate.key === key)
    if (entry === undefined) {
      this.notice(`no sign-in flow for ${key}`, 'error')
      return
    }
    let method = entry.methods[0]?.id
    if (entry.methods.length > 1) {
      const picked = await this.modals.run(new PickPrompt(this.deps.palette, `Sign-in method for ${entry.label}`, entry.methods.map(candidate => ({ value: candidate.id, label: candidate.label }))))
      if (picked === undefined) return
      method = picked.value
    }
    try {
      const outcome = await authorization.begin({
        key: entry.key,
        ...method === undefined ? {} : { method },
        interaction: {
          notify: (notice) => {
            const parts = [notice.message]
            if (notice.url !== undefined) parts.push(notice.url)
            if (notice.code !== undefined) parts.push(`code: ${notice.code}`)
            this.notice(parts.join(' '))
          },
          prompt: prompt => this.answerAuthorizationPrompt(prompt),
        },
      })
      this.notice(outcome.status === 'authorized' ? `signed in to ${entry.label}` : `sign-in to ${entry.label} cancelled`, outcome.status === 'authorized' ? 'success' : 'dim')
    } catch (error: unknown) {
      this.notice(`sign-in failed: ${describeFailure(error)}`, 'error')
    }
  }

  private async answerAuthorizationPrompt(prompt: AuthorizationPrompt): Promise<string> {
    if (prompt.kind === 'select') {
      const picked = await this.modals.run(new PickPrompt(this.deps.palette, prompt.message, prompt.options.map(option => ({
        value: option.id,
        label: option.label,
        ...option.description === undefined ? {} : { description: option.description },
      }))), prompt.signal)
      if (picked === undefined) throw new Error('the sign-in prompt was dismissed')
      return picked.value
    }
    const answer = await this.modals.run(new QuestionPrompt(this.deps.palette, {
      id: 'authorization',
      question: prompt.message,
      ...prompt.placeholder === undefined ? {} : { detail: prompt.placeholder },
    }), prompt.signal)
    if (answer?.custom === undefined) throw new Error('the sign-in prompt was dismissed')
    return answer.custom
  }

  private async exportSession(argument: string): Promise<void> {
    try {
      const path = await exportSessionZip(this.deps.ctx, this.agent.session.id, argument === '' ? this.deps.cwd : argument, new AbortController().signal)
      this.notice(`exported ${path}`, 'success')
    } catch (error: unknown) {
      this.notice(`export failed: ${describeFailure(error)}`, 'error')
    }
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
    if (session !== this.agent.session) return
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
      case 'session/title':
        this.refreshHeader()
        break
      case 'permission/preset':
        this.refreshFooter()
        break
      default:
        return
    }
    this.tui.requestRender()
  }

  private onUserMessage(message: UserMessage): void {
    const source = message.source
    if (source.kind === 'user') {
      if (this.submittedIds.has(message.id)) return
      const attachments = message.content.filter(block => block.type !== 'text').map(block => `[${block.type}]`)
      this.chat.addChild(new UserBlock(this.theme, [contentText(message.content), ...attachments].filter(part => part !== '').join('\n')))
      return
    }
    // Injected context (instructions, catalogs, runtime snapshots) is model-facing
    // and drawn nowhere; a plugin notice carries a one-line account for the user.
    if (source.kind === 'plugin' && source.form === 'notice') {
      this.chat.addChild(new NoticeBlock(this.theme, source.summary))
    }
  }

  private presentCall(name: string, args: unknown): ToolCallView | undefined {
    const definition = this.deps.ctx.get('tools')?.get(name, this.agent)
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
    const definition = this.deps.ctx.get('tools')?.get(name, this.agent)
    if (definition?.presentResult === undefined) return undefined
    try {
      return definition.presentResult(args, { content, isError, ...meta === undefined ? {} : { meta } })
    } catch {
      // Same fallback as the call presenter: the raw result text still renders.
      return undefined
    }
  }
}
