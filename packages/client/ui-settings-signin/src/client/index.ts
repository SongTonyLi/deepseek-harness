/**
 * Models-page sign-in, browser half. It fills the two seats the Models
 * section declares: a sign-in area inside every provider card of an adapter
 * family that owns a settings namespace (`llm-pi-ai`, `llm-cursor`), and the
 * dialog that carries one running attempt's conversation. The Host side is the
 * authorization seam; this package adds no settings and stores no credential
 * itself.
 *
 * Export discipline: packages/client/AGENTS.md.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the Models page's two child-slot declarations.
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { SignInCard } from './SignInCard.tsx'
import type { SignInCardFace } from './SignInCard.tsx'
import { SignInFooter } from './SignInFooter.tsx'
import type { SignInFooterFace } from './SignInFooter.tsx'
import { createSignInOperations, SignInController } from './store.ts'
import { en, zh, type SignInKey } from './locales.ts'

export type { SignInCardFace, SignInCardProps } from './SignInCard.tsx'
export type { SignInFooterFace, SignInFooterProps } from './SignInFooter.tsx'
export type { SignInDialogProps } from './SignInDialog.tsx'
export type {
  SignInAttempt, SignInDirection, SignInOperations, SignInOutcome, SignInQuestion, SignInState,
} from './store.ts'
export type { SignInKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Models-page sign-in copy. */
    'settings.signin': SignInKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.signin'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.authorization']

/**
 * Register the sign-in seats and keep the flow directory fresh.
 *
 * The directory is read once at mount and again whenever an attempt settles
 * anywhere or a credential record changes, so a second browser tab signing in
 * or out converges here without polling.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-signin: copy dictionaries')

  const controller = new SignInController(createSignInOperations(ctx))
  void controller.load()

  ctx.effect(() => {
    const refresh = (): void => { void controller.load() }
    const disposers = [
      ctx.remote.$on('authorization/settled', refresh),
      ctx.remote.$on('credentials/record-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    return () => {
      controller.dispose()
      for (const dispose of disposers) dispose()
    }
  }, 'ui-settings-signin: pushed invalidations')

  const cardInjected = (): SignInCardFace => ({
    hooks: { signIn: controller.store },
    signIn: (flow, provider, method) => { void controller.begin(flow, provider, method) },
    signOut: flow => controller.signOut(flow),
  })
  const footerInjected = (): SignInFooterFace => ({
    hooks: { signIn: controller.store },
    answer: (value) => { void controller.answer(value) },
    decline: () => { void controller.decline() },
    close: () => { controller.close() },
  })

  for (const key of ['llm-pi-ai', 'llm-cursor'] as const) {
    ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
      name: 'settings.models.provider-card',
      key,
      locale: NS,
      inject: cardInjected,
    }, SignInCard))
  }
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'signin-dialog',
    order: 0,
    locale: NS,
    inject: footerInjected,
  }, SignInFooter))
}
