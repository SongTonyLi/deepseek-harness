/** Durable developer and continuation events in the assembled terminal. */
import { expect, it } from 'vitest'
import { createDeveloperMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { bench, KEY } from './bench.ts'

it('renders developer changes and empty continuation live and from history', async () => {
  const live = await bench({ contextPreviewLines: 20 })
  live.terminal.type(KEY.ctrlO)
  live.session.append('turn/start', { turn: 1 })
  live.session.append('step/start', { turn: 1, step: 1 })
  const headerSeq = live.session.append('request/header', {
    reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [
      { name: 'search', description: 'secret schema description', parameters: { type: 'object' } },
    ] },
  }).seq
  live.session.append('developer/message', {
    turn: 1, step: 1, headerSeq,
    message: createDeveloperMessage({ source: { kind: 'test' }, content: [
      { type: 'text', text: 'Developer guidance' },
      { type: 'tool-addition', toolName: 'search' },
      { type: 'tool-removal', toolName: 'old_tool' },
    ] }),
  }, { surfaceOp: 'append' })
  live.session.append('user/message', createUserMessage({ source: { kind: 'retry' } as never, content: [] }), { surfaceOp: 'append' })
  live.session.append('user/message', createUserMessage({ source: { kind: 'retry' } as never, content: [{ type: 'text', text: 'retry with text' }] }), { surfaceOp: 'append' })
  live.session.append('user/message', createUserMessage({ source: { kind: 'future-source' } as never, content: [{ type: 'text', text: 'future body' }] }), { surfaceOp: 'append' })
  const history = live.session.ownEvents()
  const verify = (screen: string): void => {
    for (const text of ['developer message', 'Developer guidance', 'Tool added: search', 'Tool removed: old_tool',
      'continuing failed turn', 'retry with text', 'future body']) expect(screen).toContain(text)
    expect(screen).not.toContain('secret schema description')
    expect(screen.split('continuing failed turn')).toHaveLength(2)
  }
  try {
    verify(await live.screen())
  } finally {
    live.app.stop()
    await live.ctx.fiber.dispose()
  }
  const replay = await bench({ history, contextPreviewLines: 20 })
  try {
    replay.terminal.type(KEY.ctrlO)
    verify(await replay.screen())
  } finally {
    replay.app.stop()
    await replay.ctx.fiber.dispose()
  }
})
