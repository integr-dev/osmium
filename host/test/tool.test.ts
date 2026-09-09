import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'

import blockFor from 'prismarine-block'
import registryFor from 'prismarine-registry'
import { Vec3 as WorldVec } from 'vec3'

import { bestFor, type Breakable, reachFor, speedUpTools } from '../src/agent/tool.ts'

/**
 * A block that takes as long as a table says it does.
 *
 * `digTime` is prismarine's, and its arithmetic is not what is being tested: what is, is which of
 * the things an agent is carrying gets picked, and whether it gets picked up at all.
 */
function stone(times: Record<string, number>, byHand: number): Breakable {
  return {
    name: 'stone',
    digTime: (item) => (item === null ? byHand : (times[String(item)] ?? byHand)),
  }
}

function carrying(items: Array<{ type: number; name: string }>, held?: { type: number; name: string }) {
  const did: string[] = []

  const bot = {
    entity: { effects: {} },
    inventory: { items: () => items },
    heldItem: held ?? null,
    equip: async (item: { name: string }) => {
      did.push(`equip ${item.name}`)
    },
    unequip: async () => {
      did.push('unequip')
    },
  }

  return { bot: bot as unknown as Bot, did }
}

const PICK = { type: 7, name: 'stone_pickaxe' }
const DIAMOND = { type: 9, name: 'diamond_pickaxe' }
const SWORD = { type: 3, name: 'iron_sword' }

describe('bestFor', () => {
  it('picks the quickest thing the agent is carrying', () => {
    const { bot } = carrying([SWORD, PICK, DIAMOND])

    expect(bestFor(bot, stone({ 7: 400, 9: 100, 3: 3_000 }, 1_000))).toBe(DIAMOND)
  })

  it('picks nothing when bare hands are quicker than anything carried', () => {
    const { bot } = carrying([SWORD])

    // A sword against dirt: slower than a fist, which is exactly the case that leaves an agent
    // digging with whatever it last fought with.
    expect(bestFor(bot, stone({ 3: 1_500 }, 750))).toBeUndefined()
  })

  it('does not swap for a tie', () => {
    const { bot } = carrying([PICK])

    expect(bestFor(bot, stone({ 7: 1_000 }, 1_000))).toBeUndefined()
  })

  it('survives an agent with no body and no bag', () => {
    expect(bestFor({} as Bot, stone({}, 1_000))).toBeUndefined()
  })
})

describe('reachFor', () => {
  it('puts the right tool in hand', async () => {
    const { bot, did } = carrying([SWORD, DIAMOND])

    await reachFor(bot, stone({ 9: 100, 3: 3_000 }, 1_000))

    expect(did).toEqual(['equip diamond_pickaxe'])
  })

  it('leaves the hand alone when it is already right', async () => {
    const { bot, did } = carrying([DIAMOND], DIAMOND)

    await reachFor(bot, stone({ 9: 100 }, 1_000))

    expect(did).toEqual([])
  })

  it('puts down something worse than nothing', async () => {
    const { bot, did } = carrying([SWORD], SWORD)

    await reachFor(bot, stone({ 3: 1_500 }, 750))

    expect(did).toEqual(['unequip'])
  })

  it('does nothing when the hands are already empty and should be', async () => {
    const { bot, did } = carrying([SWORD])

    await reachFor(bot, stone({ 3: 1_500 }, 750))

    expect(did).toEqual([])
  })

  it('says what ended up in the hand', async () => {
    const { bot } = carrying([PICK])

    await expect(reachFor(bot, stone({ 7: 200 }, 1_000))).resolves.toBe(PICK)
  })
})

/**
 * The real registries, because the bug being guarded against is in their data.
 *
 * A hand-written table would pass whatever it was written to pass. What matters here is what
 * minecraft-data actually says about obsidian on the versions this host loads, and what
 * prismarine-block does with it.
 */
describe('speedUpTools', () => {
  function spawned(version: string) {
    const registry = registryFor(version)
    const Block = blockFor(registry)
    const obsidian = registry.blocksByName.obsidian!
    const stone = registry.blocksByName.stone!
    const pickaxe = registry.itemsByName.diamond_pickaxe!

    let spawn: (() => void) | undefined
    let chunk: (() => void) | undefined
    // The world arrives after the agent does, which is the whole reason this installs lazily.
    let loaded = false

    const bot = {
      registry,
      entity: { position: new WorldVec(0, 64, 0), effects: {} },
      once: (name: string, handler: () => void) => {
        if (name === 'spawn') spawn = handler
      },
      on: (name: string, handler: () => void) => {
        if (name === 'chunkColumnLoad') chunk = handler
      },
      removeListener: () => {},
      blockAt: () => (loaded ? Block.fromStateId(obsidian.defaultState ?? obsidian.minStateId, 0) : null),
    }

    speedUpTools(bot as unknown as Bot, 1)

    // Spawn with no world: nothing to patch, and nothing broken by trying.
    spawn?.()
    loaded = true
    chunk?.()

    return {
      pickaxe,
      obsidian: () => Block.fromStateId(obsidian.defaultState ?? obsidian.minStateId, 0),
      stone: () => Block.fromStateId(stone.defaultState ?? stone.minStateId, 0),
    }
  }

  it('waits for a world before it has a class to correct', () => {
    // Spawning with no chunks loaded used to leave the correction uninstalled for the whole
    // session, which is exactly how obsidian stayed unmineable after this was first written.
    const world = spawned('1.21.9')

    const took = world.obsidian().digTime(world.pickaxe.id, false, false, false, [], {})

    expect(took).toBeLessThan(250_000)
  })

  it('makes obsidian mineable again on a version that stopped describing pickaxes', () => {
    const world = spawned('1.21.9')

    const took = world.obsidian().digTime(world.pickaxe.id, false, false, false, [], {})

    // The pathfinder prices a dig at 1 + 3 * seconds and refuses anything over 100.
    expect(1 + (3 * took) / 1000).toBeLessThan(100)
  })

  it('leaves a version whose data is right alone', () => {
    const world = spawned('1.20.4')

    const took = world.obsidian().digTime(world.pickaxe.id, false, false, false, [], {})

    expect(took).toBeCloseTo(9400, -2)
  })

  it('does not touch a block whose material never broke', () => {
    const world = spawned('1.21.9')

    // Stone still says `mineable/pickaxe`, so the original answer already counted the tool.
    const took = world.stone().digTime(world.pickaxe.id, false, false, false, [], {})

    expect(took).toBeLessThan(500)
  })

  it('does not pretend the wrong tool is quick', () => {
    const world = spawned('1.21.9')
    const registry = registryFor('1.21.9')
    const shovel = registry.itemsByName.diamond_shovel!

    const took = world.obsidian().digTime(shovel.id, false, false, false, [], {})

    expect(took).toBe(250_000)
  })
})
