// @vitest-environment jsdom
/** The provider-card sign-in area and the attempt dialog, over scripted props. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AuthorizationFlowView } from '@deepseek-ai/dsh-api-remotes/client'
import { SignInCard, type SignInCardProps } from '../src/client/SignInCard.tsx'
import { SignInDialog, type SignInDialogProps } from '../src/client/SignInDialog.tsx'
import { SignInFooter, type SignInFooterProps } from '../src/client/SignInFooter.tsx'
import type { SignInAttempt, SignInState } from '../src/client/store.ts'
import { en, type SignInKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t: SignInDialogProps['t'] = (key: SignInKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )

const CODEX: AuthorizationFlowView = {
  key: 'llm-pi-ai/openai-codex',
  scope: 'llm-pi-ai',
  id: 'openai-codex',
  label: 'OpenAI Codex',
  methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }],
  inFlight: false,
  configured: false,
}

function cardProps(state: Partial<SignInState>, overrides: Partial<SignInCardProps> = {}): SignInCardProps {
  const store = createSnapshotStore<SignInState>({
    loaded: true,
    flows: new Map([['openai-codex', CODEX]]),
    attempt: undefined,
    ...state,
  })
  return {
    t,
    provider: { provider: 'openai-codex', displayName: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'], active: false },
    configured: false,
    keyConfigured: false,
    useSignIn: bindSnapshotSelector(store),
    signIn: vi.fn(),
    signOut: vi.fn(() => Promise.resolve(undefined)),
    ...overrides,
  } as unknown as SignInCardProps
}

function attempt(overrides: Partial<SignInAttempt> = {}): SignInAttempt {
  return {
    key: 'llm-pi-ai/openai-codex',
    provider: 'openai-codex',
    label: 'OpenAI Codex',
    running: true,
    directions: [],
    question: undefined,
    answering: false,
    outcome: undefined,
    ...overrides,
  }
}

function dialogProps(current: SignInAttempt | undefined, overrides: Partial<SignInDialogProps> = {}): SignInDialogProps {
  return {
    attempt: current,
    t,
    onAnswer: vi.fn(),
    onDecline: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

describe('the provider-card sign-in area', () => {
  it('renders nothing for a provider no flow claims', () => {
    const { container } = render(<SignInCard {...cardProps({ flows: new Map() })} />)
    expect(container.innerHTML).toBe('')
  })

  it('offers one sign-in button and the hint while the provider is not signed in', () => {
    const props = cardProps({})
    render(<SignInCard {...props} />)
    expect(screen.getByText(en.signInHint)).toBeTruthy()
    expect(screen.queryByText(en.signOut)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.signIn }))
    expect(props.signIn).toHaveBeenCalledWith(CODEX, 'openai-codex', 'oauth')
  })

  it('offers the subscription method alone when the flow also collects a key', () => {
    // The card's own API-key field already stores a key; offering pi-ai's key
    // prompt beside it would store the same secret as a record instead.
    const anthropic: AuthorizationFlowView = {
      ...CODEX,
      key: 'llm-pi-ai/anthropic',
      id: 'anthropic',
      methods: [{ id: 'oauth', label: 'Claude Pro/Max' }, { id: 'api-key', label: 'Anthropic API key' }],
    }
    const props = cardProps({ flows: new Map([['openai-codex', anthropic]]) })
    render(<SignInCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.signIn }))
    expect(props.signIn).toHaveBeenCalledWith(anthropic, 'openai-codex', 'oauth')
    expect(screen.queryByRole('button', { name: 'Sign in with Anthropic API key' })).toBeNull()
  })

  it('names each method when a flow offers more than one subscription login', () => {
    const dual: AuthorizationFlowView = {
      ...CODEX,
      methods: [{ id: 'oauth', label: 'ChatGPT Plus/Pro' }, { id: 'oauth-enterprise', label: 'ChatGPT Enterprise' }],
    }
    const props = cardProps({ flows: new Map([['openai-codex', dual]]) })
    render(<SignInCard {...props} />)
    expect(screen.queryByRole('button', { name: en.signIn })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT Plus/Pro' }))
    expect(props.signIn).toHaveBeenCalledWith(dual, 'openai-codex', 'oauth')
  })

  it('renders nothing for a provider whose only login collects a key', () => {
    const keyOnly: AuthorizationFlowView = { ...CODEX, methods: [{ id: 'api-key', label: 'MiniMax API key' }] }
    const { container } = render(<SignInCard {...cardProps({ flows: new Map([['openai-codex', keyOnly]]) })} />)
    expect(container.innerHTML).toBe('')
  })

  it('reports a subscription sign-in and signs out through the injected action', async () => {
    const props = cardProps({ flows: new Map([['openai-codex', { ...CODEX, configured: true, kind: 'grant' }]]) })
    render(<SignInCard {...props} />)
    expect(screen.getByText(en.signedInWithSubscription)).toBeTruthy()
    expect(screen.queryByText(en.signInHint)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    await waitFor(() => { expect(props.signOut).toHaveBeenCalledWith({ ...CODEX, configured: true, kind: 'grant' }) })
  })

  it('reports a stored key sign-in without the subscription wording', () => {
    render(<SignInCard {...cardProps({ flows: new Map([['openai-codex', { ...CODEX, configured: true, kind: 'api-key' }]]) })} />)
    expect(screen.getByText(en.signedIn)).toBeTruthy()
  })

  it('shows the Host refusal when a sign-out is declined', async () => {
    const signOut = vi.fn(() => Promise.resolve('the credentials document is read-only'))
    const props = cardProps({ flows: new Map([['openai-codex', { ...CODEX, configured: true, kind: 'grant' }]]) }, { signOut })
    render(<SignInCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent)
        .toBe('Sign-out failed: the credentials document is read-only')
    })
  })

  it('holds its buttons and explains while another surface runs this flow', () => {
    render(<SignInCard {...cardProps({ flows: new Map([['openai-codex', { ...CODEX, inFlight: true }]]) })} />)
    expect(screen.getByRole('button', { name: en.signIn }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(en.signInBusy)).toBeTruthy()
  })

  it('holds its buttons without the busy line while this surface runs the attempt', () => {
    render(<SignInCard {...cardProps({
      flows: new Map([['openai-codex', { ...CODEX, inFlight: true }]]),
      attempt: attempt(),
    })} />)
    expect(screen.getByRole('button', { name: en.signIn }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(en.signInBusy)).toBeNull()
  })
})

describe('the dialog seat', () => {
  it('renders the page-level dialog from the shared snapshot', () => {
    const store = createSnapshotStore<SignInState>({
      loaded: true,
      flows: new Map(),
      attempt: attempt({ directions: [{ message: 'Continue in your browser' }] }),
    })
    const props = {
      t,
      useSignIn: bindSnapshotSelector(store),
      answer: vi.fn(),
      decline: vi.fn(),
      close: vi.fn(),
    } as unknown as SignInFooterProps
    render(<SignInFooter {...props} />)
    expect(screen.getByRole('dialog', { name: 'Sign in to openai-codex' })).toBeTruthy()
    expect(screen.getByText('Continue in your browser')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(props.close).toHaveBeenCalled()
  })

  it('renders nothing while the snapshot carries no attempt', () => {
    const store = createSnapshotStore<SignInState>({ loaded: true, flows: new Map(), attempt: undefined })
    const props = {
      t,
      useSignIn: bindSnapshotSelector(store),
      answer: vi.fn(),
      decline: vi.fn(),
      close: vi.fn(),
    } as unknown as SignInFooterProps
    const { container } = render(<SignInFooter {...props} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('the attempt dialog', () => {
  it('renders nothing while no attempt is open', () => {
    const { container } = render(<SignInDialog {...dialogProps(undefined)} />)
    expect(container.innerHTML).toBe('')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0)
  })

  it('shows the page to open, the code to type, and the waiting line', () => {
    render(<SignInDialog {...dialogProps(attempt({
      directions: [{ message: 'Continue in your browser', url: 'https://auth.openai.com/start', code: 'WXYZ-1234' }],
    }))} />)
    expect(screen.getByRole('dialog', { name: 'Sign in to openai-codex' })).toBeTruthy()
    expect(screen.getByText('Continue in your browser')).toBeTruthy()
    expect(screen.getByRole('link', { name: en.openPage }).getAttribute('href')).toBe('https://auth.openai.com/start')
    expect(screen.getByText('WXYZ-1234')).toBeTruthy()
    expect(screen.getByText(en.waiting)).toBeTruthy()
  })

  it('copies the verification code and reports the result', async () => {
    const write = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText: write } })
    render(<SignInDialog {...dialogProps(attempt({
      directions: [{ message: 'Enter this code', url: 'https://auth.openai.com/device', code: 'WXYZ-1234' }],
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: en.copyCode }))
    await waitFor(() => { expect(screen.getByRole('button', { name: en.copiedCode })).toBeTruthy() })
    expect(write).toHaveBeenCalledWith('WXYZ-1234')
  })

  it('leaves the copy action unchanged when the clipboard refuses', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) } })
    render(<SignInDialog {...dialogProps(attempt({
      directions: [{ message: 'Enter this code', code: 'WXYZ-1234' }],
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: en.copyCode }))
    await waitFor(() => { expect(screen.getByRole('button', { name: en.copyCode })).toBeTruthy() })
  })

  it('answers a text question on submit and on Enter', () => {
    const props = dialogProps(attempt({
      question: { promptId: 'p1', kind: 'text', message: 'Paste the code', placeholder: 'code' },
    }))
    render(<SignInDialog {...props} />)
    const input = screen.getByLabelText(en.textInput)
    fireEvent.change(input, { target: { value: 'typed' } })
    fireEvent.click(screen.getByRole('button', { name: en.submit }))
    expect(props.onAnswer).toHaveBeenCalledWith('typed')
    fireEvent.change(screen.getByLabelText(en.textInput), { target: { value: 'again' } })
    fireEvent.keyDown(screen.getByLabelText(en.textInput), { key: 'Enter' })
    expect(props.onAnswer).toHaveBeenCalledWith('again')
  })

  it('masks a secret question and declines through its own action', () => {
    const props = dialogProps(attempt({ question: { promptId: 'p1', kind: 'secret', message: 'Paste your key' } }))
    render(<SignInDialog {...props} />)
    expect(screen.getByLabelText(en.secretInput).getAttribute('type')).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: en.decline }))
    expect(props.onDecline).toHaveBeenCalled()
  })

  it('answers a select question with the chosen option id', () => {
    const props = dialogProps(attempt({
      question: {
        promptId: 'p1',
        kind: 'select',
        message: 'Select login method:',
        options: [{ id: 'browser', label: 'Browser login' }, { id: 'device_code', label: 'Device code', description: 'headless' }],
      },
    }))
    render(<SignInDialog {...props} />)
    expect(screen.getByText('headless')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Device code/ }))
    expect(props.onAnswer).toHaveBeenCalledWith('device_code')
  })

  it('ignores a key other than Enter in the answer field', () => {
    const props = dialogProps(attempt({ question: { promptId: 'p1', kind: 'text', message: 'Paste the code' } }))
    render(<SignInDialog {...props} />)
    fireEvent.keyDown(screen.getByLabelText(en.textInput), { key: 'a' })
    expect(props.onAnswer).not.toHaveBeenCalled()
  })

  it('renders a select question that arrived without options', () => {
    const props = dialogProps(attempt({
      question: { promptId: 'p1', kind: 'select', message: 'Select login method:' },
    }))
    render(<SignInDialog {...props} />)
    expect(screen.getByRole('group', { name: en.chooseMethod }).children).toHaveLength(0)
  })

  it('holds its controls while an answer is in flight', () => {
    const props = dialogProps(attempt({
      answering: true,
      question: { promptId: 'p1', kind: 'text', message: 'Paste the code' },
    }))
    render(<SignInDialog {...props} />)
    expect(screen.getByRole('button', { name: en.submitting }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.submitting }))
    expect(props.onAnswer).not.toHaveBeenCalled()
  })

  it('offers cancel while running and close once settled', () => {
    const props = dialogProps(attempt())
    const view = render(<SignInDialog {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(props.onClose).toHaveBeenCalled()
    view.rerender(<SignInDialog {...dialogProps(attempt({ running: false, outcome: { kind: 'authorized' } }))} />)
    expect(screen.getByRole('status').textContent).toBe(en.authorized)
    expect(screen.getAllByRole('button', { name: en.close }).length).toBeGreaterThan(0)
  })

  it('reports a cancelled and a failed outcome', () => {
    const view = render(<SignInDialog {...dialogProps(attempt({ running: false, outcome: { kind: 'cancelled' } }))} />)
    expect(screen.getByRole('status').textContent).toBe(en.cancelledOutcome)
    view.rerender(<SignInDialog {...dialogProps(attempt({
      running: false,
      outcome: { kind: 'failed', message: 'token exchange failed (401)' },
    }))} />)
    expect(screen.getByRole('alert').textContent).toBe('Sign-in failed: token exchange failed (401)')
  })
})
