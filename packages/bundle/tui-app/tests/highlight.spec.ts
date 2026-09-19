/** Syntax colour: the depth a terminal takes, the theme its background picks, and the lazily loaded grammars. */

import { describe, expect, it, vi } from 'vitest'
import { GRAMMARS, SyntaxHighlighter, THEMES, backgroundIsLight, resolveColorDepth, tokenSgr } from '../src/highlight.ts'

/** A highlighter over a dark terminal that encodes 24-bit colour. */
function highlighter(overrides: Partial<ConstructorParameters<typeof SyntaxHighlighter>[0]> = {}): {
  code: SyntaxHighlighter
  changed: ReturnType<typeof vi.fn>
  settle: () => Promise<void>
} {
  const changed = vi.fn()
  const code = new SyntaxHighlighter({
    depth: 'truecolor',
    background: () => undefined,
    changed,
    ...overrides,
  })
  return {
    code,
    changed,
    // A grammar is a real dynamic import, so the wait is on the redraw the
    // highlighter asks for once it has landed rather than on a tick count.
    settle: async () => {
      for (let pass = 0; pass < 200 && changed.mock.calls.length === 0; pass += 1) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    },
  }
}

describe('resolveColorDepth', () => {
  it('reads the terminal\'s own colour depth, and nothing else', () => {
    const env = { COLORTERM: 'truecolor' }
    expect(resolveColorDepth({ paletteEnabled: true, env })).toBe('truecolor')
    expect(resolveColorDepth({ paletteEnabled: true, env: { COLORTERM: '24BIT' } })).toBe('truecolor')
    expect(resolveColorDepth({ paletteEnabled: true, env: { TERM: 'xterm-256color' } })).toBe('ansi256')
    // A palette that emits nothing, a dumb terminal, and a terminal that
    // claims no depth each draw code the way the renderer wrote it.
    expect(resolveColorDepth({ paletteEnabled: false, env })).toBe('none')
    expect(resolveColorDepth({ paletteEnabled: true, env: { TERM: 'dumb', COLORTERM: 'truecolor' } })).toBe('none')
    expect(resolveColorDepth({ paletteEnabled: true, env: {} })).toBe('none')
  })
})

describe('backgroundIsLight', () => {
  it('reads a background the terminal answered, and assumes dark without one', () => {
    expect(backgroundIsLight({ r: 255, g: 255, b: 255 })).toBe(true)
    expect(backgroundIsLight({ r: 20, g: 20, b: 30 })).toBe(false)
    expect(backgroundIsLight(undefined)).toBe(false)
  })
})

describe('tokenSgr', () => {
  it('encodes a theme colour as far as the terminal reaches', () => {
    expect(tokenSgr('#79c0ff', 'truecolor')).toBe('[38;2;121;192;255m')
    expect(tokenSgr('#fff', 'truecolor')).toBe('[38;2;255;255;255m')
    expect(tokenSgr('#79c0ff', 'ansi256')).toMatch(/^\[38;5;\d+m$/u)
    expect(tokenSgr('#79c0ff', 'none')).toBe('')
  })

  it('writes nothing for a colour it cannot read', () => {
    expect(tokenSgr(undefined, 'truecolor')).toBe('')
    expect(tokenSgr('rebeccapurple', 'truecolor')).toBe('')
    expect(tokenSgr('#12345', 'truecolor')).toBe('')
  })
})

describe('the highlighter', () => {
  it('draws a fence plain until its grammar lands, then in colour', async () => {
    const test = highlighter()
    const code = 'const rows = 42\n'
    // The first block of a language has no grammar yet, so it draws plain and
    // the frame is asked for again once the grammar is there.
    expect(test.code.lines(code, 'ts')).toBeUndefined()
    expect(test.changed).not.toHaveBeenCalled()
    await test.settle()
    expect(test.changed).toHaveBeenCalled()
    const lines = test.code.lines(code, 'ts')
    expect(lines).toBeDefined()
    expect(lines?.join('\n')).toContain('const')
    expect(lines?.join('\n')).toMatch(/\[38;2;\d+;\d+;\d+m/u)
    // One styled line per source line, so the fence keeps the height the
    // renderer would have drawn it at.
    expect(lines).toHaveLength(code.split('\n').length)
  })

  it('answers a language it has no grammar for, and a bare fence, with nothing', () => {
    const test = highlighter()
    expect(test.code.lines('x', 'brainfuck')).toBeUndefined()
    expect(test.code.lines('x', undefined)).toBeUndefined()
    expect(test.code.lines('x', 'CONSTRUCTOR')).toBeUndefined()
  })

  it('draws nothing in colour on a terminal that takes none', () => {
    const test = highlighter({ depth: 'none' })
    expect(test.code.lines('const rows = 42', 'ts')).toBeUndefined()
    expect(test.changed).not.toHaveBeenCalled()
  })

  it('asks for each grammar once, however many blocks are on screen', async () => {
    const loads: number[] = []
    const test = highlighter({
      import: (load) => {
        loads.push(1)
        return load()
      },
    })
    test.code.lines('a', 'ts')
    test.code.lines('b', 'js')
    test.code.lines('c', 'tsx')
    await new Promise(resolve => setTimeout(resolve, 200))
    // The core, the theme, and one grammar - not one grammar per block.
    expect(loads.length).toBeLessThanOrEqual(2)
  })

  it('leaves a language plain when its grammar cannot be loaded', async () => {
    const test = highlighter({ import: () => Promise.reject(new Error('no such module')) })
    expect(test.code.lines('const rows = 42', 'ts')).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(test.changed).not.toHaveBeenCalled()
    expect(test.code.lines('const rows = 42', 'ts')).toBeUndefined()
  })

  it('draws a theme\'s bold and italic tokens with those attributes', async () => {
    const test = highlighter()
    test.code.lines('# title', 'md')
    await test.settle()
    const lines = test.code.lines('# a *slanted* and **heavy** heading\n', 'md')?.join('\n') ?? ''
    expect(lines).toContain('\u001b[3m')
    expect(lines).toContain('\u001b[1m')
  })

  it('keeps one core for two languages asked for on the same frame', async () => {
    const test = highlighter()
    // Both fences are on screen at once, so both grammars load together: a
    // core apiece would leave whichever finished first without its language.
    expect(test.code.lines('const rows = 42', 'ts')).toBeUndefined()
    expect(test.code.lines('rows: 42', 'yaml')).toBeUndefined()
    for (let pass = 0; pass < 200 && test.changed.mock.calls.length < 2; pass += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(test.code.lines('const rows = 42', 'ts')).toBeDefined()
    expect(test.code.lines('rows: 42', 'yaml')).toBeDefined()
  })

  it('unwraps a grammar module a bundle wrapped again', async () => {
    const test = highlighter({
      import: async (load) => {
        const module = await load() as { default: unknown }
        // What a bundle's interop hands back: the namespace inside a namespace.
        return Array.isArray(module.default) ? { default: module } : module
      },
    })
    test.code.lines('const rows = 42', 'ts')
    await test.settle()
    expect(test.code.lines('const rows = 42', 'ts')).toBeDefined()
  })

  it('draws a block plain when its grammar registers under another name', async () => {
    const test = highlighter({ import: () => Promise.resolve({ default: [] }) })
    test.code.lines('const rows = 42', 'ts')
    await new Promise(resolve => setTimeout(resolve, 300))
    // Nothing registered, so nothing is drawn and the frame is not asked for.
    expect(test.code.lines('const rows = 42', 'ts')).toBeUndefined()
    expect(test.changed).not.toHaveBeenCalled()
  })

  it('takes the light theme over a light terminal', async () => {
    const dark = highlighter()
    const light = highlighter({ background: () => ({ r: 250, g: 250, b: 250 }) })
    dark.code.lines('const rows = 42', 'ts')
    light.code.lines('const rows = 42', 'ts')
    await dark.settle()
    await light.settle()
    const onDark = dark.code.lines('const rows = 42', 'ts')?.join('')
    const onLight = light.code.lines('const rows = 42', 'ts')?.join('')
    expect(onDark).toBeDefined()
    expect(onLight).toBeDefined()
    expect(onLight).not.toBe(onDark)
  })
})

describe('the grammar table', () => {
  it('names a module that is installed for every language it offers', async () => {
    for (const [id, load] of GRAMMARS) {
      const module = await load()
      expect(module.default, id).toBeDefined()
    }
    for (const load of Object.values(THEMES)) {
      const theme = await load()
      expect(theme.default.name).toBeTruthy()
    }
  }, 30_000)
})
