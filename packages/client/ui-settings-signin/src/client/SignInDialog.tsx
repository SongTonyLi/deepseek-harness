/**
 * The sign-in conversation as a modal: what the flow told the human to do,
 * the question it is waiting on, and how the attempt ended. It renders frames
 * the controller folded; it never talks to the Host itself.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SignInAttempt } from './store.ts'
import type { en } from './locales.ts'
import styles from './SignInCard.module.css'

/** Props of {@link SignInDialog}. */
export interface SignInDialogProps {
  /** The attempt to render; the dialog is closed while this is absent. */
  attempt: SignInAttempt | undefined
  /** Copy for this surface. */
  t: (key: keyof typeof en, params?: Record<string, string>) => string
  /** Answer the open question with a typed value or a chosen option id. */
  onAnswer: (value: string) => void
  /** Decline the open question, cancelling the attempt. */
  onDecline: () => void
  /** Withdraw a running attempt, or dismiss a settled one. */
  onClose: () => void
}

/**
 * Render one sign-in attempt.
 * @param props - the attempt, its copy, and the three actions.
 * @returns the modal, or null when no attempt is open.
 */
export function SignInDialog(props: SignInDialogProps): ReactNode {
  const { attempt, t } = props
  const [draft, setDraft] = useState('')
  if (attempt === undefined) return null
  const question = attempt.question
  // No guard on whether a question is waiting: the controller owns that rule,
  // and a second copy here could only disagree with it.
  const submit = (): void => {
    props.onAnswer(draft)
    setDraft('')
  }
  return (
    <Modal
      open
      onClose={props.onClose}
      title={t('dialogTitle', { provider: attempt.provider })}
      closeLabel={t('close')}
      footer={question !== undefined && question.kind !== 'select'
        ? (
          <>
            <Button variant="outline" disabled={attempt.answering} onClick={props.onDecline}>
              {t('decline')}
            </Button>
            <Button variant="primary" disabled={attempt.answering} onClick={submit}>
              {attempt.answering ? t('submitting') : t('submit')}
            </Button>
          </>
        )
        : (
          <Button variant="outline" onClick={props.onClose}>
            {attempt.running ? t('cancel') : t('close')}
          </Button>
        )}
    >
      <div className={styles['dialogBody']}>
        <div className={styles['directions']}>
          {attempt.directions.map((direction, index) => (
            <div key={`${String(index)}:${direction.message}`} className={styles['direction']}>
              <p className={styles['message']}>{direction.message}</p>
              {direction.url === undefined
                ? null
                : (
                  <a
                    className={styles['link']}
                    href={direction.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {t('openPage')}
                  </a>
                )}
              {direction.code === undefined
                ? null
                : <VerificationCode code={direction.code} t={t} />}
            </div>
          ))}
        </div>
        {question === undefined
          ? null
          : (
            <div className={styles['question']}>
              <span className={styles['label']}>{question.message}</span>
              {question.kind === 'select'
                ? (
                  <div className={styles['options']} role="group" aria-label={t('chooseMethod')}>
                    {(question.options ?? []).map(option => (
                      <button
                        key={option.id}
                        type="button"
                        className={styles['option']}
                        disabled={attempt.answering}
                        onClick={() => { props.onAnswer(option.id) }}
                      >
                        <span>{option.label}</span>
                        {option.description === undefined
                          ? null
                          : <span className={styles['optionDescription']}>{option.description}</span>}
                      </button>
                    ))}
                  </div>
                )
                : (
                  <input
                    className={styles['input']}
                    type={question.kind === 'secret' ? 'password' : 'text'}
                    autoComplete="off"
                    autoFocus
                    value={draft}
                    placeholder={question.placeholder}
                    aria-label={question.kind === 'secret' ? t('secretInput') : t('textInput')}
                    disabled={attempt.answering}
                    onChange={(event) => { setDraft(event.target.value) }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      submit()
                    }}
                  />
                )}
            </div>
          )}
        {attempt.running && question === undefined
          ? <p className={styles['waiting']}>{t('waiting')}</p>
          : null}
        {attempt.outcome === undefined ? null : <Outcome outcome={attempt.outcome} t={t} />}
      </div>
    </Modal>
  )
}

/**
 * One verification code with its copy action. It owns the code as a required
 * value, so the copy handler has nothing to re-check, and it owns the copied
 * state, so copying one code does not relabel another.
 */
function VerificationCode({ code, t }: { code: string; t: SignInDialogProps['t'] }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <span className={styles['code']}>
      <span className={styles['codeValue']}>{code}</span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => { void writeClipboard(code).then((written) => { setCopied(written) }) }}
      >
        {copied ? t('copiedCode') : t('copyCode')}
      </Button>
    </span>
  )
}

/** The line a settled attempt ends with. */
function Outcome({ outcome, t }: {
  outcome: NonNullable<SignInAttempt['outcome']>
  t: SignInDialogProps['t']
}): ReactNode {
  if (outcome.kind === 'failed') {
    return (
      <p className={`${styles['outcome']} ${styles['outcomeFailed']}`} role="alert">
        {t('failedOutcome', { message: outcome.message })}
      </p>
    )
  }
  return (
    <p className={styles['outcome']} role="status">
      {outcome.kind === 'authorized' ? t('authorized') : t('cancelledOutcome')}
    </p>
  )
}
