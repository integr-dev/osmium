import type { Bot } from 'mineflayer'
import type { Movements } from 'mineflayer-pathfinder'
import plugin from 'mineflayer-pathfinder'

import type { PathSettings } from './settings.ts'

/** Somewhere the agent tried to step and was put back, and when that stops mattering. */
export interface Refused {
  x: number
  y: number
  z: number
  until: number
}

/**
 * What stepping somewhere refused is priced at.
 *
 * High enough that any real detour is cheaper, low enough that it is still finite - a route with no
 * alternative is walked and fails honestly, rather than being reported as impossible.
 */
const REFUSED_COST = 1_000

/** How close to a refused spot still counts as it. One block, in every direction. */
function near(at: { x: number; y: number; z: number }, spot: Refused): boolean {
  return Math.abs(at.x - spot.x) <= 1 && Math.abs(at.y - spot.y) <= 1 && Math.abs(at.z - spot.z) <= 1
}

/**
 * The walking engine, which is mineflayer-pathfinder's rather than ours.
 *
 * **Delegated on purpose.** Walking a Minecraft world is a pile of hard-won geometry - which gaps a
 * jump clears, when a drop hurts, what a slab does to a step, which of the four blocks around a
 * diagonal have to be clear - and upstream has been getting it wrong and fixing it for years. There
 * is no version of writing that here that is not a worse copy of it.
 *
 * What this file is, then, is a translation: the operator's settings into a `Movements`, and nothing
 * else. Everything about a path that Osmium has an opinion on - what it looks like on the wire, how
 * far along it the agent is, what to do when it stops moving - lives above the driver, where the
 * flying engine will meet it.
 */

/**
 * The rules an agent walks by, built from what the operator set.
 *
 * **Upstream's defaults are permissive and ours are not.** A fresh `Movements` may dig, may pillar
 * up and may parkour, because it is written for a bot somebody is watching. An unattended agent that
 * tunnels through a wall to save nine blocks of walking has done something an operator cannot undo
 * and did not ask for, so each of those is off until it is turned on - and a route that needs one
 * simply is not found, which is a failure somebody can read.
 */
export function movementsFor(bot: Bot, wanted: PathSettings, avoid: readonly Refused[] = []): Movements {
  const movements = new plugin.Movements(bot)

  /*
   * Places the agent has been refused, priced out of the search rather than forbidden.
   *
   * A cost rather than a wall, because the ladder has to end somewhere: an agent whose only route
   * home runs through a spot a server would not let it step on should still take that route and
   * fail there, rather than be told no path exists. What this buys is that every *other* route is
   * cheaper, so the search stops proposing the one that does not work.
   *
   * Upstream's own hook, and the reason it exists - see `exclusionAreasStep` in its readme.
   */
  if (avoid.length) {
    movements.exclusionAreasStep = [
      (block: { position?: { x: number; y: number; z: number } }) => {
        const at = block.position
        if (!at) return 0

        return avoid.some((spot) => near(at, spot)) ? REFUSED_COST : 0
      },
    ]
  }

  movements.canDig = wanted.dig
  movements.allowParkour = wanted.parkour
  movements.allowSprinting = wanted.sprint
  movements.maxDropDown = wanted.maxDrop

  // Both halves of placing a block, and both off together. `allow1by1towers` is pillaring straight
  // up, which is the same permission spent on a different shape; leaving it on with nothing to place
  // from would be a route planned around materials the agent has not got.
  movements.allow1by1towers = wanted.bridge
  movements.scafoldingBlocks = wanted.bridge ? buildableWith(bot) : []

  return movements
}

/**
 * Blocks that are a full cube and still no good to build with.
 *
 * Each of these would be picked up by the rule below and then let the agent down in its own way, so
 * they are named rather than reasoned about.
 */
const AWKWARD = new Set([
  // Slippery. An agent slides off the pillar it is standing on, which is the one place it cannot
  // afford to.
  'ice',
  'packed_ice',
  'blue_ice',
  'frosted_ice',
  // A jump off these is not a jump, so none of the arithmetic a tower depends on holds.
  'slime_block',
  'honey_block',
  // Hurts to stand on, and a tower is a lot of standing.
  'magma_block',
  // A full box that is not a full height: the agent lands lower than it planned to.
  'soul_sand',
])

/**
 * What the agent may build with, as item ids.
 *
 * **Upstream's list is dirt and cobblestone and nothing else.** So an agent carrying two hundred
 * wool and nothing else reports that it has nothing left to build with and gives up on the route,
 * which is a strange thing to say while standing on a stack of the stuff.
 *
 * What matters is not what the block is called. It has to be a full cube, so the agent can stand on
 * it and jump off it, and it has to behave like one once it is down. **One block state is the cheap
 * test for the first**: a slab, a set of stairs, a chest and a log all carry states that change
 * their shape, and a block with a single state has a single shape. It turns down a few blocks that
 * would have done - logs and deepslate among them - and that is the right way round for a decision
 * an unattended agent spends somebody else's inventory on.
 *
 * **Upstream's two stay at the front**, because the order is the order they are reached for: dirt
 * and cobblestone are what a player fills a spare slot with precisely because losing them costs
 * nothing, and an agent that pillars up through somebody's wool when it has dirt on it has spent
 * the wrong thing.
 */
function buildableWith(bot: Bot): number[] {
  const registry = bot.registry
  const first: number[] = []
  const rest: number[] = []

  for (const block of registry.blocksArray) {
    if (block.boundingBox !== 'block') continue
    if (block.minStateId !== block.maxStateId) continue
    if (AWKWARD.has(block.name)) continue

    const item = registry.itemsByName[block.name]
    if (!item) continue

    if (block.name === 'dirt' || block.name === 'cobblestone') first.push(item.id)
    else rest.push(item.id)
  }

  return [...first, ...rest]
}

/**
 * What a finished search means, or nothing when it means the agent is still walking.
 *
 * `partial` is a success. Upstream returns the best prefix it found inside its budget, walks it, and
 * searches again from the end - which is exactly how a path longer than the loaded world gets
 * walked at all. Reading it as a failure would refuse every journey worth taking.
 */
export function failureOf(status: string, nodes: number): string | undefined {
  if (status === 'success' || status === 'partial') return undefined

  // A search that found nothing at all, having got somewhere, is upstream re-planning from where it
  // stands - a door closed in front of the agent looks exactly like this. It is the watchdog's to
  // judge, not a failure to report on the spot.
  if (nodes > 0) return undefined

  if (status === 'noPath') return 'there is no route there'
  if (status === 'timeout') return 'the search ran out of time'

  return `the search ended as '${status}'`
}
