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
  if (!wanted.bridge) movements.scafoldingBlocks = []

  return movements
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
