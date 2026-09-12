import type { Bot } from 'mineflayer'
import registryFor from 'prismarine-registry'
import { describe, expect, it } from 'vitest'

import { advanced, nodesOf } from '../src/agent/path/track.ts'
import { DEFAULT_DROP, DEFAULT_RANGE, MOST_DROP, MOST_RANGE, pathSettingsFrom } from '../src/agent/path/settings.ts'
import { movementsFor, type Refused } from '../src/agent/path/walk.ts'

/**
 * A bot with nothing on it but the block table.
 *
 * That is all `Movements` reads when it is built, and building a real one would mean a server. What
 * the test is actually asserting is that our settings reach upstream's fields, so the object under
 * them only has to be enough to construct one.
 */
function fakeBot(): Bot {
  return { registry: registryFor('1.20.4') } as unknown as Bot
}

describe('pathSettingsFrom', () => {
  it('falls back to what the interface offers when nothing is set', () => {
    const settings = pathSettingsFrom({})

    expect(settings.range).toBe(DEFAULT_RANGE)
    expect(settings.maxDrop).toBe(DEFAULT_DROP)
    expect(settings.dig).toBe(false)
    expect(settings.bridge).toBe(false)
    expect(settings.parkour).toBe(false)
    expect(settings.sprint).toBe(true)
  })

  it('reads what an operator wrote', () => {
    const settings = pathSettingsFrom({
      'path.range': '64',
      'path.maxDrop': '5',
      'path.dig': 'true',
      'path.bridge': 'true',
      'path.parkour': 'true',
    })

    expect(settings.range).toBe(64)
    expect(settings.maxDrop).toBe(5)
    expect(settings.dig).toBe(true)
    expect(settings.bridge).toBe(true)
    expect(settings.parkour).toBe(true)
  })

  /**
   * A typo in a box is not a reason for an agent to stop walking. Every one of these is a real thing
   * somebody types into a number field, and each has to land on the value the placeholder promises.
   */
  it('falls back rather than failing on anything that is not a number', () => {
    for (const written of ['', '   ', 'far', '-20', '0', 'NaN', '1e400']) {
      expect(pathSettingsFrom({ 'path.range': written }).range).toBe(DEFAULT_RANGE)
    }
  })

  it('holds a search to something a tick can finish', () => {
    expect(pathSettingsFrom({ 'path.range': '99999' }).range).toBe(MOST_RANGE)
    expect(pathSettingsFrom({ 'path.maxDrop': '99999' }).maxDrop).toBe(MOST_DROP)
  })

  it('takes the whole number out of a decimal', () => {
    expect(pathSettingsFrom({ 'path.range': '64.7' }).range).toBe(64)
  })

  /**
   * The interface writes `true` or clears the key, so only the word is on. Anything else is a
   * setting written by something that is not this interface, and a switch is not the place to guess.
   */
  it('reads a switch as the interface writes one', () => {
    expect(pathSettingsFrom({ 'path.dig': 'true' }).dig).toBe(true)
    expect(pathSettingsFrom({ 'path.dig': ' true ' }).dig).toBe(true)
    expect(pathSettingsFrom({ 'path.dig': 'false' }).dig).toBe(false)
    expect(pathSettingsFrom({ 'path.dig': 'yes' }).dig).toBe(false)
    expect(pathSettingsFrom({}).dig).toBe(false)
  })

  /**
   * The whole reason sprinting is not a setting of its own. `careful` exists to stop an agent
   * burning food, and sprinting is where the food goes.
   */
  it('does not sprint when anti-hunger is being careful', () => {
    expect(pathSettingsFrom({ 'util.antiHunger': 'careful' }).sprint).toBe(false)
    expect(pathSettingsFrom({ 'util.antiHunger': 'spoof' }).sprint).toBe(true)
    expect(pathSettingsFrom({ 'util.antiHunger': '' }).sprint).toBe(true)
    expect(pathSettingsFrom({}).sprint).toBe(true)
  })
})

/**
 * The translation into upstream's own object.
 *
 * Asserted against a real `Movements` rather than a stub, because the point of the test is that
 * these field names are still the field names — a rename upstream is exactly the failure that would
 * otherwise turn into an agent quietly digging through somebody's wall.
 */
describe('movementsFor', () => {
  it('refuses everything an operator has not asked for', () => {
    const movements = movementsFor(fakeBot(), pathSettingsFrom({}))

    expect(movements.canDig).toBe(false)
    expect(movements.allowParkour).toBe(false)
    expect(movements.allow1by1towers).toBe(false)
    expect(movements.scafoldingBlocks).toEqual([])
    expect(movements.maxDropDown).toBe(DEFAULT_DROP)
  })

  /** Upstream's defaults are the permissive ones, so a fresh object must not read as ours. */
  it('is stricter than the object it starts from', () => {
    const bot = fakeBot()
    const fresh = movementsFor(bot, pathSettingsFrom({ 'path.dig': 'true', 'path.parkour': 'true' }))

    expect(fresh.canDig).toBe(true)
    expect(fresh.allowParkour).toBe(true)
    expect(fresh.maxDropDown).toBe(DEFAULT_DROP)
  })

  /**
   * **A head is somebody.** An avatar is a player head in the world, and upstream is willing to
   * mine one: a head reads `boundingBox: block`, so it is not safe to walk through, and the move
   * that meets one prices breaking it like any other block. Every head in the game is diggable
   * and the only list upstream protects is chests.
   */
  it('will not mine a head, whatever the route wants', () => {
    const bot = fakeBot()
    const movements = movementsFor(bot, pathSettingsFrom({ 'path.dig': 'true' }))

    expect(movements.canDig).toBe(true)

    for (const name of ['player_head', 'player_wall_head', 'zombie_head', 'skeleton_skull']) {
      const kind = bot.registry.blocksByName[name]
      expect(kind, `${name} missing from the block table`).toBeDefined()
      expect(movements.blocksCantBreak.has(kind.id), `${name} is breakable`).toBe(true)
    }
  })

  /**
   * **And it is not ground.** Upstream sorts blocks by shape into two cases - taller than 1 is too
   * tall to stand on, shorter than 0.1 is flat enough to walk through - and a head is 0.5, so it
   * falls between them and stays `physical`. That is what lets the parkour move offer a jump onto
   * one, filing the node a block above a surface that is half that and a quarter inset on every
   * side. Asked of upstream's own `getBlock`, because a set membership proves nothing about what
   * the pathfinder then decides.
   */
  it('will not stand on a head', () => {
    const bot = fakeBot()
    const head = bot.registry.blocksByName['player_head']
    expect(head).toBeDefined()

    const movements = movementsFor(bot, pathSettingsFrom({ 'path.parkour': 'true' })) as unknown as {
      getBlock: (pos: unknown, dx: number, dy: number, dz: number) => { physical: boolean; safe: boolean }
      bot: { blockAt: unknown }
    }

    // One head, wherever it is asked about.
    movements.bot.blockAt = () => ({
      type: head.id,
      boundingBox: 'block',
      shapes: [[0.25, 0, 0.25, 0.75, 0.5, 0.75]],
      position: { x: 0, y: 64, z: 0 },
    })

    const asked = movements.getBlock({ x: 0, y: 64, z: 0 }, 0, 0, 0)

    // Not ground to land on, and not air to walk through either - so the route goes round.
    expect(asked.physical).toBe(false)
    expect(asked.safe).toBe(false)
  })

  /**
   * **A block laid has to cost more than a step taken**, or the two tie and the tie is settled by
   * nothing: a rung of a tower is a move plus a placement, upstream prices both at 1, and stepping
   * up onto a block already there is 2 as well. Measured over 400 patches of rough ground, that tie
   * had routes building where they could walk 47 times; charging 2 for the placement took it to 20.
   */
  it('charges more for laying a block than for walking a square', () => {
    const movements = movementsFor(fakeBot(), pathSettingsFrom({ 'path.bridge': 'true' }))

    expect(movements.placeCost).toBeGreaterThan(1)
  })

  it('gives back the blocks to bridge with only when bridging is allowed', () => {
    const allowed = movementsFor(fakeBot(), pathSettingsFrom({ 'path.bridge': 'true' }))

    expect(allowed.allow1by1towers).toBe(true)
    expect(allowed.scafoldingBlocks.length).toBeGreaterThan(0)
  })

  /**
   * Upstream offers dirt and cobblestone. An agent carrying nothing but wool would be told it has
   * nothing left to build with, on a stack of two hundred blocks.
   */
  describe('what it will build with', () => {
    const registry = registryFor('1.20.4')
    const allowed = movementsFor(fakeBot(), pathSettingsFrom({ 'path.bridge': 'true' })).scafoldingBlocks
    const named = (name: string) => allowed.includes(registry.itemsByName[name]!.id)

    it('takes any full block it is carrying', () => {
      expect(named('white_wool')).toBe(true)
      expect(named('oak_planks')).toBe(true)
      expect(named('white_concrete')).toBe(true)
      expect(named('stone')).toBe(true)
      expect(named('glass')).toBe(true)
    })

    /** Nothing an agent could stand on the wrong part of, or fail to jump from. */
    it('leaves out what is not a full cube', () => {
      expect(named('oak_slab')).toBe(false)
      expect(named('oak_stairs')).toBe(false)
      expect(named('chest')).toBe(false)
    })

    it('leaves out the full cubes that would still let it down', () => {
      expect(named('ice')).toBe(false)
      expect(named('slime_block')).toBe(false)
      expect(named('magma_block')).toBe(false)
    })

    /**
     * A state is not a shape.
     *
     * `grass_block` carries `snowy`, which changes what it looks like and nothing else, and
     * counting states refused it - along with every log, every leaf, podzol, mycelium, deepslate
     * and a hundred and fifty others. Measured against the registry: 300 blocks by that test, 432
     * by the shape.
     */
    it('takes a full cube that happens to have more than one state', () => {
      expect(named('grass_block')).toBe(true)
      expect(named('podzol')).toBe(true)
      expect(named('mycelium')).toBe(true)
      expect(named('oak_log')).toBe(true)
      expect(named('deepslate')).toBe(true)
    })

    /**
     * And the other direction, which the same test got wrong just as quietly.
     *
     * One state says nothing about height. A carpet is a sixteenth of a block, `dirt_path` is
     * fifteen sixteenths and `mud` is seven eighths - each of them puts the agent a step lower
     * than the route worked out, which is every jump after it measured from the wrong place.
     */
    it('leaves out what only looks like a full block', () => {
      expect(named('white_carpet')).toBe(false)
      expect(named('dirt_path')).toBe(false)
      expect(named('mud')).toBe(false)
      expect(named('lily_pad')).toBe(false)
      expect(named('cauldron')).toBe(false)
    })

    /** A cube by every test in the data, and gone by the time the agent stands on it. */
    it('leaves out the blocks that fall out from under it', () => {
      expect(named('sand')).toBe(false)
      expect(named('gravel')).toBe(false)
      expect(named('suspicious_sand')).toBe(false)
      expect(named('white_concrete_powder')).toBe(false)
    })

    /** Whatever is inside one of these is not the agent’s to spend on a staircase. */
    it('leaves out what it would lose the contents of', () => {
      expect(named('shulker_box')).toBe(false)
      expect(named('red_shulker_box')).toBe(false)
      expect(named('tnt')).toBe(false)
    })

    /** The order is the order they are reached for, and these are the ones worth losing. */
    it('reaches for dirt and cobblestone first', () => {
      expect(allowed.slice(0, 2).sort()).toEqual(
        [registry.itemsByName['dirt']!.id, registry.itemsByName['cobblestone']!.id].sort(),
      )
    })
  })

  it('carries the sprint anti-hunger decided', () => {
    expect(movementsFor(fakeBot(), pathSettingsFrom({})).allowSprinting).toBe(true)
    expect(movementsFor(fakeBot(), pathSettingsFrom({ 'util.antiHunger': 'careful' })).allowSprinting).toBe(false)
  })
})

/**
 * Places the agent has been refused, priced out of the search.
 *
 * A cost rather than a wall, and the difference matters at the end of the ladder: an agent whose
 * only route home runs through a spot the server will not accept should still walk it and fail
 * there, rather than be told no route exists at all.
 */
describe('going around somewhere the server refused', () => {
  /** A block, as upstream hands one to an exclusion. */
  function block(x: number, y: number, z: number) {
    return { position: { x, y, z } }
  }

  function refusal(x: number, y: number, z: number): Refused {
    return { x, y, z, until: Date.now() + 60_000 }
  }

  it('leaves the search alone when nothing has been refused', () => {
    expect(movementsFor(fakeBot(), pathSettingsFrom({})).exclusionAreasStep).toEqual([])
  })

  it('prices the refused spot out', () => {
    const movements = movementsFor(fakeBot(), pathSettingsFrom({}), [refusal(10, 64, -20)])
    const [priced] = movements.exclusionAreasStep

    expect(priced).toBeDefined()
    expect(priced!(block(10, 64, -20) as never)).toBeGreaterThan(0)
  })

  /** One block in every direction, because a step is refused by what is around it as well. */
  it('covers the blocks touching it', () => {
    const [priced] = movementsFor(fakeBot(), pathSettingsFrom({}), [refusal(10, 64, -20)]).exclusionAreasStep

    expect(priced!(block(11, 65, -19) as never)).toBeGreaterThan(0)
    expect(priced!(block(9, 63, -21) as never)).toBeGreaterThan(0)
  })

  it('costs nothing anywhere else', () => {
    const [priced] = movementsFor(fakeBot(), pathSettingsFrom({}), [refusal(10, 64, -20)]).exclusionAreasStep

    expect(priced!(block(20, 64, -20) as never)).toBe(0)
    expect(priced!(block(10, 70, -20) as never)).toBe(0)
  })

  /**
   * Finite on purpose. A wall would turn "this way is expensive" into "there is no way", and an
   * agent with one route home should take it and fail honestly rather than refuse to try.
   */
  it('is expensive rather than impossible', () => {
    const [priced] = movementsFor(fakeBot(), pathSettingsFrom({}), [refusal(0, 0, 0)]).exclusionAreasStep

    expect(Number.isFinite(priced!(block(0, 0, 0) as never))).toBe(true)
  })

  it('survives a block upstream hands over without a position', () => {
    const [priced] = movementsFor(fakeBot(), pathSettingsFrom({}), [refusal(0, 0, 0)]).exclusionAreasStep

    expect(priced!({} as never)).toBe(0)
  })
})

/**
 * Which endings are endings.
 *
 * The two that are not are the important ones: a partial path is how a journey longer than the
 * loaded world gets walked at all, and a search that found nothing while the agent is already on its
 * way is upstream re-planning around something that moved.
 */

describe('nodesOf', () => {
  it('keeps a node at the centre of its block', () => {
    expect(nodesOf([{ x: 10.5, y: 64, z: -3.5 }])).toEqual([{ x: 10.5, y: 64, z: -3.5 }])
  })

  it('rounds off the digits nothing downstream can draw', () => {
    expect(nodesOf([{ x: 10.500000000000002, y: 63.999999999, z: -3.4567 }])).toEqual([
      { x: 10.5, y: 64, z: -3.46 },
    ])
  })

  it('copies, so a path the engine goes on consuming is not the one on the wire', () => {
    const engine = [{ x: 1, y: 2, z: 3 }]
    const wire = nodesOf(engine)

    engine.length = 0
    expect(wire).toHaveLength(1)
  })
})

/**
 * How far along a path the agent is, measured off its position rather than asked of the engine.
 *
 * Two properties: the nearest node wins, and it never goes backwards. The second is what stops a
 * path that doubles back reporting the agent as having lost ground it walked ten minutes ago.
 */
describe('advanced', () => {
  const line = nodesOf([
    { x: 0, y: 64, z: 0 },
    { x: 1, y: 64, z: 0 },
    { x: 2, y: 64, z: 0 },
    { x: 3, y: 64, z: 0 },
  ])

  it('finds the node the agent is standing on', () => {
    expect(advanced(line, { x: 2.1, y: 64, z: 0 }, 0)).toBe(2)
  })

  it('counts height, not just the ground plan', () => {
    const stairs = nodesOf([
      { x: 0, y: 64, z: 0 },
      { x: 0, y: 65, z: 0 },
      { x: 0, y: 66, z: 0 },
    ])

    expect(advanced(stairs, { x: 0, y: 65.9, z: 0 }, 0)).toBe(2)
  })

  it('never goes back on ground it has already claimed', () => {
    // Standing on the first node again, having reported the third. A path that loops does this.
    expect(advanced(line, { x: 0, y: 64, z: 0 }, 2)).toBe(2)
  })

  it('starts where it is told rather than at the beginning', () => {
    expect(advanced(line, { x: 1, y: 64, z: 0 }, 3)).toBe(3)
  })

  it('survives a path with nothing in it', () => {
    expect(advanced([], { x: 0, y: 0, z: 0 }, 0)).toBe(0)
  })

  it('holds an out-of-range start inside the path', () => {
    expect(advanced(line, { x: 0, y: 64, z: 0 }, 99)).toBe(3)
    expect(advanced(line, { x: 0, y: 64, z: 0 }, -5)).toBe(0)
  })
})
