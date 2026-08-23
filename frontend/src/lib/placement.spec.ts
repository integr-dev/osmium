import { describe, expect, it } from 'vitest'
import { blocksToPlace, offsetOf, plannedMaterials, toWorld, type Substitution } from './placement'

describe('offsetOf', () => {
  it('is the distance from where the schematic thinks it is to where it is going', () => {
    // A placement is an anchor for the minimum corner, and the file has its own idea of where that
    // corner is. Subtracting the two is the whole of moving a build.
    expect(offsetOf({ x: 100, y: 64, z: -200 }, { x: 0, y: 0, z: 0 })).toEqual({ x: 100, y: 64, z: -200 })
    expect(offsetOf({ x: 100, y: 64, z: -200 }, { x: 40, y: 4, z: -50 })).toEqual({ x: 60, y: 60, z: -150 })
  })

  it('handles a schematic saved at negative coordinates', () => {
    // Perfectly ordinary: the file was saved wherever it was built, which is often not the origin.
    expect(offsetOf({ x: 0, y: 0, z: 0 }, { x: -128, y: 60, z: -64 })).toEqual({ x: 128, y: -60, z: 64 })
  })

  it('puts the minimum corner exactly where it was asked for', () => {
    const origin = { x: -8, y: 60, z: 4 }
    const placement = { x: 100, y: 64, z: -200 }

    // The property the whole thing exists for: place at P and the corner lands on P.
    expect(toWorld(origin, offsetOf(placement, origin))).toEqual(placement)
  })
})

describe('plannedMaterials', () => {
  const materials = [
    { name: 'minecraft:stone', blocks: 500 },
    { name: 'minecraft:diamond_block', blocks: 80 },
    { name: 'minecraft:gold_block', blocks: 40 },
    { name: 'minecraft:beacon', blocks: 4 },
  ]

  it('leaves an unsubstituted list alone, biggest first', () => {
    const planned = plannedMaterials(materials, [])

    expect(planned.map((entry) => entry.name)).toEqual([
      'minecraft:stone',
      'minecraft:diamond_block',
      'minecraft:gold_block',
      'minecraft:beacon',
    ])
    expect(planned.every((entry) => entry.substitutedFrom === undefined)).toBe(true)
  })

  it('merges everything replaced by the same block into one pile', () => {
    // Somebody counting out chests wants one number for stone, not three lines to add up.
    const rules: Substitution[] = [
      { from: 'minecraft:diamond_block', to: 'minecraft:stone' },
      { from: 'minecraft:gold_block', to: 'minecraft:stone' },
    ]

    const planned = plannedMaterials(materials, rules)
    const stone = planned.find((entry) => entry.name === 'minecraft:stone')!

    expect(stone.blocks).toBe(500 + 80 + 40)
    expect(stone.substitutedFrom).toEqual(['minecraft:diamond_block', 'minecraft:gold_block'])
    expect(planned.some((entry) => entry.name === 'minecraft:gold_block')).toBe(false)
  })

  it('keeps what is being left out, marked, rather than dropping it', () => {
    // What will not be placed is exactly what somebody wants to see before agreeing to it. A line
    // that silently vanished would read as a material the schematic never contained.
    const planned = plannedMaterials(materials, [{ from: 'minecraft:beacon', to: null }])
    const beacon = planned.find((entry) => entry.name === 'minecraft:beacon')!

    expect(beacon.omitted).toBe(true)
    expect(beacon.blocks).toBe(4)
  })

  it('does not fold an omitted block into one that keeps its own name', () => {
    // Two different fates for two blocks: one is left out, the other is untouched. Keying them the
    // same would have reported the hole as though it were being built.
    const planned = plannedMaterials(
      [
        { name: 'minecraft:stone', blocks: 500 },
        { name: 'minecraft:beacon', blocks: 4 },
      ],
      [{ from: 'minecraft:beacon', to: null }],
    )

    expect(planned).toHaveLength(2)
    expect(planned.find((entry) => entry.name === 'minecraft:stone')!.omitted).toBeUndefined()
    expect(planned.find((entry) => entry.name === 'minecraft:beacon')!.omitted).toBe(true)
  })

  it('merges into a block the schematic already contains', () => {
    // The common case: replace the expensive thing with something already in the build.
    const planned = plannedMaterials(materials, [
      { from: 'minecraft:diamond_block', to: 'minecraft:stone' },
    ])

    expect(planned.find((entry) => entry.name === 'minecraft:stone')!.blocks).toBe(580)
    expect(planned.filter((entry) => entry.name === 'minecraft:stone')).toHaveLength(1)
  })

  it('introduces a block the schematic did not contain', () => {
    const planned = plannedMaterials(materials, [
      { from: 'minecraft:diamond_block', to: 'minecraft:cobblestone' },
    ])

    const cobble = planned.find((entry) => entry.name === 'minecraft:cobblestone')!
    expect(cobble.blocks).toBe(80)
    expect(cobble.substitutedFrom).toEqual(['minecraft:diamond_block'])
  })

  it('ignores a rule for a block that is not in the schematic', () => {
    const planned = plannedMaterials(materials, [{ from: 'minecraft:netherite_block', to: 'minecraft:stone' }])

    expect(planned).toHaveLength(4)
    expect(planned.find((entry) => entry.name === 'minecraft:stone')!.blocks).toBe(500)
  })
})

describe('blocksToPlace', () => {
  it('counts what gets placed, not what the file contains', () => {
    const planned = plannedMaterials(
      [
        { name: 'minecraft:stone', blocks: 500 },
        { name: 'minecraft:beacon', blocks: 4 },
      ],
      [{ from: 'minecraft:beacon', to: null }],
    )

    // The number an estimate should be built on: the holes are not work.
    expect(blocksToPlace(planned)).toBe(500)
  })

  it('is unchanged by a substitution that only renames', () => {
    const planned = plannedMaterials(
      [
        { name: 'minecraft:stone', blocks: 500 },
        { name: 'minecraft:diamond_block', blocks: 80 },
      ],
      [{ from: 'minecraft:diamond_block', to: 'minecraft:stone' }],
    )

    expect(blocksToPlace(planned)).toBe(580)
  })
})
