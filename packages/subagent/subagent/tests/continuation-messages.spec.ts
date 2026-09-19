import { describe, expect, it } from 'vitest'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSettlementMessage, withContinuableReturnGuidance } from '../src/continuation-messages.ts'

const childId = SessionId('settled-child')
const summary = { type: 'text', text: `Background subagent ${childId} finished and will do no further work unless you send it more.` }
const reasoning: ContentBlock = { type: 'reasoning', text: 'private child reasoning' }
const toolCall: ContentBlock = { type: 'tool-call', id: ToolCallId('child-call'), name: 'read', arguments: '{}' }

describe('continuable return guidance', () => {
  it('appends the parent id and send_message instruction after the task prompt', () => {
    const parentId = SessionId('parent-session')
    const prompt: ContentBlock[] = [{ type: 'text', text: 'summarize the repo' }]
    const original = structuredClone(prompt)

    expect(withContinuableReturnGuidance(parentId, prompt)).toEqual([
      { type: 'text', text: 'summarize the repo' },
      {
        type: 'text',
        text: 'Your parent agent id is "parent-session". Before you finish, send your result to that agent with '
          + 'send_message({ agent_id: "parent-session", message: "<self-contained result>" }). The parent shares '
          + 'your workspace but does not automatically receive your transcript, tool output, or reasoning. Send '
          + 'earlier messages as well when a finding changes what the parent should do next; sending a message '
          + 'does not end your turn.',
      },
    ])
    expect(prompt).toEqual(original)
  })
})

describe('continuable settlement content', () => {
  it.each([
    ['reasoning before the answer', [reasoning, { type: 'text', text: 'answer' }]],
    ['a tool call after the answer', [{ type: 'text', text: 'answer' }, toolCall]],
  ] satisfies [string, ContentBlock[]][])('reports only the closing text with %s', (_label, output) => {
    const original = structuredClone(output)
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
    ])
    expect(output).toEqual(original)
  })

  it.each([
    ['absent output', undefined],
    ['empty output', []],
    ['reasoning-only output', [reasoning]],
    ['empty text', [{ type: 'text', text: '' }]],
  ] satisfies [string, ContentBlock[] | undefined][])('reports no closing message for %s', (_label, output) => {
    const message = createSettlementMessage(childId, { stopReason: 'completed', ...output === undefined ? {} : { output } })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('preserves text block order and bytes around omitted reasoning and tool calls', () => {
    const first: ContentBlock = { type: 'text', text: '  first\n' }
    const second: ContentBlock = { type: 'text', text: '\n第二段  ' }
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [reasoning, first, toolCall, second],
    })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      first,
      second,
    ])
  })
})

describe('continuable error settlement content', () => {
  it('names the failure reason on the opening line and tells the parent to continue', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'error',
      diagnostic: 'ENOSPC: no space left on device',
      output: [{ type: 'text', text: 'the answer' }],
    })

    expect(message.content).toEqual([
      { type: 'text', text: `Background subagent ${childId} failed before it finished: ENOSPC: no space left on device` },
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'the answer' },
      { type: 'text', text: 'Do the work directly or retry.' },
    ])
    expect(message.source).toMatchObject({
      kind: 'subagent-settled',
      form: 'notice',
      summary: `Background subagent ${childId} failed before it finished: ENOSPC: no space left on device`,
      senderSessionId: childId,
    })
  })

  it('keeps the empty-closing sentence when a failed child left no text', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'error',
      diagnostic: 'scope unwind failed',
    })

    expect(message.content).toEqual([
      { type: 'text', text: `Background subagent ${childId} failed before it finished: scope unwind failed` },
      { type: 'text', text: 'It left no closing message.' },
      { type: 'text', text: 'Do the work directly or retry.' },
    ])
  })

  it('keeps the reasonless error sentence when no diagnostic is recorded', () => {
    const message = createSettlementMessage(childId, { stopReason: 'error' })

    expect(message.content).toEqual([
      { type: 'text', text: `Background subagent ${childId} failed before it finished.` },
      { type: 'text', text: 'It left no closing message.' },
      { type: 'text', text: 'Do the work directly or retry.' },
    ])
  })

  it('bounds a failure reason to the diagnostic byte budget', () => {
    const oversized = '权限'.repeat(4_096)
    const message = createSettlementMessage(childId, {
      stopReason: 'error',
      diagnostic: oversized,
    })
    const opening = message.content[0]
    expect(opening).toEqual(expect.objectContaining({ type: 'text' }))
    const prefix = `Background subagent ${childId} failed before it finished: `
    expect(opening?.type === 'text' ? opening.text.startsWith(prefix) : false).toBe(true)
    const reason = opening?.type === 'text' ? opening.text.slice(prefix.length) : ''
    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(4_096)
    expect(reason.endsWith('[diagnostic truncated]')).toBe(true)
  })

  it('leaves aborted settlement wording unchanged', () => {
    const message = createSettlementMessage(childId, { stopReason: 'aborted' })

    expect(message.content).toEqual([
      { type: 'text', text: `Background subagent ${childId} was stopped before it finished.` },
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('does not attach a diagnostic to a completed notice', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      diagnostic: 'should not appear',
    })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'It left no closing message.' },
    ])
  })
})
