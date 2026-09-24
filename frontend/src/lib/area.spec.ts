import { describe, expect, it } from 'vitest'
import {
  afterShiftPress,
  areaBetween,
  areaFromQuery,
  areaNote,
  areaQuery,
  areaSize,
  areaUnderway,
  cubeEdges,
  withoutArea,
} from './area'

describe('an area dragged out', () => {
  it('spans the same box whichever way the drag went', () => {
    const one = areaBetween({ x: 10, z: -4 }, { x: -2, z: 7 })
    const other = areaBetween({ x: -2, z: 7 }, { x: 10, z: -4 })

    expect(one).toEqual({ west: -2, east: 10, north: -4, south: 7 })
    expect(other).toEqual(one)
  })

  /** Both ends are blocks somebody pointed at, so both are in it - and a drag onto itself is one block. */
  it('counts both corners in, so a drag onto one block is that block', () => {
    expect(areaSize(areaBetween({ x: 3, z: 3 }, { x: 3, z: 3 }))).toEqual({ width: 1, depth: 1 })
    expect(areaSize(areaBetween({ x: 0, z: 0 }, { x: 4, z: 1 }))).toEqual({ width: 5, depth: 2 })
  })

  it('keeps height only when both ends had one', () => {
    expect(areaBetween({ x: 0, y: 70, z: 0 }, { x: 1, y: 64, z: 1 })).toMatchObject({ low: 64, high: 70 })
    expect(areaBetween({ x: 0, y: 70, z: 0 }, { x: 1, y: null, z: 1 })).not.toHaveProperty('low')
    expect(areaSize(areaBetween({ x: 0, y: 70, z: 0 }, { x: 1, y: 64, z: 1 }))).toEqual({ width: 2, depth: 2, height: 7 })
  })

  describe('chosen with shift', () => {
    const a = { x: 0, y: 64, z: 0 }
    const b = { x: 3, y: 66, z: 5 }

    /** An area too big to drag across the screen at one zoom is chosen a corner at a time. */
    it('takes a click as one corner and the next click as the other', () => {
      const first = afterShiftPress(null, { start: a, end: a, moved: false })
      expect(first).toEqual({ waiting: a, chosen: null })

      const second = afterShiftPress(first.waiting, { start: b, end: b, moved: false })
      expect(second).toEqual({ waiting: null, chosen: areaBetween(a, b) })
    })

    it('takes a drag as both corners at once, even with a first corner waiting', () => {
      expect(afterShiftPress(null, { start: a, end: b, moved: true })).toEqual({ waiting: null, chosen: areaBetween(a, b) })

      const waiting = { x: -10, y: 60, z: -10 }
      expect(afterShiftPress(waiting, { start: a, end: b, moved: true }).chosen).toEqual(areaBetween(a, b))
    })

    it('draws from the waiting corner to the pointer, and from where a drag began while it drags', () => {
      expect(areaUnderway(a, null, b)).toEqual(areaBetween(a, b))
      expect(areaUnderway(null, { start: a, end: a, moved: true }, b)).toEqual(areaBetween(a, b))
      expect(areaUnderway({ x: -10, z: -10 }, { start: a, end: a, moved: true }, b)).toEqual(areaBetween(a, b))
      expect(areaUnderway(null, null, b)).toEqual(areaBetween(b, b))
    })
  })

  it('draws a box as twelve edges one block long, each along one axis', () => {
    const ends = cubeEdges()
    expect(ends).toHaveLength(12 * 6)

    for (let at = 0; at < ends.length; at += 6) {
      const along = [0, 1, 2].map((axis) => Math.abs(ends[at + 3 + axis]! - ends[at + axis]!))
      expect(along.sort()).toEqual([0, 0, 1])
    }
  })

  it('names both corners and the size, with height where there is one', () => {
    expect(areaNote(areaBetween({ x: 5, z: -1 }, { x: 1, z: 2 }))).toBe('1, -1 → 5, 2 · 5 × 4')
    expect(areaNote(areaBetween({ x: 0, y: 64, z: 0 }, { x: 2, y: 65, z: 3 }))).toBe('0, 64, 0 → 2, 65, 3 · 3 × 2 × 4')
  })
})

/**
 * The map handing a stretch of the world to the survey tab.
 *
 * Everything here is about a query string, which anybody can type - so what is tested is mostly
 * what it refuses.
 */
describe('an area handed to the survey tab', () => {
  const handoff = {
    area: areaBetween({ x: 10, z: -4 }, { x: -2, z: 7 }),
    server: 'play.example',
    dimension: 'overworld',
  }

  it('comes back as it went out', () => {
    expect(areaFromQuery(areaQuery(handoff))).toEqual(handoff)
  })

  it('sorts corners typed the wrong way round', () => {
    const query = { west: '10', north: '7', east: '-2', south: '-4', server: 'a', world: 'overworld' }

    expect(areaFromQuery(query)?.area).toEqual({ west: -2, east: 10, north: -4, south: 7 })
  })

  it('is nothing at all unless every part of it is there and is a number', () => {
    const whole = areaQuery(handoff)

    for (const key of Object.keys(whole)) {
      const missing = { ...whole }
      delete missing[key]
      expect(areaFromQuery(missing)).toBeNull()
    }

    expect(areaFromQuery({ ...whole, west: '' })).toBeNull()
    expect(areaFromQuery({ ...whole, west: 'over there' })).toBeNull()
    expect(areaFromQuery({ ...whole, west: '1.5' })).toBeNull()
    // A repeated parameter arrives as an array.
    expect(areaFromQuery({ ...whole, north: ['1', '2'] })).toBeNull()
  })

  it('leaves the rest of the query alone when it is cleared', () => {
    expect(withoutArea({ ...areaQuery(handoff), tab: 'map', denied: 'agent.run' })).toEqual({
      tab: 'map',
      denied: 'agent.run',
    })
  })
})
