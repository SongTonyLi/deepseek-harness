/**
 * The interactive terminal application: it renders the durable session log
 * and the live assistant stream of one Agent at a time into a pi-tui tree,
 * turns keystrokes into agent input, answers the approval and user-questions
 * seams for that Agent, and switches between sessions through its host. Above
 * the editor it draws an activity board of the open turn's todos and the
 * latest descendant line. Under the editor it keeps two docked regions the
 * keyboard can take over — the subagent panel and the status bar — and one
 * repeating tick advances their elapsed counters and re-reads a stale
 * subagent listing. A second tick, at its own period, brightens streamed
 * reply text and floats out reasoning, tool cards, and activity-board rows
 * that just landed, each only as far up the frame as the renderer repaints
 * without discarding the terminal's scrollback (`./screen.ts`).
 * @module @deepseek-ai/dsh-tui-app/app
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import {
  Container,
  Loader,
  Text,
  isKeyRelease,
  matchesKey,
  visibleWidth,
  type OverlayHandle,
  type RgbColor,
  type SelectListLayoutOptions,
  type Terminal,
} from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { AuthorizationDeclinedError, type AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference'
import { ReasoningEffortId, boundContextSummary, createUserMessage, type LlmModelReasoningInfo, type MessageId, type StreamChunk, type TokenUsage, type ToolCallId, type ToolResultMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Terminal-surface attribution; readers preserve the notice without this producer.
     * The transcript uses the kind to draw the row as injected context rather than a prompt.
     * @persistenceAttribution
     */
    'tui-app': { kind: 'tui-app'; form: 'notice'; summary: string }
  }
}
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
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
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-skill'
// Carries the subagent lifecycle events, the descendant listing, and the
// `subagentTiming` projection key; `tokenUsage` rides the token meter.
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import { AlternateScreen } from './alt-screen.ts'
import { btwBriefMessage } from './btw.ts'
import { attachLocalFile, type PendingAttachment } from './attach.ts'
import {
  changeDiffRows,
  changesNotice,
  installBundle,
  listBundles,
  listDeliverables,
  listPlugins,
  listSettings,
  listSubagentChoices,
  listTurnChanges,
  removeBundle,
  resetSetting,
  sessionOutline,
  setPluginEnabled,
  setSetting,
  showSetting,
  subagentChoice,
  subagentDetail,
  type SubagentChoice,
} from './catalog.ts'
import { AssistantBlock, ContextBlock, NoticeBlock, ToolBlock, UserBlock, UserShellBlock, isFoldable, type BlockFade, type BlockTheme, type FadeRender } from './blocks.ts'
import { editorCompletion, type CompletableCommand, type ReferenceItem } from './completion.ts'
import { injectedContextView, systemPromptView } from './context.ts'
import { BarCursorEditor, SET_BLINKING_BAR_CURSOR, SET_TERMINAL_DEFAULT_CURSOR } from './editor.ts'
import { parseUserShellLine, userShellContextText, userShellTranscriptRows } from './shell-line.ts'
import { PROVIDER_DEFAULT, effortHint, effortItems, matchEffort } from './effort.ts'
import { matchPermission, permissionHint, permissionItems } from './permission.ts'
import { exportSessionZip } from './export.ts'
import { RowReveal, StreamPacer } from './pace.ts'
import { ViewBanner } from './view-banner.ts'
import { BlockFadeClock, FadeRegistry, FadeTracker, buildFadeRamp, resolveFadeCapability, type FadeCapability, type FadeStyle } from './fade.ts'
import { InspectorPane, type InspectorView } from './inspector.ts'
import {
  ESCAPE_HANDOFF_MS,
  FOCUS_REGIONS,
  KEY_LINES,
  REGION_LABELS,
  resolveKey,
  type FocusRegion,
  type KeyAction,
  type MoveAxis,
} from './keys.ts'
import {
  LANDING_TICKS,
  Motion,
  SEGMENT_TICKS,
  STEP_TICKS,
  type MotionLevel,
} from './motion.ts'
import {
  clampCursor,
  isSectionSource,
  lastSection,
  moveTranscriptCursor,
  navigableBlocks,
  partLabels,
  sectionHeading,
  type MoveTarget,
  type SectionPart,
  type SectionSource,
  type TranscriptAxis,
  type TranscriptCursor,
} from './navigation.ts'
import {
  FIRST_FOOTER_SEGMENT,
  FooterBar,
  buildFooterSegments,
  footerSelectionIndex,
  type FooterSegment,
  type FooterSegmentId,
} from './footer.ts'
import { ApprovalPrompt, DetailPrompt, ModalQueue, PickPrompt, QuestionPrompt, type ModalPrompt, type PickItem } from './prompts.ts'
import {
  activityBoardView,
  activityResultParts,
  activityTurnEndStatus,
  formatActivitySubagentLine,
  renderActivityBoard,
  type ActivityBoardSubagent,
} from './activity-board.ts'
import { queuePanelRows, renderQueuePanel, type QueuePanelRow } from './queue-panel.ts'
import { READER_HINTS } from './reader.ts'
import { ReaderPane, type ReaderExit } from './reader-screen.ts'
import { SyntaxHighlighter, resolveColorDepth } from './highlight.ts'
import { GuardedMainScreen, pageContentWidth, repaintFloor } from './screen.ts'
import { describeSession, listSessionChoices, type SessionChoice } from './sessions.ts'
import { compactionNotice, readStatusFacts, retryMessage, statusReport } from './status.ts'
import {
  renderSubagentPanel,
  subagentPanelView,
  type SubagentLiveFacts,
  type SubagentPanelRow,
  type SubagentPanelView,
} from './subagent-panel.ts'
import { listTodoChoices, todoDetail, type TodoTransition } from './todos.ts'
import {
  NOTHING_TO_READ_TOAST,
  QUIT_TOAST,
  ToastClock,
  ToastPane,
  stopTurnToast,
  toastDrawable,
  toastOverlay,
} from './toast.ts'
import { editorTheme, paintDiffRows, type Palette } from './style.ts'
import {
  EMPTY_USAGE,
  addUsage,
  cardHeadline,
  contentText,
  describeFailure,
  estimateTokens,
  formatElapsed,
  formatLiveUsage,
  formatUsage,
  isSubagentTool,
  parseArguments,
  subagentRowFacts,
  toolCallText,
  toolResultBody,
  turnEndNotice,
  withLiveUsage,
  type UsageTotals,
} from './transcript.ts'

/** A second Ctrl+C inside this window quits. */
const QUIT_DOUBLE_PRESS_MS = 600

/** What input reports while the host is opening another session. */
const SESSION_SWITCH_WAIT = 'wait for the session switch to finish'

/** The one extra key the model picker answers, stated above its rows. */
const MODEL_PICKER_HINT = 'Ctrl+S saves the highlighted model as the default for the next launch'

/**
 * Read a picker row value back into a selection.
 * @param value - `provider/model`, as {@link TuiApp.modelItems} writes it.
 * @returns the provider and model.
 */
function splitModelValue(value: string): ModelSelection {
  const slash = value.indexOf('/')
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

/** What the banner and header call an open `/btw` side agent. */
const BTW_VIEW_TITLE = 'btw side agent'

/** What the transcript is told when a session switch took the conversation the reader was showing. */
const READER_GONE = 'the transcript changed · reader closed'

/** What the transcript is told when a fold key named a block the renderer can no longer rewrite. */
const ABOVE_WINDOW_NOTICE = 'above the repaint window · opened in the reader'

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

/** A region drawn around the editor, which is where the keyboard returns from. */
type DockedRegion = Exclude<FocusRegion, 'editor'>

/**
 * Where one step along the status bar's segments lands: one either way,
 * wrapping at both ends, or straight to an end.
 * @param to - which way the key steps.
 * @param index - where the selection sits now.
 * @param count - how many segments the bar draws; at least 1.
 * @returns the index to select.
 */
function barTarget(to: MoveTarget, index: number, count: number): number {
  switch (to) {
    case 'previous':
      return (index - 1 + count) % count
    case 'next':
      return (index + 1) % count
    case 'first':
      return 0
    case 'last':
      return count - 1
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(to, 'tui move target')
  }
}

/** What `/help` calls the reader, the one focus state outside the docked stack. */
const READER_LABEL = 'reader'

/** Columns between a focus state's name and the keys it answers. */
const HELP_LABEL_GAP = 2

/**
 * The key lines `/help` prints: one row per focus state in the order the
 * screen stacks them, the reader last, with a state's further lines under a
 * blank name column. The text of every line is the legend its own surface
 * draws.
 * @returns the lines, unstyled.
 */
function helpKeyLines(): string[] {
  const states: readonly (readonly [string, readonly string[]])[] = [
    ...FOCUS_REGIONS.map(region => [REGION_LABELS[region], KEY_LINES[region]] as const),
    [READER_LABEL, [READER_HINTS.list[0], READER_HINTS.pane[0]]],
  ]
  const column = Math.max(...states.map(([label]) => visibleWidth(label))) + HELP_LABEL_GAP
  return states.flatMap(([label, lines]) =>
    lines.map((line, index) => `${(index === 0 ? label : '').padEnd(column)}${line}`))
}

/** The block that carries the focus gutter right now, and which of its sections is accented. */
interface HeldSection {
  block: SectionSource
  part: number
  /** How far above its settled accent that section's mark was last drawn. */
  level: MotionLevel
}

/** What one chrome motion lifts. */
type MotionScope =
  /** The whole surface that just took the keyboard: its frame rules, its chip, and the mark it holds. */
  | 'landing'
  /** The mark alone: the focus gutter, the selected segment, the selected row. */
  | 'selection'

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
  /**
   * Persisted events drawn before live input, including closers resume
   * appended; empty for a fresh session.
   */
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
  /**
   * Open a session for viewing beside the one bound, without releasing it: a
   * subagent session whose Agent is resident in this process is viewed live
   * and its `dispose` releases nothing, and any other session is resumed and
   * released by `dispose`. The history is read at the call, so a session
   * returned to later is observed again rather than drawn from a stale copy.
   * @param id - the session to view.
   */
  observe(id: SessionId): Promise<BoundSession>
  /**
   * Open a temporary side agent for `/btw`, seeded with every event `parent`
   * has logged so far, an unfinished turn included. It runs on the parent's
   * current model with read-only tools, records the parent only as lineage,
   * and appends nothing to the parent's log; `dispose` ends it.
   * @param parent - the session the side agent is opened from.
   */
  aside(parent: BoundSession): Promise<BoundSession>
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
  /** Collapsed body rows of a system prompt or an injected context block. */
  contextPreviewLines: number
  /** Rows of the focused transcript section the docked inspector shows. */
  focusPreviewLines: number
  /** Columns the reader needs before it draws the held turn beside the turn list. */
  readerMinColumns: number
  /** Whether fenced code in a reply is drawn in syntax colours. */
  codeHighlight: boolean
  /**
   * How long one transient key-feedback line holds at full strength before it
   * fades out, in milliseconds. It is also the window a second `Escape` stops
   * the running turn in: the arm lasts exactly as long as the line is drawn.
   */
  toastMs: number
  /** Period of the live-refresh tick, in milliseconds. */
  liveRefreshMs: number
  /** Brightness levels streamed text and tool cards climb; the oldest visible level is `fadeSteps - 1`. */
  fadeSteps: number
  /** How long one brightness level lasts, in milliseconds, which is also the frame period. */
  fadeStepMs: number
  /**
   * Frames a backlog of streamed text takes to drain on screen; `0` draws
   * each delta as it arrives. Reduced motion also draws deltas as they arrive.
   */
  streamPaceFrames: number
  /**
   * Frames the rows of a tool card take to unroll when the card appears or
   * grows; `0` draws them at once. Reduced motion also draws them at once.
   */
  toolRevealFrames: number
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
  { name: 'permission', description: 'Pick the permission preset (/permission <preset>)', hint: '<preset>' },
  { name: 'sessions', description: 'Switch to another session' },
  { name: 'resume', description: 'Resume a previous session' },
  { name: 'new', description: 'Start a new session' },
  { name: 'clear', description: 'Start a new session with empty context; previous session stays on disk (resumable with /resume)' },
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
  { name: 'changes', description: 'Browse the files the last turn changed (/changes <turn> for an earlier one; Enter shows a file\'s diff)' },
  { name: 'subagents', description: 'Browse the subagent sessions under this session (Enter opens one as a live session view)' },
  { name: 'parent', description: 'Return from a subagent view or a /btw side agent to the session it was opened from' },
  { name: 'btw', description: 'Open a temporary side agent with this session\'s context to ask questions while the agent works (/btw <question>)', hint: '<question>' },
  { name: 'settings', description: 'Inspect or change settings (/settings, /settings <ns>, /settings <ns> <path> <value>, /settings reset <ns>)' },
  { name: 'plugins', description: 'List the composed plugins (/plugins bundles, /plugins enable|disable <id>, /plugins add <spec>, /plugins remove <name>)' },
  { name: 'tools', description: 'Expand or collapse every tool card and context row' },
  { name: 'turns', description: 'Read the conversation full screen, turns side by side (Ctrl+G)' },
  { name: 'quit', description: 'Save the session and exit' },
  { name: 'exit', description: 'Same as /quit' },
]

/** Names the terminal handles before the shared registry, used to hide the matching catalog row. */
const LOCAL_COMMAND_NAMES = new Set(LOCAL_COMMANDS.map(command => command.name))

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

/** Shown when `!` is submitted and this composition has no `ctx.shell`. */
const SHELL_MISSING = '! needs a shell executor in this composition'

/** Shown when a second `!` is submitted while one is still running. */
const SHELL_BUSY = 'A shell command is already running. Press Esc to cancel it first.'

/** One cancellable asynchronous operation and its shared settlement. */
interface CancellableOperation {
  controller: AbortController
  done: Promise<void>
}

/** One current-model effort operation; equal arguments share its settlement. */
interface EffortOperation extends CancellableOperation {
  argument: string
}

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

/**
 * Spinner word for a streamed or executing tool.
 * @param name - the tool name when one is known.
 * @returns `calling <name>`, or `calling` when the name has not arrived.
 */
function callingActivity(name: string | undefined): string {
  return name ? `calling ${name}` : 'calling'
}

/**
 * Whether the spinner is already naming a tool call.
 * @param activity - the current spinner word.
 * @returns true for `calling` and `calling <name>`.
 */
function isCallingActivity(activity: string): boolean {
  return activity === 'calling' || activity.startsWith('calling ')
}

/**
 * Source for a prompt the person typed in this terminal.
 * A string `rpcId` is the admission mark Auto review treats as a human instruction.
 * An edited draft keeps a non-user source; a user draft is admitted again.
 * @param draft - the queue draft being revised, when this submission replaces one.
 * @returns the source stored on the submitted user message.
 */
function terminalPromptSource(draft: UserMessage | undefined): UserMessage['source'] {
  const preserved = draft?.source
  if (preserved !== undefined && preserved.kind !== 'user') return preserved
  const admitted = { kind: 'user' as const, rpcId: randomUUID() }
  return admitted
}

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
  /** Holds {@link queue} exactly while the bound Agent's inbox has a prompt waiting. */
  private readonly queueSlot = new Container()
  /**
   * Holds {@link activity} exactly while the open turn has todo rows or a
   * latest-descendant line, so the editor sits directly under the conversation
   * the rest of the time.
   */
  private readonly activitySlot = new Container()
  /** The prompts queued for the next turn or step, drawn above the editor until the loop claims them. */
  private readonly queue: Text
  /** Current-turn todos and the latest descendant line, drawn above the editor. */
  private readonly activity: Text
  /** Rows of the last queued-prompt draw, in claim order. */
  private queueView: readonly QueuePanelRow[] = []
  /** Pending prompt held while the queue panel owns the keyboard. */
  private queueSelection: MessageId | undefined
  /** A removed queued prompt whose text is being revised in the editor. */
  private queueDraft: UserMessage | undefined
  /** Suppresses the empty-queue focus handoff during a synchronous inbox transfer. */
  private transferringQueue = false
  /** Holds {@link panel} exactly while the bound session has subagent rows. */
  private readonly panelSlot = new Container()
  /** The terminal's alternate screen, which the reader draws on; see {@link AlternateScreen}. */
  private readonly readerScreen: AlternateScreen
  /** Colours fenced code in replies; see {@link SyntaxHighlighter}. */
  private readonly codeHighlight: SyntaxHighlighter
  /** The terminal's background once it answered; undefined until then, and on a terminal that answers none. */
  private background: RgbColor | undefined
  private readonly panel: Text
  private readonly footer: FooterBar
  private readonly modals: ModalQueue
  private readonly theme: BlockTheme
  private readonly toolBlocks = new Map<ToolCallId, ToolBlock>()
  private readonly toolArguments = new Map<ToolCallId, unknown>()
  /** Raw argument text accumulated from `tool-call-delta` chunks, keyed by call id. */
  private readonly toolStreamArgs = new Map<ToolCallId, string>()
  /** Cards mounted from the live stream that no logged `tool/call` has confirmed yet. */
  private readonly unconfirmedTools = new Map<ToolCallId, ToolBlock>()
  private readonly submittedIds = new Set<string>()
  private readonly disposers: (() => void)[] = []
  /** Turn facts of the bound session's todo lines, keyed by content. */
  private todoTurns = new Map<string, TodoHistory>()
  /** Todos the activity board draws for the open turn, from the `todos` projection. */
  private activityTodos: readonly TodoItem[] = []
  /** Status last drawn for each activity-board todo, keyed by content. */
  private activityTodoStatus = new Map<string, TodoItem['status']>()
  /** Fades of todo rows that are still moving, keyed by content. */
  private activityTodoFades = new Map<string, BlockFade>()
  /** Latest descendant line the activity board draws; absent before one lands. */
  private activitySubagent: ActivityBoardSubagent | undefined
  /** Fade of the descendant line while it is still moving. */
  private activitySubagentFade: BlockFade | undefined
  /** The last descendant `tool/call` the board saw, for presenting its result. */
  private activityChildCall: { name: string; args: unknown } | undefined
  /** The turn the last logged `turn/start` opened; 0 before the first one. */
  private turn = 0
  /** Whether a nonempty system prompt has already been drawn in this transcript. */
  private sawSystemPrompt = false
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
   * editor so `Shift+Up` comes back to the section the walk was left on. A
   * session switch clears it with the blocks it named.
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
  /** Streamed deltas waiting for a frame; absent when deltas are drawn as they arrive. */
  private readonly pacer: StreamPacer | undefined
  /** Tool cards whose rows are still unrolling; each drops out once its reveal caught up. */
  private readonly reveals = new Set<ToolBlock>()
  /**
   * The chrome motions running right now. It is consulted whatever the
   * terminal draws, because a transient line has to come down again even on a
   * terminal that fades nothing.
   */
  private readonly motions = new FadeRegistry()
  /** The transient line on screen right now, with the clock that takes it down. */
  private toast: { handle: OverlayHandle; clock: ToastClock } | undefined
  /** The chrome motion running right now, and how much of the focused surface it lifts. */
  private chrome: { motion: Motion; scope: MotionScope } | undefined
  /** The lift the subagent panel's text was last built with, which only a repaint changes. */
  private panelLift: MotionLevel = 0
  /** The reader on the alternate screen right now, while one is open. */
  private reader: { pane: ReaderPane } | undefined
  /** Set while a paint of the open reader is already queued for this turn of the loop. */
  private readerPaintQueued = false
  /** Prompts shown or waiting on the modal queue, which the reader steps aside for. */
  private queuedModals = 0
  /** Until when an `Escape` that reaches the editor does nothing at all. */
  private escapeQuietUntil = 0
  /** Until when a second editor `Escape` stops the running turn. */
  private stopArmedUntil = 0
  /** Abort of the in-flight user `!` command, when one is running. */
  private shellAbort: AbortController | undefined
  /**
   * How many of the viewport's own first lines the renderer can no longer
   * repaint, from the last frame the guard settled. The transient line
   * composites into those lines, so this is what decides whether it can float
   * at all.
   */
  private viewportFloor = 0
  /** Set while {@link TuiApp.bind} replays a session's history, which draws its cards settled. */
  private replaying = false
  /** Whether this terminal draws a ramp at all, decided once at start. */
  private fading = false
  /** How streamed text is drawn; `none` until the background query settles. */
  private fadeStyle: FadeStyle = NO_FADE
  private bound: BoundSession
  /**
   * The sessions a subagent view was entered from, root first; empty while
   * the root session is bound. `/parent` returns to the last one.
   */
  private readonly parents: BoundSession[] = []
  /** The listing label of every open subagent view, outermost first, one per {@link parents} entry. */
  private readonly viewLabels: string[] = []
  /** Names the open subagent view above the editor; see {@link ViewBanner}. */
  private readonly banner: ViewBanner
  /** The open views that are `/btw` side agents, which leaving the view ends. */
  private readonly asides = new Set<BoundSession>()
  private streaming: AssistantBlock | undefined
  /** Whether the fold keys left every foldable block open; one appended later follows it. */
  private toolsExpanded = false
  /** Set while a session switch awaits the host, so input cannot target the session being left. */
  private switching = false
  /** The current-model effort command, including its lookup and optional picker. */
  private effortOperation: EffortOperation | undefined
  /** The persisted-session picker shared by `/resume` and `/sessions`, including its listing. */
  private sessionPicker: CancellableOperation | undefined
  /** Serializes `/attach` reads so pending attachments keep the typed order. */
  private attaching = Promise.resolve()
  private usage: UsageTotals = EMPTY_USAGE
  /** The in-flight model call's tokens, shown on the spinner and in the footer. */
  private liveUsage: TokenUsage | undefined
  /** Streamed characters of the current call, used until a usage chunk arrives. */
  private streamedChars = 0
  /** Whether {@link TuiApp.liveUsage} came from a provider `usage` chunk. */
  private usageExact = false
  /** Spinner label without the live ↑↓ suffix (`thinking`, `writing`, `calling read`, …). */
  private loaderActivity = 'thinking'
  /** Tool names still streamed or executing, in first-seen order. */
  private readonly pendingToolNames = new Map<ToolCallId, string>()
  private lastCtrlC = 0
  private stopped = false

  constructor(private readonly deps: TuiAppDeps) {
    const palette = deps.palette
    this.bound = deps.initial
    this.pacer = deps.reducedMotion || deps.streamPaceFrames === 0
      ? undefined
      : new StreamPacer({ drainFrames: deps.streamPaceFrames })
    this.codeHighlight = new SyntaxHighlighter({
      depth: deps.codeHighlight ? resolveColorDepth({ paletteEnabled: palette.enabled, env: deps.env }) : 'none',
      // Read per build: the background is a round trip to the terminal, and
      // the first fenced block almost always follows the answer.
      background: () => this.background,
      // A rendered Markdown block holds its lines, so the conversation is
      // told to build them again: the fence that drew plain is the one the
      // grammar just arrived for.
      changed: () => {
        this.chat.invalidate()
        this.tui.requestRender()
      },
    })
    this.theme = {
      palette,
      toolPreviewLines: deps.toolPreviewLines,
      contextPreviewLines: deps.contextPreviewLines,
      codeHighlight: this.codeHighlight,
    }
    // The second parameter is `showHardwareCursor`: the editor draws no block
    // of its own, so the terminal's own cursor is the caret. Setting it here
    // rather than through `setShowHardwareCursor` keeps the constructor from
    // requesting a render before the tree has children.
    this.tui = new GuardedMainScreen(deps.terminal, true, (viewportTop, width, frameLines) => {
      return this.settleFrame(viewportTop, width, frameLines)
    })
    this.readerScreen = new AlternateScreen(deps.terminal)
    this.header = new Text('', 0, 0)
    this.inspector = new InspectorPane(() => this.inspectorView(), { palette, previewLines: deps.focusPreviewLines })
    this.loader = new Loader(this.tui, palette.accent, palette.dim, 'thinking')
    // pi-tui starts the spinner interval in the constructor; it runs only while mounted.
    this.loader.stop()
    this.editor = new BarCursorEditor(this.tui, editorTheme(palette), { paddingX: 1 })
    this.editor.shellPaint = { highlight: this.codeHighlight, warning: palette.warning, paddingX: 1 }
    this.editor.setAutocompleteProvider(editorCompletion({
      commands: () => this.completableCommands(),
      references: (query, quoted, signal) => this.references(query, quoted, signal),
    }))
    this.editor.onSubmit = (text) => { this.onSubmit(text) }
    this.editor.onChange = () => { this.syncEditorBorder() }
    this.queue = new Text('', 0, 0)
    this.activity = new Text('', 0, 0)
    this.panel = new Text('', 0, 0)
    this.banner = new ViewBanner(palette)
    this.footer = new FooterBar(() => ({
      segments: this.segments,
      render: {
        palette: this.deps.palette,
        queue: this.queueView.length > 0,
        ...this.focus === 'bar'
          ? { selected: footerSelectionIndex(this.segments, this.barSelection), level: this.markLift() }
          : {},
      },
    }))
    this.modals = new ModalQueue({ tui: this.tui, slot: this.modalSlot, focusAfter: this.editor })
    const tree = [
      this.header, this.chat, this.statusSlot, this.modalSlot, this.inspector, this.queueSlot,
      this.activitySlot, this.banner, this.editor, this.panelSlot, this.footer,
    ]
    for (const child of tree) this.tui.addChild(child)
  }

  private get agent(): Agent {
    return this.bound.agent
  }

  /**
   * The columns every surface of the main screen is laid out in, which the
   * page margins {@link GuardedMainScreen} holds are already taken from. A
   * surface that builds its own text ahead of a frame - the follow-ups list,
   * the subagent panel - measures against this rather than the terminal.
   * @returns the layout width at the terminal's current width.
   */
  private contentWidth(): number {
    return pageContentWidth(this.deps.terminal.columns)
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
      // Neither lifecycle edge names the delegating parent in its payload;
      // both fire for out-of-process children too. The listing and the child's
      // header decide whether the activity board may show the status word.
      ctx.on('subagent/start', (info) => {
        this.markSubagentsStale()
        if (this.isBoundDescendantId(info.id)) {
          this.setActivitySubagent({ label: this.activityLabelFor(info.id), status: 'running' })
        }
      }),
      ctx.on('subagent/end', (info) => {
        this.markSubagentsStale()
        if (this.isBoundDescendantId(info.id)) {
          this.setActivitySubagent({ label: this.activityLabelFor(info.id), status: info.stopReason })
        }
      }),
      // A prompt waits above the editor from the moment it enters the inbox
      // until the loop claims it for a turn or step, or `/queue clear` drops it.
      ctx.on('agent/inbox/inserted', ({ agent: subject }) => { if (subject === this.agent) this.refreshQueue() }),
      ctx.on('agent/inbox/claimed', ({ agent: subject }) => { if (subject === this.agent) this.refreshQueue() }),
      ctx.on('agent/inbox/discarded', ({ agent: subject }) => { if (subject === this.agent) this.refreshQueue() }),
      ctx.on('approval/request', (request, next) => {
        if (!this.claimPrompt(request.agent)) return next()
        return this.askApproval(request.toolName, request.reason, request.callId, request.signal)
      }),
      ctx.on('user-questions/request', (request, next) => {
        if (!this.claimPrompt(request.agent)) return next()
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
    this.background = background
    this.fadeStyle = background === undefined
      ? { capability: 'dim', ramp: [] }
      : { capability, ramp: buildFadeRamp(background, assumedForeground(background), this.deps.fadeSteps) }
  }

  /** Release the terminal and tell the host to exit; later calls are no-ops. */
  stop(): void {
    if (this.stopped) return
    this.dropUserShell()
    this.restoreQueueDraft()
    this.stopped = true
    this.updateTicker()
    this.updateFadeTicker()
    this.cancelPickers()
    for (const dispose of this.disposers.splice(0)) dispose()
    this.modals.withdrawActive()
    this.dropReader()
    this.hideToast()
    this.loader.stop()
    // The shell that regains the terminal keeps whatever caret shape it was
    // left with, so the application gives the terminal's own shape back.
    this.deps.terminal.write(SET_TERMINAL_DEFAULT_CURSOR)
    this.tui.stop()
    this.deps.releaseInput()
    const [root, ...views] = [...this.parents, this.bound]
    for (const view of views.reverse()) {
      view.dispose().catch((error: unknown) => {
        this.deps.terminal.write(`releasing a subagent view failed: ${describeFailure(error)}\n`)
      })
    }
    this.parents.length = 0
    this.viewLabels.length = 0
    this.asides.clear()
    /* v8 ignore next -- the destructured list always holds the bound session */
    this.deps.onQuit(root ?? this.bound)
  }

  // ── session binding ─────────────────────────────────────────────────────

  /** Draw `next` as the terminal's session: clear the transcript and replay its history. */
  private bind(next: BoundSession): void {
    this.dropUserShell()
    if (this.queueDraft !== undefined) {
      this.restoreQueueDraft()
      this.editor.setText('')
    }
    this.bound = next
    // The blocks the transcript focus names are about to be discarded, so the
    // keyboard goes back to the editor and the focus gutter with it, and the
    // remembered section goes with the session that held it: the next
    // `Shift+Up` enters the new transcript on its newest section. A reader
    // reading those same blocks comes down before the keyboard is placed: a
    // replayed history refills the transcript, so nothing else would take the
    // reader off a conversation it was never opened on, and it would keep the
    // key stream. The new transcript says so once it is drawn.
    const reading = this.dropReader()
    this.focusEditor()
    this.highlighted = undefined
    this.cursor = undefined
    this.chat.clear()
    this.toolBlocks.clear()
    this.toolArguments.clear()
    this.toolStreamArgs.clear()
    this.unconfirmedTools.clear()
    this.pendingToolNames.clear()
    this.submittedIds.clear()
    this.todoTurns.clear()
    this.turn = 0
    this.sawSystemPrompt = false
    this.turnStartedAt = undefined
    this.pacer?.clear()
    this.reveals.clear()
    this.streaming = undefined
    this.endFade()
    this.blockFades.clear()
    this.usage = EMPTY_USAGE
    this.clearLiveUsage()
    this.pending = []
    this.queueView = []
    this.queueSelection = undefined
    this.clearActivityBoard()
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
    if (reading) this.notice(READER_GONE)
    this.refreshHeader()
    this.banner.setViews(this.viewLabels, this.asides.has(next) ? BTW_VIEW_TITLE : undefined)
    this.refreshQueue()
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
    if ([this.bound, ...this.parents].some(bound => bound.agent.status === 'running')) {
      this.notice('stop the running turn (Esc twice) before switching sessions', 'error')
      return
    }
    this.cancelPickers()
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
    // Every subagent view goes with the session it was entered from, newest first.
    const released = [this.bound, ...this.parents.splice(0).reverse()]
    this.viewLabels.length = 0
    this.asides.clear()
    const dropped = this.pending.length
    this.bind(next)
    this.notice(`${verb}: session ${next.agent.session.id}`, 'success')
    if (dropped > 0) this.notice(`${String(dropped)} pending attachment(s) stayed with the previous session`)
    for (const previous of released) {
      try {
        await previous.dispose()
      } catch (error: unknown) {
        this.notice(`releasing the previous session failed: ${describeFailure(error)}`, 'error')
      }
    }
  }

  /**
   * Draw one subagent session in place of the bound one, keeping the bound
   * one alive to return to: the whole conversation surface - the live
   * transcript, the conversation walk, the inspector, the reader, and that
   * session's own subagents - then reads the child. The entry's detail rows
   * follow the entry notice.
   * @param id - the subagent session.
   * @param row - the listing entry, for its label and detail rows.
   */
  private async enterSubagent(id: SessionId, row: BrowseRow): Promise<void> {
    if (this.switching) {
      this.notice('wait for the session switch to finish', 'error')
      return
    }
    this.switching = true
    let next: BoundSession
    try {
      next = await this.deps.host.observe(id)
    } catch (error: unknown) {
      this.switching = false
      this.notice(`opening subagent ${id} failed: ${describeFailure(error)}`, 'error')
      return
    }
    this.switching = false
    if (this.stopped) {
      await next.dispose()
      return
    }
    const parent = this.bound
    const dropped = this.pending.length
    this.parents.push(parent)
    this.viewLabels.push(row.item.label)
    this.bind(next)
    this.notice(`subagent ${row.item.label} · Ctrl+P or /parent returns to session ${parent.agent.session.id}`, 'success')
    if (dropped > 0) this.notice(`${String(dropped)} pending attachment(s) stayed with the parent session`)
    for (const line of await this.detailRows(row)) this.notice(line)
  }

  /**
   * Take an approval or question from `agent` when the terminal answers for
   * it: the bound session, or a session a view is held open over. A held
   * session keeps running behind a subagent view or a `/btw` side agent, so
   * its prompt is shown here, after a notice naming it, rather than refused.
   * @param agent - the Agent that asked, when the request names one.
   * @returns true for the bound Agent and every held parent.
   */
  private claimPrompt(agent: Agent | undefined): boolean {
    if (agent === this.agent) return true
    const held = this.parents.find(parent => parent.agent === agent)
    if (held === undefined) return false
    this.notice(`session ${held.agent.session.id}, behind this view, asks:`)
    return true
  }

  /**
   * Open a `/btw` side agent over the bound session and ask it `question`.
   * The side agent starts from everything the bound session has logged, runs
   * its own turns with tools, and ends when its view is left. The bound
   * session keeps running and is not sent, queued, or shown anything.
   * @param question - the text after `/btw`; empty opens the page without asking.
   */
  private async openAside(question: string): Promise<void> {
    if (this.asides.has(this.bound)) {
      if (question === '') this.notice('this is already a btw side agent; type a question, or Ctrl+P to end it')
      else this.submit(question)
      return
    }
    // A typed command never reaches here while a switch is opening.
    this.switching = true
    let next: BoundSession
    try {
      next = await this.deps.host.aside(this.bound)
    } catch (error: unknown) {
      this.switching = false
      this.notice(`opening btw failed: ${describeFailure(error)}`, 'error')
      return
    }
    this.switching = false
    if (this.stopped) {
      await next.dispose()
      return
    }
    const parent = this.bound
    const dropped = this.pending.length
    this.parents.push(parent)
    this.viewLabels.push('btw')
    this.asides.add(next)
    this.bind(next)
    this.notice(`btw · a temporary side agent with session ${parent.agent.session.id}'s context; that session keeps working and never sees this page · Ctrl+P or /parent ends it`, 'success')
    if (dropped > 0) this.notice(`${String(dropped)} pending attachment(s) stayed with the parent session`)
    next.agent.inject(btwBriefMessage())
    if (question !== '') this.submit(question)
  }

  /**
   * Return from a subagent view to the session it was entered from, drawn
   * from its log as it stands now, and release the view.
   */
  private async leaveSubagent(): Promise<void> {
    const parent = this.parents.at(-1)
    if (parent === undefined) {
      this.notice('this is the root session; /parent returns from a subagent view', 'error')
      return
    }
    if (this.switching) {
      this.notice('wait for the session switch to finish', 'error')
      return
    }
    this.switching = true
    let history: readonly SessionEvent[]
    try {
      const observed = await this.deps.host.observe(parent.agent.session.id)
      history = observed.history
      await observed.dispose()
    } catch (error: unknown) {
      this.switching = false
      this.notice(`returning to session ${parent.agent.session.id} failed: ${describeFailure(error)}`, 'error')
      return
    }
    this.switching = false
    /* v8 ignore next -- quitting releases every view before a pending return settles */
    if (this.stopped) return
    const view = this.bound
    this.parents.pop()
    this.viewLabels.pop()
    const aside = this.asides.delete(view)
    this.bind({ ...parent, history })
    this.notice(aside ? `btw ended · back in session ${parent.agent.session.id}` : `back in session ${parent.agent.session.id}`, 'success')
    try {
      await view.dispose()
    } catch (error: unknown) {
      this.notice(`releasing the ${aside ? 'btw side agent' : 'subagent view'} failed: ${describeFailure(error)}`, 'error')
    }
  }

  private completableCommands(): CompletableCommand[] {
    const registry = this.deps.ctx.get('commands')
    const shared = (registry?.list(this.agent) ?? []).filter(command => !LOCAL_COMMAND_NAMES.has(command.name))
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
      this.refreshLoader()
    } else if (this.statusSlot.children.length > 0) {
      this.loader.stop()
      this.statusSlot.removeChild(this.loader)
      this.pendingToolNames.clear()
      this.loaderActivity = 'thinking'
      this.clearLiveUsage()
      this.loader.setMessage('thinking')
    }
    this.tui.requestRender()
  }

  private refreshHeader(): void {
    const palette = this.deps.palette
    const session = this.agent.session
    const title = this.deps.ctx.get('sessionTitle')?.get(session)?.title
    const name = title === undefined ? `session ${session.id}` : `${title} ${palette.dim(`(${session.id})`)}`
    const trail = this.parents.length === 0
      ? palette.dim('· /help for commands')
      : this.asides.has(this.bound)
        ? `${palette.accent(`◆ ${BTW_VIEW_TITLE}`)} ${palette.dim('· Ctrl+P ends it and returns')}`
        : `${palette.accent(`◆ subagent view ${'›'.repeat(this.parents.length)}`)} ${palette.dim('· Ctrl+P returns')}`
    this.header.setText(`${palette.bold(palette.accent('dsh'))} ${palette.dim('·')} ${name} ${trail}`)
    this.tui.requestRender()
  }

  private refreshFooter(): void {
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
      usage: formatUsage(withLiveUsage(this.usage, this.liveUsage)),
      facts: this.statusFacts(),
      cwd: this.deps.cwd,
      home: this.home,
      attachments: this.pending.map(attachment => ({ name: attachment.name, kind: attachment.block.type })),
    })
    this.tui.requestRender()
  }

  /**
   * Redraw the follow-ups list above the editor from the bound Agent's inbox.
   * The slot is mounted exactly while a prompt waits, so the editor sits
   * directly under the conversation the rest of the time.
   */
  private refreshQueue(): void {
    const inbox = this.agent.inbox
    const rows = queuePanelRows(inbox.nextStep, inbox.nextTurn)
    this.queueView = rows
    const mounted = this.queueSlot.children.length > 0
    if (rows.length === 0) {
      this.queueSelection = undefined
      if (this.focus === 'queue' && !this.transferringQueue) this.focusEditor()
      if (mounted) this.queueSlot.removeChild(this.queue)
    } else {
      if (!mounted) this.queueSlot.addChild(this.queue)
      const selected = this.queueSelectionIndex(rows)
      this.queueSelection = rows[selected]?.message.id
      this.queue.setText(renderQueuePanel(rows, {
        palette: this.deps.palette,
        width: this.contentWidth(),
        ...this.focus === 'queue' ? { selected } : {},
      }))
    }
    this.tui.requestRender()
  }

  /**
   * Redraw the activity board above the editor from the open turn's todos and
   * the latest descendant line. The slot is mounted exactly while a row
   * draws, so the editor sits directly under follow-ups or the conversation
   * the rest of the time.
   */
  private refreshActivityBoard(): void {
    const view = activityBoardView({
      todos: this.activityTodos,
      ...this.activitySubagent === undefined ? {} : { subagent: this.activitySubagent },
    })
    const text = renderActivityBoard(view, {
      palette: this.deps.palette,
      todoFades: this.activityTodoFades,
      ...this.activitySubagentFade === undefined ? {} : { subagentFade: this.activitySubagentFade },
    })
    const mounted = this.activitySlot.children.length > 0
    if (text === '') {
      if (mounted) this.activitySlot.removeChild(this.activity)
    } else {
      if (!mounted) this.activitySlot.addChild(this.activity)
      this.activity.setText(text)
    }
    this.tui.requestRender()
  }

  /**
   * Replace the board's todos from the same `todos` projection `/todos` reads
   * and fade rows that are new or that changed status.
   */
  private syncActivityTodos(): void {
    const items = this.statusFacts().todos?.items ?? []
    const fades = new Map<string, BlockFade>()
    const statuses = new Map<string, TodoItem['status']>()
    for (const item of items) {
      const previous = this.activityTodoStatus.get(item.content)
      if (previous === undefined || previous !== item.status) {
        this.fadeBlock((fade) => { fades.set(item.content, fade) })
      } else {
        const existing = this.activityTodoFades.get(item.content)
        if (existing !== undefined) fades.set(item.content, existing)
      }
      statuses.set(item.content, item.status)
    }
    this.activityTodos = items
    this.activityTodoFades = fades
    this.activityTodoStatus = statuses
    this.refreshActivityBoard()
  }

  /**
   * Replace the one descendant line, fading it when the text changed.
   * @param line - the label, status word, and optional summary.
   */
  private setActivitySubagent(line: ActivityBoardSubagent): void {
    const next = formatActivitySubagentLine(line)
    const previous = this.activitySubagent === undefined ? undefined : formatActivitySubagentLine(this.activitySubagent)
    this.activitySubagent = line
    if (next !== previous) {
      this.activitySubagentFade = undefined
      this.fadeBlock((fade) => { this.activitySubagentFade = fade })
    }
    this.refreshActivityBoard()
  }

  /** Drop the open-turn board so bind and turn edges leave no stale rows. */
  private clearActivityBoard(): void {
    this.activityTodos = []
    this.activityTodoStatus = new Map()
    this.activityTodoFades = new Map()
    this.activitySubagent = undefined
    this.activitySubagentFade = undefined
    this.activityChildCall = undefined
    this.refreshActivityBoard()
  }

  /**
   * Whether `id` belongs under the bound session: a listing entry, or a
   * live child whose header parent is the bound session.
   * @param id - the session id a lifecycle event named.
   * @returns true when the activity board may show that child's status word.
   */
  private isBoundDescendantId(id: SessionId): boolean {
    if (this.subagentEntries.some(entry => entry.id === id)) return true
    const child = this.deps.ctx.get('agents')?.get(id)
    return child !== undefined && child.session.header.parentSession === this.agent.session.id
  }

  /**
   * Whether `session` is a descendant of the bound session: a listing entry,
   * or a header whose parent is the bound session.
   * @param session - the session that just logged an event.
   * @returns true when the activity board may show that session's latest line.
   */
  private isBoundDescendant(session: Session): boolean {
    return this.isBoundDescendantId(session.id) || session.header.parentSession === this.agent.session.id
  }

  /**
   * The listing label for a descendant, or its session id when the listing
   * has not named it.
   * @param id - the descendant session id.
   * @returns the board's label for that child.
   */
  private activityLabelFor(id: SessionId): string {
    const entry = this.subagentEntries.find(candidate => candidate.id === id)
    return entry?.kind === 'child' && entry.label !== undefined ? entry.label : id
  }

  /**
   * Replace the descendant line from a child session event. Assistant prose
   * is ignored; only tool calls, tool results, and turn ends update the line.
   * @param session - the descendant that logged `event`.
   * @param event - the durable event.
   */
  private onDescendantActivity(session: Session, event: SessionEvent): void {
    switch (event.type) {
      case 'tool/call': {
        const { name, arguments: argumentsJson } = event.data
        const args = parseArguments(argumentsJson)
        this.activityChildCall = { name, args }
        const view = args === undefined ? undefined : this.presentCall(name, args)
        // The line already names the tool in its status word.
        const title = view === undefined ? undefined : cardHeadline(name, view.title)
        this.setActivitySubagent({
          label: this.activityLabelFor(session.id),
          status: callingActivity(name),
          ...title === undefined ? {} : { summary: title },
        })
        return
      }
      case 'tool/result': {
        const result = event.data.message
        const call = this.activityChildCall
        this.activityChildCall = undefined
        const view = this.presentResult(
          call?.name ?? '',
          call?.args,
          result.content,
          result.isError === true,
          event.data.meta,
        )
        this.setActivitySubagent({
          label: this.activityLabelFor(session.id),
          ...activityResultParts(toolResultBody(view, result.content).lines[0], result.isError === true),
        })
        return
      }
      case 'turn/end':
        this.setActivitySubagent({
          label: this.activityLabelFor(session.id),
          status: activityTurnEndStatus(event.data.reason),
        })
        return
      default:
        return
    }
  }

  /**
   * Locate the held pending prompt after inbox insertions and claims.
   * @param rows - current queue rows.
   * @returns the selected index, or 0 when the prior row left.
   */
  private queueSelectionIndex(rows: readonly QueuePanelRow[]): number {
    const index = rows.findIndex(row => row.message.id === this.queueSelection)
    return index === -1 ? 0 : index
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
      // A panel with no row draws no mark, so it holds no lift either; the
      // fade tick compares against this to know when to build the text again.
      this.panelLift = 0
    } else {
      if (!mounted) this.panelSlot.addChild(this.panel)
      const selected = this.panelSelectionIndex(view.rows)
      this.panelSelection = view.rows[selected]?.id
      this.panelLift = this.panelLiftNow()
      this.panel.setText(renderSubagentPanel(view, {
        palette: this.deps.palette,
        width: this.contentWidth(),
        ...this.focus === 'panel' ? { selected, level: this.panelLift } : {},
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

  /** Retire and withdraw current-model effort work. */
  private cancelEffortOperation(): void {
    const operation = this.effortOperation
    this.effortOperation = undefined
    operation?.controller.abort()
  }

  /** Retire and withdraw persisted-session picker work. */
  private cancelSessionPicker(): void {
    const operation = this.sessionPicker
    this.sessionPicker = undefined
    operation?.controller.abort()
  }

  /** Withdraw picker work before quit or a session switch. */
  private cancelPickers(): void {
    this.cancelEffortOperation()
    this.cancelSessionPicker()
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
    // A seam the agent is blocked on is never buried: the reader steps aside
    // for as long as any prompt is waiting on the queue and comes back with
    // the keyboard once the last one settles. The count is what makes that
    // "any": the queue shows the next prompt after this one settled, and a
    // reader put back between the two would cover it. It is read again at
    // each step, so a reader that closed under a prompt is not brought back
    // from the dead.
    this.queuedModals += 1
    this.hideReader(true)
    if (this.reader === undefined) this.focusEditor()
    // Settling hands the keyboard back, so the press that closed the prompt
    // must not reach the editor's own Escape.
    return this.modals.run(prompt, signal).finally(() => {
      this.queuedModals -= 1
      this.armEscapeHandoff()
      if (this.queuedModals === 0) this.hideReader(false)
    })
  }

  /**
   * Take the reader off the terminal for as long as something else needs it,
   * or put it back. The reader itself stays open throughout, on the section
   * it was reading.
   * @param hidden - whether the reader steps aside.
   */
  private hideReader(hidden: boolean): void {
    if (this.reader === undefined) return
    if (hidden) this.hideReaderScreen()
    else this.showReader()
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
    const { palette } = this.deps
    const choices = listTodoChoices(
      this.deps.ctx,
      this.agent.session,
      content => palette.dim(palette.strikethrough(content)),
    )
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
   * Walk the files one turn changed: one row per file with its line counts,
   * and entering a row shows the file's turn-start to turn-end comparison.
   * @param turn - the turn to browse; the latest announced one when undefined.
   */
  private async browseChanges(turn: number | undefined): Promise<void> {
    const sessionId = this.agent.session.id
    const signal = new AbortController().signal
    const changes = await listTurnChanges(this.deps.ctx, sessionId, turn, signal)
    if (changes === undefined) {
      this.notice(turn === undefined ? 'no changed files recorded yet' : `no changed files recorded for turn ${String(turn)}`)
      return
    }
    if (changes.choices.length === 0) {
      this.notice(`${changes.heading}: no file listed`)
      return
    }
    await this.browse(changes.heading, changes.choices.map((choice): BrowseRow => ({
      item: { value: String(choice.index), label: choice.label, description: choice.description },
      heading: choice.label,
      detail: async () => {
        const rows = await changeDiffRows(this.deps.ctx, sessionId, choice, signal)
        return paintDiffRows(rows, rows, this.deps.palette)
      },
    })))
  }

  /**
   * `/plugins` and its management verbs over the profile's plugin manager:
   * the composed plugins alone, the bundles, a switch of one entry or bundle,
   * an installation, or a removal.
   * @param argument - the verb and its operand; empty lists the composed plugins.
   */
  private async plugins(argument: string): Promise<void> {
    const [verb = '', ...rest] = argument.split(/\s+/).filter(word => word !== '')
    const operand = rest.join(' ')
    switch (verb) {
      case '':
        this.showRows(listPlugins(this.deps.ctx), 'no plugins are listed')
        return
      case 'bundles':
        this.showRows(await listBundles(this.deps.ctx), 'no bundles are listed')
        return
      case 'enable':
      case 'disable':
        if (operand === '') break
        this.notice(await setPluginEnabled(this.deps.ctx, operand, verb === 'enable'), 'success')
        return
      case 'add':
        if (operand === '') break
        this.notice(`installing ${operand}…`)
        this.notice(await installBundle(this.deps.ctx, operand), 'success')
        return
      case 'remove':
        if (operand === '') break
        this.notice(await removeBundle(this.deps.ctx, operand), 'success')
        return
      default:
        break
    }
    this.notice('usage: /plugins · /plugins bundles · /plugins enable|disable <entry id or bundle> · /plugins add <spec> · /plugins remove <bundle>', 'error')
  }

  /**
   * Walk the subagent listing: `Enter` on a session opens it as a live view,
   * and on a row the listing could not read shows why, then reopens the list
   * on that row.
   * @param choices - the listing rows, in listing order.
   */
  private async browseSubagents(choices: readonly SubagentChoice[]): Promise<void> {
    const rows = choices.map(choice => this.subagentBrowseRow(choice))
    let visited: string | undefined
    for (;;) {
      const picked = await this.showModal(new PickPrompt(this.deps.palette, 'Subagent sessions', rows.map(row => row.item), {
        ...visited === undefined ? {} : { current: visited },
      }))
      const index = rows.findIndex(candidate => candidate.item.value === picked?.value)
      const [choice, row] = [choices[index], rows[index]]
      if (choice === undefined || row === undefined) return
      if (choice.enterable) {
        await this.enterSubagent(choice.id, row)
        return
      }
      visited = choice.id
      await this.showDetail(row)
    }
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
   * Open the selected panel row as a subagent view, which hands the keyboard
   * to the input of that view. A diagnostic row explains itself in the panel
   * and opens nothing.
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
    await this.enterSubagent(entry.id, this.subagentBrowseRow(subagentChoice(entry)))
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

  private currentSelection(bound: BoundSession = this.bound): ModelSelection {
    const { selection, agent } = bound
    const selected = selection.current ?? agent.session.requestHeader()?.config
    if (selected !== undefined) return selected
    return { provider: agent.options.provider ?? 'default', model: agent.options.model ?? 'default' }
  }

  // ── keyboard ────────────────────────────────────────────────────────────

  /**
   * Answer one terminal key report.
   *
   * Kitty release reports are consumed before they can repeat the press.
   * A visible prompt owns the whole key stream; `Ctrl+C` and `Ctrl+D` keep
   * their global meaning wherever the keyboard is; everything else is what
   * {@link resolveKey} makes of the key in the region that holds it.
   *
   * A reader holding the terminal takes every key here, so nothing reaches
   * the editor behind it and no frame of the conversation is asked for while
   * the terminal is showing another screen.
   * @param data - the raw key bytes.
   * @returns the consume marker, or undefined for the keys pi-tui's own
   * editor answers.
   */
  private onKey(data: string): { consume: true } | undefined {
    if (isKeyRelease(data)) return { consume: true }
    if (this.modals.isActive()) {
      if (!matchesKey(data, 'ctrl+c')) return undefined
      this.modals.withdrawActive()
      return { consume: true }
    }
    // The reader owns its whole key stream the same way: while it holds the
    // terminal every key is its own, and `Ctrl+C` alone brings the keyboard
    // back here. Nothing is left for the editor, so the renderer is never
    // asked for a frame of a conversation the terminal is not showing.
    const reading = this.reader
    if (reading !== undefined && this.readerScreen.active) {
      if (matchesKey(data, 'ctrl+c')) reading.pane.withdraw()
      else reading.pane.handleInput(data)
      this.queueReaderPaint()
      return { consume: true }
    }
    // An armed stop lasts exactly as long as its own line is on screen, so
    // any other key the editor takes - Ctrl+C and Ctrl+D included, which put
    // a line of their own up - takes that line down and disarms with it. Only
    // the editor ever holds an arm.
    if (this.focus === 'editor' && !matchesKey(data, 'escape')) this.disarmStop()
    // Ctrl+C and Ctrl+D keep their global meaning at the status bar, and give
    // the keyboard back to the editor on the way.
    if (matchesKey(data, 'ctrl+c')) {
      this.focusEditor()
      if (this.queueDraft !== undefined) {
        this.restoreQueueDraft()
        this.editor.setText('')
        this.notice('queued prompt edit canceled')
        return { consume: true }
      }
      const now = Date.now()
      if (now - this.lastCtrlC < QUIT_DOUBLE_PRESS_MS) {
        this.stop()
        return { consume: true }
      }
      this.lastCtrlC = now
      this.editor.setText('')
      this.showToast(QUIT_TOAST)
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+d')) {
      this.focusEditor()
      if (this.editor.getText() === '') this.stop()
      return { consume: true }
    }
    const action = resolveKey(this.focus, data)
    // A docked region consumes every key it sees; only `type` puts one back
    // into the editor, at the caret and with the keyboard.
    if (action === undefined) return this.focus === 'editor' ? undefined : { consume: true }
    return this.onAction(action, data)
  }

  /**
   * Apply one resolved key action.
   * @param action - what the key named where the keyboard is.
   * @param data - the raw key bytes, which a typing action hands to the editor.
   * @returns the consume marker, or undefined for the one key the editor's
   * open autocomplete answers itself.
   */
  private onAction(action: KeyAction, data: string): { consume: true } | undefined {
    switch (action.kind) {
      case 'focus':
        if (action.region === 'transcript') this.focusTranscript()
        else this.focusBar()
        return { consume: true }
      case 'leave':
        if (this.focus === 'editor') {
          if (action.direction === 'down') this.focusBelowEditor()
          else this.focusAboveEditor()
        } else {
          this.focusAboveBar()
        }
        return { consume: true }
      case 'cycle':
        this.cycleRegion(action.step)
        return { consume: true }
      case 'move':
        this.moveBy(action.axis, action.to)
        return { consume: true }
      case 'open':
        this.openFocused()
        return { consume: true }
      case 'fold':
        // The transcript keeps `Space` for the held block, so a leading space
        // never reaches the editor from a walk.
        this.foldFocused()
        return { consume: true }
      case 'fold-all':
        this.toggleFolding()
        return { consume: true }
      case 'reader': {
        // From the conversation the reader opens on the section the walk
        // holds; from everywhere else on the newest one.
        const held = this.focus === 'transcript' ? this.focusedSection() : undefined
        this.openReader(held?.cursor)
        return { consume: true }
      }
      case 'escape':
        return this.onEscape()
      case 'steer':
        this.onSubmit(this.editor.getText(), 'steer')
        return { consume: true }
      case 'queue':
        this.actOnQueuedPrompt(action.action)
        return { consume: true }
      case 'effort':
        if (this.switching) {
          this.notice(SESSION_SWITCH_WAIT, 'error')
          return { consume: true }
        }
        void this.dispatchCommand('/effort')
        return { consume: true }
      case 'todos':
        this.focusEditor()
        void this.dispatchCommand('/todos')
        return { consume: true }
      case 'parent':
        this.focusEditor()
        void this.leaveSubagent()
        return { consume: true }
      case 'help':
        // `?` is a key only on an empty input; anywhere in a draft it is text.
        if (this.editor.getText() !== '') return undefined
        void this.dispatchCommand('/help')
        return { consume: true }
      case 'redraw':
        this.tui.requestRender(true)
        return { consume: true }
      case 'type':
        this.focusEditor()
        // The application consumed the key, so pi-tui draws nothing for it.
        this.editor.handleInput(data)
        this.tui.requestRender()
        return { consume: true }
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        return assertNever(action, 'tui key action')
    }
  }

  /**
   * Answer `Escape`.
   *
   * From a docked region it hands the keyboard back to the editor and starts
   * the handoff window, so a second press landing in the editor does nothing
   * at all: leaving a region, a page, or a picker can never stop a running
   * turn. In the editor it arms the stop and says so, and only a second press
   * while that line is still on screen stops the turn.
   * @returns the consume marker, or undefined while the editor's open
   * autocomplete answers the key itself.
   */
  private onEscape(): { consume: true } | undefined {
    if (this.focus !== 'editor') {
      this.focusEditor()
      this.armEscapeHandoff()
      return { consume: true }
    }
    const now = this.deps.now()
    if (now < this.escapeQuietUntil) return { consume: true }
    if (this.editor.isShowingAutocomplete()) return undefined
    if (this.shellAbort !== undefined) {
      this.shellAbort.abort()
      return { consume: true }
    }
    if (this.agent.status !== 'running') {
      if (this.editor.getText().trimStart().startsWith('!')) {
        this.editor.setText('')
        this.syncEditorBorder()
      }
      return { consume: true }
    }
    if (now >= this.stopArmedUntil) {
      this.stopArmedUntil = now + this.showToast(stopTurnToast(this.turn))
      return { consume: true }
    }
    this.disarmStop()
    this.agent.cancel({ kind: 'user' }, { keepInbox: true })
    const queued = this.agent.inbox.nextTurn.length + this.agent.inbox.nextStep.length
    this.notice(queued === 0 ? 'stopping the turn…' : `stopping the turn… ${String(queued)} queued message(s) stay queued`)
    return { consume: true }
  }

  /** Start the window in which an `Escape` reaching the editor does nothing at all. */
  private armEscapeHandoff(): void {
    this.escapeQuietUntil = this.deps.now() + ESCAPE_HANDOFF_MS
  }

  /** Disarm the stop and take the line that armed it down. */
  private disarmStop(): void {
    this.stopArmedUntil = 0
    this.hideToast()
  }

  /**
   * Show one transient line over the conversation, replacing whichever line
   * is up.
   *
   * It normally costs the frame no rows: pi-tui composites an overlay into
   * the viewport after the tree rendered, so nothing already drawn moves and
   * the renderer's repaint boundary stays where it was. Where the renderer
   * can no longer repaint that part of the viewport the line is printed into
   * the conversation instead, which costs a row and keeps it: a line that says
   * which key stops a turn is worth more than its own disappearance.
   * @param text - what the line says.
   * @returns how long the line answers for, in milliseconds - the time it is
   * drawn when it floats, and the same window when the conversation kept it.
   */
  private showToast(text: string): number {
    this.hideToast()
    // Settle the frame first: the line goes onto the frame the keys that led
    // here leave behind, not the one before it.
    this.tui.renderNow()
    if (!toastDrawable(this.viewportFloor)) {
      // The viewport's top is out of the renderer's reach, and rewriting a
      // line above it would cost the terminal's whole scrollback. The
      // conversation takes the line instead, where appending is always safe.
      this.notice(text)
      return this.deps.toastMs
    }
    const clock = new ToastClock({
      shownAt: this.deps.now(),
      holdMs: this.deps.toastMs,
      steps: this.deps.fadeSteps,
      stepMs: this.deps.fadeStepMs,
      fading: this.fading && this.fadeStyle.capability !== 'none',
      now: () => this.deps.now(),
    })
    const pane = new ToastPane(text, {
      palette: this.deps.palette,
      age: () => clock.age(),
      style: () => this.fadeStyle,
    })
    this.toast = { handle: this.tui.showOverlay(pane, toastOverlay(text, () => toastDrawable(this.viewportFloor))), clock }
    this.motions.add(clock)
    this.updateFadeTicker()
    return clock.lifetimeMs()
  }

  /** Take the transient line down, if one is up. */
  private hideToast(): void {
    const toast = this.toast
    if (toast === undefined) return
    toast.handle.hide()
    // The clock settles with the line it timed, so the fade tick a line that
    // is no longer drawn was holding up disarms here rather than at the end
    // of a flight nothing can see.
    toast.clock.settle()
    this.toast = undefined
    this.updateFadeTicker()
  }

  /**
   * Read the transcript full screen.
   *
   * The reader takes the terminal rather than drawing over the conversation:
   * the frame on screen is written one last time, the main screen is then
   * held off the terminal, and the alternate screen carries the reader. The
   * conversation keeps every line it had, the renderer's repaint boundary
   * stays where it was, and nothing the reader draws can reach the terminal's
   * scrollback.
   * @param at - the section to open on; the newest one when omitted.
   */
  private openReader(at?: TranscriptCursor): void {
    const blocks = navigableBlocks(this.chat.children)
    const cursor = at ?? lastSection(blocks)
    if (cursor === undefined) {
      this.showToast(NOTHING_TO_READ_TOAST)
      return
    }
    const pane = new ReaderPane({
      palette: this.deps.palette,
      blocks: () => navigableBlocks(this.chat.children),
      rows: () => Math.max(1, this.deps.terminal.rows),
      minColumns: this.deps.readerMinColumns,
      cursor,
      highlight: this.codeHighlight,
      effects: {
        style: () => this.fadeStyle,
        background: () => this.background,
        startReveal: () => this.startReaderReveal(),
      },
      onExit: (exit) => { this.closeReader(exit) },
    })
    this.reader = { pane }
    this.showReader()
  }

  /**
   * Start one reveal of the reader on the application's fade tick, which
   * repaints the reader until the reveal settles. A terminal that runs no
   * motion reveals nothing, and the reader draws its settled rows.
   * @returns the reveal's clock, or undefined on a terminal that runs no motion.
   */
  private startReaderReveal(): BlockFadeClock | undefined {
    if (!this.fading) return undefined
    const clock = new BlockFadeClock({
      bornAt: this.deps.now(),
      stepMs: this.deps.fadeStepMs,
      steps: this.deps.fadeSteps,
      now: () => this.deps.now(),
    })
    this.motions.add(clock)
    this.updateFadeTicker()
    return clock
  }

  /**
   * Put the open reader on the terminal: settle the conversation, hold the
   * main screen off the terminal, and draw the reader on the alternate one.
   *
   * Called with a reader open and the conversation on the terminal.
   *
   * Every render the application already asks for draws the reader while it is
   * up, so a landing tool result, a streamed word, and a resize all reach it
   * without a clock of its own.
   */
  private showReader(): void {
    // The conversation the reader is opened over is drawn as it stands, so
    // the screen the terminal restores afterwards is the one the keys that
    // led here left behind.
    this.tui.renderNow()
    this.tui.suspend(() => { this.queueReaderPaint() })
    this.readerScreen.enter()
    this.paintReader()
  }

  /**
   * Take the reader off the terminal and give the conversation its screen
   * back, leaving the reader itself open. Both steps answer for a terminal
   * the reader never took, so a caller needs to know only that it is done.
   */
  private hideReaderScreen(): void {
    this.readerScreen.leave()
    // The terminal restored the conversation exactly as the reader found it,
    // so the renderer draws only what the session changed meanwhile.
    this.tui.resume()
  }

  /**
   * Draw the open reader, at most once per turn of the loop.
   *
   * The pane re-reads the conversation on every paint, so a burst of session
   * events costs one drawing rather than one per event.
   */
  private queueReaderPaint(): void {
    if (this.readerPaintQueued) return
    this.readerPaintQueued = true
    queueMicrotask(() => {
      this.readerPaintQueued = false
      this.paintReader()
    })
  }

  /** Draw the open reader now, if one holds the terminal. */
  private paintReader(): void {
    const open = this.reader
    if (open === undefined || !this.readerScreen.active) return
    this.readerScreen.paint(open.pane.render(Math.max(1, this.deps.terminal.columns)))
  }

  /**
   * Take the reader down and put the keyboard where it left it.
   * @param exit - the section last read and the region that takes over.
   */
  private closeReader(exit: ReaderExit): void {
    if (this.reader === undefined) return
    this.reader = undefined
    this.cursor = exit.cursor
    this.hideReaderScreen()
    // `focusRegion` returns early for the region the app already records, and
    // the reader left that record alone, so the caret state is set outright.
    this.setFocus(exit.target)
    this.refreshQueue()
    this.refreshSubagentPanel()
    this.armEscapeHandoff()
    this.tui.requestRender()
  }

  /**
   * Take the reader down from outside, for a terminal that is stopping or a
   * conversation that is being replaced. The application's own record goes
   * first, so the pane's settlement moves no focus and puts no cursor of a
   * transcript that is gone back on the walk.
   * @returns whether a reader was open, so the caller can report that it came down.
   */
  private dropReader(): boolean {
    const open = this.reader
    if (open === undefined) return false
    this.reader = undefined
    this.hideReaderScreen()
    open.pane.withdraw()
    return true
  }

  /**
   * Step the selection of the region that holds the keyboard.
   * @param axis - what the key steps along; each axis belongs to one region.
   * @param to - which way along it.
   */
  private moveBy(axis: MoveAxis, to: MoveTarget): void {
    switch (axis) {
      case 'section':
      case 'block':
      case 'turn':
      case 'part':
        this.moveTranscript(axis, to)
        return
      case 'prompt':
        this.moveQueueBy(to)
        return
      case 'row':
        this.movePanelBy(to)
        return
      case 'segment':
        this.moveStatusBar(to)
        return
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        assertNever(axis, 'tui move axis')
    }
  }

  /**
   * Walk the transcript focus along one axis. Past the newest section the
   * walk continues in the editor, which is drawn directly under the
   * conversation; the oldest section is the end of the walk, and a part,
   * block, or turn step stays in the transcript at both ends.
   * @param axis - what the key steps along.
   * @param to - which way along it.
   */
  private moveTranscript(axis: TranscriptAxis, to: MoveTarget): void {
    const section = this.focusedSection()
    /* v8 ignore next 5 -- only a session change empties the transcript, and it hands the keyboard back first */
    if (section === undefined) {
      // Nothing left to select: the editor takes the keyboard back.
      this.focusEditor()
      return
    }
    const { cursor, blocks } = section
    const next = moveTranscriptCursor(cursor, axis, to, blocks)
    const held = next.block === cursor.block && next.part === cursor.part
    if (axis === 'section' && to === 'next' && held) this.focusEditor()
    else this.moveCursor(next)
  }

  /**
   * Walk the queued-prompt selection, stopping at both ends.
   * @param to - which way along the pending prompts.
   */
  private moveQueueBy(to: MoveTarget): void {
    const rows = this.queueView
    const index = this.queueSelectionIndex(rows)
    const last = Math.max(0, rows.length - 1)
    const selected = to === 'first' ? 0
      : to === 'last' ? last
        : to === 'previous' ? Math.max(0, index - 1)
          : Math.min(last, index + 1)
    this.queueSelection = rows[selected]?.message.id
    this.refreshQueue()
  }

  /** Apply one focused queue-panel command to the selected pending prompt. */
  private actOnQueuedPrompt(action: 'steer' | 'inject' | 'edit'): void {
    const row = this.queueView[this.queueSelectionIndex(this.queueView)]
    if (row === undefined) return
    if (action === 'edit') {
      if (!this.agent.inbox.remove(row.message.id)) {
        this.notice('that queued prompt was already claimed', 'error')
        this.refreshQueue()
        return
      }
      this.queueDraft = row.message
      this.editor.setText(contentText(row.message.content))
      this.focusEditor()
      this.notice('editing queued prompt; Enter sends the revision')
      return
    }
    this.transferringQueue = true
    try {
      if (!this.agent.inbox.remove(row.message.id)) {
        this.notice('that queued prompt was already claimed', 'error')
        return
      }
      if (action === 'steer') this.agent.steer(row.message)
      else this.agent.inject(row.message)
    } finally {
      this.transferringQueue = false
      this.refreshQueue()
      this.refreshFooter()
    }
    this.notice(action === 'steer'
      ? 'queued prompt is steering the nearest step'
      : 'queued prompt will be injected at the nearest step without waking the Agent')
  }

  /**
   * Walk the subagent panel's selection. Above the first row the walk
   * continues in the editor, below the last one at the status bar.
   * @param to - which way along the drawn rows.
   */
  private movePanelBy(to: MoveTarget): void {
    const rows = this.panelView.rows
    const index = this.panelSelectionIndex(rows)
    switch (to) {
      case 'previous':
        if (index === 0) this.focusEditor()
        else this.selectPanelRow(index - 1)
        return
      case 'next':
        if (index === rows.length - 1) this.focusBar()
        else this.selectPanelRow(index + 1)
        return
      case 'first':
        this.selectPanelRow(0)
        return
      case 'last':
        this.selectPanelRow(rows.length - 1)
        return
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        assertNever(to, 'tui move target')
    }
  }

  /** Open what the focused region's `Enter` leads to. */
  private openFocused(): void {
    if (this.focus === 'panel') {
      this.navigate('subagent details', () => this.openPanelRow())
      return
    }
    if (this.focus === 'bar') {
      this.openSegment(this.barSelection)
      return
    }
    const section = this.focusedSection()
    /* v8 ignore next -- the transcript answers Enter only while it holds a section */
    if (section === undefined) return
    this.openReader(section.cursor)
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
   * Move the bar's selection: one segment either way wrapping at both ends,
   * or straight to an end.
   * @param to - which way along the drawn segments.
   */
  private moveStatusBar(to: MoveTarget): void {
    const count = this.segments.length
    const next = this.segments[barTarget(to, footerSelectionIndex(this.segments, this.barSelection), count)]
    /* v8 ignore next -- the wrapped index stays inside the bar's own segments */
    if (next !== undefined) this.barSelection = next.id
    this.startChrome('selection', SEGMENT_TICKS)
    this.refreshFooter()
  }

  /**
   * Put the panel's selection on one of its drawn rows. The rows behind a
   * `+<n> more` row are not selectable; `/subagents` walks the complete tree.
   * @param index - the row the selection lands on.
   */
  private selectPanelRow(index: number): void {
    this.panelSelection = this.panelView.rows[index]?.id
    this.refreshSubagentPanel()
  }

  /**
   * Give the keyboard to the status bar, starting at its first segment. The
   * bar is redrawn even when it already held the keyboard, because the
   * selection this reset would otherwise disagree with the segment still
   * drawn as selected, and `Enter` would open the other one.
   */
  private focusBar(): void {
    this.barSelection = FIRST_FOOTER_SEGMENT
    if (this.focus !== 'bar') {
      this.focusRegion('bar')
      return
    }
    this.startChrome('selection', SEGMENT_TICKS)
    this.refreshFooter()
  }

  /** Give the keyboard to the queued-prompt panel on one of its rows. */
  private focusQueue(index: number): void {
    this.queueSelection = this.queueView[index]?.message.id
    this.focusRegion('queue')
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
   * Give `Shift+Up` to the pending-prompt panel when it is drawn, then the
   * conversation above the editor.
   */
  private focusAboveEditor(): void {
    if (this.queueView.length > 0) this.focusQueue(0)
    else this.focusTranscript()
  }

  /**
   * Give `Shift+Down` to the first region below the editor.
   */
  private focusBelowEditor(): void {
    if (this.panelView.rows.length > 0) this.focusPanel(0)
    else this.focusBar()
  }

  /**
   * Give the keyboard to the region above the status bar: the subagent
   * panel's last row while the panel is drawn, and the editor otherwise,
   * which is what the bar sits under once no panel is between them.
   */
  private focusAboveBar(): void {
    if (this.panelView.rows.length > 0) this.focusPanel(this.panelView.rows.length - 1)
    else this.focusEditor()
  }

  /**
   * The section the conversation takes the keyboard on: the one it was left
   * on, settled against the blocks drawn now, and the newest section when no
   * remembered cursor survives — which is every first entry, because a
   * session switch forgets the cursor with the blocks it named.
   * @returns the cursor, or undefined when the transcript has nothing to read.
   */
  private transcriptEntry(): TranscriptCursor | undefined {
    const blocks = navigableBlocks(this.chat.children)
    const remembered = this.cursor === undefined ? undefined : clampCursor(this.cursor, blocks)
    return remembered ?? lastSection(blocks)
  }

  /**
   * Give the keyboard to the transcript, where it left off. A session with
   * nothing to read yet says so and leaves the keyboard where it was.
   */
  private focusTranscript(): void {
    const cursor = this.transcriptEntry()
    if (cursor === undefined) {
      this.showToast(NOTHING_TO_READ_TOAST)
      return
    }
    this.cursor = cursor
    this.focusRegion('transcript')
    this.tui.requestRender()
  }

  /**
   * The regions drawn around the editor right now, in screen order, except
   * that the editor itself is not part of the `Tab` walk.
   * @returns the regions `Tab` walks.
   */
  private drawnRegions(): DockedRegion[] {
    const drawn: DockedRegion[] = []
    if (this.transcriptEntry() !== undefined) drawn.push('transcript')
    if (this.queueView.length > 0) drawn.push('queue')
    if (this.panelView.rows.length > 0) drawn.push('panel')
    drawn.push('bar')
    return drawn
  }

  /**
   * Give the keyboard to the next drawn region, wrapping at both ends. The
   * editor is not in the walk: `Esc` and the printable keys return there from
   * anywhere.
   * @param step - 1 for the next region, -1 for the previous one.
   */
  private cycleRegion(step: 1 | -1): void {
    const drawn = this.drawnRegions()
    const from = drawn.findIndex(region => region === this.focus)
    const next = drawn[(from + step + drawn.length) % drawn.length]
    /* v8 ignore next -- the status bar is always drawn, so the wrapped index names a region */
    if (next === undefined) return
    if (next === 'transcript') this.focusTranscript()
    else if (next === 'queue') this.focusQueue(this.queueSelectionIndex(this.queueView))
    else if (next === 'panel') this.focusPanel(this.panelSelectionIndex(this.panelView.rows))
    else this.focusBar()
  }

  /**
   * Put the transcript focus on another section.
   * @param cursor - where the focus moves to.
   */
  private moveCursor(cursor: TranscriptCursor): void {
    this.cursor = cursor
    this.startChrome('selection', STEP_TICKS)
    this.tui.requestRender()
  }

  /**
   * Read the remembered cursor against the transcript as it is drawn right
   * now, which grew parts and blocks since the cursor was taken. The cursor
   * itself is left alone, so a page and a trip through the editor come back
   * to the same section; {@link TuiApp.moveCursor} moves it and
   * {@link TuiApp.bind} drops it with the session it belonged to.
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
      level: this.frameLift(),
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
    this.refreshQueue()
    this.refreshSubagentPanel()
  }

  /**
   * Give the keyboard to `region` and redraw the bar. The caller redraws the
   * panel; the panel's own refresh calls this when its last row leaves.
   *
   * A region taking the keyboard lifts its own chrome for a moment, which is
   * what makes the landing visible; the editor taking it back settles
   * whatever was still moving, because nothing that motion lifted is drawn
   * any more.
   * @param region - the region that takes the keyboard.
   */
  private setFocus(region: FocusRegion): void {
    if (region === 'editor') this.chrome = undefined
    else this.startChrome('landing', LANDING_TICKS)
    this.focus = region
    // pi-tui accepts a null focus, so the editor stops drawing its cursor
    // while another region owns the keyboard. An open reader owns the whole
    // key stream, so nothing the docked regions do may take it away.
    if (this.reader === undefined) this.tui.setFocus(region === 'editor' ? this.editor : null)
    this.refreshFooter()
  }

  /**
   * Answer `Ctrl+O` and `/tools`: fold or unfold every block that folds, tool
   * cards and context rows alike. The setting outlives the blocks on screen,
   * so a card or an injection that arrives later opens with the rest.
   *
   * On a transcript taller than the terminal this rewrites lines the renderer
   * can no longer repaint and pi-tui redraws the screen in full. It is the one
   * key that does; `Space` turns the held block alone, inside the window.
   */
  private toggleFolding(): void {
    this.toolsExpanded = !this.toolsExpanded
    for (const child of this.chat.children) {
      if (isFoldable(child)) child.setExpanded(this.toolsExpanded)
    }
    this.tui.requestRender()
  }

  /**
   * Answer `Space`: fold or unfold the block the transcript focus holds.
   *
   * Rewriting a block in place is legal only while the renderer can still
   * repaint its first line, and the frame's own guard is what knows that: the
   * render settles the frame, and the mark it leaves names the one block this
   * key may rewrite. A block above that window keeps what it draws, and the
   * line names the key that opens every block at once instead.
   */
  private foldFocused(): void {
    const section = this.focusedSection()
    const block = section?.block
    if (section === undefined || block === undefined || !isFoldable(block)) return
    // Settle the frame first: the mark describes the frame the keys that led
    // here leave behind, not the one before them.
    this.tui.renderNow()
    if (this.highlighted?.block !== block) {
      // What cannot be marked cannot be rewritten either; the reader draws
      // every row of it instead, at no cost to the conversation. The reader
      // takes the terminal, so the reason it opened is a notice rather than a
      // floating line: the conversation keeps it, and it is read when the
      // reader gives the screen back.
      this.notice(ABOVE_WINDOW_NOTICE)
      this.openReader(section.cursor)
      return
    }
    block.setExpanded(!block.isExpanded())
    this.tui.requestRender()
  }

  /**
   * Handle a submitted editor line: a `/` line runs a command, a nonempty `!`
   * / `!!` line runs in the terminal, and anything else becomes a user message.
   * @param raw - the editor text.
   * @param mode - how a message reaches a running Agent: `queue` waits for the next turn, `steer` enters the current one.
   */
  private onSubmit(raw: string, mode: SubmitMode = 'queue'): void {
    const text = raw.trim()
    if (text === '') return
    if (this.switching) {
      this.notice(SESSION_SWITCH_WAIT, 'error')
      return
    }
    this.editor.setText('')
    this.editor.addToHistory(text)
    const draft = this.queueDraft
    this.queueDraft = undefined
    if (draft === undefined && text.startsWith('/')) {
      void this.dispatchCommand(text)
      return
    }
    const shell = draft === undefined ? parseUserShellLine(text) : undefined
    if (shell !== undefined) {
      void this.runUserShell(shell.command, shell.excluded)
      return
    }
    this.submit(text, mode, draft)
  }

  /**
   * Run one slash command and turn a rejection into a terminal notice.
   * @param line - the complete slash-command line.
   * @returns when the command or its failure notice settles.
   */
  private dispatchCommand(line: string): Promise<void> {
    const name = line.slice(0, line.indexOf(' ') === -1 ? undefined : line.indexOf(' '))
    return this.runCommand(line).catch((error: unknown) => { this.notice(`${name} failed: ${describeFailure(error)}`, 'error') })
  }

  /**
   * Run one user-typed shell command in this process and, unless it was `!!`,
   * inject the result as next-step context for the next admitted request.
   * @param command - the text after `!` / `!!`.
   * @param excluded - true when the line used `!!`.
   */
  private async runUserShell(command: string, excluded: boolean): Promise<void> {
    if (this.shellAbort !== undefined) {
      this.notice(SHELL_BUSY, 'error')
      this.editor.setText(excluded ? `!!${command}` : `!${command}`)
      this.syncEditorBorder()
      return
    }
    const shell = this.deps.ctx.get('shell')
    if (shell === undefined) {
      this.notice(SHELL_MISSING, 'error')
      return
    }
    /* v8 ignore next -- TUI sessions record cwd on create; process cwd is the fallback when a header omitted it */
    const workdir = this.agent.session.header.cwd ?? this.deps.cwd
    const controller = new AbortController()
    this.shellAbort = controller
    try {
      const result = await (await shell.execute(shell.resolve({
        command,
        workdir,
        signal: controller.signal,
        sandboxPolicy: {
          mode: 'danger-full-access',
          workspaceRoot: workdir,
          sessionId: this.agent.session.id,
        },
      }))).result()
      if (!this.userShellCurrent(controller)) return
      this.showUserShell(command, result, excluded)
    } catch (error: unknown) {
      if (!this.userShellCurrent(controller)) return
      this.notice(`! failed: ${describeFailure(error)}`, 'error')
    } finally {
      if (this.shellAbort === controller) this.shellAbort = undefined
    }
  }

  /**
   * Whether `controller` is still the in-flight user-shell run on this bound
   * session. Bind and quit drop the controller so a late settle cannot draw or
   * inject into the next session.
   * @param controller - the AbortController created for this run.
   * @returns true while this run still owns `shellAbort` and the app is up.
   */
  private userShellCurrent(controller: AbortController): boolean {
    return !this.stopped && this.shellAbort === controller
  }

  /**
   * Detach and abort the in-flight user-shell run, if any. A late settle then
   * sees a different controller (or a stopped app) and stays silent.
   */
  private dropUserShell(): void {
    const running = this.shellAbort
    this.shellAbort = undefined
    running?.abort()
  }

  /**
   * Draw one finished user shell run and inject the model-facing notice.
   * @param command - the text after `!` / `!!`.
   * @param result - the completed foreground run.
   * @param excluded - true when the line used `!!`.
   */
  private showUserShell(command: string, result: ShellRunResult, excluded: boolean): void {
    this.chat.addChild(new UserShellBlock(this.theme, command, userShellTranscriptRows(command, result)))
    this.tui.requestRender()
    if (excluded) return
    const message = createUserMessage({
      content: [{ type: 'text', text: userShellContextText(command, result) }],
      source: { kind: 'tui-app', form: 'notice', summary: boundContextSummary(`! ${command}`) },
    })
    this.submittedIds.add(message.id)
    this.agent.inject(message)
    this.refreshQueue()
  }

  /**
   * Recolor the editor border while the draft starts with `!`.
   */
  private syncEditorBorder(): void {
    const palette = this.deps.palette
    this.editor.borderColor = this.editor.getText().trimStart().startsWith('!') ? palette.warning : palette.dim
    this.tui.requestRender()
  }

  /** Return an abandoned edit to the ordinary-turn inbox without waking the Agent. */
  private restoreQueueDraft(): void {
    const draft = this.queueDraft
    if (draft === undefined) return
    this.queueDraft = undefined
    this.agent.inbox.append('next-turn', draft)
    this.refreshQueue()
    this.refreshFooter()
  }

  private submit(text: string, mode: SubmitMode = 'queue', draft?: UserMessage): void {
    const agent = this.agent
    const attachments = this.pending.splice(0)
    const retained = draft?.content.filter(block => block.type !== 'text') ?? []
    const message: UserMessage = createUserMessage({
      content: [...retained, ...attachments.map(attachment => attachment.block), { type: 'text', text }],
      source: terminalPromptSource(draft),
    })
    if (agent.status !== 'running') {
      // An idle Agent takes the prompt at once, so it is drawn here and the
      // durable `user/message` that follows is not drawn a second time.
      this.submittedIds.add(message.id)
      const shown = attachments.length === 0 ? text : `${text}\n${attachments.map(attachment => `[${attachment.block.type}: ${attachment.name}]`).join(' ')}`
      this.chat.addChild(new UserBlock(this.theme, shown, this.turn))
      agent.followup(message)
    } else if (mode === 'steer') {
      // A prompt that waits in the inbox is drawn above the editor instead,
      // and enters the conversation through its `user/message` when claimed.
      agent.steer(message)
      this.notice('steering the running turn: it reaches the next step')
    } else {
      agent.followup(message)
      this.notice('queued for the next turn (Ctrl+S steers the running turn instead)')
    }
    this.refreshQueue()
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
      case 'btw':
        await this.openAside(argument)
        return
      case 'quit':
      case 'exit':
        this.stop()
        return
      case 'tools':
        this.toggleFolding()
        return
      case 'turns':
        this.openReader()
        return
      case 'model':
        this.cancelEffortOperation()
        await this.chooseModel(argument)
        return
      case 'effort':
        await this.runCurrentEffort(argument)
        return
      case 'permission':
        await this.choosePermission(argument)
        return
      case 'sessions':
      case 'resume':
        await this.openSessionPicker()
        return
      case 'new':
      case 'clear':
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
      case 'changes': {
        const turn = argument === '' ? undefined : Number(argument)
        if (turn !== undefined && !(Number.isSafeInteger(turn) && turn > 0)) {
          this.notice('usage: /changes · /changes <turn>', 'error')
          return
        }
        await this.browseChanges(turn)
        return
      }
      case 'subagents': {
        const choices = await listSubagentChoices(this.deps.ctx, this.agent.session.id, new AbortController().signal)
        if (choices.length === 0) {
          this.notice('no subagent sessions')
          return
        }
        await this.browseSubagents(choices)
        return
      }
      case 'parent':
        await this.leaveSubagent()
        return
      case 'settings':
        await this.settings(argument)
        return
      case 'plugins':
        await this.plugins(argument)
        return
      default:
        await this.runSharedCommand(line, name)
    }
  }

  /**
   * Print the commands and the keys: one row per focus state, the keys it
   * answers beside its name. Every legend is the one its own surface draws,
   * read from the module that owns it, so this list cannot name a key the
   * screen names differently.
   */
  private showHelp(): void {
    const palette = this.deps.palette
    const rows = this.completableCommands().map(command => `/${command.name.padEnd(12)} ${palette.dim(command.description)}`)
    this.chat.addChild(new Text([...rows, '', ...helpKeyLines().map(palette.dim)].join('\n'), 0, 1))
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
      await this.saveDefaultModel(this.currentSelection())
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
        body: [MODEL_PICKER_HINT],
        current: `${current.provider}/${current.model}`,
        // The save leaves the picker open: the highlighted model becomes the
        // next launch's default whether or not Enter then applies it here.
        onSave: (item) => { void this.saveDefaultModel(splitModelValue(item.value)) },
      }))
      if (picked === undefined) return
      next = splitModelValue(picked.value)
    }
    const effort = await this.chooseEffort(next)
    if (effort === null) return
    this.cancelEffortOperation()
    selection.current = effort === undefined ? next : { ...next, reasoningEffort: effort }
    this.notice(`model: ${next.provider}/${next.model}${effort === undefined ? '' : ` · effort ${effort}`} from the next request`, 'success')
    this.refreshFooter()
  }

  /**
   * Record `model` as the default every later launch starts from. The
   * reasoning effort rides along when the selection carries one.
   * @param model - the provider and model to save.
   */
  private async saveDefaultModel(model: ModelSelection): Promise<void> {
    const defaults = this.deps.ctx.get('agentDefaultModel')
    /* v8 ignore next 4 -- the runner injects the default-model service; only teardown can remove it */
    if (defaults === undefined) {
      this.notice('no default model service is composed', 'error')
      return
    }
    try {
      await defaults.saveSelection(model)
    } catch (error: unknown) {
      this.notice(`default model not saved: ${describeFailure(error)}`, 'error')
      return
    }
    this.notice(`default model saved: ${model.provider}/${model.model}`, 'success')
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
   * Whether asynchronous command or picker work may no longer affect its
   * originating session.
   * @param bound - the session binding that started the work.
   * @param signal - cancellation owned by the picker operation.
   * @returns true after cancellation, quit, or a session switch.
   */
  private operationAbandoned(bound: BoundSession, signal?: AbortSignal): boolean {
    return this.stopped || this.switching || this.bound !== bound || signal?.aborted === true
  }

  /**
   * Whether current-model effort work lost either its session or selection.
   * @param bound - the session binding that started the work.
   * @param selected - that binding's explicit selection when the work began.
   * @param signal - cancellation owned by the effort operation.
   * @returns true when applying the result would overwrite newer state.
   */
  private effortAbandoned(
    bound: BoundSession,
    selected: ModelSelection | undefined,
    signal: AbortSignal,
  ): boolean {
    return bound.selection.current !== selected || this.operationAbandoned(bound, signal)
  }

  /**
   * Run one current-model effort command; equal active arguments share it and
   * a different argument supersedes it.
   * @param argument - a declared effort id, `default`, or empty for the picker.
   * @returns when this effort operation settles.
   */
  private runCurrentEffort(argument: string): Promise<void> {
    if (this.effortOperation?.argument === argument) return this.effortOperation.done
    this.cancelEffortOperation()
    const controller = new AbortController()
    const operation: EffortOperation = { argument, controller, done: Promise.resolve() }
    this.effortOperation = operation
    operation.done = this.chooseCurrentEffort(argument, this.bound, controller.signal).finally(() => {
      if (this.effortOperation === operation) this.effortOperation = undefined
    })
    return operation.done
  }

  /**
   * Choose the bound model's reasoning effort for the next request: an empty
   * argument opens the picker on the effort in force, `default` restores the
   * provider default, and anything else names a declared effort.
   * @param argument - a declared effort id, `default`, or empty.
   * @param bound - the session binding whose selection the lookup describes.
   * @param signal - withdraws an empty-argument picker when the session changes.
   */
  private async chooseCurrentEffort(argument: string, bound: BoundSession, signal: AbortSignal): Promise<void> {
    const selected = bound.selection.current
    const current = this.currentSelection(bound)
    const lookup = await this.lookupEfforts(current)
    if (this.effortAbandoned(bound, selected, signal)) return
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
    ), signal)
    if (picked === undefined || this.effortAbandoned(bound, selected, signal)) return
    this.applyEffort(current, picked.value === PROVIDER_DEFAULT ? undefined : ReasoningEffortId(picked.value))
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

  /**
   * Choose the bound session's permission preset: an empty argument opens
   * the picker on the preset in force, and anything else names a catalog
   * value. A pick submits `/permission <preset>` when the shared command
   * exists, the same write path the browser uses.
   * @param argument - a catalog value, or empty for the picker.
   */
  private async choosePermission(argument: string): Promise<void> {
    const presets = this.deps.ctx.get('permissionPresets')
    if (presets === undefined) {
      this.notice('no permission service is composed', 'error')
      return
    }
    const options = presets.catalog().options
    if (argument !== '') {
      const matched = matchPermission(options, argument)
      if (matched === null) {
        const available = options.map(option => option.value).join(', ')
        this.notice(available === ''
          ? `unknown preset "${argument}"`
          : `unknown preset "${argument}" (available: ${available})`, 'error')
        return
      }
      await this.applyPermission(presets, matched)
      return
    }
    if (options.length === 0) {
      this.notice('no selectable permission presets')
      return
    }
    const current = presets.current(this.agent.session)
    const picked = await this.showModal(new PickPrompt(
      this.deps.palette,
      'Permission preset',
      permissionItems(options),
      {
        body: [permissionHint(options, current)],
        current,
      },
    ))
    if (picked === undefined) return
    await this.applyPermission(presets, picked.value)
  }

  /**
   * Switch to `name` through the shared `/permission` command when a
   * registry is composed, otherwise through the permission service.
   * @param presets - the composed permission service.
   * @param name - a catalog value.
   */
  private async applyPermission(presets: Context['permissionPresets'], name: string): Promise<void> {
    if (this.deps.ctx.get('commands') !== undefined) {
      await this.runSharedCommand(`/permission ${name}`, 'permission')
      return
    }
    presets.set(this.agent.session, name)
    this.notice(`preset ${name}`, 'success')
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

  /**
   * Open the one persisted-session picker shared by `/sessions` and `/resume`.
   * @returns when the active picker operation settles.
   */
  private openSessionPicker(): Promise<void> {
    if (this.sessionPicker !== undefined) return this.sessionPicker.done
    const controller = new AbortController()
    const operation: CancellableOperation = { controller, done: Promise.resolve() }
    this.sessionPicker = operation
    operation.done = this.chooseSession(this.bound, controller.signal).finally(() => {
      if (this.sessionPicker === operation) this.sessionPicker = undefined
    })
    return operation.done
  }

  /**
   * List and open sessions for one still-current binding.
   * @param bound - the session that was current when listing began.
   * @param signal - cancels listing and withdraws its queued or visible picker.
   */
  private async chooseSession(bound: BoundSession, signal: AbortSignal): Promise<void> {
    this.notice('listing sessions…')
    let choices: SessionChoice[]
    try {
      choices = await listSessionChoices(this.deps.ctx, bound.agent.session.id, signal)
    } catch (error: unknown) {
      if (signal.aborted) return
      throw error
    }
    if (this.operationAbandoned(bound, signal)) return
    if (choices.length === 0) {
      this.notice('no persisted sessions are listed by the composed query engine', 'error')
      return
    }
    const items = choices.map((choice): PickItem => ({ value: choice.id, ...describeSession(choice) }))
    const picked = await this.showModal(new PickPrompt(this.deps.palette, 'Switch to a session', items), signal)
    if (picked === undefined || this.operationAbandoned(bound, signal)) return
    const target = choices.find(choice => choice.id === picked.value)
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
      this.refreshQueue()
      this.notice('queue cleared', 'success')
      return
    }
    const queued = (messages: readonly UserMessage[]): UserMessage[] => messages.filter(message => message.source.kind === 'user')
    const rows = [
      ...queued(inbox.nextTurn).map(message => `next turn: ${contentText(message.content)}`),
      ...queued(inbox.nextStep).map(message => `next step: ${contentText(message.content)}`),
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
    const detail = args === undefined ? [] : toolCallText(JSON.stringify(args), this.presentCall(toolName, args), toolName).lines
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
   * Hand one live-stream delta to the transcript: through the pacer, which
   * releases it on a later frame, or at once when deltas are not paced.
   * @param channel - what the delta belongs to; consecutive deltas of one
   * channel release through the first delta's `release`.
   * @param text - the delta.
   * @param release - draws a released part of the delta.
   */
  private pace(channel: string, text: string, release: (text: string) => void): void {
    if (this.pacer === undefined) {
      release(text)
      return
    }
    this.pacer.push(channel, text, release)
    this.updateFadeTicker()
  }

  /**
   * Draw thinking that is still queued. The pacer would otherwise keep
   * releasing it after the model has moved on to reply text or a tool call.
   */
  private finishReasoningPace(): void {
    if (this.pacer?.flushChannel('reasoning') === true) this.tui.requestRender()
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
   * Take one reasoning delta, which floats out on its own tail: the reasoning
   * and the visible text of one message stream at different times, and each
   * ages from the moment its own words appeared.
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
   * Unroll a new card's rows on the frame tick from its header down. A card
   * drawn from a replayed log, and every card on a terminal that paces
   * nothing, draws whole.
   * @param block - the card that was just mounted.
   */
  private revealBlock(block: ToolBlock): void {
    if (this.replaying || this.deps.reducedMotion || this.deps.toolRevealFrames === 0) return
    block.setReveal(new RowReveal(this.deps.toolRevealFrames, 1))
    this.trackReveal(block)
  }

  /**
   * Keep a card on the frame tick while it has rows to unroll, which a call
   * or a result that makes it grow gives it again.
   * @param block - the card that just changed.
   */
  private trackReveal(block: ToolBlock): void {
    if (!block.revealing()) return
    this.reveals.add(block)
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

  // ── chrome motion ───────────────────────────────────────────────────────

  /**
   * Start one motion on the application's own clock and tick.
   *
   * A terminal that draws no ramp at all - reduced motion, a disabled
   * palette, no color - runs no motion either, and every call site draws its
   * settled rendering instead, so nothing here is on the path of a terminal
   * that asked for none.
   * @param ticks - how many fade periods the motion lasts.
   * @returns the motion, or undefined on a terminal that runs none.
   */
  private startMotion(ticks: number): Motion | undefined {
    if (!this.fading) return undefined
    const motion = new Motion({
      startedAt: this.deps.now(),
      ticks,
      stepMs: this.deps.fadeStepMs,
      now: () => this.deps.now(),
    })
    this.motions.add(motion)
    this.updateFadeTicker()
    return motion
  }

  /**
   * Lift the chrome of the region that holds the keyboard. One motion runs at
   * a time, because one region holds the keyboard at a time: a step replaces
   * the landing that brought the keyboard here, which settles the frame back
   * as soon as the walk goes on.
   * @param scope - how much of the surface the motion lifts.
   * @param ticks - how many fade periods it lasts.
   */
  private startChrome(scope: MotionScope, ticks: number): void {
    const motion = this.startMotion(ticks)
    this.chrome = motion === undefined ? undefined : { motion, scope }
  }

  /**
   * How far above its settled drawing the focused surface's own frame is
   * drawn right now.
   * @returns the level, and the settled one for everything but a landing.
   */
  private frameLift(): MotionLevel {
    return this.chrome?.scope === 'landing' ? this.chrome.motion.level() : 0
  }

  /**
   * How far above its settled drawing the mark the focused region holds is
   * drawn right now.
   * @returns the level, and the settled one while nothing moves.
   */
  private markLift(): MotionLevel {
    return this.chrome?.motion.level() ?? 0
  }

  /**
   * The lift the subagent panel's selected row is drawn with. The panel's
   * text is built when something changes it rather than once per frame, so
   * this is also what the fade tick compares against to know it must build it
   * again.
   * @returns the level, and the settled one whenever the panel does not hold
   * the keyboard.
   */
  private panelLiftNow(): MotionLevel {
    return this.focus === 'panel' ? this.markLift() : 0
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
    return this.pacer?.pending() === true
      || this.reveals.size > 0
      || this.textTail?.needsRepaint() === true
      || this.reasoningTail?.needsRepaint() === true
      || this.blockFades.needsRepaint()
      || this.motions.needsRepaint()
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
   * @param frameLines - how many lines the frame has, which is what places
   * the transient line: pi-tui composites an overlay into the frame's last
   * `rows` lines.
   * @returns whether anything changed a line, so the frame is built again
   * before it is written.
   */
  private settleFrame(viewportTop: number, width: number, frameLines: number): boolean {
    const rows = this.deps.terminal.rows
    this.viewportFloor = repaintFloor(Math.max(frameLines, rows) - rows, viewportTop)
    const section = this.focusedSection()
    const wanted: HeldSection | undefined = section !== undefined && this.focus === 'transcript'
      ? { block: section.block, part: section.cursor.part, level: this.markLift() }
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
    if (current?.block === target?.block && current?.part === target?.part && current?.level === target?.level) {
      return changed
    }
    current?.block.setHighlight(undefined)
    target?.block.setHighlight(target.part, target.level)
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
    this.pacer?.frame()
    for (const block of this.reveals) {
      if (!block.revealFrame()) this.reveals.delete(block)
    }
    this.textTail?.tick()
    this.reasoningTail?.tick()
    this.blockFades.tick()
    if (this.toast?.clock.expired() === true) this.hideToast()
    // The panel's text is built when something changes it, so its own lift is
    // what tells this period to build it again; every other surface reads the
    // level while it renders.
    if (this.panelLift !== this.panelLiftNow()) this.refreshSubagentPanel()
    if (this.activitySlot.children.length > 0) this.refreshActivityBoard()
    this.motions.tick()
    this.tui.requestRender()
    this.updateFadeTicker()
  }

  private onStreamFrame(frame: AssistantStreamFrame): void {
    switch (frame.type) {
      case 'start':
        this.pacer?.flush()
        this.streaming = undefined
        this.endFade()
        this.beginLiveUsage()
        if (this.dropUnconfirmedTools()) this.tui.requestRender()
        return
      case 'chunk': {
        const chunk = frame.chunk
        switch (chunk.type) {
          case 'text-delta':
            if (chunk.text !== '') {
              this.finishReasoningPace()
              this.setStreamActivity('writing')
              this.pace('text', chunk.text, (text) => {
                this.appendStreamedText(text)
              })
              this.noteStreamedChars(chunk.text.length)
            }
            break
          case 'reasoning-delta':
            if (chunk.text !== '') {
              this.setStreamActivity('thinking')
              this.pace('reasoning', chunk.text, (text) => {
                this.appendStreamedReasoning(text)
              })
              this.noteStreamedChars(chunk.text.length)
            }
            break
          case 'tool-call-delta':
            this.finishReasoningPace()
            this.noteStreamedToolCall(chunk)
            this.pace(`tool:${chunk.id}:${chunk.name ?? ''}`, chunk.argumentsDelta, (text) => {
              this.onToolCallDelta({ ...chunk, argumentsDelta: text })
            })
            this.noteStreamedChars(chunk.argumentsDelta.length)
            break
          case 'usage':
            this.applyLiveUsage(chunk.usage)
            break
          case 'block-start':
            if (chunk.blockType === 'text') {
              this.finishReasoningPace()
              this.setStreamActivity('writing')
            } else if (chunk.blockType === 'tool-call') {
              this.finishReasoningPace()
              if (!isCallingActivity(this.loaderActivity)) this.setLoaderActivity(callingActivity(undefined))
            } else if (chunk.blockType !== 'reasoning') {
              this.finishReasoningPace()
            }
            break
          case 'block-end':
            if (chunk.block.type === 'reasoning') this.finishReasoningPace()
            break
          case 'finish':
            break
          /* v8 ignore next -- closed-union exhaustiveness guard */
          default:
            assertNever(chunk, 'tui stream chunk')
        }
        // A paced delta is drawn by the frame tick that releases it.
        if (this.pacer === undefined) this.tui.requestRender()
        return
      }
      case 'end':
        // An abandoned attempt keeps streamed text; unconfirmed tool cards do
        // not, because those calls never ran. A retry starts a new block.
        this.pacer?.flush()
        this.streaming = undefined
        this.endFade()
        if (frame.outcome.kind === 'abandoned'
          || (frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/attempt')) {
          this.dropUnconfirmedTools()
        }
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
      // children included; their events tell the panel its listing aged and
      // replace the activity board's one descendant line when they belong
      // under the bound session.
      this.markSubagentsStale()
      if (this.isBoundDescendant(session)) this.onDescendantActivity(session, event)
      return
    }
    // A logged event is drawn after the streamed text that preceded it.
    this.pacer?.flush()
    switch (event.type) {
      case 'turn/start':
        // The turn every later event of this turn belongs to, including the
        // todo writes, which carry no turn of their own.
        this.turn = event.data.turn
        this.turnStartedAt = event.time
        this.clearActivityBoard()
        this.updateTicker()
        this.refreshFooter()
        break
      case 'todo/write':
        this.trackTodoTurns(event.data.todos)
        this.syncActivityTodos()
        break
      case 'user/message':
        this.onUserMessage(event.data)
        break
      case 'system/message':
        this.onSystemMessage(event.data)
        break
      case 'assistant/message': {
        const { message, usage, interrupted } = event.data
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
        this.streamingBlock().commit(text, reasoning, interrupted === true)
        this.streaming = undefined
        this.endFade()
        this.clearLiveUsage()
        if (usage !== undefined) this.usage = addUsage(this.usage, usage)
        this.refreshFooter()
        break
      }
      case 'tool/call': {
        const { callId, name, arguments: argumentsJson } = event.data
        this.toolStreamArgs.delete(callId)
        this.pendingToolNames.set(callId, name)
        this.setLoaderActivity(callingActivity(name))
        this.upsertToolCard(callId, name, argumentsJson, 'log')
        break
      }
      case 'tool/result': {
        const result = event.data.message
        const block = this.toolBlocks.get(result.toolCallId)
        if (block === undefined) break
        const isError = result.isError === true
        const view = this.presentResult(block.name, this.toolArguments.get(result.toolCallId), result.content, isError, event.data.meta)
        const body = toolResultBody(view, result.content)
        block.setResult(body.lines, isError, body.code, body.diff)
        this.fadeBlock((fade) => { block.setResultFade(fade) })
        this.trackReveal(block)
        this.pendingToolNames.delete(result.toolCallId)
        this.syncLoaderFromPendingTools()
        break
      }
      case 'turn/end': {
        this.turnStartedAt = undefined
        this.updateTicker()
        this.endFade()
        this.clearLiveUsage()
        this.clearActivityBoard()
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
      case 'workspace/changes': {
        const summary = this.deps.ctx.get('workspaceChanges')?.summary(session.id, event.seq)
        // A replayed log's summaries left with the Host that recorded them;
        // the notice belongs to the turn that just ended.
        if (summary === undefined) return
        this.notice(changesNotice(summary))
        break
      }
      case 'llm/retry':
        this.setLoaderActivity(retryMessage(event.data))
        break
      default:
        return
    }
    this.tui.requestRender()
    // Paint the running card before the loop continues into prepare/execute,
    // so a fast tool does not land its result in the same unread frame.
    if (event.type === 'tool/call' && !this.replaying) this.tui.renderNow()
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
    if (this.submittedIds.has(message.id)) return
    const source = message.source
    if (source.kind === 'user') {
      const attachments = message.content.filter(block => block.type !== 'text').map(block => `[${block.type}]`)
      this.chat.addChild(new UserBlock(this.theme, [contentText(message.content), ...attachments].filter(part => part !== '').join('\n'), this.turn))
      return
    }
    const view = injectedContextView(source, message.content)
    if (view === undefined) return
    this.addContext(view.title, view.parts, this.turn)
  }

  /**
   * Draw one nonempty system prompt as a navigable context block.
   * @param data - the durable `system/message` payload.
   */
  private onSystemMessage(data: SessionEvent<'system/message'>['data']): void {
    const view = systemPromptView(contentText(data.message.content), this.sawSystemPrompt)
    if (view === undefined) return
    this.sawSystemPrompt = true
    this.addContext(view.title, view.parts, data.turn)
  }

  /**
   * Append one context block, folded as every other foldable block is drawn
   * right now.
   * @param title - form and producer, a notice summary, or `system prompt`.
   * @param parts - the model-facing rows, one part per contribution.
   * @param turn - the turn the message was appended in.
   */
  private addContext(title: string, parts: readonly SectionPart[], turn: number): void {
    const block = new ContextBlock(this.theme, title, parts, turn)
    block.setExpanded(this.toolsExpanded)
    this.chat.addChild(block)
  }

  /**
   * Replace the spinner's activity word and redraw its live ↑↓ suffix.
   * @param activity - `thinking`, `writing`, `calling` / `calling <name>`, or a retry notice.
   */
  private setLoaderActivity(activity: string): void {
    this.loaderActivity = activity
    this.refreshLoader()
  }

  /**
   * Label a streamed reasoning or visible-text chunk unless a tool call is
   * already the current activity: calling stays until the last in-flight
   * tool settles or a new model call begins.
   * @param activity - `thinking` for reasoning, `writing` for visible text.
   */
  private setStreamActivity(activity: 'thinking' | 'writing'): void {
    if (isCallingActivity(this.loaderActivity)) return
    this.setLoaderActivity(activity)
  }

  /**
   * Draw `calling <name>` for the most recently remembered in-flight tool,
   * or `thinking` when none remain.
   */
  private syncLoaderFromPendingTools(): void {
    let name: string | undefined
    for (const candidate of this.pendingToolNames.values()) name = candidate
    this.setLoaderActivity(name === undefined ? 'thinking' : callingActivity(name))
  }

  /**
   * Start a new model call's live counters: seed send from the projected
   * next-request size or the last committed prompt, and zero receive.
   */
  private beginLiveUsage(): void {
    this.streamedChars = 0
    this.usageExact = false
    this.liveUsage = { inputTokens: this.seedLiveSend(), outputTokens: 0 }
    if (this.pendingToolNames.size === 0) this.loaderActivity = 'thinking'
    else this.syncLoaderFromPendingTools()
    this.refreshLiveUsage()
  }

  /**
   * Prompt tokens the current call is likely sending, before a usage chunk.
   * @returns context occupancy when the projection has one, else the last
   * committed prompt size, else 0.
   */
  private seedLiveSend(): number {
    const used = this.statusFacts().context?.used
    if (used !== undefined && used > 0) return used
    return this.usage.lastInputTokens
  }

  /**
   * Grow the receive estimate from streamed characters until the provider
   * reports usage.
   * @param chars - characters just appended to the live stream.
   */
  private noteStreamedChars(chars: number): void {
    if (chars <= 0 || this.usageExact) return
    this.streamedChars += chars
    const send = this.liveUsage === undefined ? this.seedLiveSend() : this.liveUsage.inputTokens
    this.liveUsage = { inputTokens: send, outputTokens: estimateTokens(this.streamedChars) }
    this.refreshLiveUsage()
  }

  /**
   * Replace the live counters with a provider usage chunk.
   * @param usage - the call's reported usage.
   */
  private applyLiveUsage(usage: TokenUsage): void {
    this.usageExact = true
    this.liveUsage = usage
    this.refreshLiveUsage()
  }

  /** Forget the in-flight call's counters and drop them from the spinner and footer. */
  private clearLiveUsage(): void {
    this.liveUsage = undefined
    this.streamedChars = 0
    this.usageExact = false
    this.refreshLiveUsage()
  }

  /** Redraw the spinner and the footer from the current live counters. */
  private refreshLiveUsage(): void {
    this.refreshLoader()
    this.refreshFooter()
  }

  /** Draw the spinner label plus the current call's ↑send ↓receive suffix. */
  private refreshLoader(): void {
    const suffix = formatLiveUsage(this.liveUsage)
    this.loader.setMessage(suffix === '' ? this.loaderActivity : `${this.loaderActivity} ${suffix}`)
  }

  /**
   * Label the spinner for a tool-call delta before its card is paced.
   * A known name becomes `calling <name>` and is remembered until the call
   * settles; a delta that has not named a tool yet says `calling`, and does
   * not replace a label that already names one.
   * @param chunk - one `tool-call-delta` of the live assistant stream.
   */
  private noteStreamedToolCall(chunk: Extract<StreamChunk, { type: 'tool-call-delta' }>): void {
    const name = this.streamedToolName(chunk)
    if (name !== undefined) {
      if (chunk.id !== '') this.pendingToolNames.set(chunk.id, name)
      this.setLoaderActivity(callingActivity(name))
    } else if (!isCallingActivity(this.loaderActivity)) {
      this.setLoaderActivity(callingActivity(undefined))
    }
  }

  /**
   * The tool name a live delta carries, or the name already drawn for that call.
   * @param chunk - one `tool-call-delta` of the live assistant stream.
   * @returns the name, or undefined while the model has not sent one.
   */
  private streamedToolName(chunk: Extract<StreamChunk, { type: 'tool-call-delta' }>): string | undefined {
    return chunk.name === ''
      ? undefined
      : (chunk.name ?? this.toolBlocks.get(chunk.id)?.name)
  }

  /**
   * Mount or refresh a tool card from a stream delta: the name as soon as
   * the model sends one, then the presenter headline once the arguments
   * parse as JSON.
   * @param chunk - one `tool-call-delta` of the live assistant stream.
   */
  private onToolCallDelta(chunk: Extract<StreamChunk, { type: 'tool-call-delta' }>): void {
    const name = this.streamedToolName(chunk)
    if (chunk.id === '') return
    const argumentsJson = (this.toolStreamArgs.get(chunk.id) ?? '') + chunk.argumentsDelta
    this.toolStreamArgs.set(chunk.id, argumentsJson)
    if (name === undefined) return
    this.upsertToolCard(chunk.id, name, argumentsJson, 'stream')
  }

  /**
   * Draw one tool card, creating it on the first sighting and updating the
   * call half when later arguments arrive. A streamed card stays unconfirmed
   * until the matching `tool/call` is logged.
   * @param callId - the model's call id.
   * @param name - the tool name.
   * @param argumentsJson - arguments accumulated so far, or the logged string.
   * @param source - `stream` for a live delta, `log` for the durable call.
   */
  private upsertToolCard(callId: ToolCallId, name: string, argumentsJson: string, source: 'stream' | 'log'): void {
    const args = parseArguments(argumentsJson)
    if (args !== undefined) this.toolArguments.set(callId, args)
    const call = source === 'stream' && args === undefined
      ? { title: '', lines: [] }
      : toolCallText(argumentsJson, args === undefined ? undefined : this.presentCall(name, args), name)
    const existing = this.toolBlocks.get(callId)
    if (existing !== undefined) {
      existing.setCall(name, call)
      if (isSubagentTool(name)) existing.setSubagent(subagentRowFacts(args))
      if (source === 'log') this.unconfirmedTools.delete(callId)
      this.trackReveal(existing)
      return
    }
    const block = new ToolBlock(this.theme, name, call, this.turn)
    if (isSubagentTool(name)) block.setSubagent(subagentRowFacts(args))
    block.setExpanded(this.toolsExpanded)
    this.toolBlocks.set(callId, block)
    this.chat.addChild(block)
    this.fadeBlock((fade) => { block.setFade(fade) })
    this.revealBlock(block)
    if (source === 'stream') this.unconfirmedTools.set(callId, block)
  }

  /**
   * Take down every card the live stream mounted that no `tool/call` confirmed.
   * @returns true when at least one card left the transcript.
   */
  private dropUnconfirmedTools(): boolean {
    if (this.unconfirmedTools.size === 0) return false
    for (const [callId, block] of this.unconfirmedTools) {
      this.chat.removeChild(block)
      this.reveals.delete(block)
      this.toolBlocks.delete(callId)
      this.toolArguments.delete(callId)
      this.toolStreamArgs.delete(callId)
      this.pendingToolNames.delete(callId)
    }
    this.unconfirmedTools.clear()
    this.updateFadeTicker()
    this.syncLoaderFromPendingTools()
    return true
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
    content: ToolResultMessage['content'],
    isError: boolean,
    meta: SessionEvent<'tool/result'>['data']['meta'],
  ): ToolResultView | undefined {
    const definition = this.deps.ctx.get('tools')?.get(name, this.agent)
    if (definition?.presentResult === undefined) return undefined
    try {
      return definition.presentResult(args, { content: [...content], isError, ...meta === undefined ? {} : { meta } })
    } catch {
      // Same fallback as the call presenter: the raw result text still renders.
      return undefined
    }
  }
}
