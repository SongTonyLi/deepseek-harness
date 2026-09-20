/**
 * Permission-preset rows and labels shared by `/permission` and the
 * permission status-bar hint.
 * @module @deepseek-ai/dsh-tui-app/permission
 */

import type { PresetOption } from '@deepseek-ai/dsh-permission-presets'
import type { PickItem } from './prompts.ts'

/**
 * The display name of one preset.
 * @param options - the process catalog.
 * @param preset - the selected preset, including a derived `custom` value.
 * @returns the catalog label, or the raw id when the catalog no longer lists it.
 */
export function permissionName(options: readonly PresetOption[], preset: string): string {
  return options.find(option => option.value === preset)?.name ?? preset
}

/**
 * Picker rows for the process catalog, in contribution order.
 * @param options - the selectable presets.
 * @returns the rows.
 */
export function permissionItems(options: readonly PresetOption[]): PickItem[] {
  return options.map(option => ({
    value: option.value,
    label: option.name,
    ...option.description === undefined ? {} : { description: option.description },
  }))
}

/**
 * The dim row under the picker heading.
 * @param options - the process catalog.
 * @param preset - the preset in force.
 * @returns one row naming the preset in force and how to dismiss the picker.
 */
export function permissionHint(options: readonly PresetOption[], preset: string): string {
  return `current: ${permissionName(options, preset)} · Esc keeps it`
}

/**
 * The preset a typed `/permission` argument names. Matching is without case
 * so a typed id can follow the catalog's own casing.
 * @param options - the process catalog.
 * @param typed - the argument, matched against catalog values.
 * @returns the catalog value, or null when nothing matches.
 */
export function matchPermission(options: readonly PresetOption[], typed: string): string | null {
  const wanted = typed.toLowerCase()
  return options.find(option => option.value.toLowerCase() === wanted)?.value ?? null
}
