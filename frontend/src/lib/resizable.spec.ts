import { describe, expect, it } from 'vitest'
import { clampWidth, nextWidth } from './resizable'

/**
 * The two panels are mirror images, and the sign is the whole trick: dragging right widens the one
 * on the left and narrows the one on the right. Getting it backwards is not something a type checker
 * can see.
 */
describe('dragging a handle', () => {
  const MIN = 200
  const MAX = 600

  it('widens a left-hand panel when dragged right', () => {
    expect(nextWidth(300, 50, 'right', MIN, MAX)).toBe(350)
    expect(nextWidth(300, -50, 'right', MIN, MAX)).toBe(250)
  })

  it('narrows a right-hand panel when dragged right', () => {
    expect(nextWidth(300, 50, 'left', MIN, MAX)).toBe(250)
    expect(nextWidth(300, -50, 'left', MIN, MAX)).toBe(350)
  })

  it('stops at the ends rather than inverting the panel', () => {
    expect(nextWidth(300, -1000, 'right', MIN, MAX)).toBe(MIN)
    expect(nextWidth(300, 1000, 'right', MIN, MAX)).toBe(MAX)
  })
})

describe('clamping', () => {
  it('rounds, so a fractional pointer position does not reach the style attribute', () => {
    expect(clampWidth(300.6, 200, 600)).toBe(301)
  })

  /** A stored width from a wider screen, or from before a limit changed. */
  it('brings a remembered width back inside the limits', () => {
    expect(clampWidth(9000, 200, 600)).toBe(600)
    expect(clampWidth(10, 200, 600)).toBe(200)
  })
})
