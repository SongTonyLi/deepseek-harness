/**
 * The interactive terminal application: it renders the durable session log
 * and the live assistant stream of one Agent at a time into a pi-tui tree,
 * turns keystrokes into agent input, answers the approval and user-questions
 * seams for that Agent, and switches between sessions through its host. Under
 * the editor it keeps two docked regions the keyboard can take over — the
 * subagent panel and the status bar — and one repeating tick advances their
 * elapsed counters and re-reads a stale subagent listing. A second tick, at
 * its own period, brightens the text of the message streaming right now and
 * the tool cards that just landed, each only as far up the frame as the
 * renderer repaints without discarding the terminal's scrollback
 * (`./screen.ts`).
 * @module @deepseek-ai/dsh-tui-app/app
 */

import { homedir } from 'node:os'
import {
  Container,
  Loader,
  Text,
  matchesKey,
  type RgbColor,
  type SelectListLayoutOptions,
  type Terminal,
} from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { AuthorizationDeclinedError, type AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference'
import { ReasoningEffortId, createUserMessage, type LlmModelReasoningInfo, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { assertNever } from '@deepseek-ai/dsh-util-values'
// Empty type imports carry the Context merges for the services this app reads through `ctx.get`.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-skill'
// Carries the subagent lifecycle events, the descendant listing, and the
// `subagentTiming` projection key; `tokenUsage` rides the token meter.
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { attachLocalFile, type PendingAttachment } from './attach.ts'
import {
  listDeliverables,
  listPlugins,
  listSettings,
  listSubagentChoices,
  resetSetting,
  sessionOutline,
  setSetting,
  showSetting,
  subagentChoice,
  subagentDetail,
  type SubagentChoice,
} from './catalog.ts'
import { AssistantBlock, NoticeBlock, ToolBlock, UserBlock, type BlockFade, type BlockTheme, type FadeRender } from './blocks.ts'
import { editorCompletion, type CompletableCommand, type ReferenceItem } from './completion.ts'
import { BarCursorEditor, SET_BLINKING_BAR_CURSOR, SET_TERMINAL_DEFAULT_CURSOR } from './editor.ts'
import { PROVIDER_DEFAULT, effortHint, effortItems, matchEffort } from './effort.ts'
import { exportSessionZip } from './export.ts'
import { BlockFadeClock, FadeRegistry, FadeTracker, buildFadeRamp, resolveFadeCapability, type FadeCapability, type FadeStyle } from './fade.ts'
import { InspectorPane, type InspectorView } from './inspector.ts'
import {
  clampCursor,
  enterNewest,
  isSectionSource,
  moveBlock,
  movePart,
  navigableBlocks,
  partLabels,
  sectionHeading,
  type SectionKind,
  type SectionPart,
  type SectionSource,
  type TranscriptCursor,
} from './navigation.ts'
import {
  FIRST_FOOTER_SEGMENT,
  buildFooterSegments,
  footerSelectionIndex,
  renderFooter,
  type FooterSegment,
  type FooterSegmentId,
} from './footer.ts'
import { ApprovalPrompt, DetailPrompt, ModalQueue, PickPrompt, QuestionPrompt, type ModalPrompt, type PickItem } from './prompts.ts'
import { GuardedMainScreen, repaintFloor } from './screen.ts'
import { describeSession, listSessionChoices } from './sessions.ts'
import { compactionNotice, readStatusFacts, retryMessage, statusReport } from './status.ts'
import {
  renderSubagentPanel,
  subagentPanelView,
  type SubagentLiveFacts,
  type SubagentPanelRow,
  type SubagentPanelView,
} from './subagent-panel.ts'
import { listTodoChoices, todoDetail, type TodoTransition } from './todos.ts'
import { editorTheme, type Palette } from './style.ts'
import {
  EMPTY_USAGE,
  addUsage,
  contentText,
  describeFailure,
  formatElapsed,
  formatUsage,
  parseArguments,
  toolCallText,
  toolResultLines,
  turnEndNotice,
  type UsageTotals,
} from './transcript.ts'

/** A second Ctrl+C inside this window quits. */
const QUIT_DOUBLE_PRESS_MS = 600

/**
 * Row layout of the todo picker: the label column grows with the widest todo
 * line instead of stopping at the list's 32-column default, which would cut a
 * todo well inside the width its rows are built for. 68 columns hold the
 * status glyph, the row's own content cap, and the gap before the status
 * column. A presentation choice of this terminal surface, not a deployment
 * setting.
 */
const TODO_ROW_LAYOUT: SelectListLayoutOptions = { minPrimaryColumnWidth: 1, maxPrimaryColumnWidth: 68 }

/** The panel draw of a session with no subagent rows. */
const EMPTY_PANEL_VIEW: SubagentPanelView = { rows: [], hidden: 0, ticking: false }

/**
 * How long the application waits for the terminal to answer the OSC 11
 * background-color query it sends once at start. The query is a round trip to
 * the attached terminal, so this bounds one local handshake, not a deployment
 * choice; a terminal that stays silent leaves the fade in its two-level mode.
 */
const BACKGROUND_QUERY_TIMEOUT_MS = 200

/** Drawing settings before the background query settles, and whenever the terminal draws no ramp. */
const NO_FADE: FadeStyle = { capability: 'none', ramp: [] }

/**
 * Relative luminance of the terminal background at which the foreground is
 * taken to be dark rather than light, as a fraction of a full channel.
 */
const DARK_BACKGROUND_LUMINANCE = 0.5

/** The foreground assumed over a dark background. */
const LIGHT_FOREGROUND: RgbColor = { r: 255, g: 255, b: 255 }

/** The foreground assumed over a light background. */
const DARK_FOREGROUND: RgbColor = { r: 0, g: 0, b: 0 }

/**
 * The foreground the ramp climbs towards.
 *
 * pi-tui reports the terminal background but never its foreground, so this is
 * an assumption: a light foreground over a dark background and the reverse.
 * It is never drawn - the streaming block withholds the oldest visible level,
 * which is the only level this color reaches - and only sets the direction
 * and spacing of the levels below it.
 * @param background - the background the terminal reported.
 * @returns the assumed foreground.
 */
function assumedForeground(background: RgbColor): RgbColor {
  const luminance = (0.2126 * background.r + 0.7152 * background.g + 0.0722 * background.b) / 255
  return luminance < DARK_BACKGROUND_LUMINANCE ? LIGHT_FOREGROUND : DARK_FOREGROUND
}

/**
 * Which region owns the keyboard. They stack top to bottom - the transcript
 * blocks, then the subagent panel's rows while it is drawn, then the status
 * bar's segments - and `Up` and `Down` walk that stack from whichever one the
 * editor was left through.
 */
type FocusRegion = 'editor' | 'transcript' | 'panel' | 'bar'

/** The block that carries the focus gutter right now, and which of its sections is accented. */
interface HeldSection {
  block: SectionSource
  part: SectionKind
}

/** The transcript cursor read against the blocks drawn right now. */
interface FocusedSection {
  /** The cursor, settled inside the current blocks. */
  cursor: TranscriptCursor
  /** The blocks it was settled against. */
  blocks: readonly SectionSource[]
  /** The block the cursor names. */
  block: SectionSource
  /** The section inside that block. */
  part: SectionPart
}

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
  /**
   * Fork a session into a new session at a completed turn.
   * @param id - the source session.
   * @param turn - the completed turn to cut after; the last one when omitted.
   */
  fork(id: SessionId, turn?: number): Promise<BoundSession>
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
  /** Rows of the focused transcript section the docked inspector shows. */
  focusPreviewLines: number
  /** Period of the live-refresh tick, in milliseconds. */
  liveRefreshMs: number
  /** Brightness levels streamed text and tool cards climb; the oldest visible level is `fadeSteps - 1`. */
  fadeSteps: number
  /** How long one brightness level lasts, in milliseconds, which is also the fade repaint period. */
  fadeStepMs: number
  /** Draw streamed text and tool cards in their own colors, with no ramp and no fade tick. */
  reducedMotion: boolean
  /**
   * Process environment the fade capability is decided from (`NO_COLOR`,
   * `COLORTERM`, `TERM`). Read once at start, never from the render path, so
   * tests drive every capability without touching `process.env`.
   */
  env: NodeJS.ProcessEnv
  /**
   * Wall clock the elapsed counters are measured against. Tests substitute a
   * clock they step by hand, so no spec waits on real time.
   * @returns the current Unix time in milliseconds.
   */
  now(): number
  /**
   * Start one repeating tick. The app arms at most one per purpose and only
   * while that purpose needs it: the live refresh while a turn is running, a
   * listed child is timing an open turn, or the listing is stale, and the
   * fade while streamed text or a tool card is still brightening. The
   * production source registers each interval as an effect of the plugin
   * fiber; tests substitute a source they step by hand.
   * @param callback - runs once per period.
   * @param delayMs - the period.
   * @returns the disposer that stops this tick.
   */
  tick(callback: () => void, delayMs: number): () => void
  /** The workspace root shown in the footer and used for relative attachment and export paths. */
  cwd: string
  /** Hand an authorization page to the local default browser; absent when automatic handoff is disabled. */
  openUrl?: (url: string) => Promise<void>
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
  { name: 'effort', description: 'Pick the current model\'s reasoning effort for the next request (/effort <id>, /effort default)' },
  { name: 'sessions', description: 'Switch to another session' },
  { name: 'new', description: 'Start a new session' },
  { name: 'fork', description: 'Fork this session at its last completed turn (/fork <turn> for an earlier one)' },
  { name: 'title', description: 'Rename this session (/title <text>)' },
  { name: 'attach', description: 'Attach a file or image to the next prompt (/attach <path>, /attach clear)' },
  { name: 'queue', description: 'Show or clear the messages queued for the Agent (/queue clear)' },
  { name: 'skills', description: 'List the skills the Agent can load' },
  { name: 'login', description: 'Sign in with a provider subscription (/login <key> skips the picker)' },
  { name: 'signin', description: 'Sign in to a provider' },
  { name: 'export', description: 'Write this session log as a ZIP archive (/export [directory])' },
  { name: 'status', description: 'Show context usage, token totals, session stats, todos, goal, plan, and permission' },
  { name: 'todos', description: 'Browse the agent\'s todo list (Enter shows one item in full)' },
  { name: 'outline', description: 'List the turns of this session with their prompts and replies' },
  { name: 'deliverables', description: 'List the files the agent presented in this session' },
  { name: 'subagents', description: 'Browse the subagent sessions under this session (Enter shows one session\'s details)' },
  { name: 'settings', description: 'Inspect or change settings (/settings, /settings <ns>, /settings <ns> <path> <value>, /settings reset <ns>)' },
  { name: 'plugins', description: 'List the composed plugins and their state' },
  { name: 'tools', description: 'Expand or collapse every tool card' },
  { name: 'quit', description: 'Save the session and exit' },
  { name: 'exit', description: 'Same as /quit' },
]

/**
 * Whether a sign-in method is a provider subscription rather than a key field.
 * `api-key` is the id a key-collecting login registers under; every other id
 * is a subscription method, matching the Models card.
 */
function isSubscriptionMethod(method: { readonly id: string }): boolean {
  return method.id !== 'api-key'
}

/** Tone of a notice row. */
type Tone = 'dim' | 'error' | 'success'

/** How a message submitted while a turn runs reaches the Agent. */
type SubmitMode = 'queue' | 'steer'

/**
 * What the terminal remembers about one todo line across writes. The todo
 * list carries no identity, so the content is the key: a reworded item is a
 * new one, and the item it replaced is gone.
 */
interface TodoHistory extends TodoTransition {
  /** The status the last write carried, which tells a status change from a repeat. */
  status: TodoItem['status']
}

/** One entry of a browsable list: the row the picker shows and the page behind it. */
interface BrowseRow {
  /** The picker row; its `value` identifies the entry across reopenings. */
  item: PickItem
  /** Heading of the entry's detail page. */
  heading: string
  /**
   * Read the entry's detail rows.
   * @returns the rows to show; a rejection is shown as the rows instead.
   */
  detail(): Promise<readonly string[]>
}

/** What the terminal could read about one model's reasoning efforts. */
type EffortLookup =
  /** The model declares efforts to choose between. */
  | { kind: 'ready'; reasoning: LlmModelReasoningInfo }
  /** No model catalog is composed in this profile. */
  | { kind: 'no-catalog' }
  /** Fewer than two declared efforts, so there is nothing to choose. */
  | { kind: 'no-efforts' }
  /** The catalog could not resolve the model; the message names the failure. */
  | { kind: 'failed'; message: string }

/** The interactive terminal application; one instance per process. */
export class TuiApp {
  private readonly tui: GuardedMainScreen
  private readonly header: Text
  private readonly chat = new Container()
  private readonly statusSlot = new Container()
  private readonly loader: Loader
  private readonly modalSlot = new Container()
  /** Draws the focused transcript section, and nothing at all while the keyboard is elsewhere. */
  private readonly inspector: InspectorPane
  private readonly editor: BarCursorEditor
  /** Holds {@link panel} exactly while the bound session has subagent rows. */
  private readonly panelSlot = new Container()
  private readonly panel: Text
  private readonly footer: Text
  private readonly modals: ModalQueue
  private readonly theme: BlockTheme
  private readonly toolBlocks = new Map<ToolCallId, ToolBlock>()
  private readonly toolArguments = new Map<ToolCallId, unknown>()
  private readonly submittedIds = new Set<string>()
  private readonly disposers: (() => void)[] = []
  /** Turn facts of the bound session's todo lines, keyed by content. */
  private todoTurns = new Map<string, TodoHistory>()
  /** The turn the last logged `turn/start` opened; 0 before the first one. */
  private turn = 0
  /** When the running turn started, from its `turn/start` envelope; absent between turns. */
  private turnStartedAt: number | undefined
  private pending: PendingAttachment[] = []
  /** The home directory the footer shortens the workspace path against. */
  private readonly home = homedir()
  /** The segments of the last footer draw, in bar order. */
  private segments: readonly FooterSegment[] = []
  /** Which region owns the keyboard. */
  private focus: FocusRegion = 'editor'
  /**
   * Where the transcript focus sits, kept across a page and a return to the
   * editor. A cursor the current transcript cannot place names nothing, which
   * is what a session change leaves behind.
   */
  private cursor: TranscriptCursor | undefined
  /** The section drawn with the focus gutter right now; set only by {@link TuiApp.settleFrame}. */
  private highlighted: HeldSection | undefined
  /** The segment the status bar holds; read only while the bar has focus. */
  private barSelection: FooterSegmentId = FIRST_FOOTER_SEGMENT
  /** The descendant listing the last reconcile produced, in pre-order. */
  private subagentEntries: readonly SubagentDescendantListEntry[] = []
  /** The rows of the last panel draw. */
  private panelView: SubagentPanelView = EMPTY_PANEL_VIEW
  /** The panel row the selection sits on; absent before the first row is drawn. */
  private panelSelection: SessionId | undefined
  /** Whether a live signal invalidated the listing since the last reconcile. */
  private subagentsStale = false
  /** Set while a listing is in flight, so two reconciles never overlap. */
  private listing = false
  /** Why the last listing failed; cleared by the next one that succeeds. */
  private listingFailure: string | undefined
  /** Disposer of the live-refresh tick while it is armed. */
  private ticker: (() => void) | undefined
  /** Disposer of the fade tick while it is armed. */
  private fadeTicker: (() => void) | undefined
  /** The visible-text tail of the message streaming right now; absent between messages. */
  private textTail: FadeTracker | undefined
  /** The reasoning tail of the message streaming right now; absent between messages. */
  private reasoningTail: FadeTracker | undefined
  /** The card fades running right now; each drops itself once it settles. */
  private readonly blockFades = new FadeRegistry()
  /** Set while {@link TuiApp.bind} replays a session's history, which draws its cards settled. */
  private replaying = false
  /** Whether this terminal draws a ramp at all, decided once at start. */
  private fading = false
  /** How streamed text is drawn; `none` until the background query settles. */
  private fadeStyle: FadeStyle = NO_FADE
  private bound: BoundSession
  private streaming: AssistantBlock | undefined
  private toolsExpanded = false
  /** Set while a session switch awaits the host, so input cannot target the session being left. */
  private switching = false
  /** Serializes Shift+Tab effort cycles so rapid presses apply in order. */
  private effortCycle = Promise.resolve()
  /** Serializes `/attach` reads so pending attachments keep the typed order. */
  private attaching = Promise.resolve()
  private usage: UsageTotals = EMPTY_USAGE
  private lastCtrlC = 0
  private stopped = false

  constructor(private readonly deps: TuiAppDeps) {
    const palette = deps.palette
    this.bound = deps.initial
    this.theme = { palette, toolPreviewLines: deps.toolPreviewLines }
    // The second parameter is `showHardwareCursor`: the editor draws no block
    // of its own, so the terminal's own cursor is the caret. Setting it here
    // rather than through `setShowHardwareCursor` keeps the constructor from
    // requesting a render before the tree has children.
    this.tui = new GuardedMainScreen(deps.terminal, true, (viewportTop, width) => this.settleFrame(viewportTop, width))
    this.header = new Text('', 0, 0)
    this.inspector = new InspectorPane(() => this.inspectorView(), { palette, previewLines: deps.focusPreviewLines })
    this.loader = new Loader(this.tui, palette.accent, palette.dim, 'thinking')
    // pi-tui starts the spinner interval in the constructor; it runs only while mounted.
    this.loader.stop()
    this.editor = new BarCursorEditor(this.tui, editorTheme(palette), { paddingX: 1 })
    this.editor.setAutocompleteProvider(editorCompletion({
      commands: () => this.completableCommands(),
      references: (query, quoted, signal) => this.references(query, quoted, signal),
    }))
    this.editor.onSubmit = (text) => { this.onSubmit(text) }
    this.panel = new Text('', 0, 0)
    this.footer = new Text('', 0, 0)
    this.modals = new ModalQueue({ tui: this.tui, slot: this.modalSlot, focusAfter: this.editor })
    const tree = [this.header, this.chat, this.statusSlot, this.modalSlot, this.inspector, this.editor, this.panelSlot, this.footer]
    for (const child of tree) this.tui.addChild(child)
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
        if (subject !== this.agent) {
          // Every Agent of this process reaches here, the subagent children
          // included; one of them changing state can add or drop a panel row.
          this.markSubagentsStale()
          return
        }
        this.setWorking(status === 'running')
      }),
      // Neither lifecycle edge carries the delegating parent, so they mark the
      // listing stale rather than adding or removing a row themselves; both
      // fire for out-of-process children too.
      ctx.on('subagent/start', () => { this.markSubagentsStale() }),
      ctx.on('subagent/end', () => { this.markSubagentsStale() }),
      ctx.on('approval/request', (request, next) => {
        if (request.agent !== this.agent) return next()
        return this.askApproval(request.toolName, request.reason, request.callId, request.signal)
      }),
      ctx.on('user-questions/request', (request, next) => {
        if (request.agent !== this.agent) return next()
        return this.askQuestions(request.questions, request.signal)
      }),
      this.tui.addInputListener(data => this.onKey(data)),
    )
    const projections = ctx.get('sessionProjections')
    if (projections !== undefined) {
      this.disposers.push(projections.onChanged((session) => {
        if (session === this.agent.session) this.refreshFooter()
        else this.markSubagentsStale()
      }))
    }
    this.deps.terminal.setTitle(`dsh · ${this.deps.cwd}`)
    this.tui.setFocus(this.editor)
    this.tui.start()
    this.deps.terminal.write(SET_BLINKING_BAR_CURSOR)
    this.startFade()
    this.bind(this.bound)
    if (initialPrompt !== undefined) this.submit(initialPrompt)
  }

  /**
   * Decide whether streamed text and tool cards fade at all, once per run,
   * from the palette, the environment, and the reduced-motion preference. A
   * terminal that draws no ramp tracks no tail, attaches no card fade, and
   * arms no fade tick, so streaming costs there exactly what it does with the
   * effect switched off.
   */
  private startFade(): void {
    const capability = resolveFadeCapability({
      paletteEnabled: this.deps.palette.enabled,
      env: this.deps.env,
      reducedMotion: this.deps.reducedMotion,
    })
    if (capability === 'none') return
    this.fading = true
    void this.resolveFadeRamp(capability)
  }

  /**
   * Ask the terminal for its background color, the only color a ramp can be
   * built from, and settle the drawing settings on the answer. A terminal
   * that answers nothing usable - the query timed out, or its reply did not
   * parse - leaves the two-level mode, which needs no colors. Text streamed
   * before the answer arrives draws as the Markdown component rendered it.
   * @param capability - how far this terminal encodes one ramp level.
   */
  private async resolveFadeRamp(capability: Exclude<FadeCapability, 'none'>): Promise<void> {
    const background = await this.tui.queryTerminalBackgroundColor({ timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS })
    if (this.stopped) return
    this.fadeStyle = background === undefined
      ? { capability: 'dim', ramp: [] }
      : { capability, ramp: buildFadeRamp(background, assumedForeground(background), this.deps.fadeSteps) }
  }

  /** Release the terminal and tell the host to exit; later calls are no-ops. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.updateTicker()
    this.updateFadeTicker()
    for (const dispose of this.disposers.splice(0)) dispose()
    this.modals.withdrawActive()
    this.loader.stop()
    // The shell that regains the terminal keeps whatever caret shape it was
    // left with, so the application gives the terminal's own shape back.
    this.deps.terminal.write(SET_TERMINAL_DEFAULT_CURSOR)
    this.tui.stop()
    this.deps.releaseInput()
    this.deps.onQuit(this.bound)
  }

  // ── session binding ─────────────────────────────────────────────────────

  /** Draw `next` as the terminal's session: clear the transcript and replay its history. */
  private bind(next: BoundSession): void {
    this.bound = next
    // The blocks the transcript focus names are about to be discarded, so the
    // keyboard goes back to the editor and the focus gutter with it.
    this.focusEditor()
    this.highlighted = undefined
    this.chat.clear()
    this.toolBlocks.clear()
    this.toolArguments.clear()
    this.submittedIds.clear()
    this.todoTurns.clear()
    this.turn = 0
    this.turnStartedAt = undefined
    this.streaming = undefined
    this.endFade()
    this.blockFades.clear()
    this.usage = EMPTY_USAGE
    this.pending = []
    this.subagentEntries = []
    this.panelSelection = undefined
    this.listingFailure = undefined
    this.subagentsStale = false
    this.setWorking(next.agent.status === 'running')
    // Replayed history describes what the session already did, so its cards
    // are drawn settled however long ago they were logged.
    this.replaying = true
    for (const event of next.history) this.onSessionEvent(next.agent.session, event)
    this.replaying = false
    this.refreshHeader()
    this.refreshFooter()
    this.refreshSubagentPanel()
    // Seeding the panel is a listing of its own, not an event handler's read.
    void this.reconcileSubagents()
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
    this.switching = true
    let next: BoundSession
    try {
      next = await open()
    } catch (error: unknown) {
      this.switching = false
      this.notice(`${verb} failed: ${describeFailure(error)}`, 'error')
      return
    }
    this.switching = false
    if (this.stopped) {
      // The user quit while the host was opening: the host already flushed the
      // session that was bound, and this one has nothing to keep.
      await next.dispose()
      return
    }
    const previous = this.bound
    const dropped = this.pending.length
    this.bind(next)
    this.notice(`${verb}: session ${next.agent.session.id}`, 'success')
    if (dropped > 0) this.notice(`${String(dropped)} pending attachment(s) stayed with the previous session`)
    try {
      await previous.dispose()
    } catch (error: unknown) {
      this.notice(`releasing the previous session failed: ${describeFailure(error)}`, 'error')
    }
  }

  private completableCommands(): CompletableCommand[] {
    const registry = this.deps.ctx.get('commands')
    const shared = registry?.list(this.agent) ?? []
    return [...LOCAL_COMMANDS, ...shared.map(command => ({
      name: command.name,
      description: command.description,
      ...command.input === undefined ? {} : { hint: command.input.hint },
    }))]
  }

  private async references(query: string, quoted: boolean, signal: AbortSignal): Promise<ReferenceItem[]> {
    try {
      return await this.listReferences(query, quoted, signal)
    } catch (error: unknown) {
      // The editor aborts a superseded request on the next keystroke; a
      // resolver failure is not worth a notice per keystroke either.
      if (!signal.aborted) this.notice(`@ completion failed: ${describeFailure(error)}`, 'error')
      return []
    }
  }

  private async listReferences(query: string, quoted: boolean, signal: AbortSignal): Promise<ReferenceItem[]> {
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
    const permission = this.deps.ctx.get('permissionPresets')?.current(this.agent.session)
    const started = this.turnStartedAt
    const inbox = this.agent.inbox
    this.segments = buildFooterSegments({
      selection: this.currentSelection(),
      ...permission === undefined ? {} : { permission },
      ...started === undefined ? {} : {
        turn: {
          number: this.turn,
          startedAt: started,
          elapsed: formatElapsed(this.deps.now() - started),
          queuedNextTurn: inbox.nextTurn.length,
          queuedNextStep: inbox.nextStep.length,
        },
      },
      usage: formatUsage(this.usage),
      facts: this.statusFacts(),
      cwd: this.deps.cwd,
      home: this.home,
      attachments: this.pending.map(attachment => ({ name: attachment.name, kind: attachment.block.type })),
    })
    const hints = this.agent.status === 'running'
      ? 'Enter queues for the next turn · Ctrl+S steers this turn · Esc stops it · Ctrl+O tool output · Ctrl+C twice quits'
      : 'Enter sends · Esc stops the turn · Ctrl+O tool output · Ctrl+C twice quits'
    this.footer.setText(renderFooter(this.segments, {
      palette,
      ...this.focus === 'bar' ? { selected: footerSelectionIndex(this.segments, this.barSelection) } : {},
      hints,
    }))
    this.tui.requestRender()
  }

  // ── subagent panel ──────────────────────────────────────────────────────

  /**
   * Redraw the panel from the last listing and a fresh sample of the live
   * facts. The panel is mounted exactly while it has a row, so the last
   * resident child leaving takes the panel with it — and the keyboard back to
   * the editor when the panel held it.
   */
  private refreshSubagentPanel(): void {
    const view = subagentPanelView({
      entries: this.subagentEntries,
      facts: this.subagentFacts(),
      now: this.deps.now(),
    })
    this.panelView = view
    const mounted = this.panelSlot.children.length > 0
    if (view.rows.length === 0) {
      this.panelSelection = undefined
      if (this.focus === 'panel') this.setFocus('editor')
      if (mounted) this.panelSlot.removeChild(this.panel)
    } else {
      if (!mounted) this.panelSlot.addChild(this.panel)
      const selected = this.panelSelectionIndex(view.rows)
      this.panelSelection = view.rows[selected]?.id
      this.panel.setText(renderSubagentPanel(view, {
        palette: this.deps.palette,
        ...this.focus === 'panel' ? { selected } : {},
        ...this.listingFailure === undefined ? {} : { failure: this.listingFailure },
      }))
    }
    this.updateTicker()
    this.tui.requestRender()
  }

  /**
   * Sample what this process knows about each listed child right now: whether
   * its Agent is running a turn, and one projection read for its timing and
   * token totals. Both reads are synchronous and touch no session log; a
   * child with no live Agent here contributes no facts.
   * @returns the facts by child session id.
   */
  private subagentFacts(): Map<SessionId, SubagentLiveFacts> {
    const facts = new Map<SessionId, SubagentLiveFacts>()
    const { ctx } = this.deps
    const agents = ctx.get('agents')
    const projections = ctx.get('sessionProjections')
    for (const entry of this.subagentEntries) {
      const child = agents?.get(entry.id)
      if (child === undefined) continue
      const live: SubagentLiveFacts = { running: child.status === 'running' }
      if (projections !== undefined) {
        const { values } = projections.snapshot(child.session, ['subagentTiming', 'tokenUsage'])
        const timing = values.subagentTiming
        if (timing !== undefined) {
          live.settledMs = timing.settledMs
          if (timing.active !== undefined) live.activeSince = timing.active.since
        }
        const usage = values.tokenUsage
        if (usage !== undefined) {
          live.usage = {
            inputTokens: usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
            outputTokens: usage.outputTokens,
          }
        }
      }
      facts.set(entry.id, live)
    }
    return facts
  }

  /**
   * Where the panel draws its selection.
   * @param rows - the rows of the current draw.
   * @returns the selected row's index, or 0 once the child behind it is gone.
   */
  private panelSelectionIndex(rows: readonly SubagentPanelRow[]): number {
    const index = rows.findIndex(row => row.id === this.panelSelection)
    return index === -1 ? 0 : index
  }

  /**
   * Mark the descendant listing out of date. The listing is never read from
   * the handler that noticed: the shared tick performs at most one read per
   * period, which bounds a burst of child events to one listing.
   */
  private markSubagentsStale(): void {
    if (this.deps.ctx.get('subagents') === undefined) return
    this.subagentsStale = true
    this.updateTicker()
  }

  /**
   * Re-read the descendant listing once. Two listings never overlap and a
   * result the terminal moved away from is discarded — both leave the listing
   * stale, so the next tick reads again. A rejection keeps the rows the last
   * good listing produced and records the reason without a fresh stale mark,
   * so a failing service is retried on the next live signal rather than once
   * per tick.
   */
  private async reconcileSubagents(): Promise<void> {
    const subagents = this.deps.ctx.get('subagents')
    if (subagents === undefined) return
    if (this.listing) {
      this.markSubagentsStale()
      return
    }
    this.listing = true
    this.subagentsStale = false
    const session = this.agent.session
    try {
      const entries = await subagents.listDescendants(session.id, new AbortController().signal)
      if (this.agent.session === session) {
        this.subagentEntries = entries
        this.listingFailure = undefined
      } else {
        this.markSubagentsStale()
      }
    } catch (error: unknown) {
      this.reportListingFailure(describeFailure(error))
    } finally {
      this.listing = false
      if (!this.stopped) this.refreshSubagentPanel()
    }
  }

  /**
   * Record why the listing failed. The panel carries the reason as one line
   * under its rows; the transcript hears only about a reason that changed, so
   * a service that keeps failing cannot fill the conversation with notices.
   * @param message - the failure text.
   */
  private reportListingFailure(message: string): void {
    if (this.listingFailure === message) return
    this.listingFailure = message
    this.notice(`subagent listing failed: ${message}`, 'error')
  }

  /**
   * Arm the live-refresh tick while something needs it and disarm it
   * otherwise: a running turn and a drawn row timing an open turn each need
   * one redraw per period, and a stale listing needs one reconcile. Exactly
   * one runs at a time, and a stopped app runs none.
   */
  private updateTicker(): void {
    if (!this.stopped && (this.turnStartedAt !== undefined || this.subagentsStale || this.panelView.ticking)) {
      this.ticker ??= this.deps.tick(() => { this.onTick() }, this.deps.liveRefreshMs)
      return
    }
    const ticker = this.ticker
    if (ticker === undefined) return
    this.ticker = undefined
    ticker()
  }

  /** One live-refresh period: reconcile a stale listing, then redraw what the clock moved. */
  private onTick(): void {
    if (this.subagentsStale) void this.reconcileSubagents()
    this.refreshSubagentPanel()
    if (this.turnStartedAt !== undefined) this.refreshFooter()
  }

  private statusFacts(): ReturnType<typeof readStatusFacts> {
    const projections = this.deps.ctx.get('sessionProjections')
    return projections === undefined ? {} : readStatusFacts(projections, this.agent.session)
  }

  /** Print `rows` as one block, or `empty` as a notice when there are none. */
  private showRows(rows: readonly string[], empty: string): void {
    if (rows.length === 0) {
      this.notice(empty)
      return
    }
    this.showBlock(rows)
  }

  /** Print `rows` into the transcript as one block. */
  private showBlock(rows: readonly string[]): void {
    this.chat.addChild(new Text(rows.join('\n'), 0, 1))
    this.tui.requestRender()
  }

  /**
   * Show one prompt through the modal queue. Whichever docked region holds
   * the keyboard gives it up first: the queue hands focus to the editor once
   * the prompt settles, and a bar or panel that still held it would swallow
   * every key typed after that.
   * @param prompt - the prompt to show.
   * @param signal - withdraws the prompt when aborted.
   * @returns the prompt's settled value.
   */
  private showModal<T>(prompt: ModalPrompt<T>, signal?: AbortSignal): Promise<T> {
    this.focusEditor()
    return this.modals.run(prompt, signal)
  }

  /**
   * Walk a list one entry at a time: the picker opens on `rows`, `Enter`
   * shows the picked entry's details, leaving the details returns to the
   * picker on the entry just read, and `Esc` at the picker returns to the
   * editor. An entry whose details cannot be read shows the failure in their
   * place, so the list stays open.
   * @param title - the picker heading.
   * @param rows - the entries to walk, in list order.
   * @param layout - how each row splits its width between label and description; the picker's default when omitted.
   */
  private async browse(title: string, rows: readonly BrowseRow[], layout?: SelectListLayoutOptions): Promise<void> {
    let visited: string | undefined
    for (;;) {
      const picked = await this.showModal(new PickPrompt(this.deps.palette, title, rows.map(row => row.item), {
        ...visited === undefined ? {} : { current: visited },
        ...layout === undefined ? {} : { layout },
      }))
      if (picked === undefined) return
      const row = rows.find(candidate => candidate.item.value === picked.value)
      /* v8 ignore next -- the picker settles with one of the rows it was handed */
      if (row === undefined) return
      visited = picked.value
      await this.showDetail(row)
    }
  }

  /**
   * Show one entry's detail page, with a failed read printed in place of its
   * rows. Both the picker loop and the subagent panel enter a page this way.
   * @param row - the entry the user opened.
   */
  private async showDetail(row: BrowseRow): Promise<void> {
    await this.showModal(new DetailPrompt(this.deps.palette, row.heading, await this.detailRows(row)))
  }

  /**
   * The rows one list entry's detail page shows.
   * @param row - the entry the user opened.
   * @returns its detail rows, or the failure text when the read fails.
   */
  private async detailRows(row: BrowseRow): Promise<readonly string[]> {
    try {
      return await row.detail()
    } catch (error: unknown) {
      /* v8 ignore next -- subagentDetail, the only resolver today, reports its own read failures as rows */
      return [describeFailure(error)]
    }
  }

  /**
   * Walk the agent's todo list: one row per item, and entering a row shows
   * that item in full with its position, the list's counts by status, and the
   * turns it was first written in and last changed status in.
   */
  private async browseTodos(): Promise<void> {
    const items = this.statusFacts().todos?.items ?? []
    const choices = listTodoChoices(this.deps.ctx, this.agent.session)
    if (choices.length === 0) {
      this.notice('no todos yet')
      return
    }
    // Nothing is awaited between the two reads above, so both see one list:
    // the counts and position an entered page prints agree with the rows drawn.
    const tracked = items.map(item => this.todoTurns.get(item.content))
    await this.browse('Todos', choices.map((choice): BrowseRow => ({
      item: { value: String(choice.index), label: choice.label, description: choice.description },
      heading: `Todo ${String(choice.index + 1)}`,
      detail: () => Promise.resolve(todoDetail(items, choice.index, tracked[choice.index])),
    })), TODO_ROW_LAYOUT)
  }

  /**
   * The browsable entry behind one subagent row: the same detail page the
   * `/subagents` list and the live panel open.
   * @param choice - the listing row.
   * @returns the entry.
   */
  private subagentBrowseRow(choice: SubagentChoice): BrowseRow {
    return {
      item: { value: choice.id, label: choice.label, description: choice.description },
      heading: choice.id,
      detail: () => subagentDetail(this.deps.ctx, choice, new AbortController().signal),
    }
  }

  /**
   * Open the selected panel row's session details, then give the keyboard
   * back to the panel unless its last row left while the page was open. A
   * diagnostic row explains itself in the panel and opens nothing.
   */
  private async openPanelRow(): Promise<void> {
    const rows = this.panelView.rows
    const row = rows[this.panelSelectionIndex(rows)]
    /* v8 ignore next -- the panel answers keys only while it has rows to select from */
    if (row === undefined) return
    if (!row.enterable) return
    const entry = this.subagentEntries.find(candidate => candidate.id === row.id)
    /* v8 ignore next -- every drawn row comes from the entries of the last listing */
    if (entry === undefined) return
    await this.showDetail(this.subagentBrowseRow(subagentChoice(entry)))
    if (this.panelView.rows.length > 0) this.focusRegion('panel')
  }

  private async settings(argument: string): Promise<void> {
    const [first, second, ...rest] = argument === '' ? [] : argument.split(/\s+/u)
    if (first === undefined) {
      this.showRows(listSettings(this.deps.ctx), 'no settings namespaces are registered')
      return
    }
    if (first === 'reset') {
      if (second === undefined) {
        this.notice('usage: /settings reset <namespace>', 'error')
        return
      }
      this.notice(await resetSetting(this.deps.ctx, second), 'success')
      return
    }
    if (second === undefined) {
      this.showRows(showSetting(this.deps.ctx, first), `settings ${first} is empty`)
      return
    }
    const value = rest.join(' ')
    if (value === '') {
      this.notice('usage: /settings <namespace> <path> <value>', 'error')
      return
    }
    this.notice(await setSetting(this.deps.ctx, first, second, value), 'success')
  }

  private showStatus(): void {
    this.showBlock(statusReport(this.statusFacts()))
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
    // Ctrl+C and Ctrl+D keep their global meaning at the status bar, and give
    // the keyboard back to the editor on the way.
    if (matchesKey(data, 'ctrl+c')) {
      this.focusEditor()
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
      this.focusEditor()
      if (this.editor.getText() === '') this.stop()
      return { consume: true }
    }
    if (this.focus === 'bar') return this.onStatusBarKey(data)
    if (this.focus === 'panel') return this.onPanelKey(data)
    if (this.focus === 'transcript') return this.onTranscriptKey(data)
    // The regions stack above and below the editor: Shift+Up leaves it for the
    // conversation, Shift+Down for the regions docked under it.
    if (matchesKey(data, 'shift+up')) {
      this.focusTranscript()
      return { consume: true }
    }
    if (matchesKey(data, 'shift+down')) {
      this.focusBelowEditor()
      return { consume: true }
    }
    if (matchesKey(data, 'escape') && !this.editor.isShowingAutocomplete()) {
      if (this.agent.status === 'running') {
        this.agent.cancel({ kind: 'user' }, { keepInbox: true })
        const queued = this.agent.inbox.nextTurn.length + this.agent.inbox.nextStep.length
        this.notice(queued === 0 ? 'stopping the turn…' : `stopping the turn… ${String(queued)} queued message(s) stay queued`)
      }
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+s')) {
      this.onSubmit(this.editor.getText(), 'steer')
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+o')) {
      this.toggleTools()
      return { consume: true }
    }
    if (matchesKey(data, 'shift+tab')) {
      this.effortCycle = this.effortCycle.then(
        () => this.cycleEffort(),
        /* v8 ignore next -- cycleEffort handles its own failures; this recovers a rejected chain */
        () => this.cycleEffort(),
      )
      return { consume: true }
    }
    return undefined
  }

  /**
   * Answer the keys every non-editor region answers the same way: `Escape`
   * hands the keyboard back to the editor, `Shift+Up` names the conversation,
   * and `Shift+Down` the status bar.
   * @param data - the raw key bytes.
   * @returns the consume marker when the key named a region, `undefined` when the focused region owns the key.
   */
  private onRegionKey(data: string): { consume: true } | undefined {
    if (matchesKey(data, 'escape')) {
      this.focusEditor()
      return { consume: true }
    }
    if (matchesKey(data, 'shift+up')) {
      this.focusTranscript()
      return { consume: true }
    }
    if (matchesKey(data, 'shift+down')) {
      this.focusBar()
      return { consume: true }
    }
    return undefined
  }

  /**
   * Answer one key while the status bar holds focus. Every key is consumed
   * here, so nothing typed at the bar reaches the editor.
   * @param data - the raw key bytes.
   * @returns the consume marker the input listener returns.
   */
  private onStatusBarKey(data: string): { consume: true } {
    const region = this.onRegionKey(data)
    if (region !== undefined) return region
    if (matchesKey(data, 'up')) {
      // The bar is the bottom of the stack, so Up leaves it for the panel when
      // one is drawn and for the conversation otherwise.
      if (this.panelView.rows.length > 0) this.focusPanel(this.panelView.rows.length - 1)
      else this.focusTranscript()
      return { consume: true }
    }
    if (matchesKey(data, 'left') || matchesKey(data, 'shift+tab')) {
      this.moveStatusBar(-1)
      return { consume: true }
    }
    if (matchesKey(data, 'right') || matchesKey(data, 'tab')) {
      this.moveStatusBar(1)
      return { consume: true }
    }
    if (matchesKey(data, 'enter')) this.openSegment(this.barSelection)
    return { consume: true }
  }

  /**
   * Answer one key while the transcript holds focus. Every key is consumed
   * here, so nothing typed while reading the conversation reaches the editor;
   * `Ctrl+C` and `Ctrl+D` never reach this far and keep their global meaning.
   * @param data - the raw key bytes.
   * @returns the consume marker the input listener returns.
   */
  private onTranscriptKey(data: string): { consume: true } {
    const region = this.onRegionKey(data)
    if (region !== undefined) return region
    const section = this.focusedSection()
    /* v8 ignore next 5 -- only a session change empties the transcript, and it hands the keyboard back first */
    if (section === undefined) {
      // Nothing left to select: the editor takes the keyboard back.
      this.focusEditor()
      return { consume: true }
    }
    const { cursor, blocks } = section
    if (matchesKey(data, 'up')) {
      this.moveCursor(moveBlock(cursor, -1, blocks))
      return { consume: true }
    }
    if (matchesKey(data, 'down')) {
      // Past the newest block the stack continues under the editor.
      if (cursor.block === blocks.length - 1) this.focusBelowEditor()
      else this.moveCursor(moveBlock(cursor, 1, blocks))
      return { consume: true }
    }
    if (matchesKey(data, 'left')) {
      this.moveCursor(movePart(cursor, -1, blocks))
      return { consume: true }
    }
    if (matchesKey(data, 'right')) {
      this.moveCursor(movePart(cursor, 1, blocks))
      return { consume: true }
    }
    if (matchesKey(data, 'enter')) this.openSection(section)
    return { consume: true }
  }

  /**
   * Answer one key while the subagent panel holds focus. Every key is
   * consumed here; `Ctrl+C` and `Ctrl+D` never reach this far, keeping their
   * global meaning.
   * @param data - the raw key bytes.
   * @returns the consume marker the input listener returns.
   */
  private onPanelKey(data: string): { consume: true } {
    const region = this.onRegionKey(data)
    if (region !== undefined) return region
    if (matchesKey(data, 'up')) {
      // Above the first row the stack continues in the conversation.
      if (this.panelSelectionIndex(this.panelView.rows) === 0) this.focusTranscript()
      else this.movePanel(-1)
      return { consume: true }
    }
    if (matchesKey(data, 'down')) {
      if (this.panelSelectionIndex(this.panelView.rows) === this.panelView.rows.length - 1) this.focusBar()
      else this.movePanel(1)
      return { consume: true }
    }
    if (matchesKey(data, 'enter')) this.navigate('subagent details', () => this.openPanelRow())
    return { consume: true }
  }

  /**
   * Open one page a docked region's `Enter` leads to, reporting a failure as
   * a notice instead of an unhandled rejection.
   * @param label - what the notice calls the page.
   * @param open - shows the page and settles when the user leaves it.
   */
  private navigate(label: string, open: () => Promise<void>): void {
    open().catch((error: unknown) => { this.notice(`${label} failed: ${describeFailure(error)}`, 'error') })
  }

  /**
   * Answer `Enter` on the held segment: a segment whose fact the app has a
   * navigable page for opens that page, and every other segment prints its
   * detail rows into the transcript.
   * @param selected - the segment the bar holds.
   */
  private openSegment(selected: FooterSegmentId): void {
    const segment = this.segments[footerSelectionIndex(this.segments, selected)]
    /* v8 ignore next -- the bar draws at least the model segment, and an absent id falls back to it */
    if (segment === undefined) return
    if (segment.detail.kind === 'rows') {
      this.showBlock(segment.detail.rows)
      return
    }
    // The todo list is the one page the bar hands to the app today.
    this.navigate('/todos', () => this.browseTodos())
  }

  /**
   * Move the bar's selection, wrapping at both ends.
   * @param step - 1 for the next segment, -1 for the previous one.
   */
  private moveStatusBar(step: number): void {
    const count = this.segments.length
    const next = this.segments[(footerSelectionIndex(this.segments, this.barSelection) + step + count) % count]
    /* v8 ignore next -- the wrapped index stays inside the bar's own segments */
    if (next !== undefined) this.barSelection = next.id
    this.refreshFooter()
  }

  /**
   * Move the panel's selection, stopping at both ends of the drawn rows. The
   * rows behind a `+<n> more` row are not selectable; `/subagents` walks the
   * complete tree.
   * @param step - 1 for the next row, -1 for the previous one.
   */
  private movePanel(step: number): void {
    const rows = this.panelView.rows
    const next = rows[Math.max(0, Math.min(this.panelSelectionIndex(rows) + step, rows.length - 1))]
    /* v8 ignore next -- the clamped index stays inside the panel's own rows */
    if (next !== undefined) this.panelSelection = next.id
    this.refreshSubagentPanel()
  }

  /** Give the keyboard to the status bar, starting at its first segment. */
  private focusBar(): void {
    this.barSelection = FIRST_FOOTER_SEGMENT
    this.focusRegion('bar')
  }

  /**
   * Give the keyboard to the subagent panel on one of its rows.
   * @param index - the row the selection lands on.
   */
  private focusPanel(index: number): void {
    this.panelSelection = this.panelView.rows[index]?.id
    this.focusRegion('panel')
  }

  /**
   * Give the keyboard to the region under the editor: the subagent panel's
   * first row while the panel is drawn, and the status bar otherwise.
   */
  private focusBelowEditor(): void {
    if (this.panelView.rows.length > 0) this.focusPanel(0)
    else this.focusBar()
  }

  /**
   * Give the keyboard to the transcript on its newest block. A session with
   * nothing to inspect yet says so and leaves the keyboard where it was.
   */
  private focusTranscript(): void {
    const cursor = enterNewest(navigableBlocks(this.chat.children))
    if (cursor === undefined) {
      this.notice('nothing in the transcript to inspect yet')
      return
    }
    this.cursor = cursor
    this.focusRegion('transcript')
    this.tui.requestRender()
  }

  /**
   * Put the transcript focus on another section.
   * @param cursor - where the focus moves to.
   */
  private moveCursor(cursor: TranscriptCursor): void {
    this.cursor = cursor
    this.tui.requestRender()
  }

  /**
   * Read the remembered cursor against the transcript as it is drawn right
   * now: it grew parts and blocks since the cursor was taken, and a session
   * change replaced the blocks it named altogether. The cursor itself is left
   * alone, so a page and a trip through the editor come back to the same
   * section; {@link TuiApp.focusTranscript} replaces it.
   * @returns the section the cursor names, or undefined when the transcript
   * has nothing to hold it.
   */
  private focusedSection(): FocusedSection | undefined {
    const blocks = navigableBlocks(this.chat.children)
    const cursor = this.cursor === undefined ? undefined : clampCursor(this.cursor, blocks)
    if (cursor === undefined) return undefined
    const block = blocks[cursor.block]
    const part = block?.parts()[cursor.part]
    /* v8 ignore next -- clampCursor settles on a block that carries the part it names */
    if (block === undefined || part === undefined) return undefined
    return { cursor, blocks, block, part }
  }

  /**
   * Open the focused section as a read-only page and come back to it.
   * @param section - the focused section.
   */
  private openSection(section: FocusedSection): void {
    const { cursor, blocks } = section
    const prompt = new DetailPrompt(this.deps.palette, sectionHeading(cursor, blocks), section.part.rows)
    this.navigate('section', async () => {
      await this.showModal(prompt)
      this.focusRegion('transcript')
    })
  }

  /**
   * The focused section as the docked inspector draws it.
   * @returns the view, or undefined while the keyboard is not in the
   * transcript, which draws no inspector at all.
   */
  private inspectorView(): InspectorView | undefined {
    const section = this.focusedSection()
    if (section === undefined || this.focus !== 'transcript') return undefined
    const { cursor, blocks } = section
    return {
      heading: sectionHeading(cursor, blocks),
      parts: partLabels(cursor, blocks),
      rows: section.part.rows,
      highlighted: this.highlighted !== undefined,
    }
  }

  /** Hand the keyboard back to the editor; a no-op while the editor already has it. */
  private focusEditor(): void {
    this.focusRegion('editor')
  }

  /**
   * Move the keyboard between the regions and redraw the docked ones, so the
   * region losing focus stops drawing its selection.
   * @param region - the region that takes the keyboard.
   */
  private focusRegion(region: FocusRegion): void {
    if (this.focus === region) return
    this.setFocus(region)
    this.refreshSubagentPanel()
  }

  /**
   * Give the keyboard to `region` and redraw the bar. The caller redraws the
   * panel; the panel's own refresh calls this when its last row leaves.
   * @param region - the region that takes the keyboard.
   */
  private setFocus(region: FocusRegion): void {
    this.focus = region
    // pi-tui accepts a null focus, so the editor stops drawing its cursor
    // while another region owns the keyboard.
    this.tui.setFocus(region === 'editor' ? this.editor : null)
    this.refreshFooter()
  }

  private toggleTools(): void {
    this.toolsExpanded = !this.toolsExpanded
    for (const block of this.toolBlocks.values()) block.setExpanded(this.toolsExpanded)
    this.tui.requestRender()
  }

  /**
   * Handle a submitted editor line: a `/` line runs a command, anything else
   * becomes a user message.
   * @param raw - the editor text.
   * @param mode - how a message reaches a running Agent: `queue` waits for the next turn, `steer` enters the current one.
   */
  private onSubmit(raw: string, mode: SubmitMode = 'queue'): void {
    const text = raw.trim()
    if (text === '') return
    if (this.switching) {
      this.notice('wait for the session switch to finish', 'error')
      return
    }
    this.editor.setText('')
    this.editor.addToHistory(text)
    if (text.startsWith('/')) {
      const name = text.slice(0, text.indexOf(' ') === -1 ? undefined : text.indexOf(' '))
      this.runCommand(text).catch((error: unknown) => { this.notice(`${name} failed: ${describeFailure(error)}`, 'error') })
      return
    }
    this.submit(text, mode)
  }

  private submit(text: string, mode: SubmitMode = 'queue'): void {
    const agent = this.agent
    const attachments = this.pending.splice(0)
    const message: UserMessage = createUserMessage({
      content: [...attachments.map(attachment => attachment.block), { type: 'text', text }],
      source: { kind: 'user' },
    })
    this.submittedIds.add(message.id)
    const shown = attachments.length === 0 ? text : `${text}\n${attachments.map(attachment => `[${attachment.block.type}: ${attachment.name}]`).join(' ')}`
    this.chat.addChild(new UserBlock(this.theme, shown, this.turn))
    if (agent.status !== 'running') {
      agent.followup(message)
    } else if (mode === 'steer') {
      agent.steer(message)
      this.notice('steering the running turn: it reaches the next step')
    } else {
      agent.followup(message)
      this.notice('queued for the next turn (Ctrl+S steers the running turn instead)')
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
      case 'effort':
        await this.chooseCurrentEffort(argument)
        return
      case 'sessions':
        await this.chooseSession()
        return
      case 'new':
        await this.switchSession(() => this.deps.host.create(), 'new session')
        return
      case 'fork': {
        const turn = argument === '' ? undefined : Number(argument)
        if (turn !== undefined && !(Number.isSafeInteger(turn) && turn > 0)) {
          this.notice('usage: /fork · /fork <turn>', 'error')
          return
        }
        await this.switchSession(() => this.deps.host.fork(this.agent.session.id, turn), 'forked')
        return
      }
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
      case 'login':
        await this.signIn(argument, true)
        return
      case 'signin':
        await this.signIn(argument)
        return
      case 'export':
        await this.exportSession(argument)
        return
      case 'status':
        this.showStatus()
        return
      case 'todos':
        await this.browseTodos()
        return
      case 'outline':
        this.showRows(sessionOutline(this.deps.ctx, this.agent.session), 'no completed turn yet')
        return
      case 'deliverables':
        this.showRows(await listDeliverables(this.deps.ctx, this.agent.session.id, new AbortController().signal), 'nothing presented yet')
        return
      case 'subagents': {
        const choices = await listSubagentChoices(this.deps.ctx, this.agent.session.id, new AbortController().signal)
        if (choices.length === 0) {
          this.notice('no subagent sessions')
          return
        }
        await this.browse('Subagent sessions', choices.map(choice => this.subagentBrowseRow(choice)))
        return
      }
      case 'settings':
        await this.settings(argument)
        return
      case 'plugins':
        this.showRows(listPlugins(this.deps.ctx), 'no plugins are listed')
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
      'While a turn runs: Enter queues for the next turn · Ctrl+S steers the running turn',
      '@ completes paths and sessions (workspace, ../, ~/, absolute) · / completes commands',
      'Esc stops the running turn · Ctrl+O expands or collapses tool output',
      'Shift+Tab cycles the current model\'s reasoning effort for the next request',
      'Shift+Up focuses the transcript, Shift+Down the subagent panel or the status bar',
      'Then ↑ ↓ move between blocks, panel rows, and the bar; ← → move between a block\'s parts or the bar\'s segments',
      'Enter opens the focused section or segment, Esc returns to the input',
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
      const current = this.currentSelection()
      const picked = await this.showModal(new PickPrompt(this.deps.palette, 'Model for the next request', items, {
        current: `${current.provider}/${current.model}`,
      }))
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
   * Offer the model's reasoning efforts when it declares more than one. The
   * picker opens on the effort already in force for that exact model.
   * @param model - the model the user picked.
   * @returns the chosen effort, undefined for the provider default, or null when dismissed or the model is unknown.
   */
  private async chooseEffort(model: ModelSelection): Promise<ReasoningEffortId | undefined | null> {
    const lookup = await this.lookupEfforts(model)
    // The lookup can settle after the user quits; the model change dies with it.
    if (this.stopped) return null
    if (lookup.kind === 'failed') {
      this.notice(lookup.message, 'error')
      return null
    }
    if (lookup.kind !== 'ready') return undefined
    const current = this.currentSelection()
    const sameModel = current.provider === model.provider && current.model === model.model
    const picked = await this.showModal(new PickPrompt(
      this.deps.palette,
      `Reasoning effort · ${model.provider}/${model.model}`,
      effortItems(lookup.reasoning),
      {
        body: ['Esc cancels the model change'],
        current: (sameModel ? current.reasoningEffort : undefined) ?? PROVIDER_DEFAULT,
      },
    ))
    if (picked === undefined) return null
    return picked.value === PROVIDER_DEFAULT ? undefined : ReasoningEffortId(picked.value)
  }

  /**
   * Choose the bound model's reasoning effort for the next request: an empty
   * argument opens the picker on the effort in force, `default` restores the
   * provider default, and anything else names a declared effort.
   * @param argument - a declared effort id, `default`, or empty.
   */
  private async chooseCurrentEffort(argument: string): Promise<void> {
    const current = this.currentSelection()
    const lookup = await this.lookupEfforts(current)
    // The lookup can settle after the user quits.
    if (this.stopped) return
    if (lookup.kind !== 'ready') {
      this.reportEffortLookup(lookup, current)
      return
    }
    const { reasoning } = lookup
    if (argument !== '') {
      const matched = matchEffort(reasoning, argument)
      if (matched === null) {
        const declared = reasoning.efforts.map(effort => effort.id).join(', ')
        this.notice(`${current.provider}/${current.model} has no effort "${argument}" (${declared}, default)`, 'error')
        return
      }
      this.applyEffort(current, matched)
      return
    }
    const picked = await this.showModal(new PickPrompt(
      this.deps.palette,
      `Reasoning effort · ${current.provider}/${current.model}`,
      effortItems(reasoning),
      {
        body: [effortHint(reasoning, current.reasoningEffort)],
        current: current.reasoningEffort ?? PROVIDER_DEFAULT,
      },
    ))
    if (picked === undefined) return
    this.applyEffort(current, picked.value === PROVIDER_DEFAULT ? undefined : ReasoningEffortId(picked.value))
  }

  /**
   * Advance the bound selection to the next reasoning effort, wrapping through
   * the provider default. A model with fewer than two efforts has nothing to cycle.
   */
  private async cycleEffort(): Promise<void> {
    if (this.stopped || this.modals.isActive()) return
    const current = this.currentSelection()
    const lookup = await this.lookupEfforts(current)
    // The lookup can settle after the user quits, past the entry guard.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- The entry guard's narrowing does not survive the await above.
    if (this.stopped) return
    if (lookup.kind !== 'ready') {
      this.reportEffortLookup(lookup, current)
      return
    }
    const steps: Array<ReasoningEffortId | undefined> = [undefined, ...lookup.reasoning.efforts.map(effort => effort.id)]
    const index = steps.findIndex(step => step === current.reasoningEffort)
    this.applyEffort(current, steps[index === -1 ? 1 : (index + 1) % steps.length])
  }

  /**
   * Read what one model declares about reasoning effort.
   * @param model - the model to resolve.
   * @returns the declared efforts, or why the terminal has none to offer.
   */
  private async lookupEfforts(model: ModelSelection): Promise<EffortLookup> {
    const llm = this.deps.ctx.get('llm')
    if (llm === undefined) return { kind: 'no-catalog' }
    let reasoning: LlmModelReasoningInfo | undefined
    try {
      reasoning = (await llm.resolveModelInfo(model.provider, model.model)).reasoning
    } catch (error: unknown) {
      return { kind: 'failed', message: `${model.provider}/${model.model}: ${describeFailure(error)}` }
    }
    if (reasoning === undefined || reasoning.efforts.length < 2) return { kind: 'no-efforts' }
    return { kind: 'ready', reasoning }
  }

  /**
   * Print why a model offers no effort to choose.
   * @param lookup - a lookup that resolved no efforts.
   * @param model - the model it was read for.
   */
  private reportEffortLookup(lookup: Exclude<EffortLookup, { kind: 'ready' }>, model: ModelSelection): void {
    switch (lookup.kind) {
      case 'no-catalog':
        this.notice('no model catalog is composed', 'error')
        return
      case 'failed':
        this.notice(lookup.message, 'error')
        return
      case 'no-efforts':
        this.notice(`${model.provider}/${model.model} has no selectable reasoning efforts`)
        return
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(lookup, 'effort lookup')
    }
  }

  /**
   * Install one reasoning effort on the bound selection for the next request.
   * @param model - the provider and model the effort belongs to.
   * @param effort - the chosen effort, or undefined for the provider default.
   */
  private applyEffort(model: ModelSelection, effort: ReasoningEffortId | undefined): void {
    this.bound.selection.current = effort === undefined
      ? { provider: model.provider, model: model.model }
      : { provider: model.provider, model: model.model, reasoningEffort: effort }
    this.notice(effort === undefined
      ? 'effort: provider default from the next request'
      : `effort ${effort} from the next request`, 'success')
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

  private async chooseSession(): Promise<void> {
    this.notice('listing sessions…')
    const choices = await listSessionChoices(this.deps.ctx, this.agent.session.id, new AbortController().signal)
    if (choices.length === 0) {
      this.notice('no persisted sessions are listed by the composed query engine', 'error')
      return
    }
    const items = choices.map((choice): PickItem => ({ value: choice.id, ...describeSession(choice) }))
    const picked = await this.showModal(new PickPrompt(this.deps.palette, 'Switch to a session', items))
    const target = choices.find(choice => choice.id === picked?.value)
    if (target === undefined || target.current) return
    await this.switchSession(() => this.deps.host.resume(target.id), 'resumed')
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

  /**
   * Run one `/attach` after every `/attach` typed before it. Each command
   * reaches this from its own unawaited dispatch, so two of them read their
   * files at the same time and the slower read would otherwise land second
   * whichever file the user named first. Queueing them keeps `pending`, the
   * footer count, and the notices in the order the user typed.
   * @param argument - the command argument: a path, `clear`, or nothing.
   * @returns when this attachment has settled.
   */
  private attach(argument: string): Promise<void> {
    // `attachNow` reports every failure through a notice and never rejects,
    // so one failed attachment cannot break the queue for the next one.
    const settled = this.attaching.then(() => this.attachNow(argument))
    this.attaching = settled
    return settled
  }

  private async attachNow(argument: string): Promise<void> {
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

  /**
   * Start a provider sign-in through the authorization seam.
   * @param argument - a flow key that skips the provider picker, or empty to pick.
   * @param subscriptionOnly - when true, hide key-collecting `api-key` methods so `/login` matches the Models card.
   */
  private async signIn(argument: string, subscriptionOnly = false): Promise<void> {
    const authorization = this.deps.ctx.get('authorization')
    if (authorization === undefined) {
      this.notice('no sign-in flows are composed', 'error')
      return
    }
    const listed = authorization.list()
    const entries = subscriptionOnly
      ? listed
        .map(entry => ({ key: entry.key, label: entry.label, methods: entry.methods.filter(isSubscriptionMethod) }))
        .filter(entry => entry.methods.length > 0)
      : listed
    if (entries.length === 0) {
      this.notice(subscriptionOnly ? 'no provider offers a subscription sign-in' : 'no provider offers a sign-in flow')
      return
    }
    let key = argument
    if (key === '') {
      const picked = await this.showModal(new PickPrompt(this.deps.palette, subscriptionOnly ? 'Log in with' : 'Sign in to', entries.map(entry => ({
        value: entry.key,
        label: entry.label,
        description: entry.methods.map(method => method.label).join(', '),
      }))))
      if (picked === undefined) return
      key = picked.value
    }
    const entry = entries.find(candidate => candidate.key === key)
    if (entry === undefined) {
      this.notice(subscriptionOnly ? `no subscription sign-in for ${key}` : `no sign-in flow for ${key}`, 'error')
      return
    }
    let method = entry.methods[0]?.id
    if (entry.methods.length > 1) {
      const picked = await this.showModal(new PickPrompt(this.deps.palette, `Sign-in method for ${entry.label}`, entry.methods.map(candidate => ({ value: candidate.id, label: candidate.label }))))
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
            if (notice.url !== undefined && notice.openInBrowser === true && this.deps.openUrl !== undefined) {
              void this.deps.openUrl(notice.url).catch((error: unknown) => {
                this.notice(`could not open sign-in page: ${describeFailure(error)}`, 'error')
              })
            }
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
      const picked = await this.showModal(new PickPrompt(this.deps.palette, prompt.message, prompt.options.map(option => ({
        value: option.id,
        label: option.label,
        ...option.description === undefined ? {} : { description: option.description },
      }))), prompt.signal)
      if (picked === undefined) throw new AuthorizationDeclinedError('the sign-in prompt was dismissed')
      return picked.value
    }
    const answer = await this.showModal(new QuestionPrompt(this.deps.palette, {
      id: 'authorization',
      question: prompt.message,
      ...prompt.placeholder === undefined ? {} : { detail: prompt.placeholder },
    }), prompt.signal)
    if (answer?.custom === undefined) throw new AuthorizationDeclinedError('the sign-in prompt was dismissed')
    return answer.custom
  }

  private async exportSession(argument: string): Promise<void> {
    this.notice('/export: writing the archive…')
    try {
      const path = await exportSessionZip(this.deps.ctx, this.agent.session.id, argument === '' ? this.deps.cwd : argument, new AbortController().signal)
      this.notice(`exported ${path}`, 'success')
    } catch (error: unknown) {
      this.notice(`export failed: ${describeFailure(error)}`, 'error')
    }
  }

  // ── seams ───────────────────────────────────────────────────────────────

  private async askApproval(
    toolName: string,
    reason: string | undefined,
    callId: ToolCallId | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ApprovalOutcome> {
    // The logged call, when the request names one, shows what the tool is about to do.
    const args = callId === undefined ? undefined : this.toolArguments.get(callId)
    const detail = args === undefined ? [] : toolCallText(JSON.stringify(args), this.presentCall(toolName, args)).lines
    const outcome = await this.showModal(new ApprovalPrompt(this.deps.palette, toolName, reason, detail), signal)
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
      const answer = await this.showModal(new QuestionPrompt(this.deps.palette, question), signal)
      if (answer === null) throw new Error('the question was dismissed')
      answers.push(answer)
    }
    return { answers }
  }

  // ── live stream ─────────────────────────────────────────────────────────

  private streamingBlock(): AssistantBlock {
    if (this.streaming === undefined) {
      this.streaming = new AssistantBlock(this.theme, this.turn)
      this.chat.addChild(this.streaming)
    }
    return this.streaming
  }

  /**
   * Take one visible text delta: the block draws it and the tail of that same
   * block ages it. The tail is created with the first delta of a message, so
   * a block rebuilt from history or committed from the log never carries one.
   * @param delta - the streamed text delta.
   */
  private appendStreamedText(delta: string): void {
    const block = this.streamingBlock()
    block.appendText(delta)
    if (!this.fading) return
    if (this.textTail === undefined) {
      this.textTail = this.createTail()
      block.setFade(this.tailRender(() => this.textTail))
    }
    this.textTail.append(delta)
    this.updateFadeTicker()
  }

  /**
   * Take one reasoning delta, which fades in on its own tail: the reasoning
   * and the visible text of one message stream at different times and each
   * brightens from the moment its own words appeared.
   * @param delta - the streamed reasoning delta.
   */
  private appendStreamedReasoning(delta: string): void {
    const block = this.streamingBlock()
    block.appendReasoning(delta)
    if (!this.fading) return
    if (this.reasoningTail === undefined) {
      this.reasoningTail = this.createTail()
      block.setReasoningFade(this.tailRender(() => this.reasoningTail))
    }
    this.reasoningTail.append(delta)
    this.updateFadeTicker()
  }

  /**
   * Start tracking one streaming region against the application's clock.
   * @returns the tail deltas are appended to.
   */
  private createTail(): FadeTracker {
    return new FadeTracker({
      steps: this.deps.fadeSteps,
      stepMs: this.deps.fadeStepMs,
      now: () => this.deps.now(),
    })
  }

  /**
   * The live view of one tail the streaming block reads per render.
   * @param tail - reads the field the tail is held in, so a render after the
   * message settled sees the empty tail rather than the one it was given.
   * @returns the spans, the drawing settings, and the width-change flush.
   */
  private tailRender(tail: () => FadeTracker | undefined): FadeRender {
    return {
      spans: () => tail()?.spans() ?? [],
      style: () => this.fadeStyle,
      steps: this.deps.fadeSteps,
      flush: () => { this.flushFade() },
    }
  }

  /**
   * Fade one group of a card's rows in from the terminal background, from the
   * instant the log carried them. A terminal that draws no ramp and a session
   * being replayed fade nothing.
   * @param attach - hands the fade to the block that draws those rows.
   */
  private fadeBlock(attach: (fade: BlockFade) => void): void {
    if (!this.fading || this.replaying) return
    const clock = new BlockFadeClock({
      bornAt: this.deps.now(),
      stepMs: this.deps.fadeStepMs,
      steps: this.deps.fadeSteps,
      now: () => this.deps.now(),
    })
    this.blockFades.add(clock)
    attach({ age: () => clock.age(), style: () => this.fadeStyle })
    this.updateFadeTicker()
  }

  /**
   * Settle what the current message has drawn and stop tracking it: both
   * tails go, so their text renders at the terminal's foreground from the next
   * render on. Card fades are left to expire on their own clock, because a
   * card that landed at the end of a turn keeps brightening after it.
   */
  private endFade(): void {
    this.textTail = undefined
    this.reasoningTail = undefined
    this.updateFadeTicker()
  }

  /**
   * Settle what is drawn while the message keeps streaming, which a block asks
   * for after a width change: the columns either tail was matched against no
   * longer describe the rewrapped lines.
   */
  private flushFade(): void {
    this.textTail?.flush()
    this.reasoningTail?.flush()
    this.updateFadeTicker()
  }

  /**
   * Arm the fade tick while streamed text or a card still draws below the last
   * brightness level and disarm it otherwise, so a session that is not
   * streaming runs no fade timer. Exactly one runs at a time, and a stopped
   * app runs none.
   */
  private updateFadeTicker(): void {
    if (!this.stopped && this.fadesMoving()) {
      this.fadeTicker ??= this.deps.tick(() => { this.onFadeTick() }, this.deps.fadeStepMs)
      return
    }
    const ticker = this.fadeTicker
    if (ticker === undefined) return
    this.fadeTicker = undefined
    ticker()
  }

  /**
   * Whether anything the application fades still draws below the last
   * brightness level.
   * @returns true while a tail or a card fade keeps changing what is drawn.
   */
  private fadesMoving(): boolean {
    return this.textTail?.needsRepaint() === true
      || this.reasoningTail?.needsRepaint() === true
      || this.blockFades.needsRepaint()
  }

  /**
   * Apply everything the frame's geometry decides, on the frame that was just
   * built and before it is written.
   *
   * Two effects redraw lines a component already produced and are therefore
   * held to the renderer's repaint window ({@link GuardedMainScreen}): a
   * running fade, which is told each block's own first repaintable line, and
   * the focus gutter, which a block gains or loses only while its first line
   * lies inside the window. A focused block above the window simply stays
   * unmarked, and the inspector reports that instead.
   * @param viewportTop - the frame's first repaintable line.
   * @param width - the width it was built at.
   * @returns whether anything changed a line, so the frame is built again
   * before it is written.
   */
  private settleFrame(viewportTop: number, width: number): boolean {
    const section = this.focusedSection()
    const wanted: HeldSection | undefined = section !== undefined && this.focus === 'transcript'
      ? { block: section.block, part: section.part.kind }
      : undefined
    const fades = this.fadesMoving()
    if (!fades && wanted === undefined && this.highlighted === undefined) return false
    // The walk reads the frame that was just built, so applying one change
    // cannot move the line another change is judged against.
    let start = this.header.render(width).length
    let wantedStart: number | undefined
    let changed = false
    for (const child of this.chat.children) {
      if (isSectionSource(child) && child === wanted?.block) wantedStart = start
      if (fades && (child instanceof AssistantBlock || child instanceof ToolBlock)) {
        if (child.setRepaintFloor(repaintFloor(start, viewportTop))) changed = true
      }
      start += child.render(width).length
    }
    // A block that carries the mark right now was inside the window when this
    // guard put it there, and the window the guard is handed already covers
    // what this frame will impose, so taking the mark off again is repaintable.
    const target = wantedStart !== undefined && repaintFloor(wantedStart, viewportTop) === 0 ? wanted : undefined
    const current = this.highlighted
    if (current?.block === target?.block && current?.part === target?.part) return changed
    current?.block.setHighlight(undefined)
    target?.block.setHighlight(target.part)
    this.highlighted = target
    return true
  }

  /**
   * One fade period: every tracked fade drops what settled since the last one,
   * the render request redraws the levels the clock moved, and the disarm
   * check follows. Ages come from the clock, so this period repaints the
   * levels the elapsed time asks for however long the period itself ran.
   */
  private onFadeTick(): void {
    this.textTail?.tick()
    this.reasoningTail?.tick()
    this.blockFades.tick()
    this.tui.requestRender()
    this.updateFadeTicker()
  }

  private onStreamFrame(frame: AssistantStreamFrame): void {
    switch (frame.type) {
      case 'start':
        this.streaming = undefined
        this.endFade()
        return
      case 'chunk': {
        const chunk = frame.chunk
        switch (chunk.type) {
          case 'text-delta':
            if (chunk.text !== '') this.appendStreamedText(chunk.text)
            break
          case 'reasoning-delta':
            if (chunk.text !== '') this.appendStreamedReasoning(chunk.text)
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
        this.endFade()
        this.tui.requestRender()
        return
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(frame, 'tui stream frame')
    }
  }

  // ── durable log ─────────────────────────────────────────────────────────

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (session !== this.agent.session) {
      // Every live session of this process reaches here, the subagent
      // children included; their events only tell the panel its listing aged.
      this.markSubagentsStale()
      return
    }
    switch (event.type) {
      case 'turn/start':
        // The turn every later event of this turn belongs to, including the
        // todo writes, which carry no turn of their own.
        this.turn = event.data.turn
        this.turnStartedAt = event.time
        this.updateTicker()
        this.refreshFooter()
        break
      case 'todo/write':
        this.trackTodoTurns(event.data.todos)
        break
      case 'user/message':
        this.onUserMessage(event.data)
        break
      case 'assistant/message': {
        const { message, usage, interrupted } = event.data
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
        this.streamingBlock().commit(text, reasoning, interrupted === true)
        this.streaming = undefined
        this.endFade()
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
        const block = new ToolBlock(this.theme, name, toolCallText(argumentsJson, this.presentCall(name, args)), this.turn)
        block.setExpanded(this.toolsExpanded)
        this.toolBlocks.set(callId, block)
        this.chat.addChild(block)
        this.fadeBlock((fade) => { block.setFade(fade) })
        break
      }
      case 'tool/result': {
        const [result] = event.data.message.content
        const block = this.toolBlocks.get(result.toolCallId)
        if (block === undefined) break
        const isError = result.isError === true
        const view = this.presentResult(block.name, this.toolArguments.get(result.toolCallId), result.content, isError, event.data.meta)
        block.setResult(toolResultLines(view, result.content), isError)
        this.fadeBlock((fade) => { block.setResultFade(fade) })
        this.loader.setMessage('thinking')
        break
      }
      case 'turn/end': {
        this.turnStartedAt = undefined
        this.updateTicker()
        this.endFade()
        this.refreshFooter()
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
      case 'compaction/summary':
        this.notice(compactionNotice(event.data))
        break
      case 'llm/retry':
        this.loader.setMessage(retryMessage(event.data))
        break
      default:
        return
    }
    this.tui.requestRender()
  }

  /**
   * Fold one whole-list todo write into the turn facts: a content this
   * session has not carried before starts at the current turn, a known
   * content whose status moved records that turn, and a content the write
   * dropped is forgotten.
   * @param todos - the list the write replaced the previous one with.
   */
  private trackTodoTurns(todos: readonly TodoItem[]): void {
    const tracked = new Map<string, TodoHistory>()
    for (const item of todos) {
      const known = this.todoTurns.get(item.content)
      if (known === undefined) {
        tracked.set(item.content, { firstTurn: this.turn, statusTurn: this.turn, status: item.status })
      } else if (known.status === item.status) {
        tracked.set(item.content, known)
      } else {
        tracked.set(item.content, { firstTurn: known.firstTurn, statusTurn: this.turn, status: item.status })
      }
    }
    this.todoTurns = tracked
  }

  private onUserMessage(message: UserMessage): void {
    const source = message.source
    if (source.kind === 'user') {
      if (this.submittedIds.has(message.id)) return
      const attachments = message.content.filter(block => block.type !== 'text').map(block => `[${block.type}]`)
      this.chat.addChild(new UserBlock(this.theme, [contentText(message.content), ...attachments].filter(part => part !== '').join('\n'), this.turn))
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
