/** Patch result summaries and applied diffs in live and replayed terminal cards. */
import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { presentPatchCall, presentPatchResult } from '../../../fs/tool-fs/src/apply-patch-presentation.ts'
import { bench } from './bench.ts'

const before: NonNullable<Parameters<typeof bench>[0]>['before'] = async (ctx) => {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register({
    name: 'apply_patch', description: 'patch',
    parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: () => Promise.resolve('unused'),
    presentCall: args => presentPatchCall((args as { input: string }).input),
    presentResult: (_args, result) => presentPatchResult(result),
  })
}

const input = '*** Begin Patch\n*** Add File: new.txt\n+new\n*** End Patch'
const cases = [
  { name: 'stopped', text: 'Patch stopped after 1 of 3 operations.\nCompleted:\nM done.txt\nFailed:\n- denied\nOutcome unknown:\n- unknown\nNot executed:\n- skipped', meta: { stopped: true, diffs: [{ path: 'done.txt', oldText: 'old', newText: 'new' }] }, expected: ['Patch stopped', 'denied', 'unknown', 'skipped', 'done.txt', 'old', 'new'] },
  { name: 'add', text: 'Success. Updated the following files:\nA new.txt', meta: { stopped: false, diffs: [] }, expected: ['Success. Updated', 'A new.txt'] },
  { name: 'move', text: 'Success. Updated the following files:\nM moved.txt', meta: { stopped: false, diffs: [] }, expected: ['Success. Updated', 'M moved.txt'] },
  { name: 'update', text: 'Success. Updated the following files:\nM file.txt', meta: { stopped: false, diffs: [{ path: 'file.txt', oldText: 'old', newText: 'new' }] }, expected: ['M file.txt', 'old', 'new'] },
  { name: 'error', text: 'Patch rejected before any change: denied', meta: undefined, error: true, expected: ['Patch rejected', 'denied'] },
]

describe('patch result cards', () => {
  it.each(cases)('shows $name results live and after replay', async (scenario) => {
    const { text, meta, expected } = scenario
    const failed = scenario.name === 'stopped' || scenario.name === 'error'
    const glyph = `\u001b[38;5;${failed ? '210' : '149'}m◆\u001b[39m`
    const live = await bench({ before, toolPreviewLines: 50, color: true, reducedMotion: true })
    live.appendToolCall('patch', 'apply_patch', { input })
    live.appendToolResult('patch', [{ type: 'text', text }], scenario.name === 'error', meta)
    const history = live.session.ownEvents()
    try {
      const liveScreen = await live.screen()
      for (const fragment of expected) expect(liveScreen).toContain(fragment)
      expect(live.terminal.output).toContain(glyph)
    } finally {
      live.app.stop()
      await live.ctx.fiber.dispose()
    }

    const replay = await bench({ before, history, toolPreviewLines: 50, color: true, reducedMotion: true })
    try {
      const screen = await replay.screen()
      for (const fragment of expected) expect(screen).toContain(fragment)
      expect(replay.terminal.output).toContain(glyph)
    } finally {
      replay.app.stop()
      await replay.ctx.fiber.dispose()
    }
  })
})
