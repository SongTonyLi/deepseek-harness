/** `/attach`: local files become image or file blocks through the attachment store. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { attachLocalFile } from '../src/attach.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-tui-attach-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

interface Saved { images: unknown[]; files: unknown[] }

function store(saved: Saved): AttachmentStore {
  return {
    saveImages: (inputs: readonly unknown[]) => {
      saved.images.push(...inputs)
      return Promise.resolve(inputs.map((_, index) => ({ kind: 'image', id: `img-${String(index)}`, mediaType: 'image/png' })))
    },
    saveFile: (input: unknown) => {
      saved.files.push(input)
      return Promise.resolve({ kind: 'file', id: 'file-0' })
    },
  } as never
}

describe('attachLocalFile', () => {
  it('stores a raster by extension as an image block', async () => {
    const saved: Saved = { images: [], files: [] }
    await writeFile(join(dir, 'shot.PNG'), Buffer.from([1, 2, 3]))
    const pending = await attachLocalFile(store(saved), dir, 'shot.PNG')
    expect(pending).toEqual({ name: 'shot.PNG', block: { type: 'image', attachment: { kind: 'image', id: 'img-0', mediaType: 'image/png' } } })
    expect(saved.images).toEqual([{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', name: 'shot.PNG' }])
    expect(saved.files).toEqual([])
  })

  it('stores every other extension as a file block and resolves relative to cwd', async () => {
    const saved: Saved = { images: [], files: [] }
    await writeFile(join(dir, 'notes.txt'), 'hello')
    const pending = await attachLocalFile(store(saved), dir, './notes.txt')
    expect(pending).toEqual({ name: 'notes.txt', block: { type: 'file', attachment: { kind: 'file', id: 'file-0' } } })
    expect(saved.files).toEqual([{ data: new TextEncoder().encode('hello'), name: 'notes.txt' }])
  })

  it('rejects an unreadable path', async () => {
    await expect(attachLocalFile(store({ images: [], files: [] }), dir, 'missing.txt')).rejects.toThrow('ENOENT')
  })
})
