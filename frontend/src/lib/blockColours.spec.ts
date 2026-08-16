import { describe, expect, it } from 'vitest'
import { blockColour, palette, UNKNOWN_COLOUR } from './blockColours'

/**
 * A partial table with a fallback, which is the only honest shape for this: a complete one would be
 * a generated data file kept in step with the game. What has to hold is that the table is reached
 * where it exists, that the fallback is stable, and that neither ever returns nothing.
 */
describe('blockColour', () => {
  it('gives the common materials something like their real colour', () => {
    // Not exact values — a voxel is at best one block and usually several — but the family has to
    // be right, or the model reads as a different building.
    expect(blockColour('minecraft:grass_block')).toBe('#5d8a3a')
    expect(blockColour('minecraft:stone')).toBe('#7f7f7f')
    expect(blockColour('minecraft:obsidian')).toBe('#15121e')
    expect(blockColour('minecraft:glass')).toBe('#a8d5e8')
  })

  it('matches the specific pattern before the general one', () => {
    // `dark_oak_planks` contains `oak`, and `deepslate_iron_ore` contains `deepslate`. First match
    // wins, so the order of the table is load-bearing — a general pattern moved above a specific
    // one turns every wood into oak.
    expect(blockColour('minecraft:dark_oak_planks')).not.toBe(blockColour('minecraft:oak_planks'))
    expect(blockColour('minecraft:light_blue_wool')).not.toBe(blockColour('minecraft:blue_wool'))
    expect(blockColour('minecraft:light_gray_wool')).not.toBe(blockColour('minecraft:gray_wool'))
    expect(blockColour('minecraft:deepslate_iron_ore')).not.toBe(blockColour('minecraft:iron_ore'))
  })

  it('gives every wool its own colour', () => {
    const wools = [
      'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
      'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
    ].map((colour) => blockColour(`minecraft:${colour}_wool`))

    // Sixteen distinct colours is most of what makes a coloured build readable at all.
    expect(new Set(wools).size).toBe(16)
  })

  it('answers for a block it has never heard of', () => {
    const colour = blockColour('somemod:strange_alloy_block')

    expect(colour).toMatch(/^hsl\(/)
    // Stable: the same block is the same colour in every schematic and across reloads. A random one
    // would make the model change every time it was opened.
    expect(blockColour('somemod:strange_alloy_block')).toBe(colour)
  })

  it('separates two blocks it has never heard of', () => {
    // The point of deriving rather than defaulting: unknowns should still read as different
    // materials rather than as one grey mass.
    expect(blockColour('somemod:alpha')).not.toBe(blockColour('somemod:beta'))
  })

  it('has a colour for a cell that never recorded a material', () => {
    // Everything analysed before cells carried a block name. It draws, and it claims nothing.
    expect(blockColour('')).toBe(UNKNOWN_COLOUR)
  })

  it('resolves a whole palette in order', () => {
    expect(palette(['', 'minecraft:stone'])).toEqual([UNKNOWN_COLOUR, '#7f7f7f'])
  })
})
