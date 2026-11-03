/** Select a session model distinct from the launch default in the Team composition. */
export const name = 'team-model-selection-driver'
export const inject = ['agents']

/** @param {import('@deepseek-ai/cordis').Context} ctx - snapshot composition. */
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession === undefined) {
      agent.model.select({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    }
  })
}
