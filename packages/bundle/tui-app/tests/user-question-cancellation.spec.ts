/** Terminal cancellation through the composed question service. */
import { expect, it } from 'vitest'
import UserQuestionService, { UserQuestionError, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { bench, KEY } from './bench.ts'

const ordinary: AskUserQuestionItem = { id: 'ordinary', question: 'Choose?', options: [{ label: 'Yes' }] }
const approval: AskUserQuestionItem = {
  id: 'app-access', question: 'Allow application access?', detail: 'Read and control this application.',
  options: [{ label: 'Allow' }, { label: 'Deny' }],
  intent: { kind: 'approval', approve: 'Allow', reject: 'Deny' },
}

it('distinguishes dismissal from withdrawal through the real question service', async () => {
  const test = await bench({ before: async (ctx) => { await ctx.plugin(UserQuestionService) } })
  const decisions: string[] = []
  const ask = async (question: AskUserQuestionItem, signal?: AbortSignal): Promise<string> => {
    try {
      const answer = await test.ctx.userQuestions.ask({
        agent: test.agent,
        questions: [question],
        ...signal === undefined ? {} : { signal },
      })
      return `answer:${answer.answers[0]?.selected.join(',')}`
    } catch (error) {
      if (error instanceof UserQuestionError && error.code === 'ASK_CANCELLED') {
        if (question.intent?.kind === 'approval') decisions.push('deny')
        return error.code
      }
      if (error instanceof UserQuestionError) return error.code
      throw error
    }
  }
  try {
    const dismissed = ask(ordinary)
    await test.settle()
    expect(await test.screen()).toContain('Choose?')
    test.terminal.type(KEY.escape)
    await expect(dismissed).resolves.toBe('ASK_CANCELLED')
    expect(decisions).toEqual([])

    const denied = ask(approval)
    await test.settle()
    expect(await test.screen()).toContain('Allow application access?')
    test.terminal.type(KEY.escape)
    await expect(denied).resolves.toBe('ASK_CANCELLED')
    expect(decisions).toEqual(['deny'])

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(ask(approval, alreadyAborted.signal)).resolves.toBe('ASK_ABORTED')
    expect(decisions).toEqual(['deny'])

    const controller = new AbortController()
    const aborted = ask(approval, controller.signal)
    await test.settle()
    controller.abort()
    await expect(aborted).resolves.toBe('ASK_ABORTED')
    expect(decisions).toEqual(['deny'])

    const first = ask(ordinary)
    await test.settle()
    const waiting = new AbortController()
    const queued = ask(approval, waiting.signal)
    waiting.abort()
    test.terminal.type(KEY.enter)
    await expect(first).resolves.toBe('answer:Yes')
    await expect(queued).resolves.toBe('ASK_ABORTED')
    expect(decisions).toEqual(['deny'])

    const withdrawn = ask(approval)
    await test.settle()
    test.terminal.type(KEY.ctrlC)
    await expect(withdrawn).resolves.toBe('ASK_ABORTED')
    expect(decisions).toEqual(['deny'])
  } finally {
    test.app.stop()
    await test.ctx.fiber.dispose()
  }
})
