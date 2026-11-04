/** Failed-turn continuation admission over the complete Session log. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { continuationProjectionDefinition, type ContinuationState } from './projection.ts'
import type { RetrySource } from './types.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Failed-turn continuation eligibility and admission. */
    sessionContinuation: SessionContinuation
  }
}

/** The Agent already owns a turn or maintenance operation; retry after that work settles. */
export class SessionContinuationBusyError extends Error {
  override readonly name = 'SessionContinuationBusyError'
  readonly code = 'AGENT_BUSY'

  constructor(cause: unknown) {
    super('generation continuation requires an idle agent', { cause })
  }
}

/** Owns the continuation projection and admits an empty retry while the Agent is idle. */
export class SessionContinuation extends Service {
  static inject = ['sessionProjections']
  private projection!: ProjectionHandle<ContinuationState>

  /** @param ctx - context carrying the Session projection registry. */
  constructor(ctx: Context) {
    super(ctx, 'sessionContinuation')
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(continuationProjectionDefinition)
  }

  /**
   * Admit an empty retry if the last failed turn is eligible and no human input is pending.
   * @param agent - exact live Agent whose maintenance lock guards admission.
   * @param source - durable retry identity and caller attribution.
   * @returns `accepted` or `unavailable`; an unavailable request adds no input.
   * @throws {SessionContinuationBusyError} if another Agent activity holds maintenance.
   * @throws if reading the projection or queuing the retry fails.
   */
  async retry(agent: Agent, source: RetrySource): Promise<'accepted' | 'unavailable'> {
    try {
      return agent.runMaintenance(() => {
        const inbox = agent.inbox
        if (this.projection.stateOf(agent.session).ending === null
          || inbox.nextTurn.length > 0 || inbox.nextStep.some(message => message.source.kind === 'user')) {
          return Promise.resolve('unavailable' as const)
        }
        agent.followup(createUserMessage({ content: [], source }))
        return Promise.resolve('accepted' as const)
      })
    } catch (cause: unknown) {
      // runMaintenance throws synchronously only when another activity owns the Agent.
      throw new SessionContinuationBusyError(cause)
    }
  }
}

export default SessionContinuation
