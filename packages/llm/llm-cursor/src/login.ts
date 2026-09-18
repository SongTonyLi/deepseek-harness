/**
 * Authorization flow: PKCE URL, poll, commit the grant, best-effort catalog refresh.
 *
 * @module @deepseek-ai/dsh-llm-cursor/login
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { cursorGrantRecord } from './grant.ts'
import { createCursorOauthClient } from './oauth.ts'
import type { CursorOauthDependencies } from './oauth.ts'
import { CURSOR_RECORD_KEY } from './token.ts'

/**
 * Register the Cursor subscription flow when the authorization seam is present.
 * @param ctx - plugin context carrying `ctx.authorization` and `ctx.credentials`.
 * @param oauth - injectable OAuth client dependencies.
 * @param onAuthorized - best-effort catalog refresh; must not fail the attempt.
 */
export function registerCursorFlow(
  ctx: Context,
  oauth: CursorOauthDependencies,
  onAuthorized?: () => Promise<void>,
): void {
  const client = createCursorOauthClient(oauth)
  ctx.authorization.registerFlow({
    key: CURSOR_RECORD_KEY,
    label: 'Cursor',
    methods: [{ id: 'oauth', label: 'Cursor subscription' }],
    async run(session: AuthorizationSession) {
      const grant = await client.login({
        onAuth: ({ url }) => {
          session.notify({
            message: 'Open this page to continue signing in to Cursor.',
            url,
            openInBrowser: true,
          })
        },
      }, { signal: session.signal })
      const credentials = ctx.get('credentials')
      if (credentials === undefined) {
        throw new Error('llm-cursor: authorization flow requires the credentials service')
      }
      await credentials.modifyRecord(CURSOR_RECORD_KEY, () => Promise.resolve(cursorGrantRecord(grant)))
      if (onAuthorized !== undefined) {
        try {
          await onAuthorized()
        } catch (error) {
          ctx.logger.warn('llm-cursor: catalog refresh after sign-in failed')
          ctx.logger.warn(error)
        }
      }
    },
  })
}
