/** The line above the editor that names an open subagent view. */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createPalette } from '../src/style.ts'
import { ViewBanner } from '../src/view-banner.ts'

describe('ViewBanner', () => {
  it('draws nothing while the main session is on screen', () => {
    const banner = new ViewBanner(createPalette(false))
    expect(banner.render(80)).toEqual([])
    banner.setViews(['explorer'])
    banner.setViews([])
    expect(banner.render(80)).toEqual([])
  })

  it('names the path of views and goes back one level', () => {
    const banner = new ViewBanner(createPalette(false))
    banner.setViews(['explorer'])
    expect(banner.render(80)).toEqual([' ◆ subagent view  ·  main › explorer  ·  Ctrl+P back to main'])
    banner.setViews(['explorer', 'reviewer'])
    expect(banner.render(80)).toEqual([' ◆ subagent view  ·  main › explorer › reviewer  ·  Ctrl+P back to explorer'])
    banner.invalidate()
  })

  it('fits the width and spans it on the band when styled', () => {
    const banner = new ViewBanner(createPalette(true))
    banner.setViews(['explorer'])
    const [row] = banner.render(24)
    expect(visibleWidth(row ?? '')).toBe(24)
    expect(banner.render(120).map(line => visibleWidth(line))).toEqual([120])
  })
})
