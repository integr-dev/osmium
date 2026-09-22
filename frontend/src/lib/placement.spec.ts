import { describe, expect, it } from 'vitest'
import { blockId } from './blockNames'
import {
  blocksToPlace,
  footprintOf,
  offsetOf,
  placeBox,
  plannedMaterials,
  sameSubstitutions,
  quarterOf,
  toWorld,
  type Substitution,
} from './placement'

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

  /**
   * The file names blocks `minecraft:stone`; the picker stores `stone`. They are the same block, and
   * a plain string compare silently substituted nothing at all — the rule was there, the list did
   * not change, and nothing said why.
   */
  it('matches a rule to a block whatever the namespace on either side', () => {
    // A bare rule against a namespaced material list, which is exactly what the picker produces.
    const bare = plannedMaterials(materials, [{ from: 'diamond_block', to: 'stone' }])
    const stone = bare.filter((entry) => blockId(entry.name) === 'stone')

    expect(stone).toHaveLength(1)
    expect(stone[0].blocks).toBe(580)
    expect(stone[0].substitutedFrom).toEqual(['minecraft:diamond_block'])

    // And the other way round: a namespaced rule against a bare material list.
    const namespaced = plannedMaterials(
      [{ name: 'stone', blocks: 500 }],
      [{ from: 'minecraft:stone', to: 'minecraft:dirt' }],
    )
    expect(namespaced[0].name).toBe('minecraft:dirt')
    expect(namespaced[0].substitutedFrom).toEqual(['stone'])
  })

  it('still merges into one pile when the two sides are written differently', () => {
    const planned = plannedMaterials(materials, [
      { from: 'minecraft:diamond_block', to: 'stone' },
      { from: 'gold_block', to: 'minecraft:stone' },
    ])

    // Three ways of writing stone, one pile: 500 + 80 + 40.
    const stone = planned.filter((entry) => /stone/.test(entry.name))
    expect(stone).toHaveLength(1)
    expect(stone[0].blocks).toBe(620)
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

/**
 * A freshly saved plan reported itself as still unsaved, and the comparison was the reason: the
 * draft holds what the picker and the material list gave it, the backend hands back what it stored.
 */
describe('sameSubstitutions', () => {
  it('ignores the namespace, which the two sides spell differently', () => {
    // The draft seeds a rule from the material list, so it carries `minecraft:`; the backend stores
    // every rule on the bare id so its one-rule-per-block constraint means what it says.
    expect(
      sameSubstitutions(
        [{ from: 'minecraft:diamond_block', to: 'minecraft:stone' }],
        [{ from: 'diamond_block', to: 'stone' }],
      ),
    ).toBe(true)
  })

  it('ignores the order, since a set of rules is not different for being listed differently', () => {
    expect(
      sameSubstitutions(
        [
          { from: 'gold_block', to: 'stone' },
          { from: 'diamond_block', to: 'stone' },
        ],
        [
          { from: 'diamond_block', to: 'stone' },
          { from: 'gold_block', to: 'stone' },
        ],
      ),
    ).toBe(true)
  })

  it('still notices a real difference', () => {
    expect(
      sameSubstitutions(
        [{ from: 'diamond_block', to: 'stone' }],
        [{ from: 'diamond_block', to: 'cobblestone' }],
      ),
    ).toBe(false)

    // Placing nothing is a rule, not an absence, so it is not the same as replacing with something.
    expect(
      sameSubstitutions(
        [{ from: 'beacon', to: null }],
        [{ from: 'beacon', to: 'stone' }],
      ),
    ).toBe(false)

    expect(sameSubstitutions([{ from: 'beacon', to: null }], [])).toBe(false)
  })

  it('does not reorder the array it was given', () => {
    const rules = [
      { from: 'gold_block', to: 'stone' },
      { from: 'diamond_block', to: 'stone' },
    ]
    sameSubstitutions(rules, [])
    expect(rules[0].from).toBe('gold_block')
  })
})

/**
 * The box both views draw. A turn swaps width and depth and moves nothing else: the build turns
 * inside its own box, and the placement stays on that box's minimum corner.
 */
describe('footprintOf', () => {
  const size = { x: 10, y: 4, z: 3 }
  const at = { x: 100, y: 64, z: -30 }

  it('covers the schematic from the anchor, inclusive at both ends', () => {
    expect(footprintOf(at, size, 0)).toEqual({ west: 100, east: 109, north: -30, south: -28, low: 64, high: 67 })
  })

  it('swaps width and depth on a quarter turn, with the corner where it was', () => {
    expect(footprintOf(at, size, 90)).toEqual({ west: 100, east: 102, north: -30, south: -21, low: 64, high: 67 })
    expect(footprintOf(at, size, 270)).toEqual(footprintOf(at, size, 90))
  })

  it('is the same box turned right round', () => {
    expect(footprintOf(at, size, 180)).toEqual(footprintOf(at, size, 0))
  })
})

describe('quarterOf', () => {
  it('keeps a quarter turn and refuses anything else', () => {
    expect(quarterOf(270)).toBe(270)
    expect(quarterOf(45)).toBe(0)
    expect(quarterOf(null)).toBe(0)
  })
})

/**
 * A box moved into the world the way a job moves it. Checked against the backend's own figures in
 * `RotationTest` and `BuildJobControllerTest`: a four-long row, anchored at 100, -30, turned a quarter.
 */
describe('placeBox', () => {
  const origin = { x: 0, y: 0, z: 0 }
  const size = { x: 4, y: 1, z: 1 }
  const at = { x: 100, y: 64, z: -30 }

  it('only shifts a box that is not turned', () => {
    expect(placeBox({ x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 1 }, at, origin, size, 0)).toEqual({
      min: { x: 100, y: 64, z: -30 },
      max: { x: 102, y: 65, z: -29 },
    })
  })

  it('turns a piece with its plan, keeping the corner on the anchor', () => {
    // The same numbers the job endpoint returns for this plan turned a quarter.
    expect(placeBox({ x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 1 }, at, origin, size, 90)).toEqual({
      min: { x: 100, y: 64, z: -30 },
      max: { x: 101, y: 65, z: -28 },
    })
    expect(placeBox({ x: 2, y: 0, z: 0 }, { x: 4, y: 1, z: 1 }, at, origin, size, 90)).toEqual({
      min: { x: 100, y: 64, z: -28 },
      max: { x: 101, y: 65, z: -26 },
    })
  })

  it('fills the turned footprint exactly with the whole schematic', () => {
    for (const turn of [0, 90, 180, 270]) {
      const whole = placeBox({ x: 0, y: 0, z: 0 }, { x: 4, y: 1, z: 1 }, at, origin, size, turn)
      const odd = turn % 180 === 90

      expect(whole.min, `turn ${turn}`).toEqual(at)
      expect(whole.max.x - whole.min.x, `turn ${turn}`).toBe(odd ? 1 : 4)
      expect(whole.max.z - whole.min.z, `turn ${turn}`).toBe(odd ? 4 : 1)
    }
  })
})
