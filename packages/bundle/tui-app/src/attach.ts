/**
 * `/attach`: read a local file and admit it into the attachment store as the
 * image or file block the next prompt carries, the way the browser composer
 * uploads a dropped file.
 * @module @deepseek-ai/dsh-tui-app/attach
 */

import { readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'

/** Image media types by file extension; every other extension attaches as a file. */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** One attachment waiting for the next prompt. */
export interface PendingAttachment {
  /** The display name, the file's base name. */
  name: string
  /** The durable content block the prompt carries. */
  block: ImageBlock | FileBlock
}

/**
 * Read `path` (relative to `cwd`) and store it.
 * @param store - the composed attachment store.
 * @param cwd - the directory relative paths resolve against.
 * @param path - the file to attach.
 * @returns the pending attachment.
 * @throws when the file cannot be read or the store rejects it.
 */
export async function attachLocalFile(store: AttachmentStore, cwd: string, path: string): Promise<PendingAttachment> {
  const absolute = resolve(cwd, path)
  const name = basename(absolute)
  const data = new Uint8Array(await readFile(absolute))
  const mediaType = IMAGE_MEDIA_TYPES[extname(absolute).toLowerCase()]
  if (mediaType !== undefined) {
    const [ref] = await store.saveImages([{ data, mediaType, name }])
    /* v8 ignore next -- saveImages returns one ref per input */
    if (ref === undefined) throw new Error(`the attachment store returned no reference for ${name}`)
    return { name, block: { type: 'image', attachment: ref } }
  }
  const ref = await store.saveFile({ data, name })
  return { name, block: { type: 'file', attachment: ref } }
}
