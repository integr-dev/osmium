import { describe, expect, it } from 'vitest'
import { faviconSvg, titleFrames, type FleetSummary } from './browserStatus'

function summary(overrides: Partial<FleetSummary> = {}): FleetSummary {
  return {
    reachable: true,
    hasFleet: true,
    online: 3,
    total: 4,
    percent: 62,
    etaMinutes: 14,
    ...overrides,
  }
}

describe('what the tab says', () => {
  /** The name stays in front, or a tab reading "62% built" says nothing about which tab it is. */
  it('rotates through the facts worth glancing at', () => {
    expect(titleFrames(summary())).toEqual([
      'Osmium',
      'Osmium · 3/4 in game',
      'Osmium · 62% built',
      'Osmium · ETA 14m',
    ])
  })

  /**
   * A title cycling through numbers that stopped being true is worse than no numbers at all — the
   * operator would read a stale fleet as a live one.
   */
  it('stops rotating when the backend is not answering', () => {
    expect(titleFrames(summary({ reachable: false }))).toEqual(['Osmium · offline'])
  })

  it('says nothing about a fleet it cannot see', () => {
    expect(titleFrames(summary({ hasFleet: false }))).toEqual(['Osmium'])
    expect(titleFrames(summary({ total: 0 }))).toEqual(['Osmium'])
  })

  /** Null while nothing is being placed, which is most of the time. */
  it('leaves out an ETA there is no basis for', () => {
    expect(titleFrames(summary({ etaMinutes: null }))).not.toContain('Osmium · ETA 14m')
  })
})

describe('the icon', () => {
  const LOGO = '<svg viewBox="0 0 899 846"><path d="M0 0"/></svg>'

  /** All three, healthy included: an absent dot reads as an icon that failed to load. */
  it('carries a dot in every state, and a different one each time', () => {
    const painted = (['ok', 'stale', 'offline'] as const).map((status) => faviconSvg(LOGO, status))

    for (const svg of painted) expect(svg).toContain('<circle')
    expect(new Set(painted).size).toBe(3)
  })

  it('splices the dot inside the document', () => {
    const svg = faviconSvg(LOGO, 'offline')

    // Appended after the close instead, and the browser draws the logo and drops the dot.
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg.indexOf('<circle')).toBeGreaterThan(svg.indexOf('<path'))
  })
})
