import type { Bot } from 'mineflayer'
import type { Movements } from 'mineflayer-pathfinder'
import { Vec3 as WorldVec } from 'vec3'

import type { Goal, Neighbours, Step } from './search.ts'

/**
 * Walking, as something the search can ask questions of.
 *
 * **Upstream's `Movements` is the one piece of the plugin worth keeping**, and this is the whole of
 * how it is kept. It answers "what can be reached from this square" and nothing else: no state, no
 * execution, no opinion about what the agent should be doing - just which gaps a jump clears, what a
 * slab does to a step, which of the four blocks around a diagonal have to be free, how far a drop
 * may be. That is years of edge cases and there is no version of writing it here that is not a worse
 * copy.
 *
 * Everything upstream got wrong lives in the two files this one replaces: the search, which zigzags
 * and hands out unlabelled guesses, and the tick loop, which loses track of what it is doing. See
 * `search.ts` and `drive.ts`.
 *
 * Flight will bring its own version of this file and its own executor, and share the search and the
 * journey above it. It is not written yet, and nothing here is bent into shape for it.
 */

/**
 * A square as walking describes it: somewhere to stand, and what it costs to get there.
 *
 * Upstream's `Move` satisfies this, which is the point - the objects the neighbour source produces
 * go through the search untouched and come out the other side still carrying their work.
 */
export interface Walk extends Step {
  /** Blocks to lay before this square can be stood in. Upstream's shape, read by `drive.ts`. */
  readonly toPlace: readonly Placement[]
  /** Blocks to break first. */
  readonly toBreak: readonly { x: number; y: number; z: number }[]
  /** Scaffolding still in hand once this square is reached, which prices the routes past it. */
  readonly remainingBlocks: number
}

/** One block to lay: which block to build against, and which of its faces. */
export interface Placement {
  x: number
  y: number
  z: number
  dx: number
  dy: number
  dz: number
  /** Whether reaching the spot to lay it from means jumping - a tower, rather than a bridge. */
  jump?: boolean
  /** Present when upstream wants the agent back where it started after laying it. */
  returnPos?: { x: number; y: number; z: number }
  /** A gate or door to open rather than a block to place. */
  useOne?: boolean
}

/** What can be reached from a square, by walking, under these rules. */
export function walkingFrom(movements: Movements): Neighbours {
  // The objects go straight through: upstream builds `Move`s, and a `Move` is a `Walk`.
  return (from) => movements.getNeighbors(from as never) as unknown as readonly Walk[]
}

/**
 * Where a step is stood in, rather than which block it is.
 *
 * **The two are half a block apart on two axes, and everything downstream cares which it got.** A
 * `Move` is a block: floored, corner coordinates. An agent standing in that block is at its middle.
 * Upstream papered over the difference by rewriting its whole path in place before walking it, which
 * is also why its nodes arrived on the wire already centred; this host does not rewrite the search's
 * answer, so the conversion is a function and is applied where a standing position is what is meant.
 */
export function standsAt(step: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: step.x + 0.5, y: step.y, z: step.z + 0.5 }
}

/**
 * The square a search should start from.
 *
 * **Not `position.floored()`, which is what upstream uses and what puts a search inside a block.**
 * Halfway up a jump the agent's feet are above the square it took off from and below the one it is
 * heading for, and flooring picks whichever side of the boundary the tick happened to land on. When
 * that comes down on the square a block has just been laid in, the search starts inside solid stone,
 * finds the only cheap way out is sideways, and sends the agent to build a second column next to the
 * one it is standing on.
 *
 * So an airborne agent is searched for from the square it is standing *over* - the ground it will be
 * on when it lands, which is the square every route out of here actually leaves from. On the ground
 * this is the floored position with upstream's own correction for standing on something shorter than
 * a full block.
 */
export function standingAt(bot: Bot, movements: Movements): Walk {
  const at = bot.entity.position
  const floored = at.floored()

  const held = movements.countScaffoldingItems()
  const square = (x: number, y: number, z: number): Walk => ({
    x,
    y,
    z,
    hash: `${x},${y},${z}`,
    cost: 0,
    toPlace: [],
    toBreak: [],
    remainingBlocks: held,
  })

  if (!bot.entity.onGround) {
    // The first solid thing below, within a jump's worth of height. Further than that and the agent
    // is falling rather than jumping, and where it took off from says nothing about where it will be.
    for (let y = floored.y; y >= floored.y - 2; y--) {
      const under = bot.blockAt(new WorldVec(floored.x, y - 1, floored.z))
      if (under && under.boundingBox !== 'empty') return square(floored.x, y, floored.z)
    }

    return square(floored.x, floored.y, floored.z)
  }

  // Upstream's slab correction: standing on something solid but shorter than a block leaves the
  // floored position inside it rather than on top of it.
  const under = bot.blockAt(floored)
  const into = at.y - floored.y
  const sunk = under && into > 0.001 && !movements.emptyBlocks.has(under.type)

  return square(floored.x, floored.y + (sunk ? 1 : 0), floored.z)
}

/**
 * Somewhere to get to, within a block or so.
 *
 * The estimate is upstream's, and it has to be: it is the exact remaining cost on open ground, which
 * is what makes the search's tie-breaking meaningful rather than arbitrary. See `search.ts`.
 */
export function within(x: number, y: number, z: number, range: number): Goal {
  const rangeSq = range * range

  return {
    reached: (at) => {
      const dx = x - at.x
      const dy = y - at.y
      const dz = z - at.z
      return dx * dx + dy * dy + dz * dz <= rangeSq
    },
    estimate: (at) => octile(x - at.x, z - at.z) + Math.abs(y - at.y),
  }
}

/**
 * Somewhere to get to whose height nobody knows.
 *
 * A destination picked off a map that has not been charted there is a column rather than a point,
 * and the honest instruction is "stand over that spot, at whatever height it turns out to be". The
 * estimate says nothing about height for the same reason - guessing one would push the search up or
 * down for no reason.
 */
export function over(x: number, z: number, range: number): Goal {
  const rangeSq = range * range

  return {
    reached: (at) => {
      const dx = x - at.x
      const dz = z - at.z
      return dx * dx + dz * dz <= rangeSq
    },
    estimate: (at) => octile(x - at.x, z - at.z),
  }
}

/** Diagonal-aware distance, priced the way the neighbour source prices its steps. */
function octile(dx: number, dz: number): number {
  const x = Math.abs(dx)
  const z = Math.abs(dz)
  return Math.abs(x - z) + Math.min(x, z) * Math.SQRT2
}
