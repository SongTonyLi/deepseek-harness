/** Actual model schemas from the shipped TUI profile, with only the remote model replaced. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { messagesResponse } from '../../sdk/fixtures/messages-response.ts'
import { runTuiScript } from './run-tui-script.ts'

const PTC_OVERLAY = fileURLToPath(new URL('../../../../config/examples/ptc.yml', import.meta.url))
const REPLY = 'TUI executor selection complete.'

const SCENARIOS = [
  { label: 'inherits native execution without an environment selector', mode: undefined, ptc: false },
  { label: 'ignores the retired PTC environment selector', mode: 'ptc', ptc: false },
  { label: 'uses the PTC overlay despite the retired native environment selector', mode: 'native', ptc: true },
] as const

describe('tui profile tool executors', () => {
  it.each(SCENARIOS)('$label', async ({ mode, ptc }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-executors-'))
    try {
      const requests: Record<string, unknown>[] = []
      const server = createServer((request, response) => {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => { body += chunk })
        request.on('end', () => {
          requests.push(JSON.parse(body) as Record<string, unknown>)
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(messagesResponse({ type: 'text', text: REPLY }, 'end_turn'))
        })
      })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', () => {
            server.off('error', reject)
            resolve()
          })
        })
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('model server did not bind a TCP port')
        const patch = join(cwd, 'model.patch.yml')
        await writeFile(patch, [
          '- id: agent-default-model',
          '  config: { provider: deepseek-official, model: deepseek-v4-pro }',
          '- id: session-title-llm',
          '  disabled: true',
          '- id: agent-instructions',
          '  disabled: true',
          '- id: shell-env',
          "  config: { dshHome: './.dsh-home' }",
          '- id: skill-filesystem',
          "  config: { dshHome: './.dsh-home', agentsHome: './.agents-home' }",
          '- id: session-persistence-jsonl',
          "  config: { root: './.sessions' }",
          '',
        ].join('\n'))

        const run = await runTuiScript(
          cwd,
          [...(ptc ? ['--patch', PTC_OVERLAY] : []), 'inspect tools'],
          [{ marker: REPLY, keys: '' }],
          patch,
          {
            DSH_TOOLS_MODE: mode,
            DEEPSEEK_API_KEY: 'keyless-tui-executor-test',
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
        )
        expect(run.exitCode, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`).toBe(0)
        expect(run.stdout).toContain(REPLY)
        expect(requests).toHaveLength(1)
        expect(requests[0]?.tools).toEqual(expect.any(Array))
        const tools = requests[0]?.tools as { name: string }[]
        const names = tools.map(tool => tool.name)
        if (ptc) {
          expect(names).toEqual(['run_code'])
          expect(JSON.stringify(requests[0])).toContain('read:')
        } else {
          expect(names).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'subagent', 'subagent_fork']))
          expect(names).not.toContain('run_code')
        }
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => { resolve() })
          server.closeAllConnections()
        })
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
