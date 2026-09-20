import { describe, expect, it } from 'vitest'

import { DEFAULT_ORDER, formatOrder, orderFrom, parseOrder, positions } from '../src/agent/order.ts'

const order = (text: string) => parseOrder(text)!
const walk = (min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }, text: string) =>
  [...positions(min, max, order(text))].map((at) => `${at.x},${at.y},${at.z}`)

describe('reading an order', () => {
  it('reads the wire form back', () => {
    expect(parseOrder('y+z+x+')).toEqual(DEFAULT_ORDER)
    expect(formatOrder(order('x-z+y-s'))).toBe('x-z+y-s')
    expect(order('y+z+x+s').serpentine).toBe(true)
  })

  it('is not an order unless every axis is named once, with a direction', () => {
    for (const nonsense of ['', 'y+z+', 'y+y-x+', 'y+z+w+', 'y*z+x+', 'yzx']) {
      expect(parseOrder(nonsense), nonsense).toBeUndefined()
    }
  })

  /**
   * Strict on the backend, lenient here: by the time a command arrives the piece is assigned, and
   * refusing it over a string this build cannot read would strand the work.
   */
  it('builds in the default order rather than refusing the piece', () => {
    expect(orderFrom(undefined)).toEqual(DEFAULT_ORDER)
    expect(orderFrom(null)).toEqual(DEFAULT_ORDER)
    expect(orderFrom('sideways')).toEqual(DEFAULT_ORDER)
    expect(orderFrom(42)).toEqual(DEFAULT_ORDER)
    expect(orderFrom('y-x+z-')).toEqual(order('y-x+z-'))
  })
})

describe('walking a box', () => {
  const one = { x: 0, y: 0, z: 0 }

  it('includes both corners', () => {
    expect(walk(one, one, 'y+z+x+')).toEqual(['0,0,0'])
    expect(walk(one, { x: 1, y: 0, z: 0 }, 'y+z+x+')).toEqual(['0,0,0', '1,0,0'])
  })

  it('runs the innermost sweep first and the outermost last', () => {
    const cells = walk(one, { x: 1, y: 1, z: 1 }, 'y+z+x+')

    expect(cells).toEqual(['0,0,0', '1,0,0', '0,0,1', '1,0,1', '0,1,0', '1,1,0', '0,1,1', '1,1,1'])
  })

  it('runs an axis from the far end when it is pointed that way', () => {
    expect(walk(one, { x: 2, y: 0, z: 0 }, 'y+z+x-')).toEqual(['2,0,0', '1,0,0', '0,0,0'])
  })

  it('starts at the top when the outer sweep runs down', () => {
    expect(walk({ x: 0, y: 64, z: 0 }, { x: 0, y: 66, z: 0 }, 'y-z+x+')).toEqual(['0,66,0', '0,65,0', '0,64,0'])
  })

  /** The agent finishes a row where it stands and turns around, rather than walking back empty. */
  it('snakes the innermost sweep, carrying the turn between rows', () => {
    expect(walk(one, { x: 2, y: 0, z: 1 }, 'y+z+x+s')).toEqual([
      '0,0,0',
      '1,0,0',
      '2,0,0',
      '2,0,1',
      '1,0,1',
      '0,0,1',
    ])
  })

  it('takes the corners in either order', () => {
    expect(walk({ x: 2, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 'y+z+x+')).toEqual(['0,0,0', '1,0,0', '2,0,0'])
  })

  it('visits every block of a box exactly once, whatever the order', () => {
    for (const text of ['y+z+x+', 'x-y+z-', 'z+x+y-s', 'y-x-z+s']) {
      const cells = walk({ x: -2, y: 60, z: 7 }, { x: 0, y: 62, z: 10 }, text)

      expect(cells, text).toHaveLength(3 * 3 * 4)
      expect(new Set(cells).size, text).toBe(3 * 3 * 4)
    }
  })

  /** A piece of a real build is millions of blocks: the walk has to hand them out one at a time. */
  it('is lazy enough to ask for the first block of a huge piece', () => {
    const walking = positions({ x: 0, y: 0, z: 0 }, { x: 999, y: 255, z: 999 }, DEFAULT_ORDER)

    expect(walking.next().value).toEqual({ x: 0, y: 0, z: 0 })
  })
})

/**
 * Snaking the layers: the middle sweep runs back the way it came from one layer to the next, so a
 * layer starts where the one below it finished instead of at the corner every layer began at.
 */
describe('snaking the layers', () => {
  it('reads and writes the second s', () => {
    expect(order('y+z+x+ss').snakeLayers).toBe(true)
    expect(order('y+z+x+ss').serpentine).toBe(true)
    expect(order('y+z+x+s').snakeLayers).toBe(false)
    expect(formatOrder(order('y+z+x+ss'))).toBe('y+z+x+ss')
  })

  it('rises straight into the next layer instead of crossing back', () => {
    const snaking = walk({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, 'y+z+x+ss')
    const rows = walk({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, 'y+z+x+s')

    // The last block of the lower layer, and the first of the upper one.
    expect([snaking[3], snaking[4]]).toEqual(['0,0,1', '0,1,1'])
    expect([rows[3], rows[4]]).toEqual(['0,0,1', '0,1,0'])
  })

  it('still visits every block of a box exactly once', () => {
    for (const text of ['y+z+x+ss', 'x-y+z-ss', 'z+x+y-ss']) {
      const cells = walk({ x: -2, y: 60, z: 7 }, { x: 0, y: 62, z: 10 }, text)

      expect(cells, text).toHaveLength(3 * 3 * 4)
      expect(new Set(cells).size, text).toBe(3 * 3 * 4)
    }
  })

  it('builds bottom to top all the same', () => {
    const heights = walk({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 1 }, 'y+z+x+ss').map((at) => Number(at.split(',')[1]))

    expect(heights).toEqual([...heights].sort((one, two) => one - two))
  })
})
