import { describe, expect, it } from 'vitest'

import { formatPlace, parsePlace } from './mapCoords'

/**
 * The box this backs exists because coordinates arrive from somewhere else - F3, chat, a ticket -
 * so what matters is the shapes they actually arrive in, not one shape it insists on.
 */

describe('parsePlace', () => {
  it('reads a plain pair, however it is separated', () => {
    for (const raw of ['192 208', '192,208', '192, 208', '  192   208  ', '192/208']) {
      expect(parsePlace(raw), raw).toEqual({ x: 192, z: 208 })
    }
  })

  /**
   * The case worth being deliberate about. F3 gives three numbers and the middle one is the height:
   * somebody pasting it means the place, not a place at x=192, z=64.
   */
  it('drops the height from a three-number F3 paste', () => {
    expect(parsePlace('192 64 208')).toEqual({ x: 192, z: 208 })
    expect(parsePlace('-1487 71 302')).toEqual({ x: -1487, z: 302 })
  })

  it('reads negatives on either axis', () => {
    expect(parsePlace('-192 -208')).toEqual({ x: -192, z: -208 })
    expect(parsePlace('192 -208')).toEqual({ x: 192, z: -208 })
  })

  it('ignores labels around the numbers', () => {
    expect(parsePlace('x=192 z=208')).toEqual({ x: 192, z: 208 })
    expect(parsePlace('X: 192, Z: 208')).toEqual({ x: 192, z: 208 })
  })

  it('rounds to a block, because a pixel is a block', () => {
    expect(parsePlace('192.7 208.2')).toEqual({ x: 193, z: 208 })
    expect(parsePlace('-0.5 0.4')).toEqual({ x: -0, z: 0 })
  })

  it('refuses what is not a coordinate rather than guessing', () => {
    // One number is half an answer; four is not a coordinate; none is nothing.
    expect(parsePlace('192')).toBeNull()
    expect(parsePlace('1 2 3 4')).toBeNull()
    expect(parsePlace('')).toBeNull()
    expect(parsePlace('spawn')).toBeNull()
  })

  it('reads zero as a coordinate rather than as absent', () => {
    expect(parsePlace('0 0')).toEqual({ x: 0, z: 0 })
  })
})

describe('formatPlace', () => {
  it('writes what the box will read back', () => {
    const written = formatPlace({ x: -1487.4, z: 302.6 })

    expect(written).toBe('-1487, 303')
    expect(parsePlace(written)).toEqual({ x: -1487, z: 303 })
  })
})
