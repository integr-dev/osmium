import { describe, expect, it } from 'vitest'
import { areaPath, bucketByHour, linePath, VIEW_HEIGHT, VIEW_WIDTH } from './series'

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

describe('hourly buckets', () => {
  const HOUR = 3_600_000
  const noon = Date.parse('2026-08-14T12:00:00Z')

  it('returns one bucket per hour, oldest first', () => {
    const buckets = bucketByHour([], noon + 30 * 60_000, 4)

    expect(buckets).toHaveLength(4)
    expect(buckets[0]!.at).toBe(noon - 3 * HOUR)
    expect(buckets[3]!.at).toBe(noon)
  })

  it('counts each time into the hour it happened in', () => {
    const buckets = bucketByHour([noon + 60_000, noon + 120_000, noon - HOUR], noon, 2)

    expect(buckets.map((b) => b.count)).toEqual([1, 2])
  })

  /** Folding them in would put a spike on the oldest bar every time the window moved. */
  it('drops what falls outside the window rather than piling it on the end', () => {
    const buckets = bucketByHour([noon - 10 * HOUR, noon + 5 * HOUR], noon, 3)

    expect(buckets.map((b) => b.count)).toEqual([0, 0, 0])
  })

  /** On the hour, not on a rolling offset: the bars would otherwise slide sideways every second. */
  it('aligns to the clock', () => {
    const buckets = bucketByHour([], noon + 59 * 60_000, 1)

    expect(buckets[0]!.at).toBe(noon)
  })
})
