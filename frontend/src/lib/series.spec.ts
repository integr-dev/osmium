import { describe, expect, it } from 'vitest'
import { areaPath, linePath, niceCeiling, timePath, VIEW_HEIGHT, VIEW_WIDTH } from './series'

/**
 * The three cases a sparkline actually meets — nothing yet, one sample, and a series that never
 * moves — are all divide-by-zero in the obvious implementation, and all of them look like a bug on
 * screen rather than throwing.
 */
describe('the line', () => {
  it('spans the box, with the high and low inside it', () => {
    const path = linePath([0, 10, 5])

    expect(path.startsWith('M0 ')).toBe(true)
    expect(path).toContain(`L${VIEW_WIDTH} `)

    const ys = [...path.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]))
    // Inset by half a stroke, or the peak is clipped in half and reads as a plateau.
    expect(Math.min(...ys)).toBeGreaterThan(0)
    expect(Math.max(...ys)).toBeLessThan(VIEW_HEIGHT)
  })

  it('puts the highest value above the lowest', () => {
    const [first, second] = [...linePath([1, 9]).matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) =>
      Number(m[1]),
    )

    // SVG y grows downwards, so the larger value is the smaller coordinate.
    expect(second).toBeLessThan(first!)
  })

  /** At the floor it would read as zero; at the ceiling, as a maximum. Neither is true. */
  it('draws a series that never moves down the middle', () => {
    expect(linePath([4, 4, 4])).toContain(`${VIEW_HEIGHT / 2}`)
  })

  it('centres a single sample rather than pinning it to an edge', () => {
    expect(linePath([7])).toBe(`M${VIEW_WIDTH / 2} ${VIEW_HEIGHT / 2}`)
  })

  it('draws nothing at all when there is nothing yet', () => {
    expect(linePath([])).toBe('')
    expect(areaPath([])).toBe('')
  })

  it('closes the area to the baseline', () => {
    const area = areaPath([1, 2])

    expect(area.endsWith('Z')).toBe(true)
    expect(area).toContain(`L${VIEW_WIDTH} ${VIEW_HEIGHT}`)
  })
})

describe('a line on a time axis', () => {
  it('places points by time against a fixed scale', () => {
    const { line, area } = timePath(
      [
        { at: 0, value: 0 },
        { at: 50, value: 5 },
        { at: 100, value: 10 },
      ],
      0,
      100,
      10,
      1000,
      200,
    )

    expect(line).toBe('M0 200 L500 100 L1000 0')
    expect(area).toBe('M0 200 L500 100 L1000 0 L1000 200 L0 200 Z')
  })

  /** A short history reads as short rather than being stretched across the whole chart. */
  it('leaves the part of the axis with no points empty', () => {
    const { line } = timePath([{ at: 75, value: 1 }, { at: 100, value: 1 }], 0, 100, 2, 1000, 200)

    expect(line).toBe('M750 100 L1000 100')
  })

  it('draws nothing for points outside the axis', () => {
    expect(timePath([{ at: -5, value: 1 }], 0, 100, 1, 1000, 200)).toEqual({ line: '', area: '' })
  })
})

describe('a round scale', () => {
  it('rounds up to 1, 2 or 5 of the magnitude', () => {
    expect(niceCeiling(0)).toBe(1)
    expect(niceCeiling(0.3)).toBeCloseTo(0.5)
    expect(niceCeiling(7)).toBe(10)
    expect(niceCeiling(120)).toBe(200)
    expect(niceCeiling(2000)).toBe(2000)
    expect(niceCeiling(4100)).toBe(5000)
  })
})
