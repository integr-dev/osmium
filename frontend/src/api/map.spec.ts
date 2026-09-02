import { describe, expect, it } from 'vitest'

import { MAX_TILES, areaAround, tilesIn, withinCap, type Area } from './map'

/**
 * The window a map screen asks for.
 *
 * `withinCap` is the piece with a real failure behind it: a window it shrank could come back the
 * same size, and the backend then refused the request with an error the operator saw instead of a
 * map. So the property under test is not "it shrinks" but "whatever comes out fits".
 */

const area = (minX: number, minZ: number, maxX: number, maxZ: number): Area => ({ minX, minZ, maxX, maxZ })

describe('withinCap', () => {
  it('leaves a window that already fits exactly as it is', () => {
    const asked = area(-10, -10, 10, 10)

    expect(withinCap(asked)).toEqual(asked)
  })

  /**
   * The one that broke. 81 by 51 is 4131 chunks against a cap of 4096 - a ratio of 0.996, which put
   * both halves back at 40 and 25, and 2*40+1 by 2*25+1 is the same 81 by 51 that did not fit.
   */
  it('shrinks a window that is only just too large', () => {
    const shrunk = withinCap(area(0, 0, 80, 50))

    expect(tilesIn(area(0, 0, 80, 50))).toBeGreaterThan(MAX_TILES)
    expect(tilesIn(shrunk)).toBeLessThanOrEqual(MAX_TILES)
  })

  it('produces a window that fits, at every size and shape', () => {
    // Square, wide, tall, enormous, and the awkward ones a pixel over the line.
    const shapes: Array<[number, number]> = [
      [1, 1], [64, 64], [65, 64], [81, 51], [4097, 1], [1, 4097],
      [200, 21], [21, 200], [1000, 1000], [63, 65], [64, 65], [2048, 3],
    ]

    for (const [width, depth] of shapes) {
      const asked = area(0, 0, width - 1, depth - 1)
      const got = withinCap(asked)

      expect(tilesIn(got), `${width} by ${depth} came back as ${tilesIn(got)} chunks`)
        .toBeLessThanOrEqual(MAX_TILES)
      expect(got.minX, `${width} by ${depth} is inside out`).toBeLessThanOrEqual(got.maxX)
      expect(got.minZ, `${width} by ${depth} is inside out`).toBeLessThanOrEqual(got.maxZ)
    }
  })

  it('keeps the middle of what was asked for', () => {
    // Shrinking about a corner would walk the map away from wherever the operator was looking.
    const got = withinCap(area(100, 200, 180, 250))

    expect(Math.round((got.minX + got.maxX) / 2)).toBe(140)
    expect(Math.round((got.minZ + got.maxZ) / 2)).toBe(225)
  })

  it('keeps the shape of what was asked for', () => {
    // The window is the shape of the viewport, so a shrunk one has to stay that shape: taking it
    // off one side alone would fetch a tall strip for a wide screen and leave the sides blank.
    const got = withinCap(area(0, 0, 999, 99))

    const width = got.maxX - got.minX + 1
    const depth = got.maxZ - got.minZ + 1
    expect(tilesIn(got)).toBeLessThanOrEqual(MAX_TILES)
    expect(width / depth).toBeGreaterThan(5)
    expect(width / depth).toBeLessThan(20)
  })

  it('never returns an empty window', () => {
    const got = withinCap(area(0, 0, 100_000, 100_000))

    expect(tilesIn(got)).toBeGreaterThan(0)
    expect(tilesIn(got)).toBeLessThanOrEqual(MAX_TILES)
  })
})

describe('areaAround', () => {
  it('covers the blocks asked for, with a chunk of margin', () => {
    // Blocks 0..31 are chunks 0..1; a margin of one reaches -1..2.
    expect(areaAround(0, 0, 31, 31)).toEqual({ minX: -1, minZ: -1, maxX: 2, maxZ: 2 })
  })

  it('floors on the negative side, where rounding towards zero would be a chunk out', () => {
    expect(areaAround(-1, -1, -1, -1, 0)).toEqual({ minX: -1, minZ: -1, maxX: -1, maxZ: -1 })
    expect(areaAround(-16, -16, -16, -16, 0)).toEqual({ minX: -1, minZ: -1, maxX: -1, maxZ: -1 })
    expect(areaAround(-17, -17, -17, -17, 0)).toEqual({ minX: -2, minZ: -2, maxX: -2, maxZ: -2 })
  })
})
