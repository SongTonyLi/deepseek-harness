/** The todo status glyphs and the paint completed todo content takes. */

import { describe, expect, it } from 'vitest'
import { TODO_GLYPH, paintTodoContent } from '../src/todos.ts'

describe('TODO_GLYPH', () => {
  it('marks each status with the glyph every todo row leads with', () => {
    expect(TODO_GLYPH).toEqual({ completed: '✓', in_progress: '▸', pending: '○' })
  })
})

describe('paintTodoContent', () => {
  const paint = (content: string): string => `~${content}~`

  it('scratches out completed content when a paint function is given', () => {
    expect(paintTodoContent('read the spec', 'completed', paint)).toBe('~read the spec~')
  })

  it('leaves content that is not completed, or has no paint, unchanged', () => {
    expect(paintTodoContent('write the data layer', 'in_progress', paint)).toBe('write the data layer')
    expect(paintTodoContent('wire the page', 'pending', paint)).toBe('wire the page')
    expect(paintTodoContent('read the spec', 'completed')).toBe('read the spec')
  })
})
