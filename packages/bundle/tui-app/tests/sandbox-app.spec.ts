/** The backend picker and typed commands share the real provider's durable switch path. */

import { describe, expect, it } from 'vitest'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AppleContainerSandboxProvider from '@deepseek-ai/dsh-sandbox-apple-container'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { KEY, bench } from './bench.ts'

function typeLine(terminal: { type(data: string): void }, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

describe('/sandbox in the terminal', () => {
  it('cancels without logging, confirms through the shared command, and delegates typed arguments', async () => {
    const test = await bench({
      before: async (ctx) => {
        await ctx.plugin(CommandRuntime)
        await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write' })
        await ctx.plugin(AppleContainerSandboxProvider, {
          backend: 'local',
          executable: './missing-test-container',
        })
      },
    })
    try {
      typeLine(test.terminal, '/sandbox')
      await test.settle()
      const picker = await test.screen()
      expect(picker).toContain('Sandbox backend')
      expect(picker).toContain('Container unavailable:')
      expect(picker).toContain('Access preview · Local')
      expect(picker).toContain('file policy: workspace-write')
      expect(picker).toContain('Commands → host → native file sandbox')
      expect(picker).toContain('Workspace: /work')
      expect(test.session.ownEvents().filter(event => event.type === 'command/run' || event.type === 'sandbox/backend')).toEqual([])

      test.terminal.type(KEY.escape)
      await test.settle()
      expect(await test.screen()).not.toContain('Sandbox backend')
      expect(test.session.ownEvents().filter(event => event.type === 'command/run' || event.type === 'sandbox/backend')).toEqual([])

      typeLine(test.terminal, '/sandbox')
      await test.settle()
      test.terminal.type(KEY.enter)
      await test.settle()
      expect(test.session.ownEvents().filter(event => event.type === 'sandbox/backend').map(event => event.data)).toEqual([{ backend: 'local' }])
      expect(test.session.ownEvents().filter(event => event.type === 'command/run').map(event => [event.data.name, event.data.args])).toEqual([['sandbox', ' local']])
      expect(await test.screen()).toContain('backend local')

      typeLine(test.terminal, '/sandbox local')
      await test.settle()
      expect(test.session.ownEvents().filter(event => event.type === 'sandbox/backend')).toHaveLength(2)
      expect(await test.screen()).not.toContain('Sandbox backend')

      typeLine(test.terminal, '/sandbox container')
      await test.settle()
      expect(await test.screen()).toContain('Apple container is unavailable on this host:')
      expect(test.session.ownEvents().filter(event => event.type === 'sandbox/backend')).toHaveLength(2)
      expect(test.session.ownEvents().filter(event => event.type === 'command/run').map(event => event.data.args)).toEqual([' local', ' local', ' container'])
      expect(test.session.ownEvents().filter(event => event.type === 'sandbox/mode' || event.type === 'approval/policy')).toEqual([])
      expect(test.calls.followups).toEqual([])
    } finally {
      test.app.stop()
      await test.ctx.fiber.dispose()
    }
  })
})
