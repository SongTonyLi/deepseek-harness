/** Standard subagent catalog and shared task-board fixtures for the terminal. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { TeamTaskRow } from '../src/team-panel.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Mount a task board with mutable Team mode and ordinary child discovery.
 * @param ctx - bench context before the root Agent starts.
 * @param entries - current catalog rows.
 * @param tasks - current shared tasks.
 * @returns the mutable Team selection.
 */
export function provideTeam(
  ctx: Context,
  entries: () => readonly SubagentDescendantListEntry[] = () => [],
  tasks: () => readonly TeamTaskRow[] = () => [],
): { enabled: boolean } {
  const mode = { enabled: true }
  ctx.provide('agentTeams', {
    isEnabled: () => mode.enabled,
    setEnabled: (_agent: Agent, enabled: boolean) => { mode.enabled = enabled; return Promise.resolve() },
    listTasks: tasks,
  } as never)
  const runtime = {
    rootOf: () => ctx.agents.get(SessionId('session-tui-test'))!,
    listDescendants: () => Promise.resolve(entries()),
  }
  if (ctx.get('subagents') === undefined) ctx.provide('subagents', runtime as never)
  else Object.assign(ctx.subagents, runtime)
  return mode
}

/**
 * One ordinary child discovered by the subagent runtime.
 * @param id - child identity.
 * @param label - durable child label.
 * @param mode - delegation mode.
 * @returns a direct catalog entry.
 */
export function listed(id: string, label: string, mode: 'continuable' | 'one-shot' = 'continuable'): SubagentDescendantListEntry {
  return { kind: 'child', id: SessionId(id), label, mode, activity: 'running', hasChildren: false, parentId: SessionId('session-tui-test'), depth: 1 }
}
