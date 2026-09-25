import { describe, expect, it } from 'vitest'

import { shortly, unitOf, Work } from '../src/agent/work.ts'

/**
 * What an agent knows about the piece it is holding.
 *
 * The rate and the estimate are the part worth testing: they are measured from what was reported,
 * and the cases that matter are the two where **no** estimate should be offered — a piece too new
 * to have a rate, and one that has stopped moving.
 */

const NOON = Date.parse('2026-09-25T12:00:00Z')

function building(total = 1000): Work {
  return new Work('build', 'north tower', 7, total, NOON)
}

describe('a piece being worked', () => {
  it('reads what was last reported', () => {
    const work = building()
    work.note(0, NOON)
    work.note(250, NOON + 10_000)

    expect(work.done).toBe(250)
    expect(work.left).toBe(750)
    expect(work.percent).toBe(25)
  })

  /** A piece with one block left in it is not finished, and 99% is the reading that says so. */
  it('rounds its percentage down', () => {
    const work = building()
    work.note(999, NOON)

    expect(work.percent).toBe(99)
  })

  it('measures its rate from what was reported', () => {
    const work = building()
    work.note(0, NOON)
    work.note(120, NOON + 60_000)

    expect(work.rate).toBeCloseTo(2)
    // 880 left at two a second.
    expect(work.etaMs).toBeCloseTo(440_000)
  })

  /**
   * The recent rate, not the average since it started: an agent that spent ten minutes stuck and
   * is now placing steadily has an average that describes neither.
   */
  it('forgets samples older than its window', () => {
    const work = building(10_000)
    work.note(0, NOON)
    // Nothing for three minutes, then a steady minute.
    work.note(0, NOON + 180_000)
    work.note(600, NOON + 240_000)

    expect(work.rate).toBeCloseTo(10)
  })

  /** An agent confidently saying "3 minutes" for the rest of the afternoon is the worse answer. */
  it('offers no estimate while it has nothing to base one on', () => {
    const fresh = building()
    expect(fresh.etaMs).toBeNull()

    fresh.note(0, NOON)
    expect(fresh.etaMs).toBeNull()

    // Two blocks in a minute is noise, not a rate.
    fresh.note(2, NOON + 60_000)
    expect(fresh.etaMs).toBeNull()
  })

  it('offers no estimate for a piece that has stopped moving', () => {
    const stalled = building()
    stalled.note(400, NOON)
    stalled.note(400, NOON + 120_000)

    expect(stalled.rate).toBeNull()
    expect(stalled.etaMs).toBeNull()
  })

  it('is no time at all when the piece is finished', () => {
    const work = building()
    work.note(0, NOON)
    work.note(1000, NOON + 100_000)

    expect(work.left).toBe(0)
    expect(work.etaMs).toBe(0)
  })
})

describe('how a reading is worded', () => {
  /** A number whose unit is wrong is worse than no number: a survey charts columns, not blocks. */
  it('names what the count is of, and counts one of them singular', () => {
    expect(unitOf('build', 1)).toBe('1 block')
    expect(unitOf('build', 4096)).toBe('4,096 blocks')
    expect(unitOf('survey', 1)).toBe('1 column')
    expect(unitOf('survey', 65_536)).toBe('65,536 columns')
  })

  it('writes a length of time somebody can read in a chat line', () => {
    expect(shortly(1_000)).toBe('1s')
    expect(shortly(45_000)).toBe('45s')
    expect(shortly(10 * 60_000)).toBe('10m')
    // Minutes as far as an hour and a half, because '80m' reads quicker than '1h 20m' does.
    expect(shortly(80 * 60_000)).toBe('80m')
    expect(shortly(100 * 60_000)).toBe('1h 40m')
    expect(shortly(3 * 60 * 60_000)).toBe('3h')
  })
})
