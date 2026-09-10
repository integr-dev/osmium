import type { Bot } from 'mineflayer'
import type { Movements } from 'mineflayer-pathfinder'
import plugin from 'mineflayer-pathfinder'

import { bestFor } from '../tool.ts'
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
 * The rules of walking, which are mineflayer-pathfinder's rather than ours.
 *
 * **The one piece of the plugin kept, and kept on purpose.** What a step costs is a pile of hard-won
 * geometry - which gaps a jump clears, when a drop hurts, what a slab does to a step, which of the
 * four blocks around a diagonal have to be free - and upstream has been getting it wrong and fixing
 * it for years. There is no version of writing that here that is not a worse copy of it.
 *
 * The search that reads these rules and the executor that acts on them are both ours: see
 * `search.ts` and `drive.ts` for what was wrong with upstream's.
 *
 * What this file is, then, is a translation: the operator's settings into a `Movements`, and nothing
 * else.
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
  answerToolQuestions(bot)

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

  /*
   * **Laying a block costs more than taking a step, and upstream prices them the same.**
   *
   * A rung of a tower is a move plus a placement, and with both at 1 that is 2 - which is exactly
   * what stepping up onto a block that is already there costs. So building was never worse than
   * walking, and every tie between them was settled by whatever the heap happened to hold first:
   * the agent laid a block to get onto something it could have stepped onto, and bridged over dips
   * it could have walked through.
   *
   * Two is the honest number rather than a discouragement. A placement is an item out of the pack,
   * a swap, a packet, and the best part of a second standing still - none of which a step costs.
   * Measured over 400 patches of rough ground with scaffolding in hand, it takes routes that build
   * where they could have walked from 47 to 20, and the ones that remain are steps of two blocks
   * and gaps, which do need a block.
   *
   * It is paid by {@link CLIMB} in ground.ts: the estimate has to price a block of height at
   * something near what climbing one really costs, or a vertical goal spreads sideways for
   * thousands of squares before it will go up.
   */
  movements.placeCost = 2

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
 * Answers the one question `Movements` asks the bot that the plugin's own injection used to.
 *
 * **The rules are not as free-standing as they look.** `safeOrBreak` prices breaking a block by how
 * long it would take with the best tool the agent is carrying, and it asks for that tool through
 * `bot.pathfinder` - a property the plugin adds when it is loaded. This host no longer loads it,
 * because doing so would run upstream's tick loop beside ours for no reason, so the one method the
 * rules actually reach for is supplied here instead.
 *
 * It is answered with the same autotool the executor reaches for when it comes to actually break
 * something, which is the right way round: what a route is priced on and what the agent then does
 * were two different answers before, and that is how a search talks itself into a route it cannot
 * walk in the time it thought.
 */
function answerToolQuestions(bot: Bot): void {
  const asked = bot as unknown as { pathfinder?: { bestHarvestTool?: unknown } }
  if (asked.pathfinder?.bestHarvestTool) return

  asked.pathfinder = {
    ...asked.pathfinder,
    bestHarvestTool: (block: Parameters<typeof bestFor>[1]) => bestFor(bot, block) ?? null,
  }
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
  // A full box that is not a full height: the agent lands lower than it planned to. Its shape
  // says so too now, and it is left named because a version that disagrees is not worth finding
  // out about from the bottom of a hole.
  'soul_sand',
  // Goes off. Standing on a tower of it is a way to find out what else is nearby.
  'tnt',
])

/**
 * Blocks that do not stay where they are put.
 *
 * A cube by every test in the data and still no good underfoot: place one over air and it is
 * gone by the time the agent stands on it, which for a tower is the whole tower.
 */
const FALLS = new Set([
  'sand',
  'red_sand',
  'gravel',
  'suspicious_sand',
  'suspicious_gravel',
  'anvil',
  'chipped_anvil',
  'damaged_anvil',
  'dragon_egg',
])

/**
 * What the agent may build with, as item ids.
 *
 * **Upstream's list is dirt and cobblestone and nothing else.** So an agent carrying two hundred
 * wool and nothing else reports that it has nothing left to build with and gives up on the route,
 * which is a strange thing to say while standing on a stack of the stuff.
 *
 * What matters is not what the block is called. It has to be a full cube, so the agent can stand on
 * it and jump off it, and it has to behave like one once it is down.
 *
 * **Counting block states was the cheap test for that, and it is wrong in both directions.** A
 * state is not a shape: `grass_block` carries `snowy`, which changes what it looks like and
 * nothing else, so the commonest block in the world was refused - along with every log, every
 * leaf, podzol, mycelium, deepslate and a hundred and fifty others. And single-state says nothing
 * about height, so it let through a carpet at a sixteenth of a block, a `dirt_path` at fifteen
 * sixteenths and `soul_sand` at seven eighths - each of which puts the agent a step lower than the
 * route worked out, which is a jump measured from the wrong place.
 *
 * **The shape is in the data, so the shape is what is read.** Measured against the registry this
 * host loads: 300 blocks by the old test, 432 by this one, and the 28 it drops are all genuinely
 * not cubes.
 *
 * **Upstream's two stay at the front**, because the order is the order they are reached for: dirt
 * and cobblestone are what a player fills a spare slot with precisely because losing them costs
 * nothing, and an agent that pillars up through somebody's wool when it has dirt on it has spent
 * the wrong thing.
 */
/** The corner-to-corner box of a block that fills its whole square. */
const WHOLE_BLOCK = [0, 0, 0, 1, 1, 1]

/** As much of the registry as the shape question needs, which its types do not describe. */
interface Shapes {
  blockCollisionShapes?: {
    blocks: Record<string, number | number[]>
    shapes: Record<string, number[][]>
  }
}

/**
 * Whether a block is the whole of its square in every state it can be in.
 *
 * `blockCollisionShapes` gives each block either one shape id for all of its states or one per
 * state, and each shape is a list of boxes. A block worth building with has the same answer
 * whichever state it lands in, and that answer is the single box that fills the square: a stair
 * has two boxes, a slab has one that is half high, a fence has a thin one, and a full block has
 * exactly this.
 *
 * Falls back to counting states where the data is missing, which is the old test and is at least
 * cautious - a version this host has never seen is not a reason to pillar onto a carpet.
 */
function alwaysACube(registry: Bot['registry'], block: { name: string; minStateId: number; maxStateId: number }): boolean {
  const shapes = (registry as unknown as Shapes).blockCollisionShapes
  const entry = shapes?.blocks[block.name]

  if (shapes === undefined || entry === undefined) return block.minStateId === block.maxStateId

  const ids = Array.isArray(entry) ? entry : [entry]

  return ids.every((id) => {
    const shape = shapes.shapes[String(id)]
    const box = shape?.length === 1 ? shape[0] : undefined

    return box !== undefined && box.length === 6 && box.every((side, at) => side === WHOLE_BLOCK[at])
  })
}

function buildableWith(bot: Bot): number[] {
  const registry = bot.registry
  const first: number[] = []
  const rest: number[] = []

  for (const block of registry.blocksArray) {
    if (block.boundingBox !== 'block') continue
    if (!alwaysACube(registry, block)) continue
    if (AWKWARD.has(block.name)) continue
    if (FALLS.has(block.name) || block.name.endsWith('_concrete_powder')) continue

    // Placing one of these spends whatever is inside it, which is not the agent’s to spend.
    if (block.name.endsWith('shulker_box')) continue

    const item = registry.itemsByName[block.name]
    if (!item) continue

    if (block.name === 'dirt' || block.name === 'cobblestone') first.push(item.id)
    else rest.push(item.id)
  }

  return [...first, ...rest]
}
