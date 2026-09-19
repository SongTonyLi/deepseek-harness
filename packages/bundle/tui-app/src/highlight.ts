/**
 * Syntax colour for fenced code in the transcript: the grammars a fence may
 * ask for, the theme its colours come from, and the SGR one token is drawn
 * with.
 *
 * Nothing loads at start. A grammar is a few hundred kilobytes of TextMate
 * patterns and the first tokenisation of one compiles them, so a session that
 * never renders a fenced block pays neither. The first block of a language
 * draws plain, its grammar is imported and warmed off the render path, and
 * the application is told to draw the frame again - the same "render what you
 * have, correct it when it lands" the rest of this surface uses.
 *
 * Colours come from a shiki theme rather than the palette: a theme
 * distinguishes a keyword from a type from a number, which the nine palette
 * roles cannot, and the transcript is where the model's code is read. The
 * theme is chosen from the terminal's own background, so a light terminal is
 * not given dark-theme colours, and a terminal that answers neither a colour
 * depth nor a background gets no colour at all.
 * @module @deepseek-ai/dsh-tui-app/highlight
 */

import type { HighlighterCore, ThemeRegistrationAny } from 'shiki/core'
import type { RgbColor } from '@earendil-works/pi-tui'
import { nearestAnsi256 } from './fade.ts'

/** How far a terminal can encode one token colour. */
export type ColorDepth =
  /** `ESC[38;2;R;G;Bm`, the theme's own colours. */
  | 'truecolor'
  /** `ESC[38;5;Nm`, the nearest of the 256 indexed colours. */
  | 'ansi256'
  /** No colour: the code draws as the Markdown renderer wrote it. */
  | 'none'

/**
 * What one shiki grammar module exports: a `LanguageRegistration[]`, reached
 * through one `default` from source and through two from a bundle whose
 * interop wraps the namespace again.
 */
interface LangModule {
  default: unknown
}

/** What one shiki theme module exports. */
interface ThemeModule {
  default: ThemeRegistrationAny & { name?: string }
}

/**
 * The grammars a fence may name, each behind its own import so a language is
 * paid for only where it is rendered. Exported so one spec can prove every
 * entry resolves to a module that is really installed. The list is what a coding session
 * actually shows: the languages of this repository, the shells it runs, the
 * formats it configures with, and the languages a model most often answers a
 * question in.
 */
export const GRAMMARS = new Map<string, () => Promise<LangModule>>([
  ['typescript', () => import('@shikijs/langs/typescript')],
  ['shellscript', () => import('@shikijs/langs/shellscript')],
  ['json', () => import('@shikijs/langs/json')],
  ['python', () => import('@shikijs/langs/python')],
  ['yaml', () => import('@shikijs/langs/yaml')],
  ['rust', () => import('@shikijs/langs/rust')],
  ['go', () => import('@shikijs/langs/go')],
  ['java', () => import('@shikijs/langs/java')],
  ['c', () => import('@shikijs/langs/c')],
  ['cpp', () => import('@shikijs/langs/cpp')],
  ['ruby', () => import('@shikijs/langs/ruby')],
  ['sql', () => import('@shikijs/langs/sql')],
  ['html', () => import('@shikijs/langs/html')],
  ['css', () => import('@shikijs/langs/css')],
  ['markdown', () => import('@shikijs/langs/markdown')],
  ['toml', () => import('@shikijs/langs/toml')],
  ['diff', () => import('@shikijs/langs/diff')],
])

/**
 * What a fence's info string resolves to. A `Map`, not an object: the string
 * comes from the model, so `constructor` or `__proto__` must miss rather than
 * resolve an inherited property. The JavaScript family resolves to the
 * TypeScript grammar, which tokenises plain JavaScript exactly and JSX
 * approximately - one grammar instead of two for the same colours.
 */
const ALIASES = new Map<string, string>([
  ['typescript', 'typescript'], ['ts', 'typescript'], ['tsx', 'typescript'],
  ['javascript', 'typescript'], ['js', 'typescript'], ['jsx', 'typescript'], ['mjs', 'typescript'],
  ['shell', 'shellscript'], ['sh', 'shellscript'], ['bash', 'shellscript'], ['zsh', 'shellscript'],
  ['console', 'shellscript'], ['shellscript', 'shellscript'],
  ['json', 'json'], ['jsonc', 'json'],
  ['python', 'python'], ['py', 'python'],
  ['yaml', 'yaml'], ['yml', 'yaml'],
  ['rust', 'rust'], ['rs', 'rust'],
  ['go', 'go'], ['golang', 'go'],
  ['java', 'java'],
  ['c', 'c'], ['h', 'c'],
  ['cpp', 'cpp'], ['c++', 'cpp'], ['cc', 'cpp'],
  ['ruby', 'ruby'], ['rb', 'ruby'],
  ['sql', 'sql'],
  ['html', 'html'], ['xml', 'html'],
  ['css', 'css'],
  ['markdown', 'markdown'], ['md', 'markdown'],
  ['toml', 'toml'],
  ['diff', 'diff'], ['patch', 'diff'],
])

/** The theme a dark terminal takes, and the one a light terminal takes. */
export const THEMES = {
  dark: () => import('@shikijs/themes/github-dark-default'),
  light: () => import('@shikijs/themes/github-light-default'),
} as const

/** Relative-luminance weights, as {@link backgroundIsLight} reads a background. */
const LUMINANCE = { r: 0.2126, g: 0.7152, b: 0.0722 }

/** Luminance above which a background counts as light. */
const LIGHT_ABOVE = 128

/** Control Sequence Introducer. */
const CSI = '\u001b['

/** Ends the foreground a token was drawn with; other styling is left alone. */
const RESET_FOREGROUND = `${CSI}39m`

/** Opens bold, for a theme's bold token styles. */
const BOLD = `${CSI}1m`

/** Opens italic, for a theme's italic token styles. */
const ITALIC = `${CSI}3m`

/** Ends bold. */
const RESET_BOLD = `${CSI}22m`

/** Ends italic. */
const RESET_ITALIC = `${CSI}23m`

/** shiki's `FontStyle` bits, which its themed tokens carry as a number. */
const FONT_STYLE = { italic: 1, bold: 2, underline: 4 } as const

/**
 * Which theme one terminal takes.
 * @param background - the terminal's background, or undefined when it answered none.
 * @returns true for a light terminal; a terminal that answered nothing is
 * treated as dark, which is what a terminal that answers nothing usually is.
 */
export function backgroundIsLight(background: RgbColor | undefined): boolean {
  if (background === undefined) return false
  return LUMINANCE.r * background.r + LUMINANCE.g * background.g + LUMINANCE.b * background.b > LIGHT_ABOVE
}

/**
 * Decide how far the terminal encodes a token colour.
 *
 * This is the colour depth alone: a user who asked for reduced motion still
 * gets coloured code, because colour is not motion.
 * @param input - whether the palette emits SGR at all, and the environment.
 * @returns the depth {@link tokenSgr} encodes under.
 */
export function resolveColorDepth(input: { paletteEnabled: boolean; env: NodeJS.ProcessEnv }): ColorDepth {
  if (!input.paletteEnabled) return 'none'
  const term = input.env.TERM ?? ''
  if (term === 'dumb') return 'none'
  const colorterm = (input.env.COLORTERM ?? '').toLowerCase()
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor'
  return term.includes('256color') ? 'ansi256' : 'none'
}

/**
 * The sequence one token's colour opens with.
 * @param color - the theme's colour for the token, e.g. `#79c0ff`.
 * @param depth - how far the terminal encodes it.
 * @returns the sequence, or the empty string when the colour cannot be read
 * or the terminal encodes none.
 */
export function tokenSgr(color: string | undefined, depth: ColorDepth): string {
  if (depth === 'none') return ''
  const rgb = parseHexColor(color)
  if (rgb === undefined) return ''
  return depth === 'truecolor'
    ? `${CSI}38;2;${String(rgb.r)};${String(rgb.g)};${String(rgb.b)}m`
    : `${CSI}38;5;${String(nearestAnsi256(rgb))}m`
}

/**
 * The grammar registration one module carries.
 * @param module - the imported grammar module.
 * @returns the registration array, unwrapped through however many `default`
 * layers the module system put around it.
 */
function grammarOf(module: LangModule): unknown {
  const first = module.default
  if (Array.isArray(first) || typeof first !== 'object' || first === null) return first
  return (first as LangModule).default ?? first
}

/**
 * Read one `#rgb` or `#rrggbb` colour.
 * @param color - the theme's colour string.
 * @returns the channels, or undefined for anything else, which is what a
 * theme naming a colour this module cannot read yields.
 */
function parseHexColor(color: string | undefined): RgbColor | undefined {
  if (color === undefined) return undefined
  const body = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(color)?.[1]
  if (body === undefined) return undefined
  const wide = body.length === 6 ? body : body.replace(/./gu, part => `${part}${part}`)
  return {
    r: Number.parseInt(wide.slice(0, 2), 16),
    g: Number.parseInt(wide.slice(2, 4), 16),
    b: Number.parseInt(wide.slice(4, 6), 16),
  }
}

/** What the application hands the highlighter. */
export interface HighlightOptions {
  /** How far the terminal encodes a token colour. */
  depth: ColorDepth
  /**
   * The terminal's background, read when the core is built.
   * @returns the background, or undefined on a terminal that answered none,
   * which takes the dark theme.
   */
  background(): RgbColor | undefined
  /** Called once a grammar or the theme lands, so the frame is drawn again with colour. */
  changed: () => void
  /**
   * Load one module, so a spec can drive the lazy path without importing
   * grammars; omitted uses this module's own imports.
   * @param load - the import to run.
   * @returns the module.
   */
  import?: (load: () => Promise<unknown>) => Promise<unknown>
}

/**
 * The transcript's syntax highlighter: one shiki core, built when the first
 * fence resolves a grammar and grown as further languages are asked for.
 */
export class SyntaxHighlighter {
  /** The shiki core, once a theme and one grammar have landed. */
  private core: HighlighterCore | undefined
  /**
   * The core being built, so two fences of different languages on one frame
   * share it: each would otherwise build a core of its own, and the one that
   * finished last would be the only one holding a grammar.
   */
  private building: Promise<HighlighterCore> | undefined
  /** The theme's own name, which `codeToTokens` resolves it by. */
  private theme = ''
  /** Grammar ids already registered on the core. */
  private readonly loaded = new Set<string>()
  /** Grammar ids whose import is in flight, so each is asked for once. */
  private readonly pending = new Set<string>()

  /**
   * @param options - the colour depth, the terminal background, and the redraw request.
   */
  constructor(private readonly options: HighlightOptions) {}

  /**
   * Colour one fenced block.
   * @param code - the block's source, newline separated.
   * @param lang - the fence's info string, or undefined for a bare fence.
   * @returns one styled line per source line, or undefined while the language
   * has no grammar here, its grammar is still loading, or the terminal takes
   * no colour - all of which the Markdown renderer draws plain.
   */
  lines(code: string, lang: string | undefined): string[] | undefined {
    if (this.options.depth === 'none') return undefined
    const resolved = ALIASES.get((lang ?? '').toLowerCase())
    if (resolved === undefined) return undefined
    if (!this.loaded.has(resolved)) {
      void this.load(resolved)
      return undefined
    }
    const core = this.core
    /* v8 ignore next -- a loaded grammar means the core is built */
    if (core === undefined) return undefined
    try {
      const { tokens } = core.codeToTokens(code, { lang: resolved, theme: this.theme })
      return tokens.map(line => line.map(token => this.paint(token)).join('') + RESET_FOREGROUND)
    } catch {
      // Tokenising is third-party work over model-authored text, and it runs
      // inside a render: a block that cannot be coloured draws plain from
      // here on rather than taking the frame down with it.
      this.loaded.delete(resolved)
      return undefined
    }
  }

  /**
   * Draw one token with the theme's colour and font style.
   * @param token - the themed token.
   * @returns the token's text, wrapped in the sequences it is drawn with.
   */
  private paint(token: { content: string; color?: string; fontStyle?: number }): string {
    const color = tokenSgr(token.color, this.options.depth)
    /* v8 ignore next -- shiki writes a style of 0 rather than leaving it out */
    const style = token.fontStyle ?? 0
    const bold = (style & FONT_STYLE.bold) === 0 ? '' : BOLD
    const italic = (style & FONT_STYLE.italic) === 0 ? '' : ITALIC
    const closeBold = bold === '' ? '' : RESET_BOLD
    const closeItalic = italic === '' ? '' : RESET_ITALIC
    return `${color}${bold}${italic}${token.content}${closeItalic}${closeBold}`
  }

  /**
   * Bring up the core for one grammar, then ask for the frame again.
   * @param id - the grammar to register.
   */
  private async load(id: string): Promise<void> {
    if (this.pending.has(id)) return
    const grammar = GRAMMARS.get(id)
    /* v8 ignore next -- every alias resolves to a grammar in the same table */
    if (grammar === undefined) return
    this.pending.add(id)
    try {
      const run = this.options.import ?? ((load: () => Promise<unknown>) => load())
      const module = await run(grammar) as LangModule
      if (!await this.register(id, module)) return
    } catch {
      // A grammar that cannot be loaded leaves its language plain: the code is
      // already on screen, and a fence is not worth failing a render over.
      this.loaded.delete(id)
      return
    } finally {
      this.pending.delete(id)
    }
    this.options.changed()
  }

  /**
   * Put one grammar on the core, building the core and its theme first.
   * @param id - the grammar's id.
   * @param module - the grammar module.
   * @returns whether the core now resolves that id.
   */
  private async register(id: string, module: LangModule): Promise<boolean> {
    const core = await this.ensureCore()
    await core.loadLanguage(grammarOf(module) as Parameters<HighlighterCore['loadLanguage']>[0])
    // shiki resolves a grammar by the name its own registration carries, so
    // the id is trusted only once the core reports it: a module that landed
    // in a shape this loader could not unwrap leaves the language plain
    // instead of failing the render that asks for it.
    if (!core.getLoadedLanguages().includes(id)) return false
    this.loaded.add(id)
    // The first tokenisation of a grammar compiles its patterns. Spending that
    // here keeps it off the frame that will draw the block.
    core.codeToTokens('', { lang: id, theme: this.theme })
    return true
  }

  /**
   * The core, built once however many languages ask for it at the same time.
   * @returns the core.
   */
  private async ensureCore(): Promise<HighlighterCore> {
    const built = this.core
    if (built !== undefined) return built
    this.building ??= this.buildCore()
    return this.building
  }

  /**
   * Build the core with the theme the terminal's background asks for.
   * @returns the core, which every later grammar registers on.
   */
  private async buildCore(): Promise<HighlighterCore> {
    const run = this.options.import ?? ((load: () => Promise<unknown>) => load())
    const [{ createHighlighterCoreSync }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      run(THEMES[backgroundIsLight(this.options.background()) ? 'light' : 'dark']) as Promise<ThemeModule>,
    ])
    /* v8 ignore next -- every bundled theme carries its own name */
    this.theme = theme.default.name ?? ''
    const core = createHighlighterCoreSync({
      themes: [theme.default],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })
    this.core = core
    return core
  }
}
