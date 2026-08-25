import { describe, expect, it } from 'vitest'
import { jobFigures, percentOf, summarise } from './jobs'
import type { BuildJob, JobSegment, SegmentState } from '../api/jobs'

const segment = (state: SegmentState, blocks = 100, placed = 0) =>
  ({ state, blocks, blocksPlaced: placed }) as JobSegment

const job = (segments: JobSegment[]): BuildJob =>
  ({
    segments,
    totalBlocks: segments.reduce((sum, one) => sum + one.blocks, 0),
    blocksPlaced: segments.reduce((sum, one) => sum + one.blocksPlaced, 0),
  }) as BuildJob

describe('job percentage', () => {
  /** "Done" is the one number an operator acts on, so it must not arrive a block early. */
  it('rounds down, so one block short is not finished', () => {
    expect(percentOf(999, 1000)).toBe(99)
    expect(percentOf(1000, 1000)).toBe(100)
  })

  it('has no opinion about a job with nothing in it', () => {
    expect(percentOf(0, 0)).toBe(0)
    expect(percentOf(10, 0)).toBe(0)
  })

  /** A host recounting after a restart can report more than the split said was there. */
  it('never exceeds finished', () => {
    expect(percentOf(1200, 1000)).toBe(100)
  })
})

describe('job summary', () => {
  it('counts every state, including the ones with nothing in them', () => {
    const summary = summarise(job([segment('DONE'), segment('BUILDING'), segment('BUILDING')]))

    expect(summary.counts.BUILDING).toBe(2)
    expect(summary.counts.DONE).toBe(1)
    expect(summary.counts.FAILED).toBe(0)
  })

  /**
   * Both need the same act from an operator — give this to somebody — even though a released
   * segment and a refused one arrived here for opposite reasons.
   */
  it('gathers what nobody is on, whichever way it got there', () => {
    const summary = summarise(
      job([segment('PENDING'), segment('FAILED'), segment('ASSIGNED'), segment('DONE')]),
    )

    expect(summary.waiting.map((one) => one.state)).toEqual(['PENDING', 'FAILED'])
  })

  it('reports progress against what the split actually contained', () => {
    const summary = summarise(job([segment('DONE', 100, 100), segment('BUILDING', 100, 25)]))

    expect(summary.placed).toBe(125)
    expect(summary.total).toBe(200)
    expect(summary.percent).toBe(62)
  })
})

/**
 * The figures that replaced an invented rate.
 *
 * The old ones multiplied builders by 38 blocks a minute — a constant with no basis — against a
 * schematic nobody had started. These divide what hosts actually reported by the time they have
 * been at it, which is a different kind of wrong when it is wrong: too few samples rather than a
 * fabrication.
 */
describe('job figures', () => {
  const started = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

  const job = (over: Partial<BuildJob>): BuildJob =>
    ({
      state: 'ACTIVE',
      startedAt: started(10),
      blocksPlaced: 0,
      totalBlocks: 1000,
      segments: [],
      ...over,
    }) as BuildJob

  it('sums what is placed and what there is to place', () => {
    const figures = jobFigures([
      job({ blocksPlaced: 300, totalBlocks: 1000 }),
      job({ blocksPlaced: 200, totalBlocks: 1000 }),
    ])

    expect(figures.placed).toBe(500)
    expect(figures.total).toBe(2000)
    expect(figures.percent).toBe(25)
  })

  /** Ten minutes at 600 blocks is sixty a minute, and 400 left is under seven more. */
  it('measures the rate from the time a job has been open', () => {
    const figures = jobFigures([job({ blocksPlaced: 600, totalBlocks: 1000, startedAt: started(10) })])

    expect(figures.perMinute).toBe(60)
    expect(figures.etaMinutes).toBe(7)
  })

  /**
   * A paused job keeps its blocks in the total — they are in the world — but the minutes it spent
   * stopped are not minutes anybody was working, so counting them would report a fleet as slower
   * than it is and give it an ETA it will beat.
   */
  it('rates only the jobs that are building', () => {
    const figures = jobFigures([
      job({ blocksPlaced: 600, totalBlocks: 1000, startedAt: started(10) }),
      job({ blocksPlaced: 500, totalBlocks: 1000, startedAt: started(600), state: 'PAUSED' }),
    ])

    expect(figures.placed).toBe(1100)
    expect(figures.perMinute).toBe(60)
  })

  /** A job seconds old has placed something over almost no time, which is a rate in the millions. */
  it('has no rate until there is time to divide by', () => {
    const figures = jobFigures([job({ blocksPlaced: 50, startedAt: started(0.01) })])

    expect(figures.perMinute).toBe(0)
    expect(figures.etaMinutes).toBeNull()
  })

  it('has no estimate for a fleet that has placed nothing', () => {
    const figures = jobFigures([job({ blocksPlaced: 0 })])

    expect(figures.perMinute).toBe(0)
    expect(figures.etaMinutes).toBeNull()
  })
})
