import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ORDER,
  formatOrder,
  parseOrder,
  reorder,
  reverse,
  sequence,
  type PlacementOrder,
} from './placementOrder'

const order = (text: string): PlacementOrder => parseOrder(text)!

describe('the wire form', () => {
  it('writes and reads the same order back', () => {
    expect(formatOrder(DEFAULT_ORDER)).toBe('y+z+x+')
    expect(parseOrder('y+z+x+')).toEqual(DEFAULT_ORDER)
    expect(formatOrder(order('x-z+y-s'))).toBe('x-z+y-s')
  })

  it('reads a serpentine order as one', () => {
    expect(order('y+z+x+s').serpentine).toBe(true)
    expect(order('y+z+x+').serpentine).toBe(false)
  })

  /** Repairing one would place blocks in an order nobody asked for, on hours of an agent's work. */
  it('refuses anything that is not three named axes', () => {
    expect(parseOrder('')).toBeNull()
    expect(parseOrder(null)).toBeNull()
    expect(parseOrder('y+z+')).toBeNull()
    expect(parseOrder('y+y-x+')).toBeNull()
    expect(parseOrder('y+z+w+')).toBeNull()
    expect(parseOrder('y*z+x+')).toBeNull()
  })

  it('reads what a host or a column would hand back', () => {
    expect(parseOrder(' Y+Z+X+S ')).toEqual({ ...DEFAULT_ORDER, serpentine: true })
  })
})

describe('changing an order', () => {
  it('moves an axis and closes the gap behind it', () => {
    const moved = reorder(DEFAULT_ORDER, 'x', 0)

    expect(formatOrder(moved)).toBe('x+y+z+')
  })

  it('turns one axis around and leaves the rest', () => {
    expect(formatOrder(reverse(DEFAULT_ORDER, 'z'))).toBe('y+z-x+')
  })
})

describe('the sequence', () => {
  const at = (cells: { x: number; y: number; z: number }[], index: number) => cells[index]!

  it('runs the innermost axis first and the outermost last', () => {
    const cells = sequence({ x: 2, y: 2, z: 2 }, order('y+z+x+'))

    expect(cells).toHaveLength(8)
    expect(at(cells, 0)).toEqual({ x: 0, y: 0, z: 0 })
    expect(at(cells, 1)).toEqual({ x: 1, y: 0, z: 0 })
    expect(at(cells, 2)).toEqual({ x: 0, y: 0, z: 1 })
    expect(at(cells, 4)).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('runs an axis backwards when it is pointed that way', () => {
    const cells = sequence({ x: 2, y: 1, z: 1 }, order('y+z+x-'))

    expect(cells.map((cell) => cell.x)).toEqual([1, 0])
  })

  it('starts at the top when the outer sweep runs down', () => {
    const cells = sequence({ x: 1, y: 3, z: 1 }, order('y-z+x+'))

    expect(cells.map((cell) => cell.y)).toEqual([2, 1, 0])
  })

  /** The agent finishes a row where it is and turns around, rather than walking back empty-handed. */
  it('snakes the innermost sweep, and carries the snake between rows', () => {
    const cells = sequence({ x: 3, y: 1, z: 2 }, order('y+z+x+s'))

    expect(cells.map((cell) => cell.x)).toEqual([0, 1, 2, 2, 1, 0])
  })

  it('carries the snake from the end of one plane into the next', () => {
    const cells = sequence({ x: 2, y: 2, z: 1 }, order('y+z+x+s'))

    expect(cells.map((cell) => `${cell.x}${cell.y}`)).toEqual(['00', '10', '11', '01'])
  })

  it('visits every cell exactly once, whatever the order', () => {
    for (const text of ['y+z+x+', 'x-y+z-', 'z+x+y-s', 'y-x-z+s']) {
      const cells = sequence({ x: 3, y: 2, z: 4 }, order(text))
      const seen = new Set(cells.map((cell) => `${cell.x},${cell.y},${cell.z}`))

      expect(cells, text).toHaveLength(24)
      expect(seen.size, text).toBe(24)
    }
  })

  it('has nothing to visit in an empty box', () => {
    expect(sequence({ x: 0, y: 4, z: 4 }, DEFAULT_ORDER)).toEqual([])
  })
})

/**
 * Snaking the layers, which is the same idea as snaking the rows one axis out: each layer starts
 * where the one below it finished, instead of the agent crossing the whole build to get back to
 * the corner every layer begins at.
 */
describe('snaking the layers', () => {
  it('writes and reads the second s', () => {
    expect(formatOrder(order('y+z+x+ss'))).toBe('y+z+x+ss')
    expect(order('y+z+x+ss').snakeLayers).toBe(true)
    expect(order('y+z+x+s').snakeLayers).toBe(false)
    expect(order('y+z+x+').snakeLayers).toBe(false)
  })

  it('starts each layer where the last one ended', () => {
    const cells = sequence({ x: 2, y: 2, z: 2 }, order('y+z+x+ss'))
    const at = (step: number) => `${cells[step]!.x},${cells[step]!.y},${cells[step]!.z}`

    // The last cell of the lower layer and the first of the upper one are the same column.
    expect(at(3)).toBe('0,0,1')
    expect(at(4)).toBe('0,1,1')
  })

  it('leaves a layer alone without it', () => {
    const cells = sequence({ x: 2, y: 2, z: 2 }, order('y+z+x+s'))
    const at = (step: number) => `${cells[step]!.x},${cells[step]!.y},${cells[step]!.z}`

    expect(at(3)).toBe('0,0,1')
    expect(at(4)).toBe('0,1,0')
  })

  it('visits every cell exactly once, whatever the order', () => {
    for (const text of ['y+z+x+ss', 'x-y+z-ss', 'z+x+y-ss']) {
      const cells = sequence({ x: 3, y: 2, z: 4 }, order(text))
      const seen = new Set(cells.map((cell) => `${cell.x},${cell.y},${cell.z}`))

      expect(cells, text).toHaveLength(24)
      expect(seen.size, text).toBe(24)
    }
  })
})
