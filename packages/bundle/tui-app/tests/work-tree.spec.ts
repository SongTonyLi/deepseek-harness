/** The work tree: task and todo states, owners, todo lists beneath tasks, the `own` branch, counts, and logged task revisions. */

import { describe, expect, it } from 'vitest'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { LEAD_ROLE_TEXT } from '../src/team.ts'
import type { TeamMemberRow, TeamTaskRow } from '../src/team-panel.ts'
import type { TeamLogEvent } from '../src/team-play.ts'
import {
  WORK_STATES,
  taskRevisions,
  workTree,
  type TaskRevision,
  type WorkNode,
  type WorkState,
  type WorkTree,
  type WorkTreeInputs,
} from '../src/work-tree.ts'

function member(row: Pick<TeamMemberRow, 'id' | 'name' | 'role' | 'status'> & Partial<TeamMemberRow>): TeamMemberRow {
  return { diagnostics: [], ...row }
}

function task(row: Pick<TeamTaskRow, 'id' | 'status'> & Partial<TeamTaskRow>): TeamTaskRow {
  return {
    revision: 1,
    subject: `subject ${row.id}`,
    description: `body ${row.id}`,
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    ...row,
  }
}

function todo(content: string, status: TodoItem['status']): TodoItem {
  return { content, status }
}

function revision(id: string, status: TeamTaskRow['status'], ownerId?: string): TaskRevision {
  return ownerId === undefined ? { id, status } : { id, status, ownerId }
}

function inputs(overrides: Partial<WorkTreeInputs> = {}): WorkTreeInputs {
  return {
    members: [],
    tasks: [],
    boundId: lead.id,
    boundName: 'lead',
    ownTodos: [],
    ownTurnOpen: false,
    memberTodos: () => undefined,
    revisions: [],
    note: () => undefined,
    turns: () => undefined,
    ...overrides,
  }
}

/** The top-level nodes, then every child. */
function everyNode(tree: WorkTree): WorkNode[] {
  return [...tree.nodes, ...tree.nodes.flatMap(node => node.children)]
}

function nodeAt(tree: WorkTree, key: string): WorkNode {
  const found = everyNode(tree).find(node => node.key === key)
  if (found === undefined) throw new Error(`no node ${key}`)
  return found
}

/** The state and the reason of one node. */
function verdictAt(tree: WorkTree, key: string): { state: WorkState; reason?: string } {
  const node = nodeAt(tree, key)
  return node.reason === undefined ? { state: node.state } : { state: node.state, reason: node.reason }
}

function counts(partial: Partial<Record<WorkState, number>>): Record<WorkState, number> {
  return { delivered: 0, in_progress: 0, stuck: 0, deferred: 0, pending: 0, ...partial }
}

/** Freeze a value and everything it holds, so a write to any part of it throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    const held: unknown[] = Object.values(value)
    for (const field of held) deepFreeze(field)
    Object.freeze(value)
  }
  return value
}

const lead = member({ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' })
const parser = member({ id: 'session-parser', name: 'parser', role: 'teammate', status: 'running', description: 'writes the parser' })
const reviewer = member({ id: 'session-reviewer', name: 'reviewer', role: 'teammate', status: 'running' })
const idle = member({ id: 'session-idle', name: 'idle', role: 'teammate', status: 'inactive' })
const broken = member({ id: 'session-broken', name: 'broken', role: 'teammate', status: 'failed' })
const starting = member({ id: 'session-starting', name: 'starting', role: 'teammate', status: 'provisioning' })

const parserTodos: TodoItem[] = [todo('lex', 'completed'), todo('parse', 'in_progress'), todo('test', 'pending')]

describe('workTree in a session without a team', () => {
  it('is the own branch alone, owned by the session as the orchestrator', () => {
    const tree = workTree(inputs({
      boundId: 'session-solo',
      boundName: 'main',
      ownTurnOpen: true,
      ownTodos: [todo('read', 'completed'), todo('write', 'in_progress'), todo('ship', 'pending')],
    }))
    const owner = { id: 'session-solo', name: 'main', role: LEAD_ROLE_TEXT }
    expect(tree.nodes).toStrictEqual([{
      key: 'own',
      kind: 'own',
      title: 'main',
      state: 'in_progress',
      owner,
      children: [
        { key: 'own/todo:read', kind: 'todo', title: 'read', state: 'delivered', owner, children: [] },
        { key: 'own/todo:write', kind: 'todo', title: 'write', state: 'in_progress', owner, children: [] },
        { key: 'own/todo:ship', kind: 'todo', title: 'ship', state: 'pending', owner, children: [] },
      ],
    }])
    expect(tree.counts).toStrictEqual(counts({ delivered: 1, in_progress: 1, pending: 1 }))
    expect(tree.total).toBe(3)
  })

  it('has no nodes and a zero count for every state without tasks or todos', () => {
    const tree = workTree(inputs())
    expect(tree).toStrictEqual({ nodes: [], counts: counts({}), total: 0 })
    expect(Object.keys(tree.counts).sort()).toEqual([...WORK_STATES].sort())
  })
})

describe('workTree task states', () => {
  it('delivers a completed task', () => {
    const tree = workTree(inputs({ members: [lead, idle], tasks: [task({ id: '1', status: 'completed', ownerName: 'idle' })] }))
    expect(verdictAt(tree, 'task:1')).toStrictEqual({ state: 'delivered' })
  })

  it('keeps the bound session in-progress task in progress while its turn is open and stuck idle when it is not', () => {
    const board = { members: [lead], tasks: [task({ id: '1', status: 'in_progress', ownerName: 'lead' })] }
    expect(verdictAt(workTree(inputs({ ...board, ownTurnOpen: true })), 'task:1')).toStrictEqual({ state: 'in_progress' })
    expect(verdictAt(workTree(inputs({ ...board, ownTurnOpen: false })), 'task:1'))
      .toStrictEqual({ state: 'stuck', reason: 'owner_idle' })
  })

  it('reads another owner in-progress task from that owner roster status', () => {
    const tree = workTree(inputs({
      members: [lead, parser, starting, broken, idle],
      ownTurnOpen: true,
      tasks: [
        task({ id: '1', status: 'in_progress', ownerName: 'parser' }),
        task({ id: '2', status: 'in_progress', ownerName: 'starting' }),
        task({ id: '3', status: 'in_progress', ownerName: 'broken' }),
        task({ id: '4', status: 'in_progress', ownerName: 'idle' }),
      ],
    }))
    expect(['task:1', 'task:2', 'task:3', 'task:4'].map(key => verdictAt(tree, key))).toStrictEqual([
      { state: 'in_progress' },
      { state: 'in_progress' },
      { state: 'stuck', reason: 'owner_failed' },
      { state: 'stuck', reason: 'owner_idle' },
    ])
  })

  it('keeps an in-progress task in progress when the roster does not list its owner or it has none', () => {
    const tree = workTree(inputs({
      members: [lead],
      tasks: [task({ id: '1', status: 'in_progress', ownerName: 'ghost' }), task({ id: '2', status: 'in_progress' })],
    }))
    expect(verdictAt(tree, 'task:1')).toStrictEqual({ state: 'in_progress' })
    expect(nodeAt(tree, 'task:1').owner).toStrictEqual({ name: 'ghost', role: 'teammate' })
    expect(verdictAt(tree, 'task:2')).toStrictEqual({ state: 'in_progress' })
    expect('owner' in nodeAt(tree, 'task:2')).toBe(false)
  })

  it('marks a pending task stuck on the blockers that are not deleted, in board order', () => {
    const tree = workTree(inputs({
      members: [lead],
      ownTurnOpen: true,
      tasks: [
        task({ id: '1', status: 'in_progress' }),
        task({ id: '2', status: 'pending' }),
        task({ id: '9', status: 'deleted' }),
        task({ id: '3', status: 'pending', blockedBy: ['2', 'gone', '9', '1'] }),
      ],
    }))
    const node = nodeAt(tree, 'task:3')
    expect({ state: node.state, reason: node.reason, waitsOn: node.waitsOn }).toStrictEqual({
      state: 'stuck',
      reason: 'blocked',
      waitsOn: ['1', '2'],
    })
  })

  it('does not block a pending task whose blockers are all deleted or missing', () => {
    const tree = workTree(inputs({
      ownTurnOpen: true,
      tasks: [task({ id: '9', status: 'deleted' }), task({ id: '1', status: 'pending', blockedBy: ['9', 'gone'] })],
    }))
    expect(verdictAt(tree, 'task:1')).toStrictEqual({ state: 'pending' })
    expect('waitsOn' in nodeAt(tree, 'task:1')).toBe(false)
  })

  it('carries waitsOn only on a blocked task, never on an in-progress task that lists a blocker', () => {
    const tree = workTree(inputs({
      ownTurnOpen: true,
      tasks: [task({ id: '1', status: 'pending' }), task({ id: '2', status: 'in_progress', blockedBy: ['1'] })],
    }))
    expect(verdictAt(tree, 'task:2')).toStrictEqual({ state: 'in_progress' })
    expect(tree.nodes.map(node => 'waitsOn' in node)).toEqual([false, false])
  })

  it('defers a task an owner released back to pending, past the pending edits that followed', () => {
    const tree = workTree(inputs({
      ownTurnOpen: true,
      tasks: [task({ id: '1', status: 'pending' })],
      revisions: [
        revision('1', 'pending'),
        revision('1', 'in_progress', parser.id),
        revision('2', 'completed'),
        revision('1', 'pending'),
        revision('1', 'pending'),
      ],
    }))
    expect(verdictAt(tree, 'task:1')).toStrictEqual({ state: 'deferred', reason: 'released' })
  })

  it('defers a completed task that was reopened', () => {
    const tree = workTree(inputs({
      ownTurnOpen: true,
      tasks: [task({ id: '1', status: 'pending' })],
      revisions: [revision('1', 'pending'), revision('1', 'completed'), revision('1', 'pending')],
    }))
    expect(verdictAt(tree, 'task:1')).toStrictEqual({ state: 'deferred', reason: 'reopened' })
  })

  it('does not defer a task whose revisions were always pending, end in another status, or came back from deleted', () => {
    const tree = workTree(inputs({
      ownTurnOpen: true,
      tasks: [task({ id: '1', status: 'pending' }), task({ id: '2', status: 'pending' }), task({ id: '3', status: 'pending' })],
      revisions: [
        revision('1', 'pending'),
        revision('1', 'pending'),
        revision('2', 'pending'),
        revision('2', 'in_progress', parser.id),
        revision('3', 'deleted'),
        revision('3', 'pending'),
      ],
    }))
    expect(['task:1', 'task:2', 'task:3'].map(key => verdictAt(tree, key))).toStrictEqual([
      { state: 'pending' },
      { state: 'pending' },
      { state: 'pending' },
    ])
  })

  it('marks a released task that waits on a blocker stuck rather than deferred', () => {
    const tree = workTree(inputs({
      ownTurnOpen: true,
      tasks: [task({ id: '1', status: 'pending' }), task({ id: '2', status: 'pending', blockedBy: ['1'] })],
      revisions: [revision('2', 'in_progress', parser.id), revision('2', 'pending')],
    }))
    expect(verdictAt(tree, 'task:2')).toStrictEqual({ state: 'stuck', reason: 'blocked' })
  })

  it('defers a ready pending task as left open when no turn can advance it', () => {
    const tree = workTree(inputs({
      members: [{ ...lead, status: 'inactive' }, idle, broken],
      ownTurnOpen: false,
      tasks: [task({ id: '1', status: 'pending' })],
    }))
    expect(verdictAt(tree, 'task:1')).toStrictEqual({ state: 'deferred', reason: 'left_open' })
  })

  it('keeps a ready pending task pending while the bound turn is open or a member runs or is starting', () => {
    const board = { tasks: [task({ id: '1', status: 'pending' })] }
    const cases: Partial<WorkTreeInputs>[] = [
      { ownTurnOpen: true, members: [] },
      { ownTurnOpen: false, members: [{ ...lead, status: 'inactive' }, parser] },
      { ownTurnOpen: false, members: [{ ...lead, status: 'inactive' }, starting] },
    ]
    for (const overrides of cases) {
      expect(verdictAt(workTree(inputs({ ...board, ...overrides })), 'task:1')).toStrictEqual({ state: 'pending' })
    }
  })
})

describe('workTree task nodes', () => {
  it('carries the task fields and the tasks that wait on it, and drops deleted tasks everywhere', () => {
    const scopes = ['src/a.ts']
    const tasks = [
      task({ id: '1', status: 'pending', subject: 'design', description: 'sketch the API', writeScopes: scopes }),
      task({ id: '2', status: 'pending', blockedBy: ['1'] }),
      task({ id: '3', status: 'deleted', blockedBy: ['1'] }),
      task({ id: '4', status: 'completed', blockedBy: ['1'] }),
    ]
    const tree = workTree(inputs({ ownTurnOpen: true, tasks }))
    expect(tree.nodes.map(node => node.key)).toEqual(['task:1', 'task:2', 'task:4'])
    expect(tree.nodes[0]).toStrictEqual({
      key: 'task:1',
      kind: 'task',
      title: 'design',
      state: 'pending',
      children: [],
      taskId: '1',
      description: 'sketch the API',
      blocks: ['2', '4'],
      writeScopes: ['src/a.ts'],
    })
    expect(tree.nodes[0]?.writeScopes).not.toBe(scopes)
    expect(tree.nodes[1]?.blocks).toEqual([])
    expect(tree.total).toBe(3)
  })

  it('names a listed owner with its id, role text, and status', () => {
    const tree = workTree(inputs({
      members: [lead, parser, idle],
      tasks: [
        task({ id: '1', status: 'completed', ownerName: 'lead' }),
        task({ id: '2', status: 'completed', ownerName: 'parser' }),
        task({ id: '3', status: 'completed', ownerName: 'idle' }),
      ],
    }))
    expect(tree.nodes.map(node => node.owner)).toStrictEqual([
      { id: lead.id, name: 'lead', role: LEAD_ROLE_TEXT, status: 'running' },
      { id: parser.id, name: 'parser', role: 'writes the parser', status: 'running' },
      { id: idle.id, name: 'idle', role: 'teammate', status: 'inactive' },
    ])
  })

  it('notes what a listed owner last narrated, and nothing for a silent, unlisted, or absent owner', () => {
    const asked: string[] = []
    const tree = workTree(inputs({
      members: [lead, parser, idle],
      tasks: [
        task({ id: '1', status: 'completed', ownerName: 'parser' }),
        task({ id: '2', status: 'completed', ownerName: 'idle' }),
        task({ id: '3', status: 'completed', ownerName: 'ghost' }),
        task({ id: '4', status: 'completed' }),
      ],
      note: (id) => {
        asked.push(id)
        return id === parser.id ? 'parsing the grammar' : undefined
      },
    }))
    expect(tree.nodes.map(node => 'note' in node ? node.note : 'none')).toEqual(['parsing the grammar', 'none', 'none', 'none'])
    expect(asked).toEqual([parser.id, idle.id])
  })
})

describe('workTree todo lists beneath tasks', () => {
  it('lists a running member todos beneath its in-progress task, open todos keeping their status, without turns', () => {
    const tree = workTree(inputs({
      members: [lead, parser],
      ownTurnOpen: true,
      tasks: [task({ id: '1', status: 'in_progress', ownerName: 'parser' })],
      memberTodos: id => id === parser.id ? parserTodos : undefined,
      turns: () => ({ firstTurn: 1, statusTurn: 2 }),
    }))
    const node = nodeAt(tree, 'task:1')
    expect(node.children).toStrictEqual([
      { key: 'task:1/todo:lex', kind: 'todo', title: 'lex', state: 'delivered', owner: node.owner, children: [] },
      { key: 'task:1/todo:parse', kind: 'todo', title: 'parse', state: 'in_progress', owner: node.owner, children: [] },
      { key: 'task:1/todo:test', kind: 'todo', title: 'test', state: 'pending', owner: node.owner, children: [] },
    ])
    expect(tree.counts).toStrictEqual(counts({ in_progress: 1 }))
    expect(tree.total).toBe(1)
  })

  it('defers the open todos of a member whose turn is not running', () => {
    const tree = workTree(inputs({
      members: [lead, idle, starting],
      ownTurnOpen: true,
      tasks: [
        task({ id: '1', status: 'in_progress', ownerName: 'idle' }),
        task({ id: '2', status: 'in_progress', ownerName: 'starting' }),
      ],
      memberTodos: () => parserTodos,
    }))
    for (const key of ['task:1', 'task:2']) {
      expect(nodeAt(tree, key).children.map(child => verdictAt(tree, child.key))).toStrictEqual([
        { state: 'delivered' },
        { state: 'deferred', reason: 'left_open' },
        { state: 'deferred', reason: 'left_open' },
      ])
    }
  })

  it('lists no todos beneath a completed or pending task', () => {
    const tree = workTree(inputs({
      members: [lead, parser],
      ownTurnOpen: true,
      tasks: [task({ id: '1', status: 'completed', ownerName: 'parser' }), task({ id: '2', status: 'pending', ownerName: 'parser' })],
      memberTodos: () => parserTodos,
    }))
    expect(tree.nodes.map(node => node.children)).toEqual([[], []])
  })

  it('never repeats the bound session list beneath the task it owns', () => {
    const tree = workTree(inputs({
      members: [lead],
      ownTurnOpen: true,
      tasks: [task({ id: '1', status: 'in_progress', ownerName: 'lead' })],
      ownTodos: parserTodos,
      memberTodos: () => parserTodos,
    }))
    expect(nodeAt(tree, 'task:1').children).toEqual([])
    expect(nodeAt(tree, 'own').children.map(child => child.key)).toEqual(['own/todo:lex', 'own/todo:parse', 'own/todo:test'])
  })

  it('lists no todos for a member without a live session or with an empty list', () => {
    const tree = workTree(inputs({
      members: [lead, parser, reviewer],
      tasks: [
        task({ id: '1', status: 'in_progress', ownerName: 'parser' }),
        task({ id: '2', status: 'in_progress', ownerName: 'reviewer' }),
      ],
      memberTodos: id => id === reviewer.id ? [] : undefined,
    }))
    expect(tree.nodes.map(node => node.children)).toEqual([[], []])
  })

  it('lists the todos once, beneath the in-progress task the member claimed last', () => {
    const tree = workTree(inputs({
      members: [lead, parser],
      tasks: [
        task({ id: '1', status: 'in_progress', ownerName: 'parser' }),
        task({ id: '2', status: 'in_progress', ownerName: 'parser' }),
        task({ id: '3', status: 'in_progress', ownerName: 'parser' }),
      ],
      revisions: [
        revision('3', 'in_progress', parser.id),
        revision('1', 'in_progress', parser.id),
        revision('2', 'in_progress', 'session-other'),
        revision('2', 'in_progress'),
        revision('3', 'pending', parser.id),
      ],
      memberTodos: () => parserTodos,
    }))
    expect(tree.nodes.map(node => node.children.length)).toEqual([3, 0, 0])
  })

  it('lists the todos beneath a claimed task ahead of an earlier task no revision claimed', () => {
    const tree = workTree(inputs({
      members: [lead, parser],
      tasks: [task({ id: '1', status: 'in_progress', ownerName: 'parser' }), task({ id: '2', status: 'in_progress', ownerName: 'parser' })],
      revisions: [revision('2', 'in_progress', parser.id)],
      memberTodos: () => parserTodos,
    }))
    expect(tree.nodes.map(node => node.children.length)).toEqual([0, 3])
  })

  it('lists the todos beneath the first in-progress task in board order when no revision names a claim', () => {
    const tree = workTree(inputs({
      members: [lead, parser],
      tasks: [
        task({ id: '1', status: 'pending', ownerName: 'parser' }),
        task({ id: '2', status: 'in_progress', ownerName: 'parser' }),
        task({ id: '3', status: 'in_progress', ownerName: 'parser' }),
      ],
      memberTodos: () => parserTodos,
    }))
    expect(tree.nodes.map(node => node.children.length)).toEqual([0, 3, 0])
  })
})

describe('workTree own branch', () => {
  it('is titled with the roster name of the bound member and owned by that member', () => {
    const tree = workTree(inputs({ members: [lead, parser], boundName: 'fallback', ownTodos: [todo('plan', 'completed')] }))
    const own = nodeAt(tree, 'own')
    expect(own.title).toBe('lead')
    expect(own.owner).toStrictEqual({ id: lead.id, name: 'lead', role: LEAD_ROLE_TEXT, status: 'running' })
  })

  it('is owned as a teammate without a status when a team roster does not list the bound session', () => {
    const tree = workTree(inputs({ members: [lead], boundId: 'session-x', boundName: 'x', ownTodos: [todo('plan', 'pending')] }))
    expect(nodeAt(tree, 'own').title).toBe('x')
    expect(nodeAt(tree, 'own').owner).toStrictEqual({ id: 'session-x', name: 'x', role: 'teammate' })
  })

  it('reports the first state in the order in progress, deferred, pending, delivered that one of its todos holds', () => {
    const branch = (ownTodos: TodoItem[], ownTurnOpen: boolean): { state: WorkState; reason?: string } =>
      verdictAt(workTree(inputs({ ownTodos, ownTurnOpen })), 'own')
    expect(branch([todo('a', 'completed'), todo('b', 'pending'), todo('c', 'in_progress')], true)).toStrictEqual({ state: 'in_progress' })
    expect(branch([todo('a', 'completed'), todo('b', 'pending')], true)).toStrictEqual({ state: 'pending' })
    expect(branch([todo('a', 'completed'), todo('b', 'pending'), todo('c', 'in_progress')], false))
      .toStrictEqual({ state: 'deferred', reason: 'left_open' })
    expect(branch([todo('a', 'completed'), todo('b', 'completed')], false)).toStrictEqual({ state: 'delivered' })
  })

  it('attaches the turns the application tracked to each todo that has them', () => {
    const tree = workTree(inputs({
      ownTodos: [todo('a', 'completed'), todo('b', 'pending')],
      turns: content => content === 'a' ? { firstTurn: 2, statusTurn: 5 } : undefined,
    }))
    expect(nodeAt(tree, 'own/todo:a').turns).toStrictEqual({ firstTurn: 2, statusTurn: 5 })
    expect('turns' in nodeAt(tree, 'own/todo:b')).toBe(false)
  })

  it('counts its todos after the tasks and leaves the branch itself uncounted', () => {
    const tree = workTree(inputs({
      members: [lead],
      ownTurnOpen: true,
      tasks: [task({ id: '1', status: 'completed' }), task({ id: '2', status: 'pending' })],
      ownTodos: [todo('a', 'completed'), todo('b', 'in_progress')],
    }))
    expect(tree.nodes.map(node => node.key)).toEqual(['task:1', 'task:2', 'own'])
    expect(tree.counts).toStrictEqual(counts({ delivered: 2, in_progress: 1, pending: 1 }))
    expect(tree.total).toBe(4)
  })
})

describe('workTree scenarios', () => {
  it('opened from a teammate view, reads the teammate task from its own turn and lists its todos once, in the own branch', () => {
    const reviewerTodos = [todo('read the diff', 'in_progress')]
    const view = (ownTurnOpen: boolean): WorkTree => workTree(inputs({
      members: [lead, parser, reviewer],
      boundId: parser.id,
      boundName: 'parser',
      ownTurnOpen,
      tasks: [
        task({ id: '1', status: 'in_progress', ownerName: 'parser' }),
        task({ id: '2', status: 'in_progress', ownerName: 'reviewer' }),
      ],
      revisions: [],
      ownTodos: parserTodos,
      memberTodos: id => id === parser.id ? parserTodos : id === reviewer.id ? reviewerTodos : undefined,
    }))
    const open = view(true)
    expect(verdictAt(open, 'task:1')).toStrictEqual({ state: 'in_progress' })
    expect(nodeAt(open, 'task:1').children).toEqual([])
    expect(nodeAt(open, 'task:2').children.map(child => child.key)).toEqual(['task:2/todo:read the diff'])
    const own = nodeAt(open, 'own')
    expect(own.title).toBe('parser')
    expect(own.owner).toStrictEqual({ id: parser.id, name: 'parser', role: 'writes the parser', status: 'running' })
    for (const item of parserTodos) {
      expect(everyNode(open).filter(node => node.kind === 'todo' && node.title === item.content).map(node => node.key))
        .toEqual([`own/todo:${item.content}`])
    }
    const closed = view(false)
    expect(verdictAt(closed, 'task:1')).toStrictEqual({ state: 'stuck', reason: 'owner_idle' })
    expect(nodeAt(closed, 'task:1').children).toEqual([])
  })

  it('resumed with cold teammates, reads their in-progress tasks as stuck idle with no todos beneath', () => {
    const cold = (row: TeamMemberRow): TeamMemberRow => ({ ...row, status: 'inactive' })
    const tree = workTree(inputs({
      members: [cold(lead), cold(parser), cold(reviewer)],
      ownTurnOpen: false,
      tasks: [
        task({ id: '1', status: 'in_progress', ownerName: 'parser' }),
        task({ id: '2', status: 'in_progress', ownerName: 'reviewer' }),
        task({ id: '3', status: 'pending' }),
        task({ id: '4', status: 'completed', ownerName: 'parser' }),
      ],
      revisions: [revision('1', 'in_progress', parser.id), revision('2', 'in_progress', reviewer.id)],
      memberTodos: () => undefined,
    }))
    expect(tree.nodes.map(node => ({ key: node.key, state: node.state, reason: node.reason, children: node.children }))).toStrictEqual([
      { key: 'task:1', state: 'stuck', reason: 'owner_idle', children: [] },
      { key: 'task:2', state: 'stuck', reason: 'owner_idle', children: [] },
      { key: 'task:3', state: 'deferred', reason: 'left_open', children: [] },
      { key: 'task:4', state: 'delivered', reason: undefined, children: [] },
    ])
    expect(tree.counts).toStrictEqual(counts({ delivered: 1, stuck: 2, deferred: 1 }))
  })

  it('builds a 60-task board with chained blockers and a 40-item todo list without mutating its inputs', () => {
    const tasks = Array.from({ length: 60 }, (_, index): TeamTaskRow => {
      const status: TeamTaskRow['status'] = index < 10 ? 'completed' : index === 10 ? 'in_progress' : 'pending'
      return task({
        id: String(index + 1),
        status,
        ownerName: 'parser',
        blockedBy: index === 0 ? [] : [String(index)],
        writeScopes: [`src/step-${String(index + 1)}.ts`],
      })
    })
    const ownTodos = Array.from({ length: 40 }, (_, index): TodoItem => {
      const status: TodoItem['status'] = index < 15 ? 'completed' : index === 15 ? 'in_progress' : 'pending'
      return todo(`item ${String(index + 1)}`, status)
    })
    const members = [lead, parser]
    const revisions = [revision('11', 'in_progress', parser.id)]
    const before = structuredClone({ tasks, ownTodos, members, revisions, parserTodos })
    deepFreeze({ tasks, ownTodos, members, revisions, parserTodos })
    const tree = workTree(inputs({ members, tasks, ownTodos, revisions, ownTurnOpen: true, memberTodos: () => parserTodos }))
    expect(structuredClone({ tasks, ownTodos, members, revisions, parserTodos })).toStrictEqual(before)
    expect(tree.nodes.map(node => node.key)).toEqual([...tasks.map(row => `task:${row.id}`), 'own'])
    expect(tree.counts).toStrictEqual(counts({ delivered: 25, in_progress: 2, stuck: 49, pending: 24 }))
    expect(tree.total).toBe(100)
    expect(tree.nodes.slice(0, 60).map(node => node.blocks)).toEqual(tasks.map((_, index) => index === 59 ? [] : [String(index + 2)]))
    expect(nodeAt(tree, 'task:12').waitsOn).toEqual(['11'])
    expect(nodeAt(tree, 'task:60').waitsOn).toEqual(['59'])
    expect(nodeAt(tree, 'task:11').children).toHaveLength(3)
    expect(nodeAt(tree, 'own').children).toHaveLength(40)
    expect(nodeAt(tree, 'own').state).toBe('in_progress')
    expect(tree.nodes[0]?.writeScopes).not.toBe(tasks[0]?.writeScopes)
  })
})

describe('taskRevisions', () => {
  const record = (task: unknown): TeamLogEvent => ({ type: 'team/task', data: { version: 2, teamId: 'team-1', task } })

  it('reads each well-formed team/task record oldest first, keeping the owner id only when it is a non-empty string', () => {
    expect(taskRevisions([
      record({ id: '1', revision: 1, subject: 's', description: 'd', status: 'pending', blockedBy: [], writeScopes: [] }),
      record({ id: '1', revision: 2, subject: 's', description: 'd', status: 'in_progress', ownerId: parser.id, ownerName: 'parser', blockedBy: [] }),
      record({ id: '2', status: 'completed', ownerId: 7 }),
      record({ id: '2', status: 'deleted', ownerId: '' }),
    ])).toStrictEqual([
      { id: '1', status: 'pending' },
      { id: '1', status: 'in_progress', ownerId: parser.id },
      { id: '2', status: 'completed' },
      { id: '2', status: 'deleted' },
    ])
  })

  it('skips a record whose id is missing, empty, or not a string', () => {
    expect(taskRevisions([
      record({ status: 'pending' }),
      record({ id: '', status: 'pending' }),
      record({ id: 3, status: 'pending' }),
      record({ id: '4', status: 'pending' }),
    ])).toStrictEqual([{ id: '4', status: 'pending' }])
  })

  it('skips a record whose status is missing or unknown', () => {
    expect(taskRevisions([record({ id: '1' }), record({ id: '1', status: 'archived' }), record({ id: '1', status: 1 })])).toEqual([])
  })

  it('skips data or a task that is not an object, and events of other types', () => {
    expect(taskRevisions([
      { type: 'team/task', data: null },
      { type: 'team/task', data: 'text' },
      { type: 'team/task', data: [{ task: { id: '1', status: 'pending' } }] },
      { type: 'team/task', data: { version: 2 } },
      record('1'),
      record([{ id: '1', status: 'pending' }]),
      { type: 'team/member', data: { task: { id: '1', status: 'pending' } } },
      { type: 'tool/call', data: { name: 'task_update' } },
    ])).toEqual([])
  })

  it('supplies the revisions the release rule reads', () => {
    const revisions = taskRevisions([
      record({ id: '1', status: 'pending' }),
      record({ id: '1', status: 'in_progress', ownerId: parser.id }),
      record({ id: '1', status: 'pending' }),
    ])
    const tree = workTree(inputs({ ownTurnOpen: true, tasks: [task({ id: '1', status: 'pending' })], revisions }))
    expect(verdictAt(tree, 'task:1')).toStrictEqual({ state: 'deferred', reason: 'released' })
  })
})
