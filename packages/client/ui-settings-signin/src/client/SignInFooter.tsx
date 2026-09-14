/**
 * The Models page's sign-in dialog seat. The dialog belongs to the page rather
 * than to one provider card, because an attempt survives the card scrolling
 * out of view and only one runs at a time.
 */

import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SignInDialog } from './SignInDialog.tsx'
import type { SignInState } from './store.ts'

/** Registration-side face for the dialog seat. */
export interface SignInFooterFace {
  hooks: {
    /** Sign-in snapshot bound by the renderer as useSignIn. */
    signIn: SnapshotStore<SignInState>
  }
  /** Answer the open question. */
  answer: (value: string) => void
  /** Decline the open question, cancelling the attempt. */
  decline: () => void
  /** Withdraw a running attempt, or dismiss a settled one. */
  close: () => void
}

/** Props the renderer binds for the dialog seat. */
export type SignInFooterProps =
  PropsRuntime<'settings.models.footer'>
  & PropsLocale<'settings.signin'>
  & InjectFace<SignInFooterFace>

/**
 * Render the page's sign-in dialog.
 * @param props - the sign-in snapshot, its copy, and the three actions.
 * @returns the dialog, or nothing while no attempt is open.
 */
export function SignInFooter(props: SignInFooterProps): ReactNode {
  const attempt = props.useSignIn(snapshot => snapshot.attempt)
  return (
    <SignInDialog
      attempt={attempt}
      t={props.t}
      onAnswer={props.answer}
      onDecline={props.decline}
      onClose={props.close}
    />
  )
}
