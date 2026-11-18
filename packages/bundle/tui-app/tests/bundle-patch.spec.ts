/**
 * The terminal bundle's patch mounts the subagent model-selection settings
 * that the browser composes, and the mounted module is the plugin it names.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import * as modelSelectionSettings from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import { describe, expect, it } from 'vitest'

describe('dsh-tui-app bundle patch', () => {
  it('mounts the subagent model-selection settings from the module it names', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const patches = parseEntryYaml(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')) as Array<{
      insert?: Array<{ id?: string; name?: string }>
    }>
    const row = patches.flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'subagent-model-selection-settings')
    expect(row).toEqual({ id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' })
    expect(modelSelectionSettings.name).toBe('subagent-model-selection-settings')
    expect(modelSelectionSettings.default).toBeTypeOf('function')
  })
})
