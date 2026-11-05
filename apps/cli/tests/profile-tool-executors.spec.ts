/** Executor selection across shipped bundle layers and the supported PTC overlay. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PTC_OVERLAY = join(REPOSITORY_ROOT, 'apps/cli/config/examples/ptc.yml')
const BASE_BACKED_APPS = ['web-app', 'headless', 'sdk-app', 'acp-app', 'tui-app'] as const

/** Parse the shipped patch without evaluating its Loader expressions. */
function bundle(name: string) {
  return loadOverlayPatches('profile tool executor test', join(REPOSITORY_ROOT, 'packages/bundle', name, 'cordis.patch.yml'))
}

/** Select the actual shipped executor rows after ordered patch application. */
function executorRows(app: typeof BASE_BACKED_APPS[number], ptc = false) {
  const entries = composeEntries([
    bundle('base'),
    bundle(app),
    ...(ptc ? [loadOverlayPatches('profile tool executor test', PTC_OVERLAY)] : []),
  ])
  return {
    tools: entries.find(entry => entry.id === 'tools'),
    native: entries.find(entry => entry.id === 'tool-executor-native'),
    ptc: entries.find(entry => entry.id === 'tool-executor-ptc'),
    runtime: entries.find(entry => entry.id === 'ptc-runtime'),
  }
}

describe('shipped profile tool executor selection', () => {
  it.each(BASE_BACKED_APPS)('%s inherits native execution without removed tools configuration', (app) => {
    const rows = executorRows(app)
    expect(rows.tools).toMatchObject({ name: '@deepseek-ai/dsh-tools' })
    expect(rows.tools?.config ?? {}).not.toHaveProperty('mode')
    expect(rows.tools?.config ?? {}).not.toHaveProperty('maxParallelSubCalls')
    expect(rows.native).toMatchObject({ name: '@deepseek-ai/dsh-tool-executor-native' })
    expect(rows.native?.disabled).not.toBe(true)
    expect(rows.ptc).toMatchObject({ name: '@deepseek-ai/dsh-tool-executor-ptc', disabled: true })
  })

  it.each(BASE_BACKED_APPS)('%s selects PTC through the existing executor overlay', (app) => {
    const rows = executorRows(app, true)
    expect(rows.native).toMatchObject({ disabled: true })
    expect(rows.ptc).toMatchObject({ name: '@deepseek-ai/dsh-tool-executor-ptc', disabled: false })
    expect(rows.runtime).toMatchObject({ name: '@deepseek-ai/dsh-ptc-runtime-node' })
    expect(rows.runtime?.disabled).not.toBe(true)
  })
})
