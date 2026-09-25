/** Side-question route, history, request options, and visible text. */

import { describe, expect, it } from 'vitest'
import {
  ReasoningEffortId,
  ToolCallId,
  createAssistantMessage,
  createDeveloperMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm'
import { BTW_POLICY, asideHistory, asideRoute, asideVisibleText, buildAsideOptions } from '../src/btw.ts'

const header = { provider: 'header-provider', model: 'header-model', reasoningEffort: ReasoningEffortId('high') }
const fallback = { provider: 'fallback-provider', model: 'fallback-model', reasoningEffort: ReasoningEffortId('low') }

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistant(content: ContentBlock[]) {
  return createAssistantMessage({ content, source: { provider: 'p', model: 'm' } })
}

function call(id: string): ContentBlock {
  return { type: 'tool-call', id: ToolCallId(id), name: 'read', arguments: '{}' }
}

function result(id: string) {
  return createToolResultMessage({
    callId: ToolCallId(id),
    content: [{ type: 'text', text: id }],
    isError: false,
  })
}

describe('side question route', () => {
  it('prefers the header and copies its reasoning effort', () => {
    expect(asideRoute(header, fallback)).toEqual({
      provider: 'header-provider',
      model: 'header-model',
      reasoningEffort: 'high',
    })
  })

  it('uses the fallback when the header is missing', () => {
    expect(asideRoute(undefined, fallback)).toEqual({
      provider: 'fallback-provider',
      model: 'fallback-model',
      reasoningEffort: 'low',
    })
  })

  it('omits reasoning effort when the chosen route has none', () => {
    expect(asideRoute({ provider: 'header-provider', model: 'header-model' }, fallback))
      .toEqual({ provider: 'header-provider', model: 'header-model' })
    expect(asideRoute(undefined, { provider: 'fallback-provider', model: 'fallback-model' }))
      .toEqual({ provider: 'fallback-provider', model: 'fallback-model' })
  })

  it('throws when no model is selected', () => {
    expect(() => asideRoute(undefined, undefined)).toThrow('btw: no model is selected')
    expect(() => asideRoute({ provider: '', model: 'header-model' }, fallback)).toThrow('btw: no model is selected')
    expect(() => asideRoute({ provider: 'header-provider', model: '' }, fallback)).toThrow('btw: no model is selected')
    expect(() => asideRoute(undefined, { provider: '', model: 'fallback-model' })).toThrow('btw: no model is selected')
    expect(() => asideRoute(undefined, { provider: 'fallback-provider', model: '' })).toThrow('btw: no model is selected')
  })
})

describe('side question history', () => {
  it('drops unresolved tool calls on the last assistant message and leaves the rest', () => {
    const earlier = assistant([call('old-open')])
    const prompt = user('go')
    const tail = assistant([{ type: 'text', text: 'working' }, call('done'), call('open')])
    const done = result('done')
    const history = [earlier, prompt, tail, done]
    const copy = asideHistory(history)

    expect(copy).toHaveLength(4)
    expect(copy[0]).toBe(earlier)
    expect(copy[1]).toBe(prompt)
    expect(copy[3]).toBe(done)
    expect(copy[2]).not.toBe(tail)
    expect(copy[2]?.content).toEqual([{ type: 'text', text: 'working' }, call('done')])
    expect(tail.content).toEqual([{ type: 'text', text: 'working' }, call('done'), call('open')])
    expect(history).toEqual([earlier, prompt, tail, done])
  })

  it('omits a last assistant message that is only unresolved tool calls', () => {
    const prompt = user('go')
    const tail = assistant([call('open')])
    const history = [prompt, tail]
    expect(asideHistory(history)).toEqual([prompt])
    expect(history[1]).toBe(tail)
    expect(tail.content).toEqual([call('open')])
  })

  it('returns a new array and keeps resolved history as the same messages', () => {
    const prompt = user('go')
    const tail = assistant([{ type: 'text', text: 'done' }, call('done')])
    const done = result('done')
    const history = [prompt, tail, done]
    const copy = asideHistory(history)
    expect(copy).not.toBe(history)
    expect(copy).toEqual(history)
    expect(copy[1]).toBe(tail)
    expect(asideHistory([prompt])).toEqual([prompt])
  })

  it('keeps system and developer messages that are not the trailing assistant', () => {
    const rule = createSystemMessage('rule')
    const note = createDeveloperMessage({
      content: [{ type: 'text', text: 'note' }],
      source: { kind: 'user' },
    })
    const prompt = user('go')
    const history = [rule, note, prompt]
    const copy = asideHistory(history)
    expect(copy).not.toBe(history)
    expect(copy).toEqual([rule, note, prompt])
    expect(copy[0]).toBe(rule)
    expect(copy[1]).toBe(note)
  })
})

describe('side question options', () => {
  const route = { provider: 'header-provider', model: 'header-model', reasoningEffort: ReasoningEffortId('max') }
  const signal = new AbortController().signal

  it('sends the policy, stripped history, a trimmed partial, and the question', () => {
    const prompt = user('go')
    const tail = assistant([call('open')])
    const options = buildAsideOptions({
      route,
      history: [prompt, tail],
      partial: '  still going  ',
      question: 'what is left?',
      signal,
    })
    const partial = options.messages[1]
    expect(options.provider).toBe('header-provider')
    expect(options.model).toBe('header-model')
    expect(options.reasoningEffort).toBe('max')
    expect(options.system).toBe(BTW_POLICY)
    expect(options.temperature).toBe(0)
    expect(options.signal).toBe(signal)
    expect(options.messages[0]).toBe(prompt)
    expect(partial).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'still going' }],
      source: { kind: 'model', provider: 'header-provider', model: 'header-model' },
    })
    expect(partial && 'source' in partial && partial.source).not.toHaveProperty('replayState')
    expect(options.messages[2]).toEqual({ role: 'user', content: [{ type: 'text', text: 'what is left?' }] })
    expect(options.messages[2]).not.toHaveProperty('id')
    expect(options.messages[2]).not.toHaveProperty('source')
    expect(options).not.toHaveProperty('tools')
    expect(options).not.toHaveProperty('toolHistory')
    expect(options).not.toHaveProperty('sessionId')
    expect(options).not.toHaveProperty('purpose')
    expect(options).not.toHaveProperty('maxTokens')
    expect(tail.content).toEqual([call('open')])
  })

  it('leaves out a blank partial and an absent reasoning effort', () => {
    const prompt = user('go')
    const options = buildAsideOptions({
      route: { provider: 'fallback-provider', model: 'fallback-model' },
      history: [prompt],
      partial: '   ',
      question: 'why?',
      signal,
    })
    expect(options.messages).toEqual([
      prompt,
      { role: 'user', content: [{ type: 'text', text: 'why?' }] },
    ])
    expect(options).not.toHaveProperty('reasoningEffort')
  })
})

describe('side question text', () => {
  it('joins non-empty text blocks and ignores everything else', () => {
    expect(asideVisibleText([
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: 'first' },
      { type: 'text', text: '' },
      { type: 'tool-call', id: ToolCallId('call'), name: 'read', arguments: '{}' },
      { type: 'text', text: 'second' },
    ])).toBe('first\n\nsecond')
    expect(asideVisibleText([{ type: 'reasoning', text: 'only' }])).toBe('')
  })
})
