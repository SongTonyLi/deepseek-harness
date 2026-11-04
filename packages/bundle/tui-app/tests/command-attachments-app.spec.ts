/**
 * Staged attachments submitted with shared commands and ordinary prompts.
 * Admission keeps typed order and the original image byte length, a rejected
 * or cancelled submission leaves the staged rows, and a later add survives
 * the batch that was already admitted.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  AttachmentId,
  AttachmentStore,
  type AttachmentAdmissionPart,
  type FileAttachmentRef,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type SaveFileAttachment,
  type SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import CommandRuntime, { type CommandInvocation, type CommandResult } from '@deepseek-ai/dsh-commands'
import { type Bench, KEY, bench } from './bench.ts'

const WAIT = 'wait for the attachment submission to finish (Esc cancels it)'
const CANCEL = "/plan cancelled; attachments stayed pending and the command's use of them is unknown"

const OPEN_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024 * 1024,
  maxImagesPerMessage: 32,
  maxMessageImageBytes: 1024 * 1024,
  maxImagePixels: 1024 * 1024,
  maxImageDimension: 4096,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

interface Gate {
  readonly wait: Promise<void>
  hold(): void
  release(): void
}

interface Harness {
  readonly store: AttachmentStore
  readonly imageLimits: ImageAttachmentLimits
  readonly gate: Gate
  readonly admissions: AttachmentAdmissionPart[][]
  readonly images: ImageAttachmentRef[]
  readonly files: FileAttachmentRef[]
  imageSaves: number
}

function createGate(): Gate {
  let resolveWait = (): void => {}
  let pending = Promise.resolve()
  return {
    get wait() { return pending },
    hold() {
      pending = new Promise<void>((resolve) => { resolveWait = resolve })
    },
    release() { resolveWait() },
  }
}

/** A store whose admission waits on `gate`, then uses the real limit check. Image refs use a stand-in byte length. */
function createStore(overrides: Partial<ImageAttachmentLimits> = {}): Harness {
  const imageLimits: ImageAttachmentLimits = { ...OPEN_LIMITS, ...overrides }
  const store = Object.create(AttachmentStore.prototype) as AttachmentStore
  const harness: Harness = {
    store,
    imageLimits,
    gate: createGate(),
    admissions: [],
    images: [],
    files: [],
    imageSaves: 0,
  }
  Object.assign(store, {
    imageLimits,
    async saveImages(inputs: readonly SaveImageAttachment[]): Promise<ImageAttachmentRef[]> {
      harness.imageSaves += 1
      return inputs.map((input) => {
        const ref: ImageAttachmentRef = {
          attachmentId: AttachmentId(`image-${String(harness.images.length + 1)}`),
          mediaType: input.mediaType,
          bytes: 1,
          width: 2,
          height: 2,
          ...input.name === undefined ? {} : { name: input.name },
        }
        harness.images.push(ref)
        return ref
      })
    },
    async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
      const ref: FileAttachmentRef = {
        attachmentId: AttachmentId(`file-${String(harness.files.length + 1)}`),
        name: input.name ?? 'file',
        bytes: input.data.byteLength,
      }
      harness.files.push(ref)
      return ref
    },
    async admitPromptContent(content: readonly AttachmentAdmissionPart[]): Promise<unknown> {
      harness.admissions.push([...content])
      await harness.gate.wait
      return AttachmentStore.prototype.admitPromptContent.call(store, content)
    },
  })
  return harness
}

function typeLine(terminal: { type(data: string): void }, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

async function withApp(
  before: (ctx: Context) => Promise<void> | void,
  run: (test: Bench) => Promise<void>,
): Promise<void> {
  const test = await bench({ before })
  try {
    await run(test)
  } finally {
    test.app.stop()
    await test.ctx.fiber.dispose()
  }
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-tui-cmd-attach-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function put(name: string, bytes: Uint8Array): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

async function attach(test: Bench, path: string): Promise<void> {
  const name = basename(path)
  typeLine(test.terminal, `/attach ${path}`)
  await expect.poll(() => test.terminal.text()).toContain(`attached ${name.endsWith('.png') ? 'image' : 'file'} ${name}`)
}

describe('staged attachments', () => {
  it('admits a file then an image with /plan and /goal, keeping the original byte length', async () => {
    const harness = createStore()
    const seen: CommandInvocation['attachments'][] = []
    await withApp(async (ctx) => {
      ctx.provide('attachments', harness.store)
      await ctx.plugin(CommandRuntime)
      for (const name of ['plan', 'goal'] as const) {
        ctx.commands.register({
          name,
          description: name === 'plan' ? 'Record a plan' : 'Record a goal',
          input: { hint: '<text>', attachments: true },
          handler: (invocation) => {
            seen.push(invocation.attachments)
            return { kind: 'success', text: `accepted ${invocation.rawInput.trim()}` }
          },
        })
      }
    }, async (test) => {
      await attach(test, await put('notes.txt', Uint8Array.of(1, 2, 3, 4)))
      await attach(test, await put('shot.png', Uint8Array.of(9, 8, 7)))
      const imageSaves = harness.imageSaves
      typeLine(test.terminal, '/plan look')
      await expect.poll(() => test.terminal.text()).toContain('/plan: accepted look')
      expect(harness.imageSaves).toBe(imageSaves)
      expect(harness.admissions).toEqual([[
        { type: 'file', attachment: harness.files[0] },
        { type: 'image', attachment: harness.images[0], encodedBytes: 3 },
      ]])
      expect(harness.images[0]?.bytes).toBe(1)
      expect(seen).toEqual([[
        { type: 'file', attachment: harness.files[0] },
        { type: 'image', attachment: harness.images[0] },
      ]])
      expect(test.calls.followups).toEqual([])
      typeLine(test.terminal, '/attach')
      await expect.poll(() => test.terminal.text()).toContain('nothing attached')

      await attach(test, await put('later.txt', Uint8Array.of(4, 3, 2, 1)))
      await attach(test, await put('next.png', Uint8Array.of(6, 5, 4)))
      typeLine(test.terminal, '/goal ship the lexer')
      await expect.poll(() => test.terminal.text()).toContain('/goal: accepted ship the lexer')
      expect(harness.admissions[1]).toEqual([
        { type: 'file', attachment: harness.files[1] },
        { type: 'image', attachment: harness.images[1], encodedBytes: 3 },
      ])
      expect(seen[1]).toEqual([
        { type: 'file', attachment: harness.files[1] },
        { type: 'image', attachment: harness.images[1] },
      ])
      expect(test.calls.followups).toEqual([])
      typeLine(test.terminal, '/attach')
      await expect.poll(() => test.terminal.text().split('nothing attached')).toHaveLength(3)
    })
  })

  it('keeps a file added during admission and refuses clear, prompts, and session changes', async () => {
    const harness = createStore()
    harness.gate.hold()
    let plans = 0
    let goals = 0
    const seen: CommandInvocation['attachments'][] = []
    try {
      await withApp(async (ctx) => {
        ctx.provide('attachments', harness.store)
        await ctx.plugin(CommandRuntime)
        ctx.commands.register({
          name: 'plan',
          description: 'Record a plan',
          input: { hint: '<text>', attachments: true },
          handler: (invocation) => {
            plans += 1
            seen.push(invocation.attachments)
            return { kind: 'success', text: `accepted ${invocation.rawInput.trim()}` }
          },
        })
        ctx.commands.register({
          name: 'goal',
          description: 'Record a goal',
          input: { hint: '<text>', attachments: true },
          handler: () => {
            goals += 1
            return { kind: 'success', text: 'accepted goal' }
          },
        })
      }, async (test) => {
        await attach(test, await put('notes.txt', Uint8Array.of(1, 2, 3, 4)))
        await attach(test, await put('shot.png', Uint8Array.of(9, 8, 7)))
        typeLine(test.terminal, '/plan look')
        await expect.poll(() => harness.admissions).toHaveLength(1)
        await attach(test, await put('extra.txt', Uint8Array.of(8)))
        typeLine(test.terminal, '/attach')
        await expect.poll(() => test.terminal.text()).toContain('attached: notes.txt, shot.png, extra.txt')
        typeLine(test.terminal, '/attach clear')
        typeLine(test.terminal, 'ship the notes')
        typeLine(test.terminal, '/goal ship the lexer')
        typeLine(test.terminal, '/new')
        typeLine(test.terminal, '/btw hello')
        await expect.poll(() => test.terminal.text().split(WAIT).length - 1).toBe(5)
        expect(test.hostCalls).toEqual([])
        expect(test.calls.followups).toEqual([])
        expect(plans).toBe(0)
        expect(goals).toBe(0)
        typeLine(test.terminal, '/attach')
        await expect.poll(() => test.terminal.text().split('attached: notes.txt, shot.png, extra.txt')).toHaveLength(3)

        harness.gate.release()
        await expect.poll(() => test.terminal.text()).toContain('/plan: accepted look')
        expect(plans).toBe(1)
        expect(goals).toBe(0)
        expect(seen).toEqual([[
          { type: 'file', attachment: harness.files[0] },
          { type: 'image', attachment: harness.images[0] },
        ]])
        expect(harness.admissions).toEqual([[
          { type: 'file', attachment: harness.files[0] },
          { type: 'image', attachment: harness.images[0], encodedBytes: 3 },
        ]])
        expect(test.calls.followups).toEqual([])
        typeLine(test.terminal, '/attach')
        await expect.poll(() => test.terminal.text()).toContain('attached: extra.txt')
        typeLine(test.terminal, '/new')
        await expect.poll(() => test.terminal.text()).toContain('1 pending attachment(s) stayed with the previous session')
        expect(test.hostCalls).toEqual(['create'])
      })
    } finally {
      harness.gate.release()
    }
  })

  it('does not run a handler for /compact or an unknown command while rows are staged', async () => {
    const harness = createStore()
    let compactions = 0
    await withApp(async (ctx) => {
      ctx.provide('attachments', harness.store)
      await ctx.plugin(CommandRuntime)
      ctx.commands.register({
        name: 'compact',
        description: 'Compact older conversation history',
        handler: () => {
          compactions += 1
          return { kind: 'success', text: 'compacted' }
        },
      })
    }, async (test) => {
      await attach(test, await put('notes.txt', Uint8Array.of(1, 2, 3, 4)))
      typeLine(test.terminal, '/compact')
      await expect.poll(() => test.terminal.text()).toContain('/compact: /compact does not accept attachments; attachments stayed pending')
      expect(compactions).toBe(0)
      typeLine(test.terminal, '/nope')
      await expect.poll(() => test.terminal.text()).toContain('unknown command /nope; attachments stayed pending')
      expect(compactions).toBe(0)
      typeLine(test.terminal, '/attach')
      await expect.poll(() => test.terminal.text()).toContain('attached: notes.txt')
      expect(test.calls.followups).toEqual([])
    })
  })

  it('keeps staged rows when the handler returns an error or throws', async () => {
    const harness = createStore()
    let calls = 0
    await withApp(async (ctx) => {
      ctx.provide('attachments', harness.store)
      await ctx.plugin(CommandRuntime)
      ctx.commands.register({
        name: 'plan',
        description: 'Record a plan',
        input: { hint: '<text>', attachments: true },
        handler: (invocation) => {
          calls += 1
          if (invocation.rawInput.includes('off')) {
            return { kind: 'error', text: 'Attachments cannot accompany /plan off.' }
          }
          throw new Error('plan exploded')
        },
      })
    }, async (test) => {
      await attach(test, await put('notes.txt', Uint8Array.of(1, 2, 3, 4)))
      typeLine(test.terminal, '/plan off')
      await expect.poll(() => test.terminal.text()).toContain('/plan: Attachments cannot accompany /plan off.; attachments stayed pending')
      expect(calls).toBe(1)
      typeLine(test.terminal, '/plan again')
      await expect.poll(() => test.terminal.text()).toContain("/plan failed: plan exploded; attachments stayed pending and the command's use of them is unknown")
      expect(calls).toBe(2)
      typeLine(test.terminal, '/attach')
      await expect.poll(() => test.terminal.text()).toContain('attached: notes.txt')
      expect(test.calls.followups).toEqual([])
    })
  })

  it('cancels a held admission and a held handler without dropping the staged file', async () => {
    const harness = createStore()
    const handler = createGate()
    harness.gate.hold()
    handler.hold()
    let entered = 0
    try {
      await withApp(async (ctx) => {
        ctx.provide('attachments', harness.store)
        await ctx.plugin(CommandRuntime)
        ctx.commands.register({
          name: 'plan',
          description: 'Record a plan',
          input: { hint: '<text>', attachments: true },
          handler: () => {
            entered += 1
            return handler.wait.then((): CommandResult => ({ kind: 'success', text: 'accepted' }))
          },
        })
      }, async (test) => {
        await attach(test, await put('notes.txt', Uint8Array.of(1, 2, 3, 4)))
        typeLine(test.terminal, '/plan look')
        await expect.poll(() => harness.admissions).toHaveLength(1)
        test.terminal.type(KEY.escape)
        harness.gate.release()
        await expect.poll(() => test.terminal.text()).toContain(CANCEL)
        expect(entered).toBe(0)
        expect(test.calls.followups).toEqual([])

        typeLine(test.terminal, '/plan look')
        await expect.poll(() => entered).toBe(1)
        test.terminal.type(KEY.escape)
        await expect.poll(() => test.terminal.text().split(CANCEL).length - 1).toBe(2)
        expect(entered).toBe(1)
        typeLine(test.terminal, '/attach')
        await expect.poll(() => test.terminal.text()).toContain('attached: notes.txt')
        expect(test.calls.followups).toEqual([])
      })
    } finally {
      harness.gate.release()
      handler.release()
    }
  })

  it('prints nothing more when quit settles a prompt admission', async () => {
    const harness = createStore()
    harness.gate.hold()
    try {
      await withApp((ctx) => {
        ctx.provide('attachments', harness.store)
      }, async (test) => {
        await attach(test, await put('shot.png', Uint8Array.of(9, 8, 7)))
        typeLine(test.terminal, 'describe the shot')
        await expect.poll(() => harness.admissions).toHaveLength(1)
        test.app.stop()
        await test.settle()
        const output = test.terminal.output
        harness.gate.release()
        await test.settle()
        expect(test.terminal.output).toBe(output)
        expect(test.calls.followups).toEqual([])
        expect(output).not.toContain('prompt cancelled')
        expect(output).not.toContain('attachments stayed pending')
      })
    } finally {
      harness.gate.release()
    }
  })

  it('keeps an ordinary prompt that exceeds an image limit and sends a file with one image', async () => {
    const harness = createStore({ maxImagesPerMessage: 1 })
    await withApp((ctx) => {
      ctx.provide('attachments', harness.store)
    }, async (test) => {
      await attach(test, await put('a.png', Uint8Array.of(1, 2, 3)))
      await attach(test, await put('b.png', Uint8Array.of(4, 5, 6)))
      const saves = harness.imageSaves
      typeLine(test.terminal, 'two images')
      await expect.poll(() => test.terminal.text()).toContain('Image batch exceeds the configured image-count limit.; attachments stayed pending')
      expect(harness.imageSaves).toBe(saves)
      expect(test.calls.followups).toEqual([])
      typeLine(test.terminal, '/attach')
      await expect.poll(() => test.terminal.text()).toContain('attached: a.png, b.png')

      typeLine(test.terminal, '/attach clear')
      await expect.poll(() => test.terminal.text()).toContain('attachments cleared')
      harness.imageLimits.maxImagesPerMessage = 32
      harness.imageLimits.maxMessageImageBytes = 5
      await attach(test, await put('c.png', Uint8Array.of(1, 2, 3)))
      await attach(test, await put('d.png', Uint8Array.of(4, 5, 6)))
      const byteSaves = harness.imageSaves
      typeLine(test.terminal, 'too many bytes')
      await expect.poll(() => test.terminal.text()).toContain('Image batch exceeds the configured aggregate image-byte limit.; attachments stayed pending')
      expect(harness.imageSaves).toBe(byteSaves)
      expect(test.calls.followups).toEqual([])
      typeLine(test.terminal, '/attach')
      await expect.poll(() => test.terminal.text()).toContain('attached: c.png, d.png')

      typeLine(test.terminal, '/attach clear')
      await expect.poll(() => test.terminal.text().split('attachments cleared')).toHaveLength(3)
      harness.imageLimits.maxMessageImageBytes = OPEN_LIMITS.maxMessageImageBytes
      harness.imageLimits.maxImagesPerMessage = 1
      await attach(test, await put('page.txt', Uint8Array.of(1, 2, 3, 4)))
      await attach(test, await put('one.png', Uint8Array.of(7, 8, 9)))
      const sendSaves = harness.imageSaves
      typeLine(test.terminal, 'read this')
      await expect.poll(() => test.calls.followups).toHaveLength(1)
      expect(harness.imageSaves).toBe(sendSaves)
      expect(test.calls.followups.map(message => message.content)).toEqual([[
        { type: 'file', attachment: harness.files.at(-1) },
        { type: 'image', attachment: harness.images.at(-1) },
        { type: 'text', text: 'read this' },
      ]])
      expect(test.terminal.text()).toContain('[file: page.txt] [image: one.png]')
      typeLine(test.terminal, '/attach')
      await expect.poll(() => test.terminal.text()).toContain('nothing attached')
    })
  })

  it('runs /permission and /sandbox without consuming the staged file', async () => {
    const harness = createStore()
    const received: CommandInvocation['attachments'][] = []
    await withApp(async (ctx) => {
      ctx.provide('attachments', harness.store)
      ctx.provide('permissionPresets', {
        catalog: () => ({ options: [{ value: 'workspace-write', name: 'workspace-write', description: 'Write inside the workspace.' }] }),
        current: () => 'workspace-write',
        set: () => {},
      } as never)
      await ctx.plugin(CommandRuntime)
      ctx.commands.register({
        name: 'permission',
        description: 'Switch the permission preset',
        input: { hint: '<preset>' },
        handler: (invocation) => {
          received.push(invocation.attachments)
          return { kind: 'success', text: `preset ${invocation.rawInput.trim()}` }
        },
      })
      ctx.commands.register({
        name: 'sandbox',
        description: 'Switch the sandbox backend',
        input: { hint: '<backend>' },
        handler: (invocation) => {
          received.push(invocation.attachments)
          return { kind: 'success', text: `backend ${invocation.rawInput.trim()}` }
        },
      })
    }, async (test) => {
      await attach(test, await put('keep.txt', Uint8Array.of(1, 2, 3, 4)))
      typeLine(test.terminal, '/permission workspace-write')
      await expect.poll(() => test.terminal.text()).toContain('/permission: preset workspace-write')
      typeLine(test.terminal, '/sandbox local')
      await expect.poll(() => test.terminal.text()).toContain('/sandbox: backend local')
      expect(received).toEqual([[], []])
      expect(test.calls.followups).toEqual([])
      typeLine(test.terminal, '/attach')
      await expect.poll(() => test.terminal.text()).toContain('attached: keep.txt')
    })
  })
})
