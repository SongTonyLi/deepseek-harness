/**
 * Fixtures shared by the narration specs: the terminal configuration the plugin
 * entry is mounted with, the narration's runtime-context name and sentence, and
 * the in-process child and `/btw` side agent the terminal creates.
 * @module @deepseek-ai/dsh-tui-app/tests/narration-fixtures
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionLogOffset, type SessionId } from '@deepseek-ai/dsh-session'
import { applyChildComposition, childSessionMeta } from '@deepseek-ai/dsh-subagent'
import { BTW_SANDBOXED_TOOLS, BTW_TOOLS, restrictBtwAgent } from '../src/btw.ts'
import type { Config } from '../src/index.ts'

/** Runtime-context name of the narration entry. */
export const NARRATION_CONTEXT = 'tui:subagent-narration'

/** The model-facing sentence the entry carries, verbatim. */
export const NARRATION_SENTENCE = 'Before each tool call, say in one short sentence what you are doing and why it serves the task, so your progress can be followed.'

/**
 * The validated terminal configuration, with each field at the value the
 * runner's own spec bench uses.
 * @returns the config the plugin entry is mounted with.
 */
export function terminalConfig(): Config {
  return {
    toolPreviewLines: 8,
    contextPreviewLines: 4,
    focusPreviewLines: 12,
    readerMinColumns: 60,
    codeHighlight: true,
    toastMs: 2000,
    quitGraceMs: 10_000,
    liveRefreshMs: 1000,
    streamFadeSteps: 12,
    streamFadeStepMs: 16,
    streamPaceFrames: 8,
    toolRevealFrames: 6,
    spinnerMs: 100,
    reducedMotion: false,
    mouse: false,
    openBrowser: true,
    btwTools: [...BTW_TOOLS],
    btwSandboxedTools: [...BTW_SANDBOXED_TOOLS],
  }
}

/**
 * Create an in-process child with the header and composition the subagent
 * spawn path writes: `childSessionMeta` records the delegation depth, and
 * `applyChildComposition` registers the delegation statement.
 * @param ctx - context that owns the parent and the child.
 * @param parent - the delegating parent agent.
 * @param id - the child's session id.
 * @returns the published child agent.
 */
export async function spawnChild(ctx: Context, parent: Agent, id: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: brandString<SessionId>(id),
    meta: childSessionMeta(parent, 1, false),
    agentOptions: { subagentDepth: 1 },
    setup: childCtx => applyChildComposition(childCtx, parent, {}),
  })
  return handle.agent
}

/**
 * Create a `/btw` side agent with the metadata and read-only restriction the
 * terminal gives it: `origin: 'subagent'` without a delegation depth.
 * @param ctx - context that owns the side agent.
 * @param parent - the working agent whose session the side agent observes.
 * @returns the published side agent.
 */
export async function spawnSide(ctx: Context, parent: Agent): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: brandString<SessionId>('side'),
    meta: { cwd: process.cwd(), parentSession: parent.id, isSeeded: true, origin: 'subagent' },
    seed: [],
    inheritedEventCount: SessionLogOffset(0),
    setup: (agentCtx, agent) => {
      restrictBtwAgent(agentCtx, agent, { btwTools: BTW_TOOLS, btwSandboxedTools: BTW_SANDBOXED_TOOLS })
    },
  })
  return handle.agent
}
