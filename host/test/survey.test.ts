import { describe, expect, it } from 'vitest'

import { viewChunks } from '../src/agent/bot.ts'
import { TILE } from '../src/agent/map.ts'
import { chunksIn, columnsCharted, missing, reachOf, sweep, type Footprint } from '../src/agent/survey/plan.ts'

/**
 * How a survey is flown.
 *
 * The thing worth testing is **coverage**: every chunk of the footprint has to end up within the
 * view distance of some point on the flight, or the map comes back striped. So most of what is here
 * checks the plan against the same arithmetic the server uses to decide what to send.
 */

const box = (west: number, north: number, east: number, south: number): Footprint => ({ west, north, east, south })

/** Every chunk of [area] that no point on [legs] would have the server send. */
function unseen(area: Footprint, legs: readonly { x: number; z: number }[], reach: number): string[] {
  return chunksIn(area).filter((key) => {
    const [x, z] = key.split(',').map(Number)
    // A chunk is sent when any part of it is within reach of a point actually flown over, which
    // includes the stretches between the ends of a leg.
    return !legs.some((leg, index) => {
      const before = legs[index - 1] ?? leg
      const west = Math.min(before.x, leg.x) - reach
      const east = Math.max(before.x, leg.x) + reach
      const north = Math.min(before.z, leg.z) - reach
      const south = Math.max(before.z, leg.z) + reach

      return (
        x! * TILE + TILE - 1 >= west && x! * TILE <= east && z! * TILE + TILE - 1 >= north && z! * TILE <= south
      )
    })
  })
}

describe('what the server will send', () => {
  it('is a chunk short of what it says, and never nothing', () => {
    expect(reachOf(12)).toBe(11 * TILE)
    expect(reachOf(1)).toBe(TILE)
    expect(reachOf(0)).toBe(TILE)
  })

  it('is the lesser of what we asked for and what the server allows', () => {
    expect(viewChunks({ settings: { viewDistance: 16 }, game: { serverViewDistance: 8 } })).toBe(8)
    expect(viewChunks({ settings: { viewDistance: 4 }, game: { serverViewDistance: 32 } })).toBe(4)
  })

  it('reads mineflayer own names, and falls back to its default', () => {
    expect(viewChunks({ settings: { viewDistance: 'far' } })).toBe(12)
    expect(viewChunks({ settings: { viewDistance: 'tiny' } })).toBe(6)
    expect(viewChunks({})).toBe(12)
  })

  /** A server can say anything, and a silly number flies lines that miss the ground between them. */
  it('refuses a number no server could mean', () => {
    expect(viewChunks({ settings: { viewDistance: 0 } })).toBe(2)
    expect(viewChunks({ settings: { viewDistance: 1000 } })).toBe(32)
  })
})

describe('the flight over a footprint', () => {
  const reach = reachOf(8)

  it('covers every chunk of it', () => {
    const area = box(0, 0, 40 * TILE, 24 * TILE)

    expect(unseen(area, sweep(area, reach), reach)).toEqual([])
  })

  it('covers a footprint whose sides are not whole chunks', () => {
    const area = box(-137, 42, 613, 918)

    expect(unseen(area, sweep(area, reach), reach)).toEqual([])
  })

  /** The case a divided survey usually hands an agent: a long thin strip. */
  it('covers a strip narrower than what the agent sees', () => {
    const area = box(0, 0, 60 * TILE, 3 * TILE)
    const legs = sweep(area, reach)

    expect(unseen(area, legs, reach)).toEqual([])
    // One line down the middle of it: two lines would read the same ground twice.
    expect(legs).toHaveLength(2)
  })

  it('hovers once over a footprint smaller than what the agent sees', () => {
    const area = box(0, 0, TILE, TILE)

    expect(sweep(area, reach)).toEqual([{ x: 8, z: 8 }])
  })

  /** Every turn is an agent stopping and starting again, so the long way round has fewer of them. */
  it('runs its lines along the longer side', () => {
    const wide = sweep(box(0, 0, 100 * TILE, 20 * TILE), reach)
    const tall = sweep(box(0, 0, 20 * TILE, 100 * TILE), reach)

    expect(wide[0]!.z).toBe(wide[1]!.z)
    expect(tall[0]!.x).toBe(tall[1]!.x)
  })

  /** Snaked: the end of each line is the start of the next, and the agent is already there. */
  it('does not fly back to the same end for every line', () => {
    const legs = sweep(box(0, 0, 60 * TILE, 40 * TILE), reach)

    expect(legs[1]!.x).toBe(legs[2]!.x)
  })

  /**
   * The ends stop short of the edge: the chunks beyond were sent while the agent was still on its
   * way there, so flying to the corner is flying to be sent what has already arrived.
   */
  it('stops short of the ends of its lines', () => {
    const area = box(0, 0, 60 * TILE, 8 * TILE)
    const [first, second] = sweep(area, reach)

    expect(first!.x).toBe(reach)
    expect(second!.x).toBe(60 * TILE - 1 - reach)
  })

  it('has nothing to fly over an empty footprint', () => {
    expect(sweep(box(0, 0, 0, 0), reach)).toEqual([])
  })
})

describe('what has been charted', () => {
  it('counts a chunk only where it lies inside the footprint', () => {
    const area = box(0, 0, TILE + 4, TILE)

    // The whole of the first chunk, and four columns of the second.
    expect(columnsCharted(area, ['0,0'])).toBe(TILE * TILE)
    expect(columnsCharted(area, ['1,0'])).toBe(4 * TILE)
    // Nowhere near it.
    expect(columnsCharted(area, ['9,9'])).toBe(0)
  })

  it('lists what the flight missed, nearest first', () => {
    const area = box(0, 0, 3 * TILE, TILE)
    const charted = new Set(['1,0'])

    const holes = missing(area, charted, { x: 2 * TILE, z: 0 })

    expect(holes).toHaveLength(2)
    expect(holes[0]!.x).toBeGreaterThan(holes[1]!.x)
  })
})
