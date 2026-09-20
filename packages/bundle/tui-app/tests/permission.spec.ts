/** Permission-preset rows, labels, and argument matching. */

import { describe, expect, it } from 'vitest'
import type { PresetOption } from '@deepseek-ai/dsh-permission-presets'
import { matchPermission, permissionHint, permissionItems, permissionName } from '../src/permission.ts'

const options: readonly PresetOption[] = [
  { value: 'workspace-write', name: 'workspace-write', description: 'Write inside the workspace.' },
  { value: 'danger-full-access', name: 'Full access', description: 'Full file access without approval prompts.' },
]

describe('permission preset rows', () => {
  it('lists catalog options in contribution order', () => {
    expect(permissionItems(options)).toEqual([
      { value: 'workspace-write', label: 'workspace-write', description: 'Write inside the workspace.' },
      { value: 'danger-full-access', label: 'Full access', description: 'Full file access without approval prompts.' },
    ])
    expect(permissionItems([{ value: 'auto', name: 'Auto review' }])).toEqual([
      { value: 'auto', label: 'Auto review' },
    ])
  })

  it('names the preset in force, falling back to its raw id', () => {
    expect(permissionName(options, 'danger-full-access')).toBe('Full access')
    expect(permissionName(options, 'custom')).toBe('custom')
    expect(permissionHint(options, 'workspace-write')).toBe('current: workspace-write · Esc keeps it')
    expect(permissionHint(options, 'custom')).toBe('current: custom · Esc keeps it')
  })

  it('matches an argument against catalog values without case', () => {
    expect(matchPermission(options, 'Danger-Full-Access')).toBe('danger-full-access')
    expect(matchPermission(options, 'workspace-write')).toBe('workspace-write')
    expect(matchPermission(options, 'yolo')).toBeNull()
  })
})
