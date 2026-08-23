import { describe, expect, it } from 'vitest'
import { percentOf, summarise } from './jobs'
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
