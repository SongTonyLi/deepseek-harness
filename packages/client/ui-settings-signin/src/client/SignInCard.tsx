/**
 * The sign-in area inside one Models provider card: whether this provider is
 * signed in, the buttons that start each subscription sign-in the flow offers,
 * and the sign-out.
 *
 * Only subscription methods appear here. A provider whose login just collects
 * an API key already has the card's own key field, and offering a second path
 * that stores the same secret somewhere else would be a trap; so a flow with
 * no subscription method renders nothing, as does a provider with no flow at
 * all.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AuthorizationFlowView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { isSubscriptionMethod } from './store.ts'
import type { SignInState } from './store.ts'
import type { SignInKey } from './locales.ts'
import styles from './SignInCard.module.css'

/** Registration-side face for the provider-card sign-in seat. */
export interface SignInCardFace {
  hooks: {
    /** Sign-in snapshot bound by the renderer as useSignIn. */
    signIn: SnapshotStore<SignInState>
  }
  /** Start one attempt for this flow and method. */
  signIn: (flow: AuthorizationFlowView, provider: string, method?: string) => void
  /** Forget this flow's stored credential; resolves with a refusal message. */
  signOut: (flow: AuthorizationFlowView) => Promise<string | undefined>
}

/** Props the renderer binds for the sign-in seat. */
export type SignInCardProps =
  PropsRuntime<'settings.models.provider-card'>
  & PropsLocale<'settings.signin'>
  & InjectFace<SignInCardFace>

/**
 * Render one provider's sign-in area.
 * @param props - the owning card's directory row, the sign-in snapshot, and the two actions.
 * @returns the sign-in area, or nothing when this provider has no flow.
 */
export function SignInCard(props: SignInCardProps): ReactNode {
  const { t } = props
  const state = props.useSignIn(snapshot => snapshot)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [signingOut, setSigningOut] = useState(false)
  const provider = props.provider.provider
  const flow = state.flows.get(provider)
  const methods = flow?.methods.filter(isSubscriptionMethod) ?? []
  if (flow === undefined || methods.length === 0) return null
  const busy = flow.inFlight || state.attempt?.provider === provider
  return (
    <div className={styles['card']}>
      <div className={styles['row']}>
        {flow.configured
          ? (
            <span className={styles['state']}>
              <span className={styles['dot']} />
              {flow.kind === 'grant' ? t('signedInWithSubscription') : t('signedIn')}
            </span>
          )
          : null}
        {methods.map(method => (
          <Button
            key={method.id}
            variant={flow.configured ? 'outline' : 'primary'}
            size="sm"
            disabled={busy}
            onClick={() => {
              setFailure(undefined)
              props.signIn(flow, provider, method.id)
            }}
          >
            {methods.length === 1 ? t('signIn') : t('signInWith', { method: method.label })}
          </Button>
        ))}
        {flow.configured
          ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || signingOut}
              onClick={() => {
                setFailure(undefined)
                setSigningOut(true)
                void props.signOut(flow)
                  .then((refusal) => {
                    if (refusal !== undefined) setFailure(t('signOutFailed', { message: refusal }))
                  })
                  .finally(() => { setSigningOut(false) })
              }}
            >
              {t('signOut')}
            </Button>
          )
          : null}
      </div>
      {flow.configured ? null : <p className={styles['hint']}>{t('signInHint')}</p>}
      {busy && state.attempt === undefined ? <p className={styles['hint']}>{t('signInBusy')}</p> : null}
      {failure === undefined ? null : <p className={styles['error']} role="alert">{failure}</p>}
    </div>
  )
}

export type { SignInKey }
