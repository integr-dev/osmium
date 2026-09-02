import { describe, expect, it } from 'vitest'
import { iconFor } from './itemIcons'

/**
 * The sheet is a square grid addressed by percentage, which is the one part of this worth testing:
 * the arithmetic is off-by-one prone in a way that shows up as every icon being subtly the wrong
 * one, rather than as an error.
 */
const sheet = { across: 4, tile: 16, items: { stone: 0, dirt: 5, last: 15 } }

describe('iconFor', () => {
  it('scales the sheet so one tile fills the square', () => {
    expect(iconFor(sheet, 'stone')?.size).toBe('400% 400%')
  })

  it('puts the first tile at the origin', () => {
    expect(iconFor(sheet, 'stone')?.position).toBe('0% 0%')
  })

  it('reads left to right, then down', () => {
    // Index 5 in a grid four wide is the second column of the second row, and the position runs
    // over the three gaps between four tiles rather than over the image.
    expect(iconFor(sheet, 'dirt')?.position).toBe(`${(1 / 3) * 100}% ${(1 / 3) * 100}%`)
  })

  it('puts the last tile at the far corner', () => {
    expect(iconFor(sheet, 'last')?.position).toBe('100% 100%')
  })

  it('has nothing for an item the sheet does not carry', () => {
    expect(iconFor(sheet, 'unobtainium')).toBeNull()
  })

  it('has nothing before the sheet has loaded', () => {
    expect(iconFor(null, 'stone')).toBeNull()
  })
})
