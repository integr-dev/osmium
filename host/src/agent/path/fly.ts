import type { Bot } from 'mineflayer'
import { Vec3 as WorldVec } from 'vec3'

import { log } from '../../log.ts'
import type { Driven } from './drive.ts'
import { standsAt, type Walk } from './ground.ts'
import { type Goal, type Neighbours, Search } from './search.ts'
import type { PathSettings } from './settings.ts'

/**
 * Flying, as the second engine under a journey.
 *
 * **Everything above the engine is shared.** The navigator owns the journey - the goal, the route
 * on the wire, arriving, giving up - and picks an engine per waypoint; walking is `drive.ts` and this
 * is the other one. It reports through the same `Driven`, and its route is drawn from the same
 * squares, so the map, the 3D view and the notices do not know which engine drew a line.
 *
 * **Straight when the air allows it, searched when it does not.** A flying agent can go anywhere the
 * hull fits, so most journeys are one line: the hull is swept along it, and if nothing is in the way
 * that line is the route. Only when something is does the search run - the same one walking uses,
 * over squares a player fits in rather than squares one can stand in - and what it finds is pulled
 * back into the fewest straight legs the air allows.
 *
 * **A long way is flown a stretch at a time, and high.** Somewhere a thousand blocks off is in chunks
 * the server has not sent, so there is nothing near it to aim at and a search for it can only run out
 * of time. Instead the agent climbs clear of the tallest thing ahead, flies a few dozen blocks along
 * the way at that height, and lines up the next stretch before it reaches the end of this one. Up
 * there almost nothing is in the line, so the search is left for caves, roofs and the nether.
 *
 * **Over, before round.** A spot close by with something in the straight line is flown to up, across
 * and down - the same three lines bring a cruising agent down onto its destination.
 *
 * **Anywhere it fits is somewhere to go.** A destination with ground under it is landed on; one in
 * open air is flown to and held, hovering, until the agent is sent somewhere else.
 *
 * **Movement is the physics engine's, steered.** Neither mineflayer nor the physics it runs knows
 * how to fly: the creative plugin's own `flyTo` moves the position by hand, through walls, which a
 * server answers by putting the agent back. Here the *velocity* is set every tick. The physics moves
 * the body by it before it applies gravity and drag - so what it moves is exactly what was set, every
 * collision is still resolved, and what the server sees is a player flying.
 *
 * Two kinds of flight, chosen by the server rather than by this file:
 *
 * - *Granted* - creative mode, or a server that lets the player fly. The server is told the agent
 *   is flying, exactly as a client would, and nothing about it is unusual.
 * - *Forced* - flying where the server has not allowed it, which an operator turns on separately.
 *   Vanilla kicks a player that floats for four seconds, measured by whether it keeps coming down,
 *   so the agent dips a little every two; and it claims to stand on the ground, through the same
 *   packet rewrite as no-fall, so the landing costs nothing. Anti-cheat plugins see through both.
 */

/** A point in the world. */
export interface Point {
  x: number
  y: number
  z: number
}

/** What a block is, as far as flying through it goes. Null where the world has not been sent. */
export type BlockAt = (x: number, y: number, z: number) => { name: string; boundingBox: string } | null

/** What the server allows, from its abilities packet. */
export interface Permit {
  /** Whether the player may fly: creative, or a server that grants it. */
  mayFly: boolean
  /** Vanilla's fly speed, which a server can change: acceleration per tick, in blocks. */
  speed: number
}

/** What the journey layer hands the engine for one waypoint. */
export interface FlightRules {
  reach: number
  slice: number
  budget: number
  sprint: boolean
  lean: number
  /** Flying without the server's leave - see the header. */
  forced: boolean
  speed: number
  /** What the operator multiplies the flying speed by. See `path.flySpeed`. */
  boost: number
}

/** What a flying agent tells the journey layer, beyond what walking does. */
export interface FlightReport extends Driven {
  /** Flying cannot get there, and why. The journey carries on on foot. */
  grounded(why: string): void
}

/** Where a flight is going. No height is a column. */
type Target = { x: number; y: number | undefined; z: number }

/** Vanilla's fly speed, for a server that has not said. */
export const FLY_SPEED = 0.05

/** How a waypoint is got to: flown, walked, or first asked the server for. */
export type Takeoff = 'fly' | 'ask' | 'walk'

/**
 * Whether a waypoint is flown, walked, or asked for first.
 *
 * In order: flight the server already allows; then the command that asks it to, once; and only then
 * flight it has not allowed, if the operator said to force it. Forcing is the last resort rather than
 * the first, because granted flight is the kind nothing on the server objects to.
 *
 * **Never asked for while it is already allowed.** Most of these commands switch flight off as well
 * as on, and running one on an agent that may already fly would take the leave away.
 */
export function takeoff(
  wanted: Pick<PathSettings, 'mode' | 'forceFly' | 'flyCommand'>,
  permit: Permit,
  asked: boolean,
): Takeoff {
  if (wanted.mode !== 'fly') return 'walk'
  if (permit.mayFly) return 'fly'
  if (wanted.flyCommand && !asked) return 'ask'
  return wanted.forceFly ? 'fly' : 'walk'
}

/**
 * Blocks that are empty to the physics and are still no place to fly through.
 *
 * Lava burns, the rest hurt or hold, and a portal would take the agent somewhere else entirely.
 *
 * **Water is not one of them.** A player who is flying is not slowed by water - vanilla leaves
 * fluids alone for anyone with flight - and the velocity this engine sets is what the physics moves
 * the body by, in water as out of it. Counted as closed, an agent that started underwater had no
 * square with room in it and gave up on flying before it had moved. See {@link WET}.
 */
const UNSAFE = new Set([
  'lava',
  'fire',
  'soul_fire',
  'cobweb',
  'sweet_berry_bush',
  'powder_snow',
  'wither_rose',
  'nether_portal',
  'end_portal',
  'end_gateway',
])

/** Solid, and still nothing to land on. */
const BAD_GROUND = new Set(['magma_block', 'campfire', 'soul_campfire', 'cactus', 'pointed_dripstone'])

/**
 * Water, which is flown through but not for longer than it has to be.
 *
 * A player underwater runs out of air, so a searched square of it costs {@link WET_COST} on top of
 * its distance, and a surface counts as ground when a stretch works out how high to fly - over a
 * lake, not along its bed.
 */
const WET = new Set(['water', 'bubble_column'])

/** What a searched square of water costs on top of its distance. */
const WET_COST = 2

/**
 * Blocks that burn, kept a margin clear of rather than only not flown into.
 *
 * **Not flying into a square of lava is not enough.** A route drawn through the squares beside a pool
 * is a route that passes within a hair of it, and anything that puts the agent a little off that
 * line - a corner taken early, the server nudging it off a block face - put it face first in the
 * lava. So every line, every square searched and every tick flown keeps the hull this far from all
 * of them.
 */
const SCORCHING = new Set(['lava', 'fire', 'soul_fire'])

/** How far from a burning block the hull is kept, in blocks. */
const SCORCH_MARGIN = 0.5

/** How many ticks of the velocity about to be set are checked for burning blocks before it is set. */
const SCORCH_TICKS = 2

/** What a searched square too close to something burning costs on top of its distance. */
const HOT_COST = 16

/** How far a line starting too close to something burning may stay that close, on its way off. */
const ESCAPE = 2

/** Whether a block is air as far as flight goes. An unsent block is not: nobody knows what it is. */
export function open(blockAt: BlockAt, x: number, y: number, z: number): boolean {
  const block = blockAt(x, y, z)
  return block !== null && block.boundingBox === 'empty' && !UNSAFE.has(block.name)
}

/** Whether a player fits in this square: the block it is in and the one its head is in. */
export function room(blockAt: BlockAt, x: number, y: number, z: number): boolean {
  return open(blockAt, x, y, z) && open(blockAt, x, y + 1, z)
}

/** Whether a flight can land here: room, and solid ground that does not hurt under it. */
export function standable(blockAt: BlockAt, x: number, y: number, z: number): boolean {
  if (!room(blockAt, x, y, z)) return false
  const under = blockAt(x, y - 1, z)
  return under !== null && under.boundingBox === 'block' && !BAD_GROUND.has(under.name)
}

/** A square as the search and the route on the wire both want it. Flight has no work to do. */
export function cell(x: number, y: number, z: number, cost = 0): Walk {
  return { x, y, z, hash: `${x},${y},${z}`, cost, toPlace: [], toBreak: [], remainingBlocks: 0 }
}

/** The 26 squares around one, as offsets. */
const OFFSETS: ReadonlyArray<readonly [number, number, number]> = [-1, 0, 1].flatMap((dx) =>
  [-1, 0, 1].flatMap((dy) =>
    [-1, 0, 1].flatMap((dz) => (dx === 0 && dy === 0 && dz === 0 ? [] : [[dx, dy, dz] as const])),
  ),
)

/**
 * What can be reached from a square by flying, one square in any direction.
 *
 * **A diagonal is only offered where the hull does not clip a corner on the way.** Moving one across
 * and one up passes through the square beside and the square above as well as the one it ends in,
 * so every one of those has to have room too - otherwise the route threads a gap the physics will
 * not let the agent through, and it hangs against the edge of a block.
 */
export function flyingFrom(blockAt: BlockAt): Neighbours {
  // Each block read once per search. The margin kept from burning blocks reads a few dozen around
  // every square, and neighbouring squares share nearly all of them.
  const seen = new Map<string, ReturnType<BlockAt>>()
  const cached: BlockAt = (x, y, z) => {
    const key = `${x},${y},${z}`
    if (seen.has(key)) return seen.get(key)!
    const block = blockAt(x, y, z)
    seen.set(key, block)
    return block
  }

  return (from) => {
    const steps: Walk[] = []

    for (const [dx, dy, dz] of OFFSETS) {
      const x = from.x + dx
      const y = from.y + dy
      const z = from.z + dz
      if (!room(cached, x, y, z)) continue
      if (!swept(cached, from, dx, dy, dz)) continue
      // Dear rather than closed, so a search that starts beside lava can still find its way off.
      const hot = !clearOfHeat(cached, x + 0.5, y + CLEARANCE, z + 0.5)
      const wet = WET.has(cached(x, y, z)?.name ?? '') || WET.has(cached(x, y + 1, z)?.name ?? '')
      steps.push(cell(x, y, z, Math.hypot(dx, dy, dz) + (hot ? HOT_COST : 0) + (wet ? WET_COST : 0)))
    }

    return steps
  }
}

/** Whether every square a one-square move passes through on the way has room. */
function swept(blockAt: BlockAt, from: Point, dx: number, dy: number, dz: number): boolean {
  // Each partial offset of the move: along one of its axes, or two, short of all of them.
  for (let mask = 1; mask < 7; mask++) {
    const ox = mask & 1 ? dx : 0
    const oy = mask & 2 ? dy : 0
    const oz = mask & 4 ? dz : 0

    // A mask naming an axis the move does not use is the same square as a smaller one.
    if ((mask & 1 && dx === 0) || (mask & 2 && dy === 0) || (mask & 4 && dz === 0)) continue
    // And one naming every axis it does use is the destination, which is already checked.
    if (ox === dx && oy === dy && oz === dz) continue

    if (!room(blockAt, from.x + ox, from.y + oy, from.z + oz)) return false
  }

  return true
}

/**
 * Somewhere near a point the agent fits.
 *
 * Not somewhere to *land*: a destination in open air is a destination, and requiring ground near it
 * made every one of them unreachable - the search then spent its whole budget proving that, with the
 * agent standing still. The estimate is the straight-line distance, which is exactly what flying
 * there costs in open air, leaned on by `path.haste` the way walking's is.
 */
export function aloftNear(target: Point, range: number, lean: number, blockAt: BlockAt): Goal {
  return {
    reached: (at) =>
      Math.hypot(target.x - at.x, target.y - at.y, target.z - at.z) <= range && room(blockAt, at.x, at.y, at.z),
    estimate: (at) => Math.hypot(target.x - at.x, target.y - at.y, target.z - at.z) * lean,
  }
}

/**
 * Somewhere to land over a column whose height nobody knows.
 *
 * Landed on rather than hovered over, because a column has no height to hover at: its ground is the
 * only height the operator can have meant.
 */
export function landingOver(x: number, z: number, range: number, lean: number, blockAt: BlockAt): Goal {
  return {
    reached: (at) => Math.hypot(x - at.x, z - at.z) <= range && standable(blockAt, at.x, at.y, at.z),
    estimate: (at) => Math.hypot(x - at.x, z - at.z) * lean,
  }
}

/** A player's hull: half its width, and its height. */
const HALF_WIDTH = 0.3
const HEIGHT = 1.8

/** How far apart the hull is checked along a line. A quarter block cannot step over a whole one. */
const STRIDE = 0.25

/**
 * How far above a square's floor a leg is flown.
 *
 * **Never flush with the blocks underneath.** A route over ground put the feet exactly on the top face
 * of the blocks below, and the forced flight's dip then pushed them a few hundredths into that layer -
 * where the next block along is a wall, and the agent hung against it with the line ahead reported
 * blocked.
 *
 * **Nor flush with the blocks overhead.** A player is 1.8 tall and a square with room is two, so this
 * is the margin at both ends at once: a fifth of a block left nothing above, and a gap two high was
 * flown with the head a few thousandths into its ceiling - which the physics stops dead, sideways
 * too, while every line the search drew through the gap said it was clear. A tenth either way is
 * still clear of every dip.
 */
const CLEARANCE = 0.1

/**
 * Whether the hull can travel a straight line, from feet position to feet position.
 *
 * Swept rather than sampled at the ends: a line between two open squares can pass through the corner
 * of a wall between them, and it is exactly that wall a straight route has to not fly into.
 */
export function clearLine(blockAt: BlockAt, from: Point, to: Point): boolean {
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const samples = Math.max(1, Math.ceil(length / STRIDE))

  // Starting too close to something burning, the first stretch of any way off is still too close -
  // and refusing it would leave an agent beside lava with no line out at all.
  const leaving = !clearOfHeat(blockAt, from.x, from.y, from.z)

  for (let at = 0; at <= samples; at++) {
    const t = at / samples
    const x = from.x + (to.x - from.x) * t
    const y = from.y + (to.y - from.y) * t
    const z = from.z + (to.z - from.z) * t
    if (!hullFits(blockAt, x, y, z, leaving && length * t <= ESCAPE)) return false
  }

  return true
}

function hullFits(blockAt: BlockAt, x: number, y: number, z: number, heatless = false): boolean {
  for (let bx = Math.floor(x - HALF_WIDTH); bx <= Math.floor(x + HALF_WIDTH - 1e-6); bx++) {
    for (let bz = Math.floor(z - HALF_WIDTH); bz <= Math.floor(z + HALF_WIDTH - 1e-6); bz++) {
      for (let by = Math.floor(y); by <= Math.floor(y + HEIGHT - 1e-6); by++) {
        if (!open(blockAt, bx, by, bz)) return false
      }
    }
  }
  return heatless || clearOfHeat(blockAt, x, y, z)
}

/** Whether the hull at a feet position is at least {@link SCORCH_MARGIN} from anything burning. */
function clearOfHeat(blockAt: BlockAt, x: number, y: number, z: number): boolean {
  const reach = HALF_WIDTH + SCORCH_MARGIN
  for (let bx = Math.floor(x - reach); bx <= Math.floor(x + reach); bx++) {
    for (let bz = Math.floor(z - reach); bz <= Math.floor(z + reach); bz++) {
      for (let by = Math.floor(y - SCORCH_MARGIN); by <= Math.floor(y + HEIGHT + SCORCH_MARGIN); by++) {
        const block = blockAt(bx, by, bz)
        if (block !== null && SCORCHING.has(block.name)) return false
      }
    }
  }
  return true
}

/**
 * The fewest straight legs a route can be flown in.
 *
 * Greedy from each end of a leg: carry on to the furthest point still in a clear line, then start the
 * next leg there. A searched route is a staircase of one-square steps; flown as they come, that is a
 * stop at every corner of a diagonal.
 */
export function straighten(points: readonly Point[], clear: (from: Point, to: Point) => boolean): Point[] {
  if (points.length <= 2) return [...points]

  const kept = [points[0]!]
  let at = 0

  while (at < points.length - 1) {
    let next = at + 1
    while (next + 1 < points.length && clear(points[at]!, points[next + 1]!)) next++
    kept.push(points[next]!)
    at = next
  }

  return kept
}

/** The point on a segment nearest another. */
function nearestOn(at: Point, from: Point, to: Point): Point {
  const lx = to.x - from.x
  const ly = to.y - from.y
  const lz = to.z - from.z
  const length = lx * lx + ly * ly + lz * lz
  const t =
    length === 0 ? 0 : Math.max(0, Math.min(1, ((at.x - from.x) * lx + (at.y - from.y) * ly + (at.z - from.z) * lz) / length))
  return { x: from.x + lx * t, y: from.y + ly * t, z: from.z + lz * t }
}

/** How far a point is from the segment between two others. */
export function awayFrom(at: Point, from: Point, to: Point): number {
  const near = nearestOn(at, from, to)
  return Math.hypot(at.x - near.x, at.y - near.y, at.z - near.z)
}

/** Horizontal drag per tick in vanilla flight: what makes a speed settle rather than grow. */
const DRAG = 0.91

/** The fastest a flying player climbs or sinks, in blocks a tick. */
const CLIMB_SPEED = 0.375

/** How close to a point counts as there. */
const REACHED = 0.35

/** The furthest from a corner the next leg takes over, in blocks. Any further and a corner is cut into a wall. */
const PASS_MOST = 1

/**
 * How much of the way back to its line the agent is pulled in a tick, and the most that pull may be.
 *
 * Aiming at the end of the leg alone leaves a drift or a dip where it put the agent, a little off the
 * line the air was checked along - which is how a flight came to scrape along something the line was
 * clear of. Pulled back, it flies the line that was checked.
 */
const HOLD_LINE = 0.3
const HOLD_LINE_MOST = 0.3

/**
 * How fast a corner can be taken, out of `top`.
 *
 * The whole speed straight on, less the sharper it turns - a quarter of it at a right angle - and
 * nothing for a turn back the way it came.
 */
export function cornerSpeed(at: Point, corner: Point, after: Point, top: number): number {
  const inX = corner.x - at.x
  const inY = corner.y - at.y
  const inZ = corner.z - at.z
  const outX = after.x - corner.x
  const outY = after.y - corner.y
  const outZ = after.z - corner.z

  const lengths = Math.hypot(inX, inY, inZ) * Math.hypot(outX, outY, outZ)
  if (lengths === 0) return 0

  const eased = Math.max(0, (1 + (inX * outX + inY * outY + inZ * outZ) / lengths) / 2)
  return top * eased * eased
}

/**
 * The fastest a corner can be taken and turned within {@link TURN_ROOM} of it, when the velocity
 * changes by at most `accel` a tick. Unbounded straight on.
 *
 * Turning means changing the velocity by the difference between the two directions, which takes that
 * many accelerations - and the agent carries on past the corner for half of it.
 */
export function turnSpeed(at: Point, corner: Point, after: Point, accel: number): number {
  const inLength = Math.hypot(corner.x - at.x, corner.y - at.y, corner.z - at.z)
  const outLength = Math.hypot(after.x - corner.x, after.y - corner.y, after.z - corner.z)
  if (inLength === 0 || outLength === 0) return 0

  const change = Math.hypot(
    (after.x - corner.x) / outLength - (corner.x - at.x) / inLength,
    (after.y - corner.y) / outLength - (corner.y - at.y) / inLength,
    (after.z - corner.z) / outLength - (corner.z - at.z) / inLength,
  )
  if (change < 1e-6) return Infinity
  return Math.sqrt((2 * accel * TURN_ROOM) / change)
}

/** How often a forced flight comes down a little, in ticks. Vanilla kicks at eighty. */
const ANTI_KICK = 40

/** How far that dip is, in blocks. Vanilla forgives anything that keeps coming down by more than 1/32. */
const DIP = -0.04

/** How long a leg may go without getting any closer before it counts as stuck, in ticks. */
const STALL_TICKS = 40

/** How much closer counts as getting closer, in blocks. */
const STALL_PROGRESS = 0.25

/** How long to wait for the ground after the last leg, before calling it arrived regardless. */
const LANDING_TICKS = 60

/** How often what the flight is doing is worth a debug line. */
const NARRATE_MS = 1_000

/** How far up to look for a column's ground, in blocks from the top of the world. */
const WORLD_TOP = 320
const WORLD_BOTTOM = -64

/**
 * Further than this, a destination is flown towards a stretch at a time rather than searched for.
 *
 * About as far as the loaded world reaches past the agent in every direction a server commonly sends,
 * and as far as a search through the air finishes quickly.
 */
const SEARCH_WITHIN = 40

/** How far along the way a stretch aims, longest first. */
const STRETCHES = [48, 32, 16]

/** How far above the straight line a stretch will climb to get over something in it. */
const CLIMBS = [0, 6, 12, 24, 48]

/** How close to the end of a stretch the next is lined up, in blocks. */
const LINE_UP_AT = 12

/**
 * How far above the highest ground along the way a long flight cruises, in blocks.
 *
 * **High enough that the ground stops mattering.** Skimming it, every tree and hill in the line is
 * something to climb over or search round, one stretch at a time; a dozen blocks above the tallest
 * thing ahead, a stretch is one clear line nearly every time.
 */
const CRUISE_ABOVE = 12

/**
 * How far apart the heights are that a stretch tries, climbing, when the one it wants is blocked.
 *
 * **Up is the answer to something in the way, before round or through.** A wall that needed the build
 * limit to cross was searched through like a maze instead, a square at a time.
 */
const CRUISE_STEP = 24

/**
 * How far above the agent the ground under a stretch is looked for, in blocks.
 *
 * The ground is what a flight has to clear, not everything in the column: counted from the top of the
 * world, a spawn with builds at the build limit left no height worth flying at anywhere near it.
 */
const CRUISE_LOOK_UP = 32

/**
 * How far past the end of a stretch the ground is looked over to set its height, in blocks.
 *
 * Only so far: counting everything a hundred blocks ahead, one tower at spawn that reaches the top of
 * the world ruled out flying high anywhere near it - from a stretch that was never going to pass it.
 */
const CRUISE_BEYOND = 24

/**
 * The slope a change of height is flown at, in blocks up or down per block along: about what vertical
 * flight speed allows at full speed forwards, so a climb costs almost nothing.
 *
 * **Along the way, not on the spot.** Straight up and then across is a right angle, and a right angle
 * is taken at a crawl - every climb stopped dead at the top, and every descent at the bottom.
 */
const GLIDE = 0.35

/** How much of the {@link GLIDE} distance a climb tries, in order, before going straight up. */
const RAMP_SHARES = [1, 0.5, 0.25, 0]

/**
 * How far off the straight way a stretch will turn to go round something too tall to fly over, in
 * degrees, straight on first.
 */
const CRUISE_VEERS = [0, 25, -25, 50, -50]

/**
 * How far past a corner the agent may carry on while it turns, in blocks.
 *
 * What sets how fast a corner is taken as well as how sharp it is. Steering changes the velocity by a
 * flight's acceleration a tick and no more, so a corner taken fast is a wide arc - and at speed, on a
 * route of short legs through somewhere tight, that arc ran five blocks past a corner into a wall.
 */
const TURN_ROOM = 0.35

/** How much clearer than the ground a climb over something close by passes, in blocks. */
const OVER_BY = 2

/** The flying engine. See the header. */
export class FlightDriver {
  private target: Target | undefined
  private range = 1
  private rules: FlightRules | undefined

  private plotting: Search | undefined
  /** When the search in hand started, for saying how long it took. */
  private searchedAt = 0
  /** The legs still to fly, as feet positions. */
  private legs: Point[] = []
  /** Where the leg being flown started: the line it is held to. */
  private from: Point | undefined
  /** Whether the route in hand stops short of the target, so its end is somewhere to plan from. */
  private short = false
  /** The leg end the next stretch was last lined up from, so it is tried once per stretch. */
  private linedUp: Point | undefined
  /** Whether the last search could not reach the target at all. */
  private hopeless = false

  /** Whether the agent is flying, as far as this engine is concerned. */
  private aloft = false
  /** What gravity was before flying, which only matters to a client that reads it. */
  private gravity: number | undefined
  /** Whether it has nowhere to go and is holding where it is in the air. */
  private holding = false
  /** Ticks counted, for the dip and for stalls. */
  private ticks = 0
  /** Ticks spent waiting for the ground after the last leg. */
  private landing: number | undefined
  /** Why flying was given up, while the agent comes down to the ground before walking takes over. */
  private grounding: string | undefined

  /**
   * The velocity set last tick, which the next one is steered from.
   *
   * **Not what the physics left behind.** It takes gravity and drag off a velocity after moving the
   * body by it, so reading it back and nudging it by a slow flight's acceleration came up short of the
   * gravity every tick - and every level leg sank in the middle.
   */
  private sent: Point = { x: 0, y: 0, z: 0 }

  private stall = { distance: Infinity, since: 0, count: 0 }

  /** When it last said what it was doing. */
  private narrated = 0

  /**
   * The highest thing in each column looked over this journey, by `x,z`.
   *
   * A column is a few hundred blocks read top down, and each stretch looks over the next hundred
   * columns - most of which the last one already did.
   */
  private readonly tops = new Map<string, number>()

  private readonly onTick = (): void => this.tick()

  /** What a block is, from the world the bot holds. Null where it has not been sent. */
  private readonly blocks: BlockAt = (x, y, z) => {
    const block = this.bot.blockAt(new WorldVec(x, y, z))
    return block ? { name: block.name, boundingBox: block.boundingBox } : null
  }

  constructor(
    private readonly id: number,
    private readonly bot: Bot,
    private readonly rulesNow: () => FlightRules,
    private readonly report: FlightReport,
  ) {}

  start(): void {
    this.bot.on('physicsTick', this.onTick)
  }

  /** Puts everything down, the agent included. */
  stop(): void {
    this.bot.removeListener('physicsTick', this.onTick)
    this.release()
  }

  /** Whether it is on its way somewhere. */
  moving(): boolean {
    return this.target !== undefined
  }

  /**
   * Whether the agent should claim to be on the ground.
   *
   * Only while forced into the air: a granted flight takes no fall damage and a server that allows
   * it has nothing to be lied to about.
   */
  claimsGround(): boolean {
    return this.aloft && this.rules?.forced === true
  }

  /** Fly there: land if there is ground, hold in the air if not. `y` absent is a column. */
  go(target: { x: number; y?: number; z: number }, range: number): void {
    // Not landed first: an agent already in the air goes on from where it is.
    this.forget()
    this.tops.clear()
    this.target = { x: target.x, y: target.y, z: target.z }
    this.range = range
    this.rules = this.rulesNow()
    this.plan()
  }

  /**
   * Stop going anywhere. In the air, that is holding where it is, which is what stopping means to
   * something flying - dropping out of the sky is not.
   */
  halt(): void {
    const aloft = this.aloft
    this.forget()
    if (aloft) {
      log.debug(`Agent ${this.id} was stopped in the air, and is holding there`)
      this.holding = true
    }
  }

  /** Stop flying altogether: the journey is walked from here, or the session is over. */
  release(): void {
    this.forget()
    this.land()
  }

  /** Everything about the journey, leaving whether the agent is in the air alone. */
  private forget(): void {
    this.target = undefined
    this.plotting = undefined
    this.legs = []
    this.from = undefined
    this.short = false
    this.linedUp = undefined
    this.hopeless = false
    this.landing = undefined
    this.holding = false
    this.grounding = undefined
    this.stall = { distance: Infinity, since: this.ticks, count: 0 }
  }

  private tick(): void {
    if (!this.bot.entity) return
    this.ticks++

    try {
      if (!this.target) {
        if (this.holding) this.hold()
        return
      }
      if (this.landing !== undefined) return this.settle()
      if (this.plotting) return this.think()
      if (this.legs.length === 0) return this.plan()
      this.steer()
    } catch (err) {
      log.warn(`Agent ${this.id} could not work out how to fly: ${(err as Error).message}`)
      this.drop('working out the flight failed')
    }
  }

  /**
   * Works out the next part of the flight from where the agent is.
   *
   * Straight at somewhere near the destination it can stop, if the air allows it. Otherwise, for a
   * destination further than a search comfortably reaches, a stretch along the way; and a search
   * through the air only for what is left - a short hop, or a destination close by with something in
   * the way.
   *
   * `raised` starts a search a square up, which is how a flight that stalled against something gets
   * clear of it.
   */
  private plan(raised = false): void {
    const target = this.target
    const rules = this.rules
    if (!target || !rules || !this.bot.entity) return

    const at = this.bot.entity.position
    const here = { x: at.x, y: at.y, z: at.z }
    const spot = this.stopAt(target, here)
    const aim = spot ? aloft(spot) : undefined

    if (aim && clearLine(this.blocks, here, aim)) {
      log.debug(
        `Agent ${this.id} is flying straight to ${spot!.x} ${spot!.y} ${spot!.z}` +
          (standable(this.blocks, spot!.x, spot!.y, spot!.z) ? ', to land there' : ', to hold there in the air'),
      )
      this.short = false
      this.follow([aim])
      return
    }

    // Up over whatever is in the way and down onto the spot, which is three straight lines where a
    // search through the air would be thousands of squares.
    const over = aim ? this.overTheTop(here, aim) : undefined
    if (over) {
      log.debug(`Agent ${this.id} is flying up over what is in the way to ${spoken(aim!)}, at y ${over[0]!.y.toFixed(1)}`)
      this.short = false
      this.follow(over)
      return
    }

    const far = Math.hypot(target.x - here.x, (target.y ?? here.y) - here.y, target.z - here.z) > SEARCH_WITHIN

    if (far) {
      const cruise = this.cruiseFrom(here, target)
      if (cruise) {
        log.debug(
          `Agent ${this.id} is cruising towards ${place(target)} at y ${cruise[cruise.length - 1]!.y.toFixed(1)}, ` +
            `to ${spoken(cruise[cruise.length - 1]!, 1)}`,
        )
        this.short = true
        this.follow(cruise)
        return
      }

      const stretch = this.stretchFrom(here, target)
      if (stretch) {
        log.debug(
          `Agent ${this.id} is flying a stretch towards ${place(target)}, ` +
            `to ${stretch.x.toFixed(1)} ${stretch.y.toFixed(1)} ${stretch.z.toFixed(1)}`,
        )
        this.short = true
        this.follow([stretch])
        return
      }

      // **Not there yet is not in the way.** Flying outruns the server sending the world, so the air a
      // stretch would cross is often simply not sent - and searching it can only fail, and failing
      // twice used to send the rest of the journey on foot. It holds where it is and asks again next
      // tick, which is cheap: an unsent square fails before any line is swept.
      if (!this.aheadSent(here, target)) {
        if (this.due()) log.debug(`Agent ${this.id} is waiting for the world ahead to arrive before flying on towards ${place(target)}`)
        if (this.aloft) this.hold()
        return
      }
    }

    // What the search aims at: the destination when it is close, and the nearest stretch along the way
    // when it is not - which is somewhere in the loaded world, so the search has an answer to find.
    const hop = far ? this.alongTheWay(here, target, STRETCHES[0]!) : undefined
    const goal = hop
      ? aloftNear(hop, 3, rules.lean, this.blocks)
      : target.y === undefined
        ? landingOver(target.x, target.z, this.range, rules.lean, this.blocks)
        : aloftNear({ x: target.x, y: target.y, z: target.z }, this.range, rules.lean, this.blocks)

    log.debug(
      `Agent ${this.id} ${spot ? `has no straight line to ${spot.x} ${spot.y} ${spot.z}` : `knows nowhere to stop near ${place(target)}`}` +
        `, so it is searching the air${hop ? ` for a way ${STRETCHES[0]} blocks along` : ''}`,
    )

    this.short = hop !== undefined
    this.searchedAt = Date.now()
    this.plotting = new Search(this.startCell(here, raised), flyingFrom(this.blocks), goal, {
      budget: rules.budget,
      slice: rules.slice,
      reach: rules.reach,
    })
  }

  /**
   * A point along the way to a far destination, in a straight clear line from `from`.
   *
   * The longest stretch first, at the height the line to the destination would be at there, then
   * higher over whatever is in it. Nothing if every one is blocked or not sent.
   */
  private stretchFrom(from: Point, target: Target): Point | undefined {
    for (const length of STRETCHES) {
      const base = this.alongTheWay(from, target, length)
      if (!base) continue

      for (const climb of CLIMBS) {
        const square = { x: Math.floor(base.x), y: Math.floor(base.y) + climb, z: Math.floor(base.z) }
        if (square.y >= WORLD_TOP - 2 || !room(this.blocks, square.x, square.y, square.z)) continue

        const point = aloft(square)
        if (clearLine(this.blocks, from, point)) return point
      }
    }
    return undefined
  }

  /**
   * A stretch flown high: up to a height clear of everything ahead, then level along the way.
   *
   * The height is set by the tallest thing in the columns the next {@link CRUISE_AHEAD} blocks cross,
   * so the flight climbs once, before the hill, rather than a stretch at a time up its face. Nothing
   * where the destination is close enough to come down to, where the ground ahead has not been sent,
   * or where the climb itself is blocked - under a roof, in a cave, in the nether - which the
   * stretches and the search below it are for.
   */
  private cruiseFrom(from: Point, target: Target): Point[] | undefined {
    const dx = target.x - from.x
    const dz = target.z - from.z
    const across = Math.hypot(dx, dz)
    if (across <= SEARCH_WITHIN) return undefined

    const heading = Math.atan2(dz, dx)
    const ceiling = this.ceilingAbove(from)
    const below = this.lookUnder(from.y)
    let why = 'no stretch is long enough before the destination'

    // Straight on, at every length and every height up to the highest it can climb, before turning at
    // all: a turn is distance that is not towards the destination, and height is not.
    for (const veer of CRUISE_VEERS) {
      const angle = heading + (veer * Math.PI) / 180
      const ux = Math.cos(angle)
      const uz = Math.sin(angle)
      const rises = this.risesAlong(from, ux, uz, STRETCHES[0]! + CRUISE_BEYOND, below)
      const known = rises.length - 1

      for (const length of STRETCHES) {
        if (length >= across) continue
        if (known < length) {
          why = `the ground ahead is sent only ${Math.max(0, known)} blocks out`
          continue
        }

        const peak = rises[Math.min(known, length + CRUISE_BEYOND)]!
        // **Never lower than it already is**, but for gliding down towards the destination. Coming
        // back down once past a wall is climbing again at the next one; coming down only at the end
        // is a drop of however high it flew, at the speed a flight sinks.
        const glide = this.glideAt(target, across - length, from.y)
        const wanted = Math.max(peak.top + 1 + CRUISE_ABOVE, glide === undefined ? from.y : Math.min(from.y, glide))

        for (const height of levels(wanted, ceiling)) {
          const end = { x: from.x + ux * length, y: height, z: from.z + uz * length }
          const route = this.rampTo(from, end, ux, uz, length)
          if (!route) continue

          if (height > wanted + 0.5) log.debug(`Agent ${this.id} is climbing to y ${height.toFixed(1)} to fly over what is in the way at y ${wanted.toFixed(1)}`)
          if (veer !== 0) log.debug(`Agent ${this.id} is turning ${veer} degrees to fly round what is in the way: ${why}`)
          return route
        }
        why = `nothing is clear along the way at any height from y ${Math.min(wanted, ceiling).toFixed(0)} up to y ${ceiling.toFixed(0)}, the highest it can climb here`
      }
    }
    return this.noCruise(why)
  }

  /**
   * A stretch to `end`, with its change of height flown along the way.
   *
   * The whole stretch as one sloping line where the air allows it; otherwise up (or down) along the
   * first part of it and level for the rest, steeper each time something is in the way, and straight
   * up only when nothing else is clear.
   */
  private rampTo(from: Point, end: Point, ux: number, uz: number, length: number): Point[] | undefined {
    const rise = Math.abs(end.y - from.y)
    if (rise < 0.5) return clearLine(this.blocks, from, end) ? [end] : undefined

    for (const share of RAMP_SHARES) {
      const along = Math.min(length, (rise / GLIDE) * share)
      const top = { x: from.x + ux * along, y: end.y, z: from.z + uz * along }
      if (!clearLine(this.blocks, from, top)) continue
      if (along >= length - 0.01) return [end]
      if (clearLine(this.blocks, top, end)) return [top, end]
    }
    return undefined
  }

  /**
   * The highest a flight should be this far from its destination, to come down onto it along the
   * {@link GLIDE} rather than drop onto it at the end. Nothing where nobody knows how high the
   * destination is.
   */
  private glideAt(target: Target, remaining: number, from: number): number | undefined {
    const ground =
      target.y ?? this.topOf(Math.floor(target.x), Math.floor(target.z), this.lookUnder(from))
    if (ground === undefined) return undefined
    const floor = target.y ?? ground + 1
    return floor + CLEARANCE + Math.max(0, remaining) * GLIDE
  }

  /**
   * The highest the agent can climb straight up from where it is, in whole blocks, to the build limit.
   *
   * Every height a stretch tries is one it can get to, so the climb itself is never what fails.
   */
  private ceilingAbove(from: Point): number {
    const limit = this.worldTop() - 3
    let y = from.y
    while (y + 1 <= limit && hullFits(this.blocks, from.x, y + 1, from.z)) y += 1
    return y
  }

  /** The height the ground under a stretch is read from: see {@link CRUISE_LOOK_UP}. */
  private lookUnder(y: number): number {
    return Math.min(this.worldTop(), Math.ceil((y + CRUISE_LOOK_UP) / 16) * 16)
  }

  /** Why a stretch is not flown high, for telling a flight that skims the ground from the log. */
  private noCruise(why: string): undefined {
    log.debug(`Agent ${this.id} is not cruising: ${why}`)
    return undefined
  }

  /**
   * Up, across and down to a spot close by, when the straight line to it is blocked.
   *
   * Just clear of the tallest thing between - or at the height the agent is already flying, when
   * that is higher, which makes this the way down from a cruise as well.
   */
  private overTheTop(from: Point, aim: Point): Point[] | undefined {
    const dx = aim.x - from.x
    const dz = aim.z - from.z
    const across = Math.hypot(dx, dz)
    if (across < 1) return undefined

    const ground = this.highestAlong(from, dx / across, dz / across, across, this.lookUnder(Math.max(from.y, aim.y)))
    if (ground.known < across) return undefined

    // As high as it takes, up to the highest it can climb: the lowest that clears the ground first,
    // and higher over whatever else is in the way.
    const wanted = Math.max(from.y, aim.y, ground.top + 1 + OVER_BY)

    const ux = dx / across
    const uz = dz / across

    const apart = (one: Point, other: Point) => Math.hypot(one.x - other.x, one.y - other.y, one.z - other.z) > 0.01

    for (const height of levels(wanted, this.ceilingAbove(from))) {
      // Up along the way and down along the way, each as shallow as the air there allows - see GLIDE.
      // Apart: a wall right in front makes the climb steep, and nothing about it makes the far side's
      // descent steep too.
      for (const upShare of RAMP_SHARES) {
        const up = Math.min(across, (Math.abs(height - from.y) / GLIDE) * upShare)
        const top = { x: from.x + ux * up, y: height, z: from.z + uz * up }
        if (apart(from, top) && !clearLine(this.blocks, from, top)) continue

        for (const downShare of RAMP_SHARES) {
          const down = Math.min(across - up, (Math.abs(height - aim.y) / GLIDE) * downShare)
          const brow = { x: aim.x - ux * down, y: height, z: aim.z - uz * down }

          const points = [top, brow, aim].filter((point, index, all) => apart(point, index === 0 ? from : all[index - 1]!))
          let at = from
          let clear = true
          for (const point of points) {
            // The climb is already known to be clear.
            if (point !== top && !clearLine(this.blocks, at, point)) {
              clear = false
              break
            }
            at = point
          }
          if (clear) return points
        }
      }
    }
    return undefined
  }

  /**
   * The tallest thing in the columns a line crosses, and how far along it the world has been sent.
   *
   * Every column the hull overlaps, a block apart. `top` is the highest of them as far as `known`.
   */
  private highestAlong(from: Point, ux: number, uz: number, length: number, below: number): { top: number; known: number } {
    const rises = this.risesAlong(from, ux, uz, length, below)
    const known = rises.length - 1
    return { top: rises[known]?.top ?? WORLD_BOTTOM, known: known === Math.ceil(length) ? length : known }
  }

  /**
   * The tallest thing below `below` so far, and where it is, at each block along a line - as far as
   * the world has been sent. Index `n` covers the first `n` blocks, so one pass answers for every
   * stretch length.
   */
  private risesAlong(
    from: Point,
    ux: number,
    uz: number,
    length: number,
    below: number,
  ): Array<{ top: number; x: number; z: number }> {
    const rises: Array<{ top: number; x: number; z: number }> = []
    let peak = { top: WORLD_BOTTOM, x: Math.floor(from.x), z: Math.floor(from.z) }

    for (let along = 0; along <= Math.ceil(length); along++) {
      const d = Math.min(along, length)
      const x = from.x + ux * d
      const z = from.z + uz * d

      for (let bx = Math.floor(x - HALF_WIDTH); bx <= Math.floor(x + HALF_WIDTH); bx++) {
        for (let bz = Math.floor(z - HALF_WIDTH); bz <= Math.floor(z + HALF_WIDTH); bz++) {
          const column = this.topOf(bx, bz, below)
          if (column === undefined) return rises
          if (column > peak.top) peak = { top: column, x: bx, z: bz }
        }
      }
      rises.push(peak)
    }
    return rises
  }

  /**
   * The highest block below `below` in a column that is not air to fly through, or nothing if the
   * column has not been sent.
   */
  private topOf(x: number, z: number, below: number): number | undefined {
    const key = `${x},${z},${below}`
    const held = this.tops.get(key)
    if (held !== undefined) return held

    let sent = false
    for (let y = below - 1; y >= WORLD_BOTTOM; y--) {
      const block = this.blocks(x, y, z)
      if (block === null) {
        // Above what the world holds, where nothing is sent however loaded the column is.
        if (!sent) continue
        return this.remember(key, y)
      }
      sent = true
      // A water surface is ground to fly over, though it is not ground to fly into: see WET.
      if (!open(this.blocks, x, y, z) || WET.has(block.name)) return this.remember(key, y)
    }
    return sent ? this.remember(key, WORLD_BOTTOM) : undefined
  }

  private remember(key: string, y: number): number {
    this.tops.set(key, y)
    return y
  }

  /** The top of the world the agent is in: its build limit, where the server has said. */
  private worldTop(): number {
    const game = this.bot.game as unknown as { minY?: number; height?: number } | undefined
    return game?.height !== undefined ? (game.minY ?? 0) + game.height : WORLD_TOP
  }

  /** Whether the world has been sent as far as the shortest stretch along the way reaches. */
  private aheadSent(from: Point, target: Target): boolean {
    const base = this.alongTheWay(from, target, STRETCHES[STRETCHES.length - 1]!)
    return !base || this.blocks(Math.floor(base.x), Math.floor(base.y), Math.floor(base.z)) !== null
  }

  /** The point `length` blocks along the straight way to a destination, at the height the way is there. */
  private alongTheWay(from: Point, target: Target, length: number): Point | undefined {
    const toY = target.y ?? from.y
    const dx = target.x - from.x
    const dy = toY - from.y
    const dz = target.z - from.z
    const distance = Math.hypot(dx, dy, dz)
    if (distance <= length) return undefined

    const t = length / distance
    return { x: from.x + dx * t, y: from.y + dy * t, z: from.z + dz * t }
  }

  /** One slice of searching the air. */
  private think(): void {
    const search = this.plotting
    if (!search) return

    // Longer while standing still, as walking does: there is nothing else for the tick to do.
    const found = search.run(this.aloft ? undefined : this.rules!.slice * 3)
    if (found.outcome === 'partial') {
      if (this.aloft) this.hold()
      if (this.due()) {
        log.debug(`Agent ${this.id} is still searching the air: ${found.looked} squares in ${Date.now() - this.searchedAt} ms`)
      }
      return
    }

    this.plotting = undefined
    log.debug(
      `Agent ${this.id} searched the air: ${found.outcome}, ${found.steps.length} squares long, ` +
        `${found.looked} looked at in ${Date.now() - this.searchedAt} ms`,
    )

    if (found.steps.length === 0) {
      this.drop(found.outcome === 'timeout' ? 'the search through the air ran out of time' : 'there is no way there through the air')
      return
    }

    // The same rule walking keeps: the closest it can get is flown once, and the same answer from
    // where it ends is the answer rather than a reason to shuffle forward for ever.
    if (found.outcome === 'nowhere') {
      if (this.hopeless) {
        this.drop('there is no way there through the air')
        return
      }
      this.hopeless = true
      this.report.closest()
    } else {
      this.hopeless = false
    }

    if (found.outcome !== 'found') this.short = true
    this.follow((found.steps as Walk[]).map(aloft))
  }

  /** Takes points as the legs to fly, straightened, and draws them. */
  private follow(points: readonly Point[]): void {
    const at = this.bot.entity.position
    const here = { x: at.x, y: at.y, z: at.z }

    this.legs = straighten([here, ...points], (from, to) => clearLine(this.blocks, from, to)).slice(1)
    this.from = here
    this.linedUp = undefined
    this.stall = { distance: Infinity, since: this.ticks, count: this.stall.count }

    log.debug(`Agent ${this.id} will fly ${this.legs.length} leg(s): ${this.legs.map(spoken).join(' -> ')}`)
    this.draw()
  }

  /**
   * The route as the map and the 3D view draw it: from where the agent is, through every leg.
   *
   * From the agent rather than from the first leg's end, because a flight is often one leg - and a line
   * of one point is not a line, so a straight flight used to draw nothing at all.
   */
  private draw(): void {
    const at = this.bot.entity.position
    const points = [{ x: at.x, y: at.y, z: at.z }, ...this.legs]
    this.report.route(
      points.map((point) => cell(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z))),
      true,
    )
  }

  /** One tick of flying towards the next leg's end. */
  private steer(): void {
    const leg = this.legs[0]
    const rules = this.rules
    if (!leg || !rules) return

    this.takeOff()

    const at = this.bot.entity.position
    const dx = leg.x - at.x
    const dy = leg.y - at.y
    const dz = leg.z - at.z
    const distance = Math.hypot(dx, dy, dz)
    const after = this.legs[1]

    // **A corner is passed, not arrived at.** Within a block or so - further the faster it is going -
    // the next leg takes over, and is steered this same tick rather than losing one to the change.
    // Only where the next leg can be flown from here: taken early, the corner is cut, and the air
    // across it is air nobody checked.
    const moving = Math.hypot(this.sent.x, this.sent.y, this.sent.z)
    const early = after ? Math.max(REACHED, Math.min(PASS_MOST, moving * 2)) : REACHED
    const pass = early > REACHED && distance <= early && !clearLine(this.blocks, at, after!) ? REACHED : early

    if (distance <= pass) {
      this.legs.shift()
      this.from = { x: leg.x, y: leg.y, z: leg.z }
      this.stall = { distance: Infinity, since: this.ticks, count: this.stall.count }
      if (this.legs.length > 0) {
        this.steer()
        return
      }

      // The end of a route that stops short is where the next part starts, not an arrival.
      if (this.short) {
        log.debug(`Agent ${this.id} flew to the end of a route that stops short, and is working out the rest`)
        this.plan()
        return
      }

      this.arrive(leg)
      return
    }

    // The next stretch, lined up before this one ends, so a long flight does not stop at every joint.
    if (!after && this.short && distance <= LINE_UP_AT && this.linedUp !== leg) this.lineUpFrom(leg)

    if (this.stuck(distance, leg)) return

    const boost = rules.boost
    const accel = rules.speed * boost * (rules.sprint ? 2 : 1)
    const top = (accel * DRAG) / (1 - DRAG)
    const climbSpeed = CLIMB_SPEED * boost
    const next = this.legs[1]

    // **Braked as late as steering can brake, and only as far as the end of the leg needs.** Nothing is
    // left at the last leg's end; a corner keeps what its turn allows. It used to brake the way coasting
    // does, a tenth off the distance left every tick, into every corner - so the last ten blocks of
    // each leg crawled, and a route of several legs stopped dead at every one of them.
    const step = Math.max(accel, 0.05)
    const exit = next ? Math.min(cornerSpeed(at, leg, next, top), turnSpeed(at, leg, next, step)) : 0
    let speed = Math.min(top, Math.sqrt(exit * exit + 2 * accel * distance), next ? top : distance)

    // **Straight, in all three axes at once.** The whole vector is slowed until the climb fits, so it
    // points at the end of the leg all the way there rather than running level and climbing late.
    const climb = Math.abs(dy) / distance
    if (climb * speed > climbSpeed) speed = climbSpeed / climb

    // And held to the line it is on, which is the line the air was checked along - see HOLD_LINE.
    const from = this.from ?? { x: at.x, y: at.y, z: at.z }
    const near = nearestOn(at, from, leg)
    const pull = clampLength({ x: (near.x - at.x) * HOLD_LINE, y: (near.y - at.y) * HOLD_LINE, z: (near.z - at.z) * HOLD_LINE }, HOLD_LINE_MOST)

    const want = {
      x: (dx / distance) * speed + pull.x,
      y: (dy / distance) * speed + pull.y,
      z: (dz / distance) * speed + pull.z,
    }
    const velocity = approach(this.sent, want, step)

    // Vanilla kicks a player that floats without coming down. Forced, it comes down a little now and
    // then, and the pull back to the line takes it straight back up.
    if (rules.forced && this.ticks % ANTI_KICK === 0 && velocity.y > DIP) velocity.y = DIP

    if (this.scorching(at, velocity)) return

    this.push(velocity)
    if (Math.hypot(dx, dz) > 0.2) void this.bot.look(Math.atan2(-dx, -dz), 0, true)

    if (this.due()) {
      log.debug(
        `Agent ${this.id} flying to ${spoken(leg)} from ${spoken(at)}: ${distance.toFixed(2)} left, ` +
          `${awayFrom(at, from, leg).toFixed(2)} off the line, velocity ${velocity.x.toFixed(3)} ${velocity.y.toFixed(3)} ${velocity.z.toFixed(3)}, ` +
          `${this.legs.length} leg(s) to go${this.short ? ', more after' : ''}${rules.forced ? ', forced' : ''}`,
      )
    }
  }

  /** Adds the next straight stretch after a leg's end, if the air allows one. */
  private lineUpFrom(end: Point): void {
    const target = this.target
    if (!target) return
    this.linedUp = end

    const spot = this.stopAt(target, end)
    const aim = spot ? aloft(spot) : undefined
    if (aim && clearLine(this.blocks, end, aim)) {
      log.debug(`Agent ${this.id} lined up the last leg, to ${spoken(aim)}`)
      this.legs.push(aim)
      this.short = false
      this.draw()
      return
    }

    const over = aim ? this.overTheTop(end, aim) : undefined
    if (over) {
      log.debug(`Agent ${this.id} lined up the way down, to ${spoken(aim!)}`)
      this.legs.push(...over)
      this.short = false
      this.draw()
      return
    }

    const far = Math.hypot(target.x - end.x, (target.y ?? end.y) - end.y, target.z - end.z) > SEARCH_WITHIN
    if (!far) return

    const cruise = this.cruiseFrom(end, target)
    const stretch = cruise ?? [this.stretchFrom(end, target)].filter((point) => point !== undefined)
    if (stretch.length === 0) return

    log.debug(`Agent ${this.id} lined up the next stretch, to ${spoken(stretch[stretch.length - 1]!)}`)
    this.legs.push(...stretch)
    this.draw()
  }

  /** The last leg is flown: land where there is ground, hold where there is not. */
  private arrive(leg: Point): void {
    const x = Math.floor(leg.x)
    const y = Math.floor(leg.y)
    const z = Math.floor(leg.z)

    if (standable(this.blocks, x, y, z)) {
      log.debug(`Agent ${this.id} is landing at ${x} ${y} ${z}`)
      this.landing = 0
      this.push({ x: 0, y: 0, z: 0 })
      this.land()
      return
    }

    log.debug(`Agent ${this.id} arrived at ${x} ${y} ${z} with nothing under it, and is holding there in the air`)
    this.target = undefined
    this.holding = true
    this.hold()
    this.report.arrived()
  }

  /**
   * Whether the velocity about to be set would carry the agent near something burning, and if so,
   * stopping instead and working the route out again.
   *
   * The last word, after the route and the line: whatever put the agent where it is, it does not
   * fly on into lava. Nothing is refused while it is already too close, which is when moving is the
   * way out.
   */
  private scorching(at: Point, velocity: Point): boolean {
    if (!clearOfHeat(this.blocks, at.x, at.y, at.z)) return false

    for (let tick = 1; tick <= SCORCH_TICKS; tick++) {
      const x = at.x + velocity.x * tick
      const y = at.y + velocity.y * tick
      const z = at.z + velocity.z * tick
      if (clearOfHeat(this.blocks, x, y, z)) continue

      const count = this.stall.count + 1
      log.info(`Agent ${this.id} stopped short of something burning ahead of ${spoken(at)}, and is working the route out again`)
      this.push({ x: 0, y: 0, z: 0 })

      if (count >= 3) {
        this.drop('it kept finding its way blocked by fire or lava')
        return true
      }
      this.legs = []
      this.stall = { distance: Infinity, since: this.ticks, count }
      this.plan()
      return true
    }
    return false
  }

  /** Whether the leg has stopped getting any closer, and what was done about it. */
  private stuck(distance: number, leg: Point): boolean {
    if (distance < this.stall.distance - STALL_PROGRESS) {
      this.stall = { distance, since: this.ticks, count: this.stall.count }
      return false
    }
    if (this.ticks - this.stall.since < STALL_TICKS) return false

    const at = this.bot.entity.position
    const count = this.stall.count + 1

    log.debug(
      `Agent ${this.id} stopped getting closer to ${spoken(leg)} at ${spoken(at)}: ${distance.toFixed(2)} left, ` +
        `last set ${spoken(this.sent, 3)}, ` +
        `the hull ${hullFits(this.blocks, at.x, at.y, at.z) ? 'fits' : 'does not fit'} where it is, ` +
        `the line ahead is ${clearLine(this.blocks, at, leg) ? 'clear' : 'blocked'}, stall ${count}`,
    )

    if (count >= 3) {
      this.drop('it kept being stopped in the air')
      return true
    }

    // From a square up: whatever stopped it is most often the edge of what it was flying over.
    this.legs = []
    this.stall = { distance: Infinity, since: this.ticks, count }
    this.plan(true)
    return true
  }

  /** Waits for the ground after the last leg. */
  private settle(): void {
    const entity = this.bot.entity
    entity.velocity.x = 0
    entity.velocity.z = 0

    this.landing = (this.landing ?? 0) + 1
    if (entity.onGround !== true && this.landing < LANDING_TICKS) return

    log.debug(`Agent ${this.id} landed`)
    this.target = undefined
    this.landing = undefined

    const why = this.grounding
    if (why !== undefined) {
      this.grounding = undefined
      this.report.grounded(why)
      return
    }
    this.report.arrived()
  }

  /** Stays where it is in the air, dipping now and then if the server has not allowed it to fly. */
  private hold(): void {
    const forced = this.rules?.forced === true
    const dip = forced && this.ticks % ANTI_KICK === 0
    // The tick after a dip climbs back, so holding somewhere is holding there rather than sinking.
    const back = forced && this.ticks % ANTI_KICK === 1
    this.push({ x: 0, y: dip ? DIP : back ? -DIP : 0, z: 0 })
  }

  private push(velocity: Point): void {
    const entity = this.bot.entity
    entity.velocity.x = velocity.x
    entity.velocity.y = velocity.y
    entity.velocity.z = velocity.z
    this.sent = { ...velocity }
  }

  private takeOff(): void {
    if (this.aloft) return
    this.aloft = true

    const physics = this.bot.physics as unknown as { gravity: number }
    this.gravity ??= physics.gravity
    physics.gravity = 0

    // Anything walking left held would push against the flight for the whole of it.
    this.bot.clearControlStates()
    const velocity = this.bot.entity.velocity
    this.sent = { x: velocity.x, y: 0, z: velocity.z }

    log.debug(`Agent ${this.id} is taking off${this.rules?.forced === true ? ', forced - the server has not allowed it' : ''}`)
    if (this.rules?.forced === false) this.tellServer(true)
  }

  /** Gravity back on, and the server told the agent has stopped flying. */
  private land(): void {
    if (!this.aloft) return
    this.aloft = false
    this.holding = false

    const physics = this.bot.physics as unknown as { gravity: number }
    if (this.gravity !== undefined) physics.gravity = this.gravity
    if (this.rules?.forced === false) this.tellServer(false)
    log.debug(`Agent ${this.id} stopped flying`)
  }

  /** The abilities packet a client sends when it starts or stops flying. Only for granted flight. */
  private tellServer(flying: boolean): void {
    try {
      this.bot._client.write('abilities', { flags: flying ? 2 : 0 })
    } catch (err) {
      log.debug(`Agent ${this.id} could not tell the server it is ${flying ? '' : 'not '}flying: ${(err as Error).message}`)
    }
  }

  /**
   * Where the flight gives up on the air.
   *
   * **Down first, if it is up.** Gravity switched back on two hundred blocks up is a fall of two
   * hundred blocks, into whatever is under it - lava included - with walking left to start from
   * wherever it ends. So an agent in the air flies straight down to the ground under it, and walking
   * takes over from there; only with nothing safe to come down onto does it drop where it is.
   */
  private drop(why: string): void {
    log.info(`Agent ${this.id} cannot fly there: ${why}`)

    const down = this.aloft && this.grounding === undefined ? this.groundUnder() : undefined
    if (down) {
      log.debug(`Agent ${this.id} is coming down to ${down.x} ${down.y} ${down.z} before walking`)
      this.forget()
      this.grounding = why
      this.target = { x: down.x, y: down.y, z: down.z }
      this.range = 1
      this.follow([aloft(down)])
      return
    }

    // Held, and the journey ended, rather than dropped: what is under it may be the lava it was
    // avoiding, and a failed journey hovering in the air is one the operator can send somewhere else.
    if (this.aloft && this.grounding === undefined) {
      log.info(`Agent ${this.id} has nothing safe straight under it to come down onto, and is holding where it is`)
      this.forget()
      this.holding = true
      this.hold()
      this.report.lost(`${why}, and there is nothing safe under it to come down onto`)
      return
    }

    this.release()
    this.report.grounded(why)
  }

  /** The first ground straight under the agent, if it can be landed on and flown down to. */
  private groundUnder(): Walk | undefined {
    const at = this.bot.entity.position
    const x = Math.floor(at.x)
    const z = Math.floor(at.z)

    for (let y = Math.floor(at.y); y > WORLD_BOTTOM; y--) {
      if (open(this.blocks, x, y - 1, z)) continue
      if (!standable(this.blocks, x, y, z) || !clearOfHeat(this.blocks, x + 0.5, y, z + 0.5)) return undefined
      const square = cell(x, y, z)
      return clearLine(this.blocks, { x: at.x, y: at.y, z: at.z }, aloft(square)) ? square : undefined
    }
    return undefined
  }

  /** Whether a debug line is due. */
  private due(): boolean {
    const now = Date.now()
    if (now - this.narrated < NARRATE_MS) return false
    this.narrated = now
    return true
  }

  /**
   * A square to stop in that is already known to be one, for flying straight at.
   *
   * For a point, the square nearest *the point* that can be landed on, then the nearest the agent
   * fits in - the one the point names, whenever it can be. For a column, its highest ground, if the
   * column has been sent.
   */
  private stopAt(target: Target, from: Point): Walk | undefined {
    if (target.y === undefined) {
      const x = Math.floor(target.x)
      const z = Math.floor(target.z)
      for (let y = WORLD_TOP; y > WORLD_BOTTOM; y--) {
        if (this.blocks(x, y - 1, z)?.boundingBox === 'block') return standable(this.blocks, x, y, z) ? cell(x, y, z) : undefined
      }
      return undefined
    }

    const reach = Math.ceil(this.range)
    let best: { square: Walk; lands: boolean; off: number; distance: number } | undefined

    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dz = -reach; dz <= reach; dz++) {
          const x = Math.floor(target.x) + dx
          const y = Math.floor(target.y) + dy
          const z = Math.floor(target.z) + dz
          const off = Math.hypot(target.x - x, target.y - y, target.z - z)
          if (off > this.range || !room(this.blocks, x, y, z)) continue

          const lands = standable(this.blocks, x, y, z)
          const distance = Math.hypot(from.x - x, from.y - y, from.z - z)
          const better =
            !best ||
            (lands && !best.lands) ||
            (lands === best.lands && (off < best.off || (off === best.off && distance < best.distance)))
          if (better) best = { square: cell(x, y, z), lands, off, distance }
        }
      }
    }

    return best?.square
  }

  /**
   * The square a search starts from: the one the feet are in, or the nearest above it with room.
   *
   * **Only ever a square with room.** Raised after a stall, this used to take the square above, and
   * the one above that when it was taken, without looking - which under a ceiling is a square inside
   * it, and a route drawn from there that the agent flew straight up into the block.
   */
  private startCell(at: Point, raised: boolean): Walk {
    const x = Math.floor(at.x)
    const y = Math.floor(at.y + 0.001)
    const z = Math.floor(at.z)

    for (const candidate of raised ? [y + 1, y, y + 2] : [y, y + 1]) {
      if (room(this.blocks, x, candidate, z)) return cell(x, candidate, z)
    }
    return cell(x, y, z)
  }
}

/** Where a leg through a square is flown: its middle, and clear of its floor. See {@link CLEARANCE}. */
function aloft(square: Point): Point {
  const standing = standsAt(square)
  return { x: standing.x, y: standing.y + CLEARANCE, z: standing.z }
}

/**
 * The heights a stretch tries, in order: the one it wants, then every {@link CRUISE_STEP} above it,
 * then the highest it can climb. Only the highest it can climb when even the one it wants is out of
 * reach - a stretch just under a ceiling is still a stretch over everything below it.
 */
function levels(wanted: number, ceiling: number): number[] {
  if (wanted >= ceiling) return [ceiling]

  const heights = [wanted]
  for (let height = (Math.floor(wanted / CRUISE_STEP) + 1) * CRUISE_STEP; height < ceiling; height += CRUISE_STEP) {
    heights.push(height)
  }
  heights.push(ceiling)
  return heights
}

/** A velocity moved towards another by at most `step`, along the difference between them. */
function approach(from: Point, to: Point, step: number): Point {
  const ex = to.x - from.x
  const ey = to.y - from.y
  const ez = to.z - from.z
  const size = Math.hypot(ex, ey, ez)
  if (size <= step) return { ...to }
  return { x: from.x + (ex / size) * step, y: from.y + (ey / size) * step, z: from.z + (ez / size) * step }
}

function clampLength(vector: Point, most: number): Point {
  const size = Math.hypot(vector.x, vector.y, vector.z)
  if (size <= most) return vector
  return { x: (vector.x / size) * most, y: (vector.y / size) * most, z: (vector.z / size) * most }
}

function spoken(point: Point, places = 2): string {
  return `${point.x.toFixed(places)} ${point.y.toFixed(places)} ${point.z.toFixed(places)}`
}

function place(target: Target): string {
  return `${target.x} ${target.y ?? 'any'} ${target.z}`
}
