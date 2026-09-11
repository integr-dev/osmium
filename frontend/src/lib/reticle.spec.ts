import { describe, expect, it } from 'vitest'

import { ARM, axisCross, cornerArms } from './reticle'

/** The flat triples, read back as the segments they describe. */
function segments(points: number[]): Array<{ from: number[]; to: number[] }> {
  const out: Array<{ from: number[]; to: number[] }> = []

  for (let at = 0; at < points.length; at += 6) {
    out.push({ from: points.slice(at, at + 3), to: points.slice(at + 3, at + 6) })
  }

  return out
}

describe('cornerArms', () => {
  it('draws three arms at each of the eight corners', () => {
    expect(segments(cornerArms()).length).toBe(24)
  })

  it('starts every arm on a corner of the block', () => {
    for (const { from } of segments(cornerArms())) {
      expect(from.every((side) => Math.abs(side) === 0.5)).toBe(true)
    }
  })

  it('runs each arm inwards along one axis only', () => {
    for (const { from, to } of segments(cornerArms(0.25))) {
      const moved = from.map((side, axis) => Math.abs(side - to[axis]!))

      expect(moved.filter((step) => step > 0).length).toBe(1)
      expect(Math.max(...moved)).toBeCloseTo(0.25, 10)

      // Inwards, so nothing sticks out of the block it is wrapping.
      expect(to.every((side) => Math.abs(side) <= 0.5)).toBe(true)
    }
  })

  it('leaves the middle of every edge open, which is the whole point', () => {
    // Two arms of a quarter on a one block edge leave half of it clear.
    for (const { to } of segments(cornerArms(ARM))) {
      expect(to.some((side) => Math.abs(side) < 0.5)).toBe(true)
    }
  })

  it('will not be talked into a wireframe cube', () => {
    // At half, arms from neighbouring corners would meet in the middle of each edge.
    for (const { from, to } of segments(cornerArms(4))) {
      const moved = from.map((side, axis) => Math.abs(side - to[axis]!))

      expect(Math.max(...moved)).toBeCloseTo(0.5, 10)
    }
  })

  it('survives being asked for nothing', () => {
    for (const { from, to } of segments(cornerArms(-1))) {
      expect(to).toEqual(from)
    }
  })
})

describe('axisCross', () => {
  it('crosses the middle once along each axis', () => {
    const arms = segments(axisCross())

    expect(arms.length).toBe(3)

    for (const axis of [0, 1, 2]) {
      const along = arms[axis]!
      expect(Math.abs(along.to[axis]! - along.from[axis]!)).toBeCloseTo(1, 10)

      // Flat in the other two, so it is a cross and not a box.
      for (const other of [0, 1, 2].filter((one) => one !== axis)) {
        expect(along.from[other]).toBe(0)
        expect(along.to[other]).toBe(0)
      }
    }
  })

  it('is centred, so scaling it about the pivot keeps it on the pivot', () => {
    for (const { from, to } of segments(axisCross())) {
      for (const axis of [0, 1, 2]) expect(from[axis]! + to[axis]!).toBeCloseTo(0, 10)
    }
  })
})
