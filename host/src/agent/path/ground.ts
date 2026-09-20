import type { Bot } from 'mineflayer'
import type { Movements } from 'mineflayer-pathfinder'
import { Vec3 as WorldVec } from 'vec3'

import { avoiding, type Goal, type KeepOut, type Neighbours, type Step } from './search.ts'

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
  /**
   * Upstream's own mark for a move that only works at a run.
   *
   * It is what the executor reads to know a jump needs speed carried into it - see `drive.ts`. Set
   * by `getMoveParkourForward` and by nothing else, which is exactly the question being asked.
   */
  readonly parkour?: boolean
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

/** What can be reached from a square, by walking, under these rules and out of these squares. */
export function walkingFrom(movements: Movements, keepOut?: KeepOut): Neighbours {
  // The objects go straight through: upstream builds `Move`s, and a `Move` is a `Walk`.
  const offered: Neighbours = (from) => {
    const walks = movements.getNeighbors(from as never) as unknown as readonly Walk[]
    const swims = SWIMS.map(([dx, dy, dz]) => swimming(movements, from as Walk, dx, dy, dz)).filter(
      (step): step is Walk => step !== undefined,
    )
    return swims.length > 0 ? [...walks, ...swims] : walks
  }

  return avoiding(offered, keepOut)
}

/**
 * The height to walk to for a point, which for a point on top of water is the water.
 *
 * **A swimmer floats in the top square of water, not the square above it** - and a point picked on a
 * water surface is the square above it, because that is the square the surface is the top of. Walked
 * to as given, that square is a block and a half from every square a swimmer can be in, never within
 * arriving distance, so the search spent its whole budget proving it could not get there while the
 * agent stood at the water's edge.
 */
export function swimmingHeight(bot: Bot, x: number, y: number, z: number): number {
  const square = bot.blockAt(new WorldVec(Math.floor(x), Math.floor(y), Math.floor(z)))
  const under = bot.blockAt(new WorldVec(Math.floor(x), Math.floor(y) - 1, Math.floor(z)))
  const dry = square !== null && square.boundingBox === 'empty' && square.name !== 'water'
  return dry && under?.name === 'water' ? y - 1 : y
}

/**
 * Every way a swimmer goes up or down a square: straight, or with a square across on the way.
 *
 * **Sloped as well as straight**, because a route of only straight moves down through water is a
 * staircase - down a square, across a square, down again - and a swimmer steering that turns to face
 * every step of it.
 */
const SWIMS: ReadonlyArray<readonly [number, 1 | -1, number]> = [1, -1].flatMap((dy) =>
  [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].map(([dx, dz]) => [dx!, dy as 1 | -1, dz!] as const),
)

/** As much of upstream's block reading as swimming asks about, which its types do not describe. */
interface Wading {
  getBlock(node: { x: number; y: number; z: number }, dx: number, dy: number, dz: number): { liquid: boolean; safe: boolean }
  liquidCost: number
}

/**
 * Up or down a square of water, from a square of water.
 *
 * **Upstream swims along the top of water and never through it** - both of its vertical moves
 * refuse a square of liquid outright - so an agent that was underwater had no route to anywhere, a
 * point under the surface was somewhere no route reached, and one sent across a lake could only ever
 * be routed along whatever depth it went in at. Holding jump in water rises and letting go sinks,
 * which is all these moves are: `drive.ts` swims them.
 *
 * Only into more water, so the route surfaces at the top square of it rather than a square above
 * the surface a swimmer cannot rise into, and bottoms out on the square above the bed; the walking
 * moves carry on from there. Lava is liquid too and never safe, so none of this reaches it.
 */
function swimming(movements: Movements, from: Walk, dx: number, dy: 1 | -1, dz: number): Walk | undefined {
  const rules = movements as unknown as Wading
  const block = (x: number, y: number, z: number) => rules.getBlock(from, x, y, z)
  const water = (x: number, y: number, z: number) => {
    const found = block(x, y, z)
    return found.liquid && found.safe
  }

  // The square the feet end in, and the head above it: water, so a swimmer can be there.
  if (!water(0, 0, 0) || !water(dx, dy, dz) || !block(dx, dy + 1, dz).safe) return undefined

  if (dx !== 0 || dz !== 0) {
    // **Along a slope, the body sweeps the corner squares too**, or a swim down past the lip of a
    // ledge is routed through the ledge. Up: through the water above first. Down: across first,
    // which is where the head of the move already is.
    if (dy === 1 && (!water(0, 1, 0) || !block(0, 2, 0).safe || !block(dx, 0, dz).safe)) return undefined
    if (dy === -1 && (!water(0, -1, 0) || !block(dx, 1, dz).safe)) return undefined
  } else if (dy === 1 && !block(0, 2, 0).safe) {
    return undefined
  }

  const x = from.x + dx
  const y = from.y + dy
  const z = from.z + dz
  return {
    x,
    y,
    z,
    hash: `${x},${y},${z}`,
    cost: Math.hypot(dx, dy, dz) + rules.liquidCost,
    toPlace: [],
    toBreak: [],
    remainingBlocks: from.remainingBlocks,
  }
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

  // **In water, the square of water it is in.** A swimmer is never on the ground, and the airborne
  // answer below looks for the floor under it - which puts the start of a search on the bed of the
  // lake, a square the agent is nowhere near and cannot sink to on purpose.
  if ((bot.entity as unknown as { isInWater?: boolean }).isInWater === true) {
    const liquids = (movements as unknown as { liquids: Set<number> }).liquids
    for (const y of [floored.y, floored.y - 1]) {
      const block = bot.blockAt(new WorldVec(floored.x, y, floored.z))
      if (block && liquids.has(block.type)) return square(floored.x, y, floored.z)
    }
  }

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
 * The estimate is upstream's arithmetic, leaned on: octile distance is the exact remaining cost on
 * open ground, and {@link LEAN} is what stops that exactness costing thirty seconds. See `search.ts`
 * for what the tie-breaking does with it.
 */
export function within(x: number, y: number, z: number, range: number, lean = LEAN): Goal {
  const rangeSq = range * range

  return {
    reached: (at) => {
      const dx = x - at.x
      const dy = y - at.y
      const dz = z - at.z
      return dx * dx + dy * dy + dz * dz <= rangeSq
    },
    estimate: (at) => octile(x - at.x, z - at.z) * lean + Math.abs(y - at.y) * CLIMB,
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
export function over(x: number, z: number, range: number, lean = LEAN): Goal {
  const rangeSq = range * range

  return {
    reached: (at) => {
      const dx = x - at.x
      const dz = z - at.z
      return dx * dx + dz * dz <= rangeSq
    },
    estimate: (at) => octile(x - at.x, z - at.z) * lean,
  }
}

/**
 * How much the distance left is leaned on.
 *
 * **Being exactly right about the ground is what made a long walk take half a minute.** Octile
 * distance is the true remaining cost across open ground, so every square that is no further from
 * the goal scores the same - and A* has no reason to prefer any of them. Ground that is not open
 * makes it worse: a hill or a wall means the real cost is higher than the estimate everywhere behind
 * it, and the search fills in the whole basin before it will commit to a way round.
 *
 * Overstating the distance left is the standard answer, and the trade is a route that can come back
 * slightly longer than the shortest one. Measured against the real rules, over rolling ground with
 * walls across it:
 *
 * | route | expanded at 1 | at 1.5 | route cost |
 * | --- | --- | --- | --- |
 * | 80 blocks | 4451 | 208 | 98 -> 100 |
 * | 150 blocks | 37646 | 1333 | 189 -> 206 |
 * | 150 blocks and 25 up | 125091 | 11701 | 224 -> 265 |
 *
 * Nobody watching an agent walk can tell a route a tenth longer from the shortest one; everybody
 * notices the thirty seconds it used to spend standing still first.
 *
 * **Only the horizontal term**, and that is not a detail: {@link CLIMB} already charges height more
 * than it costs, and leaning on that as well tips the search into climbing towards anything above it
 * before it has gone anywhere - measured, a goal 150 out and 25 up went from 125091 squares to
 * timing out at 600000.
 *
 * **The default rather than a constant.** An operator moves it with `path.haste`; `leanFor` in
 * settings.ts says where its ends are and what each costs.
 */
const LEAN = 1.5

/**
 * What a block of height is worth to the estimate.
 *
 * **Going up is the one thing the estimate was lying about.** A step along the ground costs 1 and
 * takes 1 off the estimate, so on open ground the estimate is exactly right. A step upwards costs
 * more - a move, plus the block that has to be laid to stand on - and used to take only 1 off. So
 * the first rung of a tower always looked worse than any square on the ground, and the search spread
 * out across the whole plane before it would climb: measured, 3901 squares expanded for a route that
 * was 25 straight up.
 *
 * The number tracks what a rung actually costs, so it moved when `placeCost` did - see `walk.ts`,
 * where laying a block went to 2 to stop the agent building its way past ground it could walk. At
 * 1.8 against a rung of 3 the same vertical goal cost 3565 squares instead of 605.
 *
 * Charging most of what a rung really costs puts that right, and it does it *only* for height -
 * leaning on the whole estimate instead would make going round something look more expensive than it
 * is and start cutting corners through walls. Slightly over the cheapest way up, which is a ladder or
 * a slope at 1, so a route with stairs in it can come back a step longer than the shortest. Nobody
 * watching can tell; everybody notices five seconds of standing still.
 */
const CLIMB = 2.5

/** Diagonal-aware distance, priced the way the neighbour source prices its steps. */
function octile(dx: number, dz: number): number {
  const x = Math.abs(dx)
  const z = Math.abs(dz)
  return Math.abs(x - z) + Math.min(x, z) * Math.SQRT2
}
