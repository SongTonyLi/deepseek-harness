/** Project logged system prompts and injected context into transcript sections. */

import { describe, expect, it } from 'vitest'
import { injectedContextView, systemPromptView } from '../src/context.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

describe('systemPromptView', () => {
  it('skips an empty rendering, which logs that no system prompt is in force', () => {
    expect(systemPromptView('', false)).toBeUndefined()
  })

  it('names the first nonempty prompt and every later replacement', () => {
    expect(systemPromptView('You are the agent.', false)).toEqual({
      title: 'system prompt',
      parts: [{ kind: 'system', rows: ['You are the agent.'] }],
    })
    expect(systemPromptView('Updated.\nKeep going.', true)).toEqual({
      title: 'system prompt update',
      parts: [{ kind: 'system', rows: ['Updated.', 'Keep going.'] }],
    })
  })
})

describe('injectedContextView', () => {
  it('skips the user\'s own prompt, a tool result, a model source, and a compaction replacement', () => {
    expect(injectedContextView({ kind: 'user' }, text('hi'))).toBeUndefined()
    expect(injectedContextView({ kind: 'tool', callId: 'c' }, text('out'))).toBeUndefined()
    expect(injectedContextView({ kind: 'model' }, text('x'))).toBeUndefined()
    expect(injectedContextView({ kind: 'plugin', plugin: 'compact' }, text('summary'))).toBeUndefined()
    expect(injectedContextView(null, text('x'))).toBeUndefined()
  })

  it('names instructions by form and producer, and keeps the model-facing text as one part', () => {
    expect(injectedContextView(
      { kind: 'plugin', plugin: 'agent-instructions', form: 'instructions' },
      text('# AGENTS.md'),
    )).toEqual({
      title: 'instructions · agent-instructions',
      parts: [{ kind: 'instructions', rows: ['# AGENTS.md'] }],
    })
  })

  it('uses instruction file paths and skill names when the source records them', () => {
    expect(injectedContextView(
      { kind: 'agent-instructions', form: 'instructions', changes: [{ path: 'AGENTS.md' }, { path: 'CLAUDE.md' }] },
      text('follow these'),
    )).toMatchObject({ title: 'instructions · AGENTS.md, CLAUDE.md' })
    expect(injectedContextView(
      { kind: 'skill-invocation', name: 'demo-skill', form: 'instructions' },
      text('skill body'),
    )).toMatchObject({ title: 'instructions · demo-skill' })
  })

  it('uses a notice summary as the title and still carries the full body', () => {
    expect(injectedContextView(
      { kind: 'plugin', plugin: 'skill', form: 'notice', summary: 'skill loaded' },
      text('full notice body'),
    )).toEqual({
      title: 'notice · skill loaded',
      parts: [{ kind: 'notice', rows: ['full notice body'] }],
    })
  })

  it('splits a snapshot into one part per named contribution', () => {
    expect(injectedContextView(
      {
        kind: 'plugin',
        plugin: 'workspace',
        form: 'snapshot',
        sections: [{ name: 'sandbox', text: 'allow python' }, { name: 'git', text: 'clean\ntree' }],
      },
      text('assembled'),
    )).toEqual({
      title: 'snapshot · workspace',
      parts: [
        { kind: 'snapshot', label: 'sandbox', rows: ['allow python'] },
        { kind: 'snapshot', label: 'git', rows: ['clean', 'tree'] },
      ],
    })
  })

  it('falls back to the assembled text when snapshot sections are missing or unreadable', () => {
    expect(injectedContextView(
      { kind: 'plugin', plugin: 'workspace', form: 'snapshot', sections: 'nope' },
      text('assembled'),
    )).toMatchObject({ parts: [{ kind: 'snapshot', rows: ['assembled'] }] })
    expect(injectedContextView(
      { kind: 'plugin', plugin: 'workspace', form: 'snapshot', sections: [] },
      text('assembled'),
    )).toMatchObject({ parts: [{ kind: 'snapshot', rows: ['assembled'] }] })
    expect(injectedContextView(
      { kind: 'plugin', plugin: 'workspace', form: 'snapshot', sections: [null, { name: 'ok', text: 'yes' }] },
      text('assembled'),
    )).toMatchObject({ parts: [{ kind: 'snapshot', rows: ['assembled'] }] })
    expect(injectedContextView(
      { kind: 'plugin', plugin: 'workspace', form: 'snapshot', sections: [{ text: 'anon' }] },
      text('assembled'),
    )).toMatchObject({ parts: [{ kind: 'snapshot', rows: ['assembled'] }] })
    expect(injectedContextView(
      { kind: 'plugin', plugin: 'workspace', form: 'snapshot', sections: [{ name: 'bare' }] },
      text('assembled'),
    )).toMatchObject({ parts: [{ kind: 'snapshot', rows: ['assembled'] }] })
  })

  it('names catalogs, relays, recalls, and an undeclared form by producer', () => {
    expect(injectedContextView({ kind: 'plugin', plugin: 'skills', form: 'catalog' }, text('list')))
      .toMatchObject({ title: 'catalog · skills' })
    expect(injectedContextView({ kind: 'plugin', plugin: 'subagent', form: 'relay' }, text('hi')))
      .toMatchObject({ title: 'relay · subagent' })
    expect(injectedContextView(
      { kind: 'session-reference', form: 'recall', references: [{ label: 'prior' }] },
      text('excerpt'),
    )).toMatchObject({ title: 'recall · prior' })
    expect(injectedContextView({ kind: 'plugin', plugin: 'mystery', form: 'future' }, text('x'))).toEqual({
      title: 'mystery',
      parts: [{ kind: 'context', rows: ['x'] }],
    })
    expect(injectedContextView({ kind: 'webhook' }, text('payload'))).toMatchObject({ title: 'webhook' })
  })

  it('keeps an empty body as one blank row so the keyboard still has a section', () => {
    expect(injectedContextView({ kind: 'plugin', plugin: 'goal', form: 'notice', summary: 'goal set' }, []))
      .toMatchObject({ parts: [{ kind: 'notice', rows: [''] }] })
  })

  it('falls back to the durable kind when a producer field is absent', () => {
    expect(injectedContextView({ kind: 'plugin', form: 'instructions' }, text('x')))
      .toMatchObject({ title: 'instructions · plugin' })
    expect(injectedContextView({ kind: 'skill-invocation', form: 'instructions' }, text('x')))
      .toMatchObject({ title: 'instructions · skill-invocation' })
    expect(injectedContextView({ kind: 'session-reference', form: 'recall' }, text('x')))
      .toMatchObject({ title: 'recall · session-reference' })
    expect(injectedContextView({ kind: 'agent-instructions', form: 'instructions' }, text('x')))
      .toMatchObject({ title: 'instructions · agent-instructions' })
    expect(injectedContextView({ kind: 'plugin', plugin: 'goal', form: 'notice' }, text('x')))
      .toMatchObject({ title: 'notice · goal' })
  })

  it('keeps an empty named contribution rather than dropping it', () => {
    expect(injectedContextView(
      { kind: 'plugin', plugin: 'workspace', form: 'snapshot', sections: [{ name: 'bare', text: '' }] },
      text('assembled'),
    )).toMatchObject({
      parts: [{ kind: 'snapshot', label: 'bare', rows: [''] }],
    })
  })

  it('keeps first-seen producer labels and drops duplicates', () => {
    expect(injectedContextView(
      { kind: 'session-reference', form: 'recall', references: [{ label: 'prior' }, { label: 'prior' }, { label: 'other' }] },
      text('excerpt'),
    )).toMatchObject({ title: 'recall · prior, other' })
  })
})
