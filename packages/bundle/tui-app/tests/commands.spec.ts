/** The terminal's session, attachment, queue, skill, sign-in, `/login`,
 *  Shift+Tab effort cycling, export, and reference commands over scripted services. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
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

/** Two persisted sessions, the current one and an older titled one. */
function sessionList(ctx: Context): void {
  ctx.provide('sessionQuery', {
    listSessions: () => Promise.resolve([
      { header: { id: 'session-tui-test', createdAt: 20, cwd: '/work' } },
      { header: { id: 'session-older', createdAt: 10, cwd: '/elsewhere' } },
    ]),
    readTitleSnapshots: () => Promise.resolve([
      { status: 'fulfilled', value: {} },
      { status: 'fulfilled', value: { title: { title: 'Older chat' } } },
    ]),
  } as never)
}

describe('session commands', () => {
  it('switches through the picker, binds the new session, and releases the previous one', async () => {
    const test = await bench({
      before: sessionList,
      openedHistory: [{
        type: 'user/message',
        seq: 0,
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'earlier prompt' }], source: { kind: 'user' } }),
      }] as never[],
    })
    typeLine(test.terminal, '/sessions')
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
    expect(screen).toContain('› earlier prompt')
    expect(screen).toContain('test-provider/opened-model')
    typeLine(test.terminal, '/quit')
    expect(test.quits[0]?.agent.session.id).toBe('session-older')
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

  it('reports an empty session list', async () => {
    const test = await bench()
    typeLine(test.terminal, '/sessions')
    await test.settle()
    expect(test.terminal.text()).toContain('no persisted sessions are listed')
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
    expect(test.terminal.text()).toContain('stop the running turn (Esc) before switching')
  })

  it('refuses input and a second switch while the host opens, and releases a session opened after quit', async () => {
    const gate = { release: () => {} }
    const test = await bench({ hostGate: gate })
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.hostCalls).toEqual(['create'])
    typeLine(test.terminal, 'too early')
    typeLine(test.terminal, '/fork')
    await test.settle()
    expect(test.terminal.text().split('wait for the session switch to finish')).toHaveLength(3)
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
    presets.set(test.session.id, 'workspace-write')
    test.session.append('permission/preset', { preset: 'workspace-write' })
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
    expect(test.terminal.text()).toContain('2 attached')
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
    expect(test.terminal.text().trimEnd().endsWith('Ctrl+C twice quits')).toBe(true)
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
    interaction: { notify(notice: unknown): void; prompt(prompt: AuthorizationPrompt): Promise<string> }
  }

  function authorization(ctx: Context, flow: Flow): void {
    ctx.provide('authorization', {
      list: () => flow.entries,
      begin: async (request: BeginRequest) => {
        flow.begun.push({ key: request.key, method: request.method })
        request.interaction.notify({ message: 'open the page', url: 'https://example.test/auth', code: 'ABCD' })
        request.interaction.notify({ message: 'waiting for the browser' })
        const answers: string[] = []
        for (const prompt of flow.prompts) answers.push(await request.interaction.prompt(prompt))
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
    const test = await bench({ before: (ctx) => { authorization(ctx, flow) } })
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

  it('takes the provider from the argument, reports a cancelled flow, and fails loud on a dismissed prompt', async () => {
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
    expect(test.terminal.text()).toContain('sign-in failed: the sign-in prompt was dismissed')
    flow.prompts = [{ kind: 'text', message: 'Type', signal: new AbortController().signal }]
    typeLine(test.terminal, '/signin other')
    await test.settle()
    // The first Escape leaves the free-text row for the list; the second dismisses the prompt.
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.text().split('sign-in failed: the sign-in prompt was dismissed')).toHaveLength(3)
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
    expect(test.terminal.text()).toContain('Shift+Tab cycles the current model')
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
            if (model === 'blank') return Promise.resolve({ reasoning: {} })
            return Promise.resolve(model === 'think'
              ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'slow' }] } }
              : { reasoning: { efforts: [{ id: 'only', name: 'Only' }] } })
          },
        } as never)
        ctx.provide('settings', { replace: (namespace: string, value: unknown) => { saved.push([namespace, value]); return Promise.resolve() } } as never)
      },
    })
    typeLine(test.terminal, '/model p/think')
    await test.settle()
    expect(test.terminal.text()).toContain('Reasoning effort for think')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p', model: 'think', reasoningEffort: 'high' })
    expect(test.terminal.text()).toContain('effort high')
    typeLine(test.terminal, '/model p/think')
    await test.settle()
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
    expect(saved).toEqual([['agent-default-model', { provider: 'p', model: 'blank' }]])
    expect(test.terminal.text()).toContain('default model saved: p/blank')
  })

  it('cycles the current model reasoning effort on Shift+Tab', async () => {
    const test = await bench({
      before: (ctx) => {
        ctx.provide('llm', {
          listProviders: () => [{ id: 'p', name: 'P' }],
          listModels: () => Promise.resolve([]),
          resolveModelInfo: (_provider: string, model: string) => {
            if (model === 'broken') return Promise.reject(new Error('no such model'))
            if (model === 'plain') return Promise.resolve({ reasoning: { efforts: [{ id: 'only', name: 'Only' }] } })
            if (model === 'blank') return Promise.resolve({ reasoning: {} })
            return Promise.resolve({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
          },
        } as never)
      },
    })
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'low' })
    expect(test.terminal.text()).toContain('effort low from the next request')
    test.terminal.type(KEY.shiftTab)
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model' })
    expect(test.terminal.text()).toContain('effort: provider default from the next request')
    test.selection.current = { provider: 'test-provider', model: 'test-model', reasoningEffort: 'stale' as never }
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'low' })
    test.selection.current = { provider: 'p', model: 'plain' }
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    expect(test.terminal.text()).toContain('p/plain has no selectable reasoning efforts')
    expect(test.selection.current).toEqual({ provider: 'p', model: 'plain' })
    test.selection.current = { provider: 'p', model: 'blank' }
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    expect(test.terminal.text()).toContain('p/blank has no selectable reasoning efforts')
    test.selection.current = { provider: 'p', model: 'broken' }
    test.terminal.type(KEY.shiftTab)
    await test.settle()
    expect(test.terminal.text()).toContain('p/broken: no such model')
    const bare = await bench()
    bare.terminal.type(KEY.shiftTab)
    await bare.settle()
    expect(bare.terminal.text()).toContain('no model catalog is composed')
    let release: ((info: { reasoning: { efforts: { id: string; name: string }[] } }) => void) | undefined
    const quitting = await bench({
      before: (ctx) => {
        ctx.provide('llm', {
          listProviders: () => [],
          listModels: () => Promise.resolve([]),
          resolveModelInfo: () => new Promise((resolve) => { release = resolve }),
        } as never)
      },
    })
    quitting.terminal.type(KEY.shiftTab)
    await Promise.resolve()
    quitting.terminal.type(KEY.shiftTab)
    quitting.app.stop()
    release?.({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
    await quitting.settle()
    expect(quitting.selection.current).toEqual({ provider: 'test-provider', model: 'test-model' })
  })
})
