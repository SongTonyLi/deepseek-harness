// @vitest-environment jsdom
/** The masked credential renderer: reveal control, accessible names, and reset to masked. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { CredentialScanner, formatTables } from '@deepseek-ai/dsh-util-credential-mask'
import { SecretText } from '../src/client/SecretText.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

type Props = ComponentProps<typeof SecretText>

// Assembled at run time so the repository holds no literal in a credential format.
const KEY = ['sk', '-', '0123456789abcdef0123456789abcdef'].join('')
const OTHER = ['sk', '-', 'fedcba9876543210fedcba9876543210'].join('')
const masked = (value: string): string => value.slice(0, 8) + '*'.repeat(value.length - 8)

function props(raw: string, interactive: boolean, dictionary: Record<string, string> = zh, node?: Props['node']): Props {
  // The component reads only these owner and locale seats.
  return {
    node: node ?? { id: 'secret', start: 0, end: raw.length, data: { masked: masked(raw) } },
    raw, interactive, t: makeTranslate(dictionary),
  } as Props
}

const BEGIN = ['-----BEGIN', ' PRIVATE KEY-----'].join('')
const END = ['-----END', ' PRIVATE KEY-----'].join('')
const PASSWORD = '密🙂a*e\u0301'
const BODY = 'a🙂b\udc00'

const partitionCases = [
  {
    name: 'an ASCII key',
    text: KEY,
    maskedParts: ['sk-01234', '*'.repeat(27)],
    rawParts: ['sk-01234', '56789abcdef0123456789abcdef'],
  },
  {
    name: 'a Unicode address password',
    text: `postgres://user:${PASSWORD}@host/db`,
    maskedParts: ['******'],
    rawParts: [PASSWORD],
  },
  ...['\n', '\r\n'].map(newline => ({
    name: `a private key block with ${newline === '\n' ? 'LF' : 'CRLF'}`,
    text: [BEGIN, BODY, 'c*', END].join(newline),
    maskedParts: [BEGIN + newline, '****', newline, '**', newline + END],
    rawParts: [BEGIN + newline, BODY, newline, 'c*', newline + END],
  })),
  {
    name: 'a private key header with retained asterisks and Unicode',
    text: [`${BEGIN} note*🙂`, BODY, END].join('\n'),
    maskedParts: [`${BEGIN} note`, '*', '🙂\n', '****', `\n${END}`],
    rawParts: [`${BEGIN} note`, '*', '🙂\n', BODY, `\n${END}`],
  },
]

describe('SecretText', () => {
  it.each(partitionCases)('preserves inline partitions when revealing $name', ({ text, maskedParts, rawParts }) => {
    const node = new CredentialScanner(formatTables()).match(text, 0)!
    const raw = text.slice(node.start, node.end)
    const view = render(<SecretText {...props(raw, true, en, node)} />)
    const value = view.container.querySelector('[data-secret] > span')!
    const partitions = Array.from(value.children)
    const maskedMarkup = value.innerHTML
    expect(partitions.map(part => part.textContent)).toEqual(maskedParts)
    expect(value.textContent).toBe(node.data.masked)
    expect(value.innerHTML).not.toContain(raw)

    fireEvent.click(view.getByRole('button', { name: 'Show secret' }))
    expect(Array.from(value.children)).toHaveLength(partitions.length)
    for (const [index, partition] of partitions.entries()) {
      expect(value.children[index]).toBe(partition)
    }
    expect(partitions.map(part => part.textContent)).toEqual(rawParts)
    expect(value.textContent).toBe(raw)

    fireEvent.click(view.getByRole('button', { name: 'Hide secret' }))
    expect(value.innerHTML).toBe(maskedMarkup)
    expect(value.textContent).toBe(node.data.masked)
  })

  it('draws only the masked form without a control in non-interactive text', () => {
    const view = render(<div data-host><SecretText {...props(KEY, false)} /></div>)
    const run = view.container.querySelector('[data-secret]')!
    expect(run.textContent).toBe(masked(KEY))
    expect(view.container.querySelector('button')).toBeNull()
  })

  it('reveals and hides the value from its own control', () => {
    const view = render(<SecretText {...props(KEY, true)} />)
    const run = view.container.querySelector('[data-secret]')!
    const reveal = view.getByRole('button', { name: '显示密钥' })
    expect(run.textContent).toBe(masked(KEY))
    expect(reveal.getAttribute('aria-pressed')).toBe('false')
    expect(reveal.querySelector('svg')).not.toBeNull()

    fireEvent.click(reveal)
    expect(run.textContent).toBe(KEY)
    const hide = view.getByRole('button', { name: '隐藏密钥' })
    expect(hide.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(hide)
    expect(run.textContent).toBe(masked(KEY))
  })

  it('starts masked again when a different credential reuses the same element', () => {
    const view = render(<SecretText {...props(KEY, true, en)} />)
    fireEvent.click(view.getByRole('button', { name: 'Show secret' }))
    view.rerender(<SecretText {...props(OTHER, true, en)} />)
    expect(view.container.querySelector('[data-secret]')!.textContent).toBe(masked(OTHER))
    expect(view.getByRole('button', { name: 'Show secret' }).getAttribute('aria-pressed')).toBe('false')
  })
})
