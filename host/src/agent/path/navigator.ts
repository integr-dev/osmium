/**
 * The plugin as one object, rather than by name.
 *
 * **It is CommonJS, and only some of it survives being imported by name.** Node works out a CJS
 * module's named exports by reading the source, and upstream writes
 * `module.exports = { pathfinder, Movements: require('./lib/movements'), goals: require('./lib/goals') }`
 * - the first is a local binding the reader can see, and the other two are calls it cannot. So
 * `import { goals }` throws at startup with "does not provide an export named 'goals'".
 *
 * Its own type declarations say otherwise, which is why nothing caught this until the host was
 * actually started: they describe the package as ESM with three named exports, so a build that
 * cannot run typechecks cleanly. The default import is `module.exports` itself, which has all
 * three on it whatever the reader made of the source.
 */
import type { Bot } from 'mineflayer'
import type { Movements } from 'mineflayer-pathfinder'

import { log } from '../../log.ts'
import type { Schedule } from '../schedule.ts'
import { Driver, type Rules } from './drive.ts'
import { over, standsAt, type Walk, within } from './ground.ts'
import type { PathSettings } from './settings.ts'
import { advanced, nodesOf, type PathNode, type PathWork } from './track.ts'
import { movementsFor, type Refused } from './walk.ts'

/** Re-exported so the protocol names one module for the whole shape of a path. */
export type { PathNode, PathWork } from './track.ts'

/**
 * One agent's answer to "go there".
 *
 * **The one owner of a journey**, sitting above whichever engine does the walking. Everything the
 * rest of Osmium sees - the goal, the path, how far along it the agent is, why it stopped - is this
 * file's, and the engine underneath is an implementation detail that changes per mode. Walking is
 * `drive.ts`; flying will be its own. Neither is allowed to reach past here, which is what keeps one
 * wire event, one pair of renderers and one notion of being stuck.
 */

/**
 * Where a journey has got to.
 *
 * `idle` is the resting state and also what a stop reports - an agent that is not going anywhere and
 * an agent that was told to stop going somewhere are the same agent, and giving the second one a
 * state of its own would leave the interface with a banner nothing ever clears.
 */
export type PathState = 'planning' | 'moving' | 'arrived' | 'failed' | 'idle'

/**
 * Somewhere an agent has been told to be.
 *
 * **The height is optional, and its absence means something.** A destination picked off a map that
 * has not been charted there is a column rather than a point: nobody knows how high the ground is,
 * and the honest instruction is "get to that column, at whatever height it turns out to be" rather
 * than a guess that would send an agent to the bottom of the world. See {@link AgentNavigator.seek}.
 */
export interface Waypoint {
  x: number
  y?: number
  z: number
}

export interface PathUpdate {
  state: PathState
  /** Where it is ultimately going. Absent when it is going nowhere. */
  goal?: Waypoint
  /** The whole path, sent when it is drawn and again whenever it is redrawn. */
  nodes?: PathNode[]
  /** Blocks the route still means to lay or break, sent with {@link nodes}. */
  work?: PathWork[]
  /** How far along {@link nodes} the agent is. */
  progress?: number
  /** Why it stopped, for `failed`. */
  reason?: string
}

/**
 * How close to the destination counts as arrived.
 *
 * One block, rather than the block itself. A coordinate an operator typed is a place, not a square:
 * insisting on standing exactly on it turns "go to the base" into a search that fails because
 * somebody left a chest there.
 */
const GOAL_NEAR = 1

/**
 * How close to an intermediate waypoint counts as passing it.
 *
 * Looser, because a waypoint is a hint about the route rather than a destination. The ones that
 * matter come from a coarse pass over stored map tiles, which knows the shape of the ground and
 * nothing about what is standing on it.
 */
const WAYPOINT_NEAR = 3

/** How often progress goes out while the agent is moving. */
const REPORT_MS = 1_000

/**
 * How long one search may run, in wall clock.
 *
 * Bigger than upstream's default because {@link SLICE} is smaller: the budget is measured from when
 * the search started, not from how much of it has actually run, so a search that thinks in tenths of
 * a tick needs proportionally longer on the clock to think the same amount.
 */
const THINK_MS = 10_000

/**
 * How much of one tick a search may take.
 *
 * Upstream's default is 40 ms of a 50 ms tick, which is right for a bot with a process to itself.
 * This host runs the whole fleet in one, and a tick spent searching is a tick every other agent's
 * chat, telemetry and world stream does not get.
 */
const SLICE = 10

/** How often a server correcting the agent is worth a line. See {@link AgentNavigator.putBack}. */
const TELEPORT_REPORT_MS = 1_000

/**
 * How many times the server may put the agent back before its route is the problem.
 *
 * A correction or two is ordinary - a chunk arriving, a shove, a door. A run of them at the same
 * spot is the server refusing a step, over and over, and no amount of re-planning through that spot
 * will land differently. Roughly a second's worth at the rate one of these loops runs.
 */
const REFUSALS = 8

/**
 * How far up counts as being stood on something, in blocks.
 *
 * Half a block: more than any disagreement about where a surface is, and less than the block-sized
 * lift that follows every placement the agent makes under itself.
 */
const LIFTED = 0.5

/**
 * How long a refused spot stays refused.
 *
 * It expires because the reason usually does: a block breaks, a door opens, a player moves. A
 * permanent one would have an agent avoiding a doorway for the rest of the session because it was
 * shoved there once.
 */
const REFUSED_FOR_MS = 60_000

/**
 * How many spots may be written off before the journey is.
 *
 * Each one costs a re-plan, and a route that needs five of them is not a route with an obstacle in
 * it - it is a destination this agent cannot reach the way it is trying to. Failing then is worth
 * more than walking into things until somebody notices.
 */
const REFUSALS_MOST = 5

/** Every control an agent can be holding, for saying which it was. mineflayer's own names. */
const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const

export class AgentNavigator {
  /** Where it is going, in order. The last is the destination; the rest are the route to it. */
  private waypoints: Waypoint[] = []
  private at = 0

  private nodes: PathNode[] = []
  private work: PathWork[] = []
  private progress = 0
  /** Whether {@link nodes} has changed since the last report. */
  private redrawn = false

  private ticker: NodeJS.Timeout | undefined

  /**
   * The engine, which walks.
   *
   * Ours rather than the plugin's - see `drive.ts` for why. Held here because this class is the one
   * owner of a journey, and the engine under it is an implementation detail that changes per mode:
   * this one walks, and the one flight brings will meet the same interface.
   */
  private readonly driver: Driver

  /**
   * The rules the engine walks by, built once per waypoint rather than per search.
   *
   * Building a `Movements` reads the whole block table, and the engine asks for these every time it
   * thinks about a stretch again - which, with mending, is often.
   */
  private rules: Rules | undefined

  private readonly onForced: () => void
  private readonly onTick: () => void

  /** Where the agent was on the last tick, which is what a teleport is measured against. */
  private before: { x: number; y: number; z: number } | undefined

  /** So a server correcting six times a second costs a line a second rather than six. */
  private toldAt = 0

  /**
   * Places this journey has been refused, and when each stops counting.
   *
   * Per journey rather than per agent: the reasons are about a route, and a new destination deserves
   * a clean map. They still expire, because a door that was shut may not be.
   */
  private refused: Refused[] = []

  /**
   * How many times the server has moved this agent itself since the last time anybody asked.
   *
   * **The one reading that says whose fault a stall is.** mineflayer raises `forcedMove` when a
   * server sends a position for the player rather than accepting the one the client sent - which is
   * what a server does when it has decided the client's movement was not legitimate. An agent that
   * is walking on the spot while this counts up is being put back by the server every tick; one that
   * is walking on the spot while this stays at zero is failing entirely on this side, and nothing
   * about what we send can be the cause.
   */
  private forced = 0

  /** Setbacks since the last re-plan, which is what tells a refusal from a correction. */
  private refusedHere = 0

  constructor(
    private readonly id: number,
    private readonly bot: Bot,
    private readonly wanted: () => PathSettings,
    private readonly report: (update: PathUpdate) => void,
    /** Handed straight to the engine: walking is this class's business, the hands are not. */
    hands: Schedule,
  ) {
    this.onForced = () => this.putBack()

    this.driver = new Driver(
      id,
      bot,
      // Read per search rather than captured: an operator flipping a switch while an agent walks
      // should reach the next stretch it thinks about, not the next journey it is sent on.
      () => this.rules ?? this.ruleset(),
      {
        route: (steps, settled) => this.routed(steps, settled),
        arrived: () => this.reached(),
        lost: (why) => this.finish('failed', why),
        stalled: () => log.debug(`Agent ${this.id} was stuck ${this.physics()}`),
      },
      hands,
    )

    // Cheap: three numbers copied twenty times a second, which is what makes a teleport measurable
    // at all - by the time `forcedMove` is raised, the position it replaced is already gone.
    this.onTick = () => {
      const at = this.bot.entity?.position
      if (at) this.before = { x: at.x, y: at.y, z: at.z }
    }
  }

  start(): void {
    this.driver.start()

    // Typed through mineflayer's own augmentation of its events, which declares its payload types
    // without importing them - so they arrive here as `any` and are given a shape at the edge.
    const bot = this.bot as unknown as {
      on(event: string, handler: (...args: never[]) => void): void
    }

    bot.on('forcedMove', this.onForced as (...args: never[]) => void)
    bot.on('physicsTick', this.onTick as (...args: never[]) => void)
  }

  /**
   * Puts everything down.
   *
   * Called when a session ends, which is also every respawn and every dimension change - the world
   * under a path is gone, and a goal that outlived it would have the agent walking to a coordinate
   * in a place it is no longer standing.
   */
  stop(): void {
    const bot = this.bot as unknown as {
      removeListener(event: string, handler: (...args: never[]) => void): void
    }

    bot.removeListener('forcedMove', this.onForced as (...args: never[]) => void)
    bot.removeListener('physicsTick', this.onTick as (...args: never[]) => void)

    clearInterval(this.ticker)
    this.ticker = undefined

    this.clear()

    // Best effort. The bot may already be gone, in which case there is nothing left to tell.
    try {
      this.driver.stop()
    } catch (err) {
      log.debug(`Agent ${this.id} could not stop its engine: ${(err as Error).message}`)
    }
  }

  /**
   * Go to the last of these, by way of the rest.
   *
   * A list rather than a point because a route may be handed down whole. The interface sends one
   * entry today; a coarse pass over the map tiles the fleet has already charted will send the shape
   * of a journey nobody's loaded chunks can see all of at once.
   */
  goto(waypoints: readonly Waypoint[]): void {
    if (waypoints.length === 0) {
      log.warn(`Agent ${this.id} was told to go nowhere`)
      return
    }

    this.waypoints = [...waypoints]
    this.at = 0
    this.refused = []
    this.seek()
  }

  /** The operator said stop. Not a failure - it is the outcome they asked for. */
  halt(): void {
    if (this.waypoints.length === 0) return

    log.info(`Agent ${this.id} was told to stop where it is`)
    this.finish('idle')
  }

  /** Whether it is on its way somewhere. */
  moving(): boolean {
    return this.waypoints.length > 0
  }

  /** Whether the route it is walking still has blocks to lay or break. See `Driver.building`. */
  building(): boolean {
    return this.driver.building()
  }

  /**
   * The server moved the agent itself, rather than accepting where the agent said it was.
   *
   * **The distance is the diagnosis.** A correction of nothing at all - the agent put back exactly
   * where it already was - is a server refusing a move it considers illegal, and the argument is
   * about the move rather than the place. A correction of a few tenths is the two sides disagreeing
   * about where a block's face is, which is a collision-shape problem. A correction of metres is
   * something else entirely, and would name itself.
   *
   * Reported once a second at most. A server doing this six times a second would otherwise bury
   * every other line in the log, and the sixth correction says nothing the first did not.
   */
  private putBack(): void {
    this.forced++

    /*
     * **Being stood on top of your own block is not a refusal.**
     *
     * Every rung of a tower ends with the server moving the agent about a block *upward*: it has the
     * block that was just placed and the agent standing on it, and this side is still falling towards
     * where the top used to be. That is the two sides agreeing about the placement and disagreeing
     * about the timing - the opposite of a step being turned down.
     *
     * Counted as refusals they reach the limit in eight rungs, and the agent writes off the square it
     * is standing on and re-plans from halfway up its own tower. Which is why a tall tower used to
     * restart in the middle for no visible reason.
     */
    if (this.liftedOntoSomething()) return

    this.refusedHere++

    // A run of them at one spot is the server refusing this step rather than correcting a drift.
    if (this.refusedHere >= REFUSALS) this.giveUpOnHere()

    const now = Date.now()
    if (now - this.toldAt < TELEPORT_REPORT_MS) return
    this.toldAt = now

    const from = this.before
    const to = this.bot.entity?.position
    if (!from || !to) return

    const dx = to.x - from.x
    const dy = to.y - from.y
    const dz = to.z - from.z

    log.debug(
      `Agent ${this.id} was put back by the server: ` +
        `${from.x.toFixed(3)} ${from.y.toFixed(3)} ${from.z.toFixed(3)} -> ` +
        `${to.x.toFixed(3)} ${to.y.toFixed(3)} ${to.z.toFixed(3)}` +
        ` (moved ${dx.toFixed(3)} ${dy.toFixed(3)} ${dz.toFixed(3)}, ` +
        `${Math.hypot(dx, dy, dz).toFixed(3)} blocks)`,
    )
  }

  /**
   * Whether the server just stood the agent on top of something rather than turning a step down.
   *
   * Upward, and not sideways: a refusal puts the agent back where it was, which is a correction of
   * nothing at all or a few tenths in the direction it was trying to go. A whole block straight up is
   * the server placing it on a surface this side has not caught up with yet.
   */
  private liftedOntoSomething(): boolean {
    const from = this.before
    const to = this.bot.entity?.position
    if (!from || !to) return false

    const up = to.y - from.y
    const sideways = Math.hypot(to.x - from.x, to.z - from.z)

    return up > LIFTED && sideways < LIFTED
  }

  /**
   * Writes off the spot the agent is standing at, and plans again without it.
   *
   * **The only thing left to do about a step a server will not accept.** Nothing sent from here
   * makes it accept one - see `unembed.ts` for the arithmetic behind why - so the answer is to stop
   * proposing it. The route around may be longer; it exists, which the one being attempted does not.
   *
   * Gives up on the journey once enough spots have been written off. A destination that needs five
   * of them is not a destination with an obstacle in front of it.
   */
  private giveUpOnHere(): void {
    this.refusedHere = 0

    const at = this.bot.entity?.position
    if (!at) return

    const spot = {
      x: Math.floor(at.x),
      y: Math.floor(at.y),
      z: Math.floor(at.z),
      until: Date.now() + REFUSED_FOR_MS,
    }

    // The same spot again is the same obstacle, so its clock is extended rather than counted twice.
    const held = this.refused.find((other) => other.x === spot.x && other.y === spot.y && other.z === spot.z)
    if (held) {
      held.until = spot.until
      return
    }

    this.refused.push(spot)
    log.warn(
      `Agent ${this.id} keeps being put back at ${spot.x} ${spot.y} ${spot.z}, so it will go around`,
    )

    if (this.refused.length > REFUSALS_MOST) {
      log.warn(`Agent ${this.id} has been refused ${this.refused.length} places on one journey; giving up`)
      this.finish('failed', 'the server kept putting it back')
      return
    }

    // From where it stands, with the new exclusion in place.
    this.seek()
  }

  /**
   * What the operator's settings come down to, as the engine wants them.
   *
   * The refusals go in as a cost rather than a wall - see `walk.ts` - so a route whose only way
   * home runs through a spot the server will not accept is still found, and still fails there,
   * rather than being reported as impossible.
   */
  private ruleset(): Rules {
    const wanted = this.wanted()

    return {
      movements: movementsFor(this.bot, wanted, this.refused) as Movements,
      reach: wanted.range,
      sprint: wanted.sprint,
      lean: wanted.lean,
      slice: SLICE,
      budget: THINK_MS,
    }
  }

  /** Sets the engine at the waypoint it is on. */
  private seek(): void {
    const target = this.waypoints[this.at]
    if (!target) return

    const wanted = this.wanted()
    const last = this.at === this.waypoints.length - 1
    const near = last ? GOAL_NEAR : WAYPOINT_NEAR

    this.nodes = []
    this.work = []
    this.progress = 0
    this.redrawn = false

    // Dropped as they expire rather than on a timer: this is the only place they are read, so an
    // expired one has never been acted on between here and here.
    const now = Date.now()
    this.refused = this.refused.filter((spot) => spot.until > now)
    this.refusedHere = 0

    this.rules = this.ruleset()

    // A column when no height was given, a point when one was, and the difference is the one worth
    // keeping: a column is satisfied by standing over the spot, which is what "somewhere around
    // there" means when nobody has charted the ground.
    this.driver.go(
      target.y === undefined
        ? over(target.x, target.z, near, wanted.lean)
        : within(target.x, target.y, target.z, near, wanted.lean),
    )

    log.info(
      `Agent ${this.id} is heading for ${target.x} ${target.y ?? 'any'} ${target.z}` +
        `${last ? '' : ` (waypoint ${this.at + 1} of ${this.waypoints.length})`}` +
        `, searching ${wanted.range} blocks out`,
    )

    // The destination, not the waypoint being sought. What an operator asked for is where the
    // journey ends; the ones in between are how it gets there, and drawing a goal marker on one
    // would say the agent had arrived somewhere it is only passing through.
    this.report({ state: 'planning', goal: this.waypoints[this.waypoints.length - 1] ?? target })

    clearInterval(this.ticker)
    this.ticker = setInterval(() => this.tick(), REPORT_MS)
  }

  /**
   * The engine drew a route, or redrew one.
   *
   * Held rather than sent. A route is redrawn every slice while a search grows and again whenever a
   * stretch is mended, and three hundred nodes down the wire at twenty hertz is a lot of bandwidth
   * spent moving a line by one node. {@link tick} sends it, at the rate anybody can read it - except
   * the first, which goes at once so the map draws the moment the agent starts walking.
   */
  private routed(steps: readonly Walk[], settled: boolean): void {
    if (this.waypoints.length === 0) return

    const first = this.nodes.length === 0

    // Standing positions, not blocks. `PathNode` has always meant the middle of a block - see
    // `track.ts` - and a line drawn through block corners sits half a block off the agent walking it.
    this.nodes = nodesOf(steps.map(standsAt))
    this.work = workOf(steps)

    // An empty route is not a drawn one. A search that has not got anywhere yet reports one on every
    // slice, and `every` on no stretches at all answers true - so this said "drew a route of 0 nodes"
    // two hundred times while the agent stood there thinking.
    if (settled && this.nodes.length > 0) {
      log.debug(
        `Agent ${this.id} drew a route of ${this.nodes.length} nodes with ${this.work.length} blocks to change`,
      )
    }
    this.progress = 0
    this.redrawn = true

    // Unsettled routes are guesses that change every slice; drawing each one would be a line
    // flickering across the map for no information. The settled one that follows is the answer.
    if (first && settled) this.tick()
  }

  /** Progress, and the path itself when it has been redrawn since the last one. */
  private tick(): void {
    if (this.waypoints.length === 0 || this.nodes.length === 0) return

    const at = this.bot.entity?.position
    if (at) this.progress = advanced(this.nodes, at, this.progress)

    const goal = this.destination()

    this.report({
      state: 'moving',
      progress: this.progress,
      ...(goal ? { goal } : {}),
      ...(this.redrawn ? { nodes: this.nodes, work: this.work } : {}),
    })

    this.redrawn = false
  }

  /** The engine says it is standing where it was sent. */
  private reached(): void {
    if (this.waypoints.length === 0) return

    this.at++

    if (this.at < this.waypoints.length) {
      this.seek()
      return
    }

    const target = this.destination()
    log.info(`Agent ${this.id} arrived at ${target?.x} ${target?.y ?? 'any'} ${target?.z}`)
    this.finish('arrived')
  }

  /**
   * What the agent's own physics thought was happening, at the moment it stopped getting anywhere.
   *
   * **The one reading that separates the two ways an agent stalls**, which otherwise look identical
   * from outside and have nothing in common as faults:
   *
   * - *Trying and blocked.* A movement control is held and the velocity is non-zero, but the
   *   position does not change. The client is walking into something it believes is there - so the
   *   question is about the world it has, or about a server putting it back where it was.
   * - *Not trying.* No control held, or a velocity of zero. Nothing is pushing the agent at all, and
   *   the question is about whatever should have been.
   *
   * `isCollidedHorizontally` is prismarine-physics' own answer to "is a wall stopping me", which is
   * the state this whole class of bug is about.
   */
  private physics(): string {
    const entity = this.bot.entity
    if (!entity) return 'with no body in the world'

    const at = entity.position
    const velocity = entity.velocity
    const wall = (entity as unknown as { isCollidedHorizontally?: boolean }).isCollidedHorizontally

    const held = CONTROLS.filter((control) => {
      try {
        return this.bot.getControlState(control)
      } catch {
        return false
      }
    })

    const putBack = this.forced
    this.forced = 0

    return (
      `at ${at.x.toFixed(2)} ${at.y.toFixed(2)} ${at.z.toFixed(2)}` +
      `, moving ${velocity.x.toFixed(4)} ${velocity.y.toFixed(4)} ${velocity.z.toFixed(4)}` +
      `, ${entity.onGround ? 'on the ground' : 'airborne'}` +
      `, ${wall ? 'against a wall' : 'clear of walls'}` +
      `, holding ${held.length ? held.join('+') : 'nothing'}` +
      // Zero here means the server has not touched it, whatever else is wrong.
      `, put back by the server ${putBack} time(s) since the last report` +
      `, standing in ${this.around()}`
    )
  }

  /**
   * What the agent believes is around it, which is not always what is there.
   *
   * The version this session speaks is a *guess* on a server that will not name itself - an anarchy
   * server advertising a junk protocol number gets whatever definitions this build has newest. Get
   * that wrong and the block states decode to the wrong blocks, so the agent walks into walls that
   * are not there and through ones that are. This is what that looks like from the inside, and it
   * reads the same way `grounded` does on the first spawn.
   */
  private around(): string {
    const bot = this.bot
    const at = bot.entity?.position
    if (!at) return 'nowhere'

    const name = (dx: number, dy: number, dz: number) => bot.blockAt(at.offset(dx, dy, dz))?.name ?? 'unknown'

    return (
      `${name(0, 0, 0)}, head in ${name(0, 1, 0)}, on ${name(0, -1, 0)}` +
      `, sides +x ${name(1, 0, 0)} / -x ${name(-1, 0, 0)} / +z ${name(0, 0, 1)} / -z ${name(0, 0, -1)}` +
      `, above the sides +x ${name(1, 1, 0)} / -x ${name(-1, 1, 0)} / +z ${name(0, 1, 1)} / -z ${name(0, 1, -1)}`
    )
  }

  private finish(state: PathState, reason?: string): void {
    const goal = this.destination()

    this.clear()

    try {
      this.driver.halt()
    } catch (err) {
      log.debug(`Agent ${this.id} could not stop its engine: ${(err as Error).message}`)
    }

    this.report({ state, ...(goal ? { goal } : {}), ...(reason ? { reason } : {}) })
  }

  private clear(): void {
    clearInterval(this.ticker)
    this.ticker = undefined

    this.waypoints = []
    this.at = 0
    this.refused = []
    this.refusedHere = 0
    this.nodes = []
    this.work = []
    this.progress = 0
    this.redrawn = false
  }

  private destination(): Waypoint | undefined {
    return this.waypoints[this.waypoints.length - 1]
  }
}

/**
 * Every block a route still means to change, in the order it means to.
 *
 * Taken from the steps rather than from the engine's own bookkeeping, because a step has its work
 * shifted off it as it is done: what comes out here is what is *left*, which is what somebody
 * watching wants to see. A placement names the block it builds against and a face, so the square
 * that actually changes is one step off it.
 */
function workOf(steps: readonly Walk[]): PathWork[] {
  const planned: PathWork[] = []

  for (const step of steps) {
    for (const spot of step.toBreak) planned.push({ x: spot.x, y: spot.y, z: spot.z, kind: 'break' })
    for (const spot of step.toPlace) {
      planned.push({ x: spot.x + spot.dx, y: spot.y + spot.dy, z: spot.z + spot.dz, kind: 'place' })
    }
  }

  return planned
}
