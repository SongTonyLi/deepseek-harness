/** The terminal's session, attachment, queue, skill, sign-in, `/login`,
 *  Shift+Tab effort picker, `/permission` picker, export, and reference
 *  commands over scripted services. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError, type AuthorizationNotice, type AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { KEY, bench, exportStubs } from './bench.ts'

function typeLine(terminal: { type(data: string): void }, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-tui-commands-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** Cached titles the picker reads without loading session logs. */
function sessionTitles(ctx: Context, titles: Record<string, string> = { 'session-older': 'Older chat' }): void {
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (header: { id: string }) => {
      const title = titles[header.id]
      return title === undefined ? undefined : { values: { title } }
    },
    cachedPredecessorTitle: () => undefined,
  } as never)
}

/** Two persisted sessions, the current one and an older titled one. */
function sessionList(ctx: Context): void {
  ctx.provide('sessionQuery', {
    listSessions: () => Promise.resolve([
      { header: { id: 'session-tui-test', createdAt: 20, cwd: '/work' } },
      { header: { id: 'session-older', createdAt: 10, cwd: '/elsewhere' } },
    ]),
  } as never)
  sessionTitles(ctx)
}

describe('session commands', () => {
  it('resumes through the picker, binds the selected session, and releases the previous one', async () => {
    const test = await bench({
      before: sessionList,
      openedHistory: [{
        type: 'user/message',
        seq: 0,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'earlier prompt' }], source: { kind: 'user' } }),
      }] as never[],
    })
    typeLine(test.terminal, '/resume')
    await test.settle()
    expect(test.terminal.text()).toContain('Older chat')
    expect(test.terminal.text()).toContain('/elsewhere')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.hostCalls).toEqual(['resume:session-older'])
    expect(test.opened[0]?.disposed).toBe(1)
    const screen = test.terminal.text()
    expect(screen).toContain('resumed: session session-older')
    expect(screen).toContain('❯ earlier prompt')
    expect(screen).toContain('opened-model · effort default')
    typeLine(test.terminal, '/quit')
    expect(test.quits[0]?.agent.session.id).toBe('session-older')
  })

  it('cancels an effort picker queued behind /resume before binding its target', async () => {
    let releaseSessions: ((records: unknown[]) => void) | undefined
    let releaseEffort: ((info: { reasoning: { efforts: { id: string; name: string }[] } }) => void) | undefined
    const test = await bench({
      before: (ctx) => {
        ctx.provide('sessionQuery', {
          listSessions: () => new Promise<unknown[]>((resolve) => { releaseSessions = resolve }),
        } as never)
        sessionTitles(ctx)
        ctx.provide('llm', {
          listProviders: () => [],
          listModels: () => Promise.resolve([]),
          resolveModelInfo: () => new Promise((resolve) => { releaseEffort = resolve }),
        } as never)
      },
    })
    typeLine(test.terminal, '/resume')
    await Promise.resolve()
    test.terminal.type(KEY.shiftTab)
    await Promise.resolve()
    releaseSessions?.([
      { header: { id: 'session-tui-test', createdAt: 20, cwd: '/work' } },
      { header: { id: 'session-older', createdAt: 10, cwd: '/elsewhere' } },
    ])
    await test.settle()
    expect(test.terminal.text()).toContain('Switch to a session')
    releaseEffort?.({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
    await Promise.resolve()
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.hostCalls).toEqual(['resume:session-older'])
    expect(test.opened[1]?.bound.selection.current).toEqual({ provider: 'test-provider', model: 'opened-model' })
    expect(await test.screen()).not.toContain('Reasoning effort ·')
  })

  it('keeps the current session when the picker picks it or is dismissed', async () => {
    const test = await bench({ before: sessionList })
    typeLine(test.terminal, '/sessions')
    await test.settle()
    test.terminal.type(KEY.enter)
    await test.settle()
    typeLine(test.terminal, '/sessions')
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.hostCalls).toEqual([])
    expect(test.opened[0]?.disposed).toBe(0)
  })

  it('coalesces the session commands and drops stale listings after another switch starts or completes', async () => {
    let listings = 0
    let releaseSessions: ((records: unknown[]) => void) | undefined
    const test = await bench({
      before: (ctx) => {
        ctx.provide('sessionQuery', {
          listSessions: () => {
            listings += 1
            return new Promise<unknown[]>((resolve) => { releaseSessions = resolve })
          },
        } as never)
        sessionTitles(ctx)
      },
    })
    typeLine(test.terminal, '/resume')
    await Promise.resolve()
    typeLine(test.terminal, '/sessions')
    expect(listings).toBe(1)
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.hostCalls).toEqual(['create'])
    releaseSessions?.([
      { header: { id: 'session-tui-test', createdAt: 20, cwd: '/work' } },
      { header: { id: 'session-older', createdAt: 10, cwd: '/elsewhere' } },
    ])
    await test.settle()
    expect(await test.screen()).not.toContain('Switch to a session')
    expect(test.hostCalls).toEqual(['create'])

    const aborted = await bench({
      before: (ctx) => {
        ctx.provide('sessionQuery', {
          listSessions: (signal: AbortSignal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => { reject(new Error('listing aborted')) }, { once: true })
          }),
        } as never)
      },
    })
    typeLine(aborted.terminal, '/resume')
    await Promise.resolve()
    typeLine(aborted.terminal, '/new')
    await aborted.settle()
    expect(aborted.terminal.text()).not.toContain('/resume failed')
    expect(aborted.hostCalls).toEqual(['create'])
  })

  it('silences effort and session listings canceled by a failed switch', async () => {
    let releaseSessions: ((records: unknown[]) => void) | undefined
    let releaseEffort: ((info: { reasoning: { efforts: { id: string; name: string }[] } }) => void) | undefined
    const test = await bench({
      hostFailure: 'store offline',
      before: (ctx) => {
        ctx.provide('sessionQuery', {
          listSessions: () => new Promise<unknown[]>((resolve) => { releaseSessions = resolve }),
        } as never)
        ctx.provide('llm', {
          listProviders: () => [],
          listModels: () => Promise.resolve([]),
          resolveModelInfo: () => new Promise((resolve) => { releaseEffort = resolve }),
        } as never)
      },
    })
    typeLine(test.terminal, '/resume')
    await Promise.resolve()
    test.terminal.type(KEY.shiftTab)
    await Promise.resolve()
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.terminal.text()).toContain('new session failed: store offline')
    releaseSessions?.([])
    releaseEffort?.({ reasoning: { efforts: [{ id: 'only', name: 'Only' }] } })
    await test.settle()
    expect(test.terminal.text()).not.toContain('no persisted sessions are listed')
    expect(test.terminal.text()).not.toContain('no selectable reasoning efforts')
  })

  it('reports an empty session list or a listing failure', async () => {
    const test = await bench()
    typeLine(test.terminal, '/sessions')
    await test.settle()
    expect(test.terminal.text()).toContain('no persisted sessions are listed')

    const failed = await bench({
      before: (ctx) => {
        ctx.provide('sessionQuery', {
          listSessions: () => Promise.reject(new Error('query offline')),
        } as never)
      },
    })
    typeLine(failed.terminal, '/resume')
    await failed.settle()
    expect(failed.terminal.text()).toContain('/resume failed: query offline')
  })

  it('starts and forks sessions through the host and refuses while a turn runs', async () => {
    const test = await bench()
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.hostCalls).toEqual(['create'])
    expect(test.terminal.text()).toContain('new session: session session-opened-1')
    typeLine(test.terminal, '/fork')
    await test.settle()
    expect(test.hostCalls).toEqual(['create', 'fork:session-opened-1'])
    expect(test.opened[1]?.disposed).toBe(1)
    typeLine(test.terminal, '/fork 2')
    await test.settle()
    typeLine(test.terminal, '/fork x')
    typeLine(test.terminal, '/fork 0')
    await test.settle()
    expect(test.hostCalls).toEqual(['create', 'fork:session-opened-1', 'fork:session-fork-of-session-opened-1@2'])
    expect(test.terminal.text()).toContain('usage: /fork · /fork <turn>')
    test.setStatus('running')
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.hostCalls).toHaveLength(3)
    // The refusal names the stop as the editor answers it: two presses.
    expect(test.terminal.text()).toContain('stop the running turn (Esc twice) before switching')
  })

  it('starts an empty session through /clear and leaves the previous one resumable', async () => {
    const test = await bench({
      history: [{
        type: 'user/message',
        seq: 0,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'keep this prompt' }], source: { kind: 'user' } }),
      }] as never[],
    })
    await test.settle()
    expect(test.terminal.text()).toContain('❯ keep this prompt')
    typeLine(test.terminal, '/clear')
    await test.settle()
    expect(test.hostCalls).toEqual(['create'])
    expect(test.opened[0]?.disposed).toBe(1)
    expect(test.terminal.text()).toContain('new session: session session-opened-1')
    expect(await test.screen()).not.toContain('❯ keep this prompt')
    typeLine(test.terminal, '/help')
    await test.settle()
    expect(test.terminal.text()).toContain('/clear')
    expect(test.terminal.text()).toContain('previous session stays on disk')
  })

  it('refuses input and a second switch while the host opens, and releases a session opened after quit', async () => {
    const gate = { release: () => {} }
    let effortLookups = 0
    const test = await bench({
      hostGate: gate,
      before: (ctx) => {
        ctx.provide('llm', {
          resolveModelInfo: () => {
            effortLookups += 1
            return Promise.resolve({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
          },
        } as never)
      },
    })
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.hostCalls).toEqual(['create'])
    test.terminal.type(KEY.shiftTab)
    typeLine(test.terminal, 'too early')
    typeLine(test.terminal, '/fork')
    await test.settle()
    expect(test.terminal.text().split('wait for the session switch to finish')).toHaveLength(4)
    expect(effortLookups).toBe(0)
    expect(test.calls.followups).toHaveLength(0)
    expect(test.hostCalls).toEqual(['create'])
    gate.release()
    await test.settle()
    expect(test.terminal.text()).toContain('new session: session session-opened-1')
    typeLine(test.terminal, '/new')
    await test.settle()
    test.terminal.type(KEY.ctrlD)
    expect(test.quits).toHaveLength(1)
    gate.release()
    await test.settle()
    expect(test.opened[2]?.disposed).toBe(1)
    expect(test.quits[0]?.agent.session.id).toBe('session-opened-1')
  })

  it('reports host failures and a previous session that would not release', async () => {
    const failing = await bench({ hostFailure: 'store offline' })
    typeLine(failing.terminal, '/fork')
    await failing.settle()
    expect(failing.terminal.text()).toContain('forked failed: store offline')
    const test = await bench()
    const initial = test.opened[0]
    if (initial === undefined) throw new Error('bench lost the initial session')
    initial.bound.dispose = () => Promise.reject(new Error('still busy'))
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.terminal.text()).toContain('releasing the previous session failed: still busy')
  })

  it('shows, sets, and redraws the title, and reports rename failures', async () => {
    const titles = new Map<SessionId, string>()
    const test = await bench({
      before: (ctx) => {
        ctx.provide('sessionTitle', {
          get: (session: Session) => {
            const title = titles.get(session.id)
            return title === undefined ? undefined : { title }
          },
          rename: (session: Session, title: string) => {
            if (title === 'bad') throw new Error('title rejected')
            titles.set(session.id, title)
            session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
          },
        } as never)
      },
    })
    typeLine(test.terminal, '/title')
    await test.settle()
    expect(test.terminal.text()).toContain('this session has no title yet')
    typeLine(test.terminal, '/title Refactor plan')
    await test.settle()
    expect(test.terminal.text()).toContain('Refactor plan (session-tui-test)')
    typeLine(test.terminal, '/title')
    await test.settle()
    expect(test.terminal.text()).toContain('title: Refactor plan')
    typeLine(test.terminal, '/title bad')
    await test.settle()
    expect(test.terminal.text()).toContain('rename failed: title rejected')
    const bare = await bench()
    typeLine(bare.terminal, '/title x')
    await bare.settle()
    expect(bare.terminal.text()).toContain('no session title service is composed')
  })

  it('redraws the footer when the permission preset changes', async () => {
    const presets = new Map<SessionId, string>()
    const test = await bench({
      before: (ctx) => { ctx.provide('permissionPresets', { current: (session: Session) => presets.get(session.id) } as never) },
    })
    expect(test.terminal.text()).not.toContain('permission')
    expect(test.terminal.text()).not.toContain('+1')
    presets.set(test.session.id, 'workspace-write')
    test.session.append('permission/preset', { preset: 'workspace-write' })
    await test.settle()
    // Unfocused, the new permission fact folds into +N rather than crowding the key line.
    expect(test.terminal.text()).toContain('+1')
    expect(test.terminal.text()).not.toContain('permission workspace-write')
    test.terminal.type(KEY.shiftDown)
    await test.settle()
    expect(test.terminal.text()).toContain('permission workspace-write')
  })
})

describe('attachments', () => {
  it('attaches files to the next prompt, shows them, and clears them', async () => {
    await writeFile(join(dir, 'notes.txt'), 'hi')
    await writeFile(join(dir, 'shot.png'), Buffer.from([1]))
    const test = await bench({
      before: (ctx) => {
        ctx.provide('attachments', {
          saveImages: () => Promise.resolve([{ kind: 'image', id: 'img', mediaType: 'image/png' }]),
          saveFile: () => Promise.resolve({ kind: 'file', id: 'file' }),
        } as never)
      },
    })
    typeLine(test.terminal, '/attach')
    await test.settle()
    expect(test.terminal.text()).toContain('nothing attached')
    typeLine(test.terminal, `/attach ${join(dir, 'notes.txt')}`)
    typeLine(test.terminal, `/attach ${join(dir, 'shot.png')}`)
    await test.settle()
    expect(test.terminal.text()).toContain('attached file notes.txt')
    expect(test.terminal.text()).toContain('+1')
    typeLine(test.terminal, '/attach')
    await test.settle()
    expect(test.terminal.text()).toContain('attached: notes.txt, shot.png')
    typeLine(test.terminal, 'look at these')
    await test.settle()
    expect(test.calls.followups[0]?.content).toEqual([
      { type: 'file', attachment: { kind: 'file', id: 'file' } },
      { type: 'image', attachment: { kind: 'image', id: 'img', mediaType: 'image/png' } },
      { type: 'text', text: 'look at these' },
    ])
    expect(test.terminal.text()).toContain('[file: notes.txt] [image: shot.png]')
    // The bar's one line ends with the keys that leave the editor, both ways.
    expect(test.terminal.text().trimEnd().endsWith('Shift+↑ read · Shift+↓ status')).toBe(true)
    expect(test.terminal.text().split('\n').filter(line => line.includes('/work')).at(-1)).not.toContain('attached')
    typeLine(test.terminal, `/attach ${join(dir, 'notes.txt')}`)
    await test.settle()
    typeLine(test.terminal, '/attach clear')
    await test.settle()
    expect(test.terminal.text()).toContain('attachments cleared')
    typeLine(test.terminal, `/attach ${join(dir, 'missing.txt')}`)
    await test.settle()
    expect(test.terminal.text()).toContain('attach failed')
  })

  it('keeps the typed order when a later attachment reads faster than an earlier one', async () => {
    await writeFile(join(dir, 'slow.txt'), 'hi')
    await writeFile(join(dir, 'quick.png'), Buffer.from([1]))
    const test = await bench({
      before: (ctx) => {
        ctx.provide('attachments', {
          // The image store answers at once and the file store a timer later,
          // so the read of the file typed first settles after the read of the
          // image typed second.
          saveImages: () => Promise.resolve([{ kind: 'image', id: 'img', mediaType: 'image/png' }]),
          saveFile: () => new Promise(resolve => setTimeout(() => { resolve({ kind: 'file', id: 'file' }) }, 20)),
        } as never)
      },
    })
    // Each command runs from its own unawaited dispatch, as two lines typed in
    // a row do.
    typeLine(test.terminal, `/attach ${join(dir, 'slow.txt')}`)
    typeLine(test.terminal, `/attach ${join(dir, 'quick.png')}`)
    await test.settle()
    await test.settle()
    typeLine(test.terminal, '/attach')
    await test.settle()
    expect(test.terminal.text()).toContain('attached: slow.txt, quick.png')
    typeLine(test.terminal, 'both please')
    await test.settle()
    expect(test.calls.followups[0]?.content).toEqual([
      { type: 'file', attachment: { kind: 'file', id: 'file' } },
      { type: 'image', attachment: { kind: 'image', id: 'img', mediaType: 'image/png' } },
      { type: 'text', text: 'both please' },
    ])
    expect(test.terminal.text()).toContain('[file: slow.txt] [image: quick.png]')
  })

  it('reports a missing attachment store and draws attachment markers of replayed prompts', async () => {
    const test = await bench()
    typeLine(test.terminal, '/attach x.txt')
    await test.settle()
    expect(test.terminal.text()).toContain('no attachment store is composed')
    test.session.append('user/message', createUserMessage({
      content: [{ type: 'image', attachment: { kind: 'image', id: 'img', mediaType: 'image/png' } as never }, { type: 'text', text: 'replayed' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await test.settle()
    expect(test.terminal.text()).toMatch(/replayed\s+\[image\]/u)
  })
})

describe('command failures and aliases', () => {
  it('turns a rejected command into a notice instead of an unhandled rejection', async () => {
    const test = await bench({ before: (ctx) => { ctx.provide('skills', { list: () => Promise.reject(new Error('catalog offline')) } as never) } })
    typeLine(test.terminal, '/skills')
    await test.settle()
    expect(test.terminal.text()).toContain('/skills failed: catalog offline')
  })

  it('accepts /exit as /quit and lists it in help', async () => {
    const test = await bench()
    typeLine(test.terminal, '/help')
    await test.settle()
    expect(test.terminal.text()).toContain('/exit')
    expect(test.terminal.text()).toContain('/resume')
    expect(test.terminal.text()).toContain('/clear')
    typeLine(test.terminal, '/exit')
    expect(test.quits).toHaveLength(1)
  })

  it('drops pending attachments on a switch with a notice', async () => {
    const test = await bench({
      before: (ctx) => { ctx.provide('attachments', { saveFile: () => Promise.resolve({ kind: 'file', id: 'file' }) } as never) },
    })
    await writeFile(join(dir, 'a.txt'), 'a')
    typeLine(test.terminal, `/attach ${join(dir, 'a.txt')}`)
    await test.settle()
    expect(test.terminal.text()).toContain('attached file a.txt')
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.terminal.text()).toContain('1 pending attachment(s) stayed with the previous session')
  })
})

describe('queue, skills, and export', () => {
  it('lists and clears the inbox', async () => {
    const test = await bench()
    typeLine(test.terminal, '/queue')
    await test.settle()
    expect(test.terminal.text()).toContain('nothing is queued')
    test.agent.inbox.append('next-turn', createUserMessage({ content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } }))
    test.agent.inbox.append('next-step', createUserMessage({ content: [{ type: 'text', text: 'soon' }], source: { kind: 'user' } }))
    typeLine(test.terminal, '/queue')
    await test.settle()
    expect(test.terminal.text()).toContain('next turn: later')
    expect(test.terminal.text()).toContain('next step: soon')
    typeLine(test.terminal, '/queue clear')
    await test.settle()
    expect(test.terminal.text()).toContain('queue cleared')
    expect(test.agent.inbox.nextTurn).toEqual([])
  })

  it('lists skills or explains their absence', async () => {
    const test = await bench({
      before: (ctx) => { ctx.provide('skills', { list: () => Promise.resolve([{ name: 'review', description: 'Review a diff' }]) } as never) },
    })
    typeLine(test.terminal, '/skills')
    await test.settle()
    expect(test.terminal.text()).toContain('review Review a diff')
    const empty = await bench({ before: (ctx) => { ctx.provide('skills', { list: () => Promise.resolve([]) } as never) } })
    typeLine(empty.terminal, '/skills')
    await empty.settle()
    expect(empty.terminal.text()).toContain('no skills are available')
    const bare = await bench()
    typeLine(bare.terminal, '/skills')
    await bare.settle()
    expect(bare.terminal.text()).toContain('no skill catalog is composed')
  })

  it('exports the session log into the given directory and reports failures', async () => {
    const test = await bench({ before: (ctx) => { exportStubs(ctx, 'session-tui-test' as SessionId) } })
    typeLine(test.terminal, `/export ${dir}`)
    await test.settle()
    // The notice wraps the archive path across terminal columns.
    expect(test.terminal.text().replaceAll(/\s+/g, '')).toContain(`exported${join(dir, 'dsh-session-session-tui-test.zip')}`)
    const bare = await bench()
    typeLine(bare.terminal, '/export')
    await bare.settle()
    expect(bare.terminal.text()).toContain('export failed: export needs the session query')
  })
})

describe('sign-in', () => {
  interface Flow {
    entries: unknown[]
    outcome: 'authorized' | 'cancelled'
    prompts: AuthorizationPrompt[]
    begun: unknown[]
  }

  interface BeginRequest {
    key: string
    method?: string
    interaction: { notify(notice: AuthorizationNotice): void; prompt(prompt: AuthorizationPrompt): Promise<string> }
  }

  function authorization(ctx: Context, flow: Flow): void {
    ctx.provide('authorization', {
      list: () => flow.entries,
      begin: async (request: BeginRequest) => {
        flow.begun.push({ key: request.key, method: request.method })
        request.interaction.notify({
          message: 'open the page',
          url: 'https://example.test/auth',
          openInBrowser: true,
          code: 'ABCD',
        })
        request.interaction.notify({ message: 'read more', url: 'https://example.test/info' })
        request.interaction.notify({ message: 'waiting for the browser' })
        const answers: string[] = []
        try {
          for (const prompt of flow.prompts) answers.push(await request.interaction.prompt(prompt))
        } catch (error: unknown) {
          if (error instanceof AuthorizationDeclinedError) return { status: 'cancelled' }
          throw error
        }
        flow.begun.push(answers)
        return { status: flow.outcome }
      },
    } as never)
  }

  it('walks provider, method, notices, and prompts to an authorized outcome', async () => {
    const flow: Flow = {
      entries: [
        { key: 'deepseek', label: 'DeepSeek', methods: [{ id: 'device', label: 'Device code' }, { id: 'key', label: 'API key' }] },
        { key: 'other', label: 'Other', methods: [] },
      ],
      outcome: 'authorized',
      prompts: [
        { kind: 'select', message: 'Which account?', options: [{ id: 'a', label: 'Alpha', description: 'first' }, { id: 'b', label: 'Beta' }], signal: new AbortController().signal },
        { kind: 'text', message: 'Paste the key', placeholder: 'sk-…', signal: new AbortController().signal },
      ],
      begun: [],
    }
    const opened: string[] = []
    const test = await bench({
      openUrl: (url) => { opened.push(url); return Promise.resolve() },
      before: (ctx) => { authorization(ctx, flow) },
    })
    typeLine(test.terminal, '/signin')
    await test.settle()
    expect(test.terminal.text()).toContain('Device code, API key')
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('Sign-in method for DeepSeek')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('open the page https://example.test/auth code: ABCD')
    expect(test.terminal.text()).toContain('read more https://example.test/info')
    expect(opened).toEqual(['https://example.test/auth'])
    expect(test.terminal.text()).toContain('Which account?')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('Paste the key')
    typeLine(test.terminal, 'sk-secret')
    await test.settle()
    expect(flow.begun).toEqual([{ key: 'deepseek', method: 'key' }, ['b', 'sk-secret']])
    expect(test.terminal.text()).toContain('waiting for the browser')
    expect(test.terminal.text()).toContain('signed in to DeepSeek')
    flow.prompts = []
    typeLine(test.terminal, '/signin other')
    await test.settle()
    expect(flow.begun.slice(2)).toEqual([{ key: 'other', method: undefined }, []])
  })

  it('keeps the URL usable and the attempt running when browser handoff fails', async () => {
    const flow: Flow = {
      entries: [{ key: 'other', label: 'Other', methods: [{ id: 'oauth', label: 'Subscription' }] }],
      outcome: 'authorized',
      prompts: [],
      begun: [],
    }
    const test = await bench({
      openUrl: () => Promise.reject(new Error('desktop unavailable')),
      before: (ctx) => { authorization(ctx, flow) },
    })
    typeLine(test.terminal, '/login other')
    await test.settle()
    expect(test.terminal.text()).toContain('open the page https://example.test/auth code: ABCD')
    expect(test.terminal.text()).toContain('could not open sign-in page: desktop unavailable')
    expect(test.terminal.text()).toContain('signed in to Other')
  })

  it('takes the provider from the argument, reports a cancelled flow, and treats dismissed prompts as cancellation', async () => {
    const flow: Flow = {
      entries: [{ key: 'other', label: 'Other', methods: [{ id: 'only', label: 'Only' }] }],
      outcome: 'cancelled',
      prompts: [],
      begun: [],
    }
    const test = await bench({ before: (ctx) => { authorization(ctx, flow) } })
    typeLine(test.terminal, '/signin other')
    await test.settle()
    expect(flow.begun).toEqual([{ key: 'other', method: 'only' }, []])
    expect(test.terminal.text()).toContain('sign-in to Other cancelled')
    typeLine(test.terminal, '/signin nope')
    await test.settle()
    expect(test.terminal.text()).toContain('no sign-in flow for nope')
    flow.prompts = [{ kind: 'select', message: 'Pick', options: [{ id: 'a', label: 'A' }], signal: new AbortController().signal }]
    typeLine(test.terminal, '/signin other')
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.text()).toContain('sign-in to Other cancelled')
    flow.prompts = [{ kind: 'text', message: 'Type', signal: new AbortController().signal }]
    typeLine(test.terminal, '/signin other')
    await test.settle()
    // The first Escape leaves the free-text row for the list; the second dismisses the prompt.
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.text().split('sign-in to Other cancelled')).toHaveLength(4)
  })

  it('reports a flow failure as a sign-in failure', async () => {
    const test = await bench({
      before: (ctx) => {
        ctx.provide('authorization', {
          list: () => [{ key: 'other', label: 'Other', methods: [{ id: 'oauth', label: 'Subscription' }] }],
          begin: () => Promise.reject(new Error('issuer unreachable')),
        } as never)
      },
    })
    typeLine(test.terminal, '/login other')
    await test.settle()
    expect(test.terminal.text()).toContain('sign-in failed: issuer unreachable')
  })

  it('reports missing flows and dismissed pickers', async () => {
    const bare = await bench()
    typeLine(bare.terminal, '/signin')
    await bare.settle()
    expect(bare.terminal.text()).toContain('no sign-in flows are composed')
    const none = await bench({ before: (ctx) => { authorization(ctx, { entries: [], outcome: 'authorized', prompts: [], begun: [] }) } })
    typeLine(none.terminal, '/signin')
    await none.settle()
    expect(none.terminal.text()).toContain('no provider offers a sign-in flow')
    const flow: Flow = {
      entries: [{ key: 'a', label: 'A', methods: [{ id: '1', label: 'One' }, { id: '2', label: 'Two' }] }],
      outcome: 'authorized',
      prompts: [],
      begun: [],
    }
    const test = await bench({ before: (ctx) => { authorization(ctx, flow) } })
    typeLine(test.terminal, '/signin')
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    typeLine(test.terminal, '/signin a')
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(flow.begun).toEqual([])
  })

  it('lists /login in help and offers only subscription methods', async () => {
    const flow: Flow = {
      entries: [
        { key: 'codex', label: 'Codex', methods: [{ id: 'oauth', label: 'ChatGPT' }, { id: 'api-key', label: 'API key' }] },
        { key: 'keys', label: 'Keys only', methods: [{ id: 'api-key', label: 'API key' }] },
      ],
      outcome: 'authorized',
      prompts: [],
      begun: [],
    }
    const test = await bench({ before: (ctx) => { authorization(ctx, flow) } })
    typeLine(test.terminal, '/help')
    await test.settle()
    expect(test.terminal.text()).toContain('/login')
    expect(test.terminal.text()).toContain('Shift+Tab effort')
    typeLine(test.terminal, '/login')
    await test.settle()
    expect(test.terminal.text()).toContain('ChatGPT')
    expect(test.terminal.text()).not.toContain('API key')
    expect(test.terminal.text()).not.toContain('Keys only')
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(flow.begun).toEqual([{ key: 'codex', method: 'oauth' }, []])
    expect(test.terminal.text()).toContain('signed in to Codex')
    typeLine(test.terminal, '/login keys')
    await test.settle()
    expect(test.terminal.text()).toContain('no subscription sign-in for keys')
    const none = await bench({ before: (ctx) => { authorization(ctx, { entries: [{ key: 'keys', label: 'Keys only', methods: [{ id: 'api-key', label: 'API key' }] }], outcome: 'authorized', prompts: [], begun: [] }) } })
    typeLine(none.terminal, '/login')
    await none.settle()
    expect(none.terminal.text()).toContain('no provider offers a subscription sign-in')
    const blocked = await bench({
      before: (ctx) => {
        authorization(ctx, {
          entries: [{ key: 'codex', label: 'Codex', methods: [{ id: 'oauth', label: 'ChatGPT' }] }],
          outcome: 'authorized',
          prompts: [],
          begun: [],
        })
        ctx.provide('llm', {
          listProviders: () => [],
          listModels: () => Promise.resolve([]),
          resolveModelInfo: () => Promise.resolve({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }),
        } as never)
      },
    })
    typeLine(blocked.terminal, '/login')
    await blocked.settle()
    blocked.terminal.type(KEY.shiftTab)
    await blocked.settle()
    expect(blocked.selection.current).toEqual({ provider: 'test-provider', model: 'test-model' })
    blocked.terminal.type(KEY.escape)
    await blocked.settle()
  })
})

describe('references and model', () => {
  it('completes @ mentions from workspace paths and other sessions', async () => {
    const test = await bench({
      before: (ctx) => {
        ctx.provide('fileReferences', {
          list: (_agent: unknown, query: string) => Promise.resolve(query === 'src'
            ? [{ path: 'src/app.ts', kind: 'file' }, { path: 'src', kind: 'directory' }, { path: 'we"ird', kind: 'file' }]
            : []),
        } as never)
        ctx.provide('sessionReferenceResolver', {
          listCandidates: (_agent: unknown, query: string) => Promise.resolve(query === 'src'
            ? [{ sessionId: 'session-older', label: 'Older chat', cwd: '/elsewhere' }, { sessionId: 'session-x', label: 'X' }]
            : []),
        } as never)
      },
    })
    for (const char of 'see @src') test.terminal.type(char)
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('src/app.ts')
    expect(screen).toContain('src/')
    expect(screen).toContain('Older chat')
    expect(screen).toContain('session · /elsewhere')
    expect(screen).not.toContain('we"ird')
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.terminal.text()).toContain('see @src/app.ts')
    const bare = await bench()
    for (const char of '@none') bare.terminal.type(char)
    await bare.settle()
    expect(bare.terminal.text()).toContain('@none')
  })

  it('swallows an aborted reference request and reports other resolver failures once', async () => {
    const test = await bench({
      before: (ctx) => {
        ctx.provide('fileReferences', {
          list: (_agent: unknown, query: string, signal: AbortSignal) => {
            if (query === 'slow') return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('aborted')) }) })
            return Promise.reject(new Error('index broken'))
          },
        } as never)
      },
    })
    for (const char of '@slow') test.terminal.type(char)
    await test.settle()
    // The next keystroke aborts the pending request; only the new request's failure is reported.
    test.terminal.type('x')
    await test.settle()
    expect(test.terminal.text().split('@ completion failed')).toHaveLength(2)
    expect(test.terminal.text()).toContain('@ completion failed: index broken')
  })

  it('picks a reasoning effort after the model and saves the default', async () => {
    const saved: unknown[] = []
    const test = await bench({
      saveDefaultModel: (value) => { saved.push(value); return Promise.resolve() },
      before: (ctx) => {
        ctx.provide('llm', {
          listProviders: () => [{ id: 'p', name: 'P' }],
          listModels: () => Promise.resolve([
            { provider: 'p', id: 'think', name: 'Think' },
            { provider: 'p', id: 'plain', name: 'Plain' },
            { provider: 'p', id: 'broken', name: 'Broken' },
          ]),
          resolveModelInfo: (_provider: string, model: string) => {
            if (model === 'broken') return Promise.reject(new Error('no such model'))
            if (model === 'blank') return Promise.resolve({ reasoning: { efforts: [] } })
            return Promise.resolve(model === 'think'
              ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'slow' }] } }
              : { reasoning: { efforts: [{ id: 'only', name: 'Only' }] } })
          },
        } as never)
      },
    })
    typeLine(test.terminal, '/model p/think')
    await test.settle()
    expect(test.terminal.text()).toContain('Reasoning effort · p/think')
    expect(test.terminal.text()).toContain('Esc cancels the model change')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p', model: 'think', reasoningEffort: 'high' })
    expect(test.terminal.text()).toContain('effort high')
    // Re-picking the same model opens on the effort in force, so Enter keeps it.
    typeLine(test.terminal, '/model p/think')
    await test.settle()
    expect(test.terminal.text()).toContain('High ✓')
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p', model: 'think', reasoningEffort: 'high' })
    typeLine(test.terminal, '/model p/think')
    await test.settle()
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p', model: 'think' })
    typeLine(test.terminal, '/model p/think')
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p', model: 'think' })
    typeLine(test.terminal, '/model p/plain')
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p', model: 'plain' })
    typeLine(test.terminal, '/model p/blank')
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p', model: 'blank' })
    typeLine(test.terminal, '/model p/broken')
    await test.settle()
    expect(test.terminal.text()).toContain('p/broken: no such model')
    expect(test.selection.current).toEqual({ provider: 'p', model: 'blank' })
    typeLine(test.terminal, '/model bad')
    typeLine(test.terminal, '/model bad/')
    await test.settle()
    expect(test.terminal.text()).toContain('usage: /model <provider>/<model>')
    typeLine(test.terminal, '/model save')
    await test.settle()
    expect(saved).toEqual([{ provider: 'p', model: 'blank' }])
    expect(test.terminal.text()).toContain('default model saved: p/blank')
  })

  it('saves the highlighted model as the next launch\'s default on Ctrl+S without closing the picker', async () => {
    const saved: unknown[] = []
    let failSave = false
    const test = await bench({
      saveDefaultModel: (value) => {
        if (failSave) return Promise.reject(new Error('disk full'))
        saved.push(value)
        return Promise.resolve()
      },
      before: (ctx) => {
        ctx.provide('llm', {
          listProviders: () => [{ id: 'p', name: 'P' }],
          listModels: () => Promise.resolve([{ provider: 'p', id: 'one', name: 'One' }, { provider: 'p', id: 'two', name: 'Two' }]),
          resolveModelInfo: () => Promise.resolve({ reasoning: { efforts: [] } }),
        } as never)
      },
    })
    typeLine(test.terminal, '/model')
    await test.settle()
    expect(test.terminal.text()).toContain('Ctrl+S saves the highlighted model as the default for the next launch')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.ctrlS)
    await test.settle()
    // The default is the highlighted row, not the session's model, and the
    // picker is still open: the session keeps its own model until Enter.
    expect(saved).toEqual([{ provider: 'p', model: 'two' }])
    expect(test.terminal.text()).toContain('default model saved: p/two')
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model' })
    expect(test.terminal.text()).toContain('Model for the next request')
    // A failed save says so and the picker stays open; Esc then changes nothing.
    failSave = true
    test.terminal.type(KEY.ctrlS)
    await test.settle()
    expect(test.terminal.text()).toContain('default model not saved: disk full')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model' })
    expect(saved).toHaveLength(1)
    // Ctrl+S on a filter that matches nothing has no row to save.
    typeLine(test.terminal, '/model')
    await test.settle()
    for (const character of 'zzz') test.terminal.type(character)
    test.terminal.type(KEY.ctrlS)
    await test.settle()
    expect(saved).toHaveLength(1)
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    await test.settle()
  })

  it('opens the same reasoning-effort picker on Shift+Tab as /effort', async () => {
    const test = await bench({
      before: (ctx) => {
        ctx.provide('llm', {
          listProviders: () => [],
          listModels: () => Promise.resolve([]),
          resolveModelInfo: () => Promise.resolve({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }),
        } as never)
      },
    })
    for (const character of 'draft prompt') test.terminal.type(character)
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('Reasoning effort · test-provider/test-model')
    expect(screen).toContain('current: Provider default · Esc keeps it')
    expect(screen).toContain('Provider default ✓')
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model' })
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' })
    expect(test.terminal.text()).toContain('effort high from the next request')
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.calls.followups[0]?.content).toEqual([{ type: 'text', text: 'draft prompt' }])
  })

  it('ignores a Kitty Shift+Tab release after handling its press', async () => {
    const test = await bench()
    test.terminal.type('\u001b[9;2u')
    await test.settle()
    test.terminal.type('\u001b[9;2:3u')
    await test.settle()
    expect(test.terminal.text().split('no model catalog is composed')).toHaveLength(2)
  })

  it('coalesces Shift+Tab and empty /effort while the lookup is pending and opens nothing after quit', async () => {
    let lookups = 0
    let release: ((info: { reasoning: { efforts: { id: string; name: string }[] } }) => void) | undefined
    const test = await bench({
      before: (ctx) => {
        ctx.provide('llm', {
          listProviders: () => [],
          listModels: () => Promise.resolve([]),
          resolveModelInfo: () => {
            lookups += 1
            return new Promise((resolve) => { release = resolve })
          },
        } as never)
      },
    })
    test.terminal.type(KEY.shiftTab)
    await Promise.resolve()
    test.terminal.type(KEY.shiftTab)
    typeLine(test.terminal, '/effort')
    expect(lookups).toBe(1)
    test.app.stop()
    release?.({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
    await test.settle()
    expect(test.terminal.text()).not.toContain('Reasoning effort ·')
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model' })
  })

  it('keeps a later explicit effort when an older Shift+Tab lookup settles', async () => {
    const releases: Array<(info: { reasoning: { efforts: { id: string; name: string }[] } }) => void> = []
    const test = await bench({
      before: (ctx) => {
        ctx.provide('llm', {
          listProviders: () => [],
          listModels: () => Promise.resolve([]),
          resolveModelInfo: () => new Promise((resolve) => { releases.push(resolve) }),
        } as never)
      },
    })
    test.terminal.type(KEY.shiftTab)
    await Promise.resolve()
    typeLine(test.terminal, '/effort high')
    await Promise.resolve()
    expect(releases).toHaveLength(2)
    releases[1]?.({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' })
    releases[0]?.({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' })
    expect(await test.screen()).not.toContain('Reasoning effort ·')
  })

  it('keeps a later model when an older Shift+Tab lookup settles', async () => {
    let release: ((info: { reasoning: { efforts: { id: string; name: string }[] } }) => void) | undefined
    const test = await bench({
      before: (ctx) => {
        ctx.provide('llm', {
          listProviders: () => [],
          listModels: () => Promise.resolve([]),
          resolveModelInfo: (_provider: string, model: string) => model === 'next'
            ? Promise.resolve({})
            : new Promise((resolve) => { release = resolve }),
        } as never)
      },
    })
    test.terminal.type(KEY.shiftTab)
    await Promise.resolve()
    typeLine(test.terminal, '/model p/next')
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p', model: 'next' })
    release?.({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p', model: 'next' })
    expect(await test.screen()).not.toContain('Reasoning effort · test-provider/test-model')
  })

  it('drops a pending Shift+Tab picker when a session switch starts', async () => {
    const gate = { release: () => {} }
    let release: ((info: { reasoning: { efforts: { id: string; name: string }[] } }) => void) | undefined
    const test = await bench({
      hostGate: gate,
      before: (ctx) => {
        ctx.provide('llm', {
          listProviders: () => [],
          listModels: () => Promise.resolve([]),
          resolveModelInfo: () => new Promise((resolve) => { release = resolve }),
        } as never)
      },
    })
    test.terminal.type(KEY.shiftTab)
    await Promise.resolve()
    typeLine(test.terminal, '/new')
    await Promise.resolve()
    release?.({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
    await test.settle()
    expect(test.terminal.text()).not.toContain('Reasoning effort ·')
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model' })
    gate.release()
    await test.settle()
    expect(test.hostCalls).toEqual(['create'])
    expect(test.terminal.text()).toContain('new session: session session-opened-1')
  })

  it('retires a pending Shift+Tab lookup so the new session can open its own picker', async () => {
    const releases: Array<(info: { reasoning: { efforts: { id: string; name: string }[] } }) => void> = []
    const test = await bench({
      before: (ctx) => {
        ctx.provide('llm', {
          listProviders: () => [],
          listModels: () => Promise.resolve([]),
          resolveModelInfo: () => new Promise((resolve) => { releases.push(resolve) }),
        } as never)
      },
    })
    test.terminal.type(KEY.shiftTab)
    await Promise.resolve()
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.hostCalls).toEqual(['create'])
    expect(test.terminal.text()).toContain('new session: session session-opened-1')
    test.terminal.type(KEY.shiftTab)
    await Promise.resolve()
    expect(releases).toHaveLength(2)
    releases[0]?.({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
    await Promise.resolve()
    releases[1]?.({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
    await test.settle()
    expect(test.terminal.text()).toContain('Reasoning effort · test-provider/opened-model')
    test.terminal.type(KEY.escape)
    await test.settle()
  })
})

describe('the effort command', () => {
  /** A catalog whose models declare two efforts, one effort, or nothing resolvable. */
  function catalog(ctx: Context): void {
    ctx.provide('llm', {
      listProviders: () => [{ id: 'p', name: 'P' }],
      listModels: () => Promise.resolve([]),
      resolveModelInfo: (_provider: string, model: string) => {
        if (model === 'broken') return Promise.reject(new Error('no such model'))
        if (model === 'plain') return Promise.resolve({ reasoning: { efforts: [{ id: 'only', name: 'Only' }] } })
        return Promise.resolve({
          reasoning: {
            defaultEffort: 'low',
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'slow' }],
          },
        })
      },
    } as never)
  }

  it('opens on the effort in force and applies the picked one', async () => {
    const test = await bench({ before: catalog })
    typeLine(test.terminal, '/effort')
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('Reasoning effort · test-provider/test-model')
    expect(screen).toContain('current: Provider default · Esc keeps it')
    expect(screen).toContain('Provider default ✓')
    expect(screen).toContain('resolves to Low')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' })
    expect(test.terminal.text()).toContain('effort high from the next request')
    typeLine(test.terminal, '/effort')
    await test.settle()
    expect(test.terminal.text()).toContain('current: High · Esc keeps it')
    expect(test.terminal.text()).toContain('High ✓')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' })
    typeLine(test.terminal, '/effort')
    await test.settle()
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.up)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model' })
    expect(test.terminal.text()).toContain('effort: provider default from the next request')
  })

  it('takes a declared effort or the default keyword as its argument', async () => {
    const test = await bench({ before: catalog })
    typeLine(test.terminal, '/effort High')
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' })
    typeLine(test.terminal, '/effort default')
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model' })
    expect(test.terminal.text()).toContain('effort: provider default from the next request')
    typeLine(test.terminal, '/effort turbo')
    await test.settle()
    expect(test.terminal.text()).toContain('test-provider/test-model has no effort "turbo" (low, high, default)')
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model' })
  })

  it('reports a model, a catalog, or a profile that offers no effort', async () => {
    const test = await bench({ before: catalog })
    test.selection.current = { provider: 'p', model: 'plain' }
    typeLine(test.terminal, '/effort')
    await test.settle()
    expect(test.terminal.text()).toContain('p/plain has no selectable reasoning efforts')
    test.selection.current = { provider: 'p', model: 'broken' }
    typeLine(test.terminal, '/effort high')
    await test.settle()
    expect(test.terminal.text()).toContain('p/broken: no such model')
    expect(test.selection.current).toEqual({ provider: 'p', model: 'broken' })
    const bare = await bench()
    typeLine(bare.terminal, '/effort')
    await bare.settle()
    expect(bare.terminal.text()).toContain('no model catalog is composed')
  })

  it('opens no picker when the lookup settles after the app stops', async () => {
    /** A catalog whose lookups hang until the test releases them. */
    async function gated(line: string): Promise<{ screen: string; selection: unknown }> {
      let release: ((info: { reasoning: { efforts: { id: string; name: string }[] } }) => void) | undefined
      const test = await bench({
        before: (ctx) => {
          ctx.provide('llm', {
            listProviders: () => [],
            listModels: () => Promise.resolve([]),
            resolveModelInfo: () => new Promise((resolve) => { release = resolve }),
          } as never)
        },
      })
      typeLine(test.terminal, line)
      await Promise.resolve()
      test.app.stop()
      release?.({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
      await test.settle()
      return { screen: test.terminal.text(), selection: test.selection.current }
    }

    const effort = await gated('/effort')
    expect(effort.screen).not.toContain('Reasoning effort ·')
    expect(effort.selection).toEqual({ provider: 'test-provider', model: 'test-model' })
    const model = await gated('/model p/think')
    expect(model.screen).not.toContain('Reasoning effort ·')
    expect(model.selection).toEqual({ provider: 'test-provider', model: 'test-model' })
  })
})

describe('the permission command', () => {
  /** Catalog plus the shared `/permission` write path the picker submits. */
  function permissionServices(ctx: Context, current = 'workspace-write'): { lines: string[] } {
    const state = { current }
    const options = [
      { value: 'workspace-write', name: 'workspace-write', description: 'Write inside the workspace.' },
      { value: 'danger-full-access', name: 'Full access', description: 'Full file access without approval prompts.' },
    ]
    const lines: string[] = []
    ctx.provide('permissionPresets', {
      catalog: () => ({ options }),
      current: () => state.current,
      set: (_session: Session, name: string) => { state.current = name },
    } as never)
    ctx.provide('commands', {
      list: () => [{ name: 'permission', description: 'Switch the permission preset', input: { hint: '<preset>' } }],
      execute: (_agent: unknown, line: string) => {
        lines.push(line)
        const name = line.slice('/permission '.length)
        state.current = name
        return Promise.resolve({ result: { kind: 'success', text: `preset ${name}` } })
      },
    } as never)
    return { lines }
  }

  it('opens on the preset in force and applies the picked one', async () => {
    let lines: string[] = []
    const test = await bench({
      before: (ctx) => { lines = permissionServices(ctx).lines },
    })
    typeLine(test.terminal, '/permission')
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('Permission preset')
    expect(screen).toContain('current: workspace-write · Esc keeps it')
    expect(screen).toContain('workspace-write ✓')
    expect(screen).toContain('Full access')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(lines).toEqual(['/permission danger-full-access'])
    expect(test.terminal.text()).toContain('/permission: preset danger-full-access')
    typeLine(test.terminal, '/permission')
    await test.settle()
    expect(test.terminal.text()).toContain('current: Full access · Esc keeps it')
    expect(test.terminal.text()).toContain('Full access ✓')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(lines).toEqual(['/permission danger-full-access'])
  })

  it('takes a catalog value as its argument', async () => {
    let lines: string[] = []
    const test = await bench({
      before: (ctx) => { lines = permissionServices(ctx).lines },
    })
    typeLine(test.terminal, '/permission Danger-Full-Access')
    await test.settle()
    expect(lines).toEqual(['/permission danger-full-access'])
    expect(test.terminal.text()).toContain('/permission: preset danger-full-access')
    typeLine(test.terminal, '/permission yolo')
    await test.settle()
    expect(test.terminal.text()).toContain('unknown preset "yolo" (available: workspace-write, danger-full-access)')
    expect(lines).toEqual(['/permission danger-full-access'])
  })

  it('reports a profile that offers no permission service or no presets', async () => {
    const bare = await bench()
    typeLine(bare.terminal, '/permission')
    await bare.settle()
    expect(bare.terminal.text()).toContain('no permission service is composed')
    const empty = await bench({
      before: (ctx) => {
        ctx.provide('permissionPresets', {
          catalog: () => ({ options: [] }),
          current: () => 'custom',
        } as never)
      },
    })
    typeLine(empty.terminal, '/permission')
    await empty.settle()
    expect(empty.terminal.text()).toContain('no selectable permission presets')
    typeLine(empty.terminal, '/permission auto')
    await empty.settle()
    expect(empty.terminal.text()).toContain('unknown preset "auto"')
  })

  it('lists /permission once when the shared command is also registered', async () => {
    const test = await bench({
      before: (ctx) => { permissionServices(ctx) },
    })
    typeLine(test.terminal, '/help')
    await test.settle()
    const rows = test.terminal.text().split('\n').filter(line => /^\s*\/permission\b/u.test(line))
    expect(rows).toHaveLength(1)
  })

  it('applies a pick through the permission service when no command registry is composed', async () => {
    const applied: string[] = []
    const test = await bench({
      before: (ctx) => {
        ctx.provide('permissionPresets', {
          catalog: () => ({ options: [{ value: 'workspace-write', name: 'workspace-write' }, { value: 'auto', name: 'Auto review' }] }),
          current: () => 'workspace-write',
          set: (_session: Session, name: string) => { applied.push(name) },
        } as never)
      },
    })
    typeLine(test.terminal, '/permission')
    await test.settle()
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(applied).toEqual(['auto'])
    expect(test.terminal.text()).toContain('preset auto')
  })
})
