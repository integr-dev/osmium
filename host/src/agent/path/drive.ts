import type { Bot } from 'mineflayer'
import type { Movements } from 'mineflayer-pathfinder'
// Upstream ships types for its package and none for its own internals, so the simulation arrives
// untyped and is given a shape below rather than spreading `any` through the file.
// @ts-expect-error - no declarations for this path
import untypedPhysics from 'mineflayer-pathfinder/lib/physics.js'
import { Vec3 as WorldVec } from 'vec3'

import { log } from '../../log.ts'
import { RANK, type Schedule } from '../schedule.ts'
import { reachFor } from '../tool.ts'
import { type Placement, standingAt, standsAt, type Walk, walkingFrom, within } from './ground.ts'
import { type Goal, type Route, Search } from './search.ts'

/**
 * The executor, which is ours.
 *
 * **The one file upstream got wrong.** `Movements` is good and kept (`ground.ts`); the search was
 * merely mediocre and is replaced (`search.ts`); this - upstream's `monitorMovement` - is where every
 * fault that has cost a day of this project actually lives, and none of them are about Minecraft.
 * They are all one fault wearing different hats: **nothing owned what the agent was doing.**
 *
 * Its route, its half-finished search, whether it was placing and which block it was placing were
 * four module-level variables that any of a dozen code paths could write. So a search that was still
 * thinking assigned a guess over the route twenty times a second; a placement begun for one route
 * finished against another, because `resetPath` cleared the flag and released the lock but could not
 * call back the equip already in the air; a block update the agent caused itself threw away the path
 * it had just built; and the timer meant to notice a stall sat after the early returns of the very
 * branches that stall, so it could never fire on one.
 *
 * Every rule below is one of those, turned into something a state machine can enforce:
 *
 * - **One job at a time, and a job owns the agent.** While a block is being laid or broken nothing
 *   else moves the agent, and a route arriving meanwhile waits its turn rather than displacing the
 *   work already under way.
 * - **A job belongs to the stretch that asked for it.** {@link Driver.era} counts changes to the
 *   stretch being walked; a job carries the count it began under, and one that comes back to a
 *   different world is dropped instead of being finished into it. Checked at the moment the request
 *   would go out, which is the seam upstream had no way to reach.
 * - **An unsettled stretch may be walked, never built on.** Walking a guess costs a tick and the
 *   next slice corrects it. Building on a guess is not recoverable - the blocks are gone and the
 *   tower is in a column the search abandoned.
 * - **A change the route meant to make is not a change.** See {@link Section.planned}.
 * - **A change re-plans one stretch, not the journey.** See {@link SECTION}.
 * - **One futility timer, ahead of the work.** It sees a hung placement, which is the only kind of
 *   stall that ever actually mattered.
 *
 * What is *not* here on purpose: the geometry of what a step costs, and the simulation of whether a
 * run can be walked, jumped or sprinted. Those are upstream's and they are good.
 *
 * Flight will want its own version of this file - no jumping, no scaffolding, no ground - and will
 * share `search.ts` and the journey above. Nothing here is bent into shape for it in advance.
 */

/**
 * Upstream's physics simulation, which is what decides how a step is taken.
 *
 * It runs the real player physics forward from where the agent is standing: can a straight run reach
 * that square, does it need a jump, will a sprint carry it. Each of these reads only the first entry
 * of what it is passed, so it is handed one square rather than a route.
 */
/** One tick of a jump, real or simulated. */
export interface Frame {
  x: number
  y: number
  z: number
  speed: number
  onGround: boolean
  held?: string
  yaw?: number
  /** How far from the middle of the square a block is going into. Towers only. */
  off?: number
}

export interface Simulation {
  canStraightLine(aim: readonly WorldVec[], sprint?: boolean): boolean
  canSprintJump(aim: readonly WorldVec[], after?: number): boolean
  canWalkJump(aim: readonly WorldVec[], after?: number): boolean
  /**
   * Where a jump taken this tick puts the agent back on the ground, if it ever does.
   *
   * The question the three above cannot answer - see {@link Jumping}.
   */
  lands(aim: readonly WorldVec[], sprint: boolean): WorldVec | undefined
  /** The same jump tick by tick, for {@link Driver.record}. Diagnostic, and optional. */
  traced?(aim: readonly WorldVec[], sprint: boolean): Frame[]
}

/** As much of prismarine’s player state as the landing question reads. */
interface Simulated {
  pos: WorldVec
  vel: WorldVec
  onGround: boolean
  yaw: number
  control: {
    forward: boolean
    back: boolean
    left: boolean
    right: boolean
    jump: boolean
    sprint: boolean
    sneak: boolean
  }
}

/** The two of upstream’s internals that {@link Jumping} is built from. */
interface Innards {
  /** The agent the simulation is of. Upstream keeps it; the fixed heading is measured from it. */
  bot: Bot
  simulateUntil(
    done: (state: Simulated) => boolean,
    control: (state: Simulated, tick: number) => void,
    ticks: number,
  ): Simulated
  getController(
    to: WorldVec,
    jump: boolean,
    sprint: boolean,
    after?: number,
  ): (state: Simulated, tick: number) => void
}

const Engine = untypedPhysics as unknown as new (bot: Bot) => Innards & Omit<Simulation, 'lands' | 'traced'>

/**
 * How long a jump is worth simulating for, in ticks. Two seconds; none of them stay up half that.
 */
const JUMP_TICKS = 40

/** How many ticks of getting into position for a block are worth keeping. Ten seconds of them. */
const RUNG_TICKS = 200

/** How many ticks after a landing are worth keeping, to see whether it stayed on the block. */
const AFTER_TICKS = 20

/** The controls a recorder reports, in the order it reports them. */
const HELD = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const

/**
 * Upstream’s simulation, asked the one question it does not ask itself: **where does this jump
 * put the agent down?**
 *
 * `canSprintJump` and friends are all built on `getReached`, which is satisfied the moment the
 * simulated player passes within 0.35 of the target - *at any tick, at any height, at any speed*.
 * A jump whose arc crosses the square at head height and carries a block and a half beyond it
 * therefore answers yes, and answers yes for exactly the same reason as one that comes down on the
 * middle of it. Over ground the difference does not matter, because whatever it lands on is more
 * ground. At a gap it is the difference between the route and the void: measured, a corner taken
 * at 0.292 reported "running straight there" a block short of the square and was 0.98 past its far
 * edge half a second later, on its way down 84 blocks.
 *
 * So a jump over a gap is chosen on where it ends, which means simulating it until it is standing
 * again rather than until it is briefly near something. Everything else upstream answers is left
 * exactly as it is.
 */
class Jumping extends Engine implements Simulation {
  /**
   * The controls a jump is flown with, held for the whole of it.
   *
   * Deliberately not upstream's `getController`, which re-aims at the target every simulated
   * tick. Re-aiming turns a jump into an arc: as the agent drifts off the line the bearing
   * swings, and the thrust swings with it. The arc is not a landing error - it was measured
   * predicted to a tenth of a block - but it sweeps sideways through whatever is beside the
   * line it should have flown, and 0.32 of a block of bend is more than the fifth of a block
   * of slack a 0.6 wide box has in a square.
   *
   * So the heading is taken once, at the ledge, and held. {@link Driver.decide} holds the same
   * one for the same flight, and the strafe keys are cleared here because it clears them too -
   * the answer is only worth having if it is an answer about the jump the agent will fly.
   */
  private flownAt(from: WorldVec, to: WorldVec, sprint: boolean): (state: Simulated, tick: number) => void {
    const heading = Math.atan2(-(to.x - from.x), -(to.z - from.z))

    return (state) => {
      state.yaw = heading
      state.control.forward = true
      state.control.back = false
      state.control.left = false
      state.control.right = false
      state.control.sneak = false
      state.control.jump = true
      state.control.sprint = sprint
    }
  }

  lands(aim: readonly WorldVec[], sprint: boolean): WorldVec | undefined {
    const to = aim[0]
    if (to === undefined) return undefined

    // Off the ground first, back on it second. Without the first half the simulation is finished
    // before it starts, because the agent is standing on a block when it is asked.
    let flew = false

    const put = this.simulateUntil(
      (state) => {
        if (!state.onGround) flew = true
        return flew && state.onGround
      },
      this.flownAt(this.bot.entity.position, to, sprint),
      JUMP_TICKS,
    )

    return flew && put.onGround ? put.pos : undefined
  }

  /**
   * The same jump, tick by tick, for comparing against what the agent actually did.
   *
   * Diagnostic. {@link Driver.record} plays the real flight alongside it, and the tick the two
   * part company is the answer to why a jump did not go where it was chosen to go.
   */
  traced(aim: readonly WorldVec[], sprint: boolean): Frame[] {
    const to = aim[0]
    if (to === undefined) return []

    const frames: Frame[] = []
    const control = this.flownAt(this.bot.entity.position, to, sprint)

    this.simulateUntil(
      (state) => {
        frames.push({
          x: state.pos.x,
          y: state.pos.y,
          z: state.pos.z,
          speed: Math.hypot(state.vel?.x ?? 0, state.vel?.z ?? 0),
          onGround: state.onGround,
        })
        return frames.length > 1 && state.onGround
      },
      control,
      JUMP_TICKS,
    )

    return frames
  }
}

/** What the driver tells whoever asked for the journey. */
export interface Driven {
  /** The route was drawn or redrawn. `settled` is false while a stretch is still being thought about. */
  route(steps: readonly Walk[], settled: boolean): void
  /** It is standing where it was sent. */
  arrived(): void
  /** It cannot get there, and why. */
  lost(why: string): void
  /**
   * The search ran out of world before it reached the goal, so the route it drew only gets as close
   * as it can.
   *
   * Said separately from {@link route} because it is news rather than a line: the agent is still
   * walking, and nothing on a map tells a route to the goal from a route towards it.
   */
  closest(): void
  /**
   * It stopped getting anywhere and is thinking again.
   *
   * Not a failure and not reported to an operator - it is what should happen when a door closes in
   * front of an agent. It exists because what is worth *saying* about a stall is what the agent's
   * own physics thought was going on at the time, and that reading belongs to the journey layer.
   */
  stalled(): void
}

/** What an operator's settings come down to, once the journey layer has read them. */
export interface Rules {
  movements: Movements
  /** How far past the straight-line estimate a route may cost before it is not worth having. */
  reach: number
  sprint: boolean
  /**
   * How long one slice of searching may take, out of a fifty millisecond tick.
   *
   * Here rather than a constant because the whole fleet shares one process: a tick spent searching
   * is a tick every other agent's chat, telemetry and world stream does not get, and how much of one
   * an agent may take is a fleet decision rather than this file's.
   */
  slice: number
  /** How long a whole search may run before it gives up. */
  budget: number
  /**
   * How hard a search leans on the distance left - see `leanFor` in settings.ts.
   *
   * Only read where the driver draws a goal of its own, which is mending a stretch; every other search
   * is handed the operator's goal, and the lean is already in it. Optional so a caller with no view on
   * route quality gets the lean agents always had.
   */
  lean?: number
}

/**
 * How many steps of route go in one stretch.
 *
 * **The unit of re-planning.** A door closing forty blocks ahead should cost a search of the forty
 * blocks around it, not of the whole journey - and it certainly should not throw away the tower the
 * agent is halfway up. So the route is cut into stretches when it is drawn, and a change re-plans
 * only the stretch it lands in, between that stretch's own two ends.
 *
 * Roughly a chunk's worth of walking, which is about as far ahead as the agent can see the world it
 * is planning through anyway. Smaller makes each mend cheaper and pins the route to more forced
 * waypoints; larger costs more to mend and constrains the route less. Neither failure is dramatic.
 */
const SECTION = 64

/**
 * How many steps from the end of a route that stops short the rest of it is looked for.
 *
 * **A route that does not reach the goal is a route with more of itself to find, and the place to
 * find it from is where it ends.** Searching for that only once the agent is standing there costs
 * exactly the pause it is meant to avoid, so it starts while there is still walking to do - by the
 * time the last step is taken the next stretch is usually already on the end of the route.
 *
 * Sixteen steps is about four seconds of walking, which buys a search of a hundred and fifty blocks
 * several times over at the rate a slice of a tick thinks.
 */
const LOOKAHEAD = 16

/**
 * How much longer a slice may be while there is nothing to walk.
 *
 * The tick belongs to whatever the agent is doing with it, and an agent standing still waiting for a
 * route is doing nothing else with it at all. Thinking three times as hard while it waits is three
 * times less waiting, and costs the movement code nothing, because there is no movement.
 */
const STANDING_STILL = 3

/**
 * Whether finished searches report what they cost. See {@link Driver.cost}.
 *
 * Off by default, and on with `OSMIUM_SEARCH_COST=true`. A line per search is a lot of log for a fleet
 * that is working, and the accounting behind it reads the clock inside the search's hottest loop; it is
 * there for the afternoon somebody is working out why routes are slow.
 */
const MEASURED = process.env['OSMIUM_SEARCH_COST'] === 'true'

/** How close to a square counts as standing in it. Upstream's numbers, and its simulation's. */
const NEAR = 0.35

/** How many squares ahead a jump that needs a run-up is worth carrying speed for. */
const LOOK_AHEAD_RUN_UP = 2

/**
 * How much of the takeoff square has to be left before another step towards a gap is safe.
 *
 * A walked tick is about a seventh of a block, so a fifth is one tick of warning. Below it the next
 * step is off the edge, and off the edge of a gap is a fall rather than a jump.
 */
const ROOM_TO_RUN = 0.2

/**
 * How far off the bearing of a gap the agent may be and still jump, in radians.
 *
 * **A jump keeps the heading it took off with, and turning is not instant.** `bot.look` animates,
 * so the tick a jump is decided on is often a tick the agent is still rotating through - and the
 * simulation that promised the jump did not model that: upstream's controller snaps its simulated
 * player onto the bearing before the first tick. The real one leaves along whatever heading it had,
 * clips the far block's edge and falls.
 *
 * A tenth of a radian is under six degrees, which over three blocks is a third of a block sideways -
 * inside the half block of slack a landing square gives.
 */
const FACING = 0.1

/**
 * How far below the square it is walking to the agent has to be before its route is fiction.
 *
 * **A missed jump is not a stall, and waiting for the stall clock to notice costs seconds.** The
 * route says the agent is crossing a gap; the agent is falling down it. Three blocks is more than
 * any step down the route plans for itself and less than any fall worth re-planning after.
 */
const FELL = 2

/** How far from the square it is walking to counts as no longer being on the route at all. */
const LOST = 8

/**
 * How far away a square has to be, horizontally, to be worth turning towards.
 *
 * **A tower has nowhere to face.** Every rung is directly above the last, so the horizontal distance
 * to the next square is a rounding error - and the angle towards a rounding error is not an angle.
 * `atan2` of two values either side of zero swings the whole way round on nothing, so the agent was
 * handed a different heading every tick and spun on top of its own pillar.
 *
 * That is not merely ugly. Turning is animated, and mineflayer *waits* for its own turn to finish
 * before it sends a placement - so a heading that changes every tick is a turn that never finishes,
 * and a placement that never goes out. Which is why a rung sometimes cost two jumps instead of one.
 *
 * A tenth of a block: smaller than any real step, larger than the noise in standing still.
 */
const WORTH_TURNING = 0.1

/** How far down to look while pillaring. Straight down; negative is down, as `lookAt` works it out. */
const AT_ITS_FEET = -Math.PI / 2

/**
 * How far across its own block the agent has to be before it can build off that side.
 *
 * **Not upstream's number, because upstream's cannot be met.** Its routine backs towards a point a
 * whole block ahead - where the new block is going - and calls the agent ready within 0.4 of it. A
 * crouched agent stops with its centre about 0.7 across its own block, because sneaking is exactly
 * the rule that keeps its box over something solid, which leaves it 0.8 away and never ready. So
 * the target here is the edge the agent is actually standing on.
 *
 * Its box is 0.6 wide, so 0.7 puts the leading face flush with the boundary: as far out as crouching
 * allows, and the angle from which the side of the block underfoot is a face the server accepts.
 */
const AT_EDGE = 0.68

/**
 * How far down to look while backing onto an edge, in radians.
 *
 * Upstream's: almost straight down, which is what puts the side of the block underfoot in view.
 */
const OVER_THE_EDGE = -1.421

const SETTLED = 0.02

/**
 * How long the end of a journey is braked into before it is called an arrival, in ticks.
 *
 * A counter-strafe kills a sprint in two or three, so six is room to spare. It is a bound rather
 * than a duration: something holding the agent in motion - a push, a slope, a server that keeps
 * putting it back - must not be able to stop it ever arriving.
 */
const HOLD_UP = 6

/**
 * How many squares past the one being jumped to still count as landing on the route.
 *
 * Three, which is as far as one jump can carry an agent past what it aimed at. Further than that
 * and a landing is not an overshoot, it is somewhere else.
 */
const LOOK_AHEAD_LANDING = 3

/**
 * Above this, stopping is worth doing something about rather than waiting out.
 *
 * **Friction alone is far too slow to stop inside one block.** It takes 0.6 of the speed off each
 * tick, so a sprint decays 0.28, 0.17, 0.10, 0.06, 0.04 - about two thirds of a block of travel
 * before it counts as still. An agent that arrives at the foot of a tower at a run therefore slides
 * out of the square before it is allowed to build, every single time, and the tower starts a block
 * further on than the route meant. Pressing back against the direction of travel stops it in one or
 * two ticks instead, inside the square it arrived in.
 */
const BRAKING = 0.05

/**
 * How far off the middle of a square is worth correcting before pillaring out of it.
 *
 * **Tried once before and taken out again, because it was walking.** Shuffling towards the middle at
 * walking speed overshoots it, and the correction for that overshoots back - a ladder of corrections
 * that read as an agent climbing the edge of its own tower. What makes it safe now is that stopping
 * is a counter-strafe rather than letting go: the agent can arrive at the middle and stay there.
 *
 * Its box is 0.6 wide in a square of 1, so a sixth of a block off centre still leaves a fifth of a
 * block of the square on the near side. Tighter than that is chasing floating point.
 */
const OFF_CENTRE = 0.17

/**
 * The smallest correction worth pressing a key for, in blocks.
 *
 * Half of what a walked tick covers. A key is held for the whole tick whatever the error is, so
 * chasing anything smaller than this moves the agent further than it was out by and the next tick
 * corrects back - which is the shuffle, not the fix.
 */
const A_STEP = 0.07

/**
 * How much sideways travel is worth correcting, in blocks a tick.
 *
 * A twentieth of a walking pace. Below this the agent is going where it is looking; above it, it is
 * crabbing, and a jump would carry that into the column beside the one it aimed at.
 */
const DRIFTING = 0.03

/**
 * How many ticks' worth of travel it takes to stop, as a multiple of the current speed.
 *
 * **A distance, worked out from the speed, rather than a fixed one.** A fixed distance brakes an
 * agent that was going to stop in time anyway, which slows it below the threshold, which lets it
 * walk again - a tug of war that settles short of the goal. Against the speed there is no fight:
 * fast means brake now, slow means carry on.
 *
 * Counter-strafing kills a sprint in about two ticks; three leaves room for the tick it takes to
 * notice.
 */
const STOPPING = 3

/** How often the agent says what it decided about the square ahead. */
const NARRATE_MS = 1_000
const HIGH = 1

/** How close to a stretch a change has to be to matter to it. Upstream's tolerances. */
const BESIDE = 1
const ABOVE = 2

/** How long a step may take before the route rather than the world is the problem. */
const STUCK_MS = 3_500

/**
 * How long a job may take before it is hung rather than slow.
 *
 * A floor rather than the answer: breaking asks for as long as the block actually takes. Six seconds
 * covers any placement, which is a packet and an acknowledgement.
 */
const JOB_MS = 6_000

/**
 * How much longer than the block itself a dig is given.
 *
 * **Obsidian is why this exists.** A netherite pickaxe takes about eight and a half seconds on it,
 * and a flat six second deadline gave up on every single attempt - three times over, at exactly six
 * seconds each, while the dig was going perfectly well. Double the block's own time, because the
 * server's idea of how long it takes is the one that counts and ours is an estimate made without
 * reading the tool's enchantments.
 */
const DIG_SLACK = 2

/**
 * How many times one block is asked for before the route is what is wrong.
 *
 * Each try is a jump's worth of waiting for the agent's own box to clear the square. Three is enough
 * to ride out a refusal or a missed window without the agent standing under an unplaceable block for
 * anything like {@link JOB_MS}.
 */
const ATTEMPTS = 3

/**
 * How far the agent may be from the block it is building against.
 *
 * **The server checks this and says nothing when it fails.** A refused placement drops the agent
 * back to the ground, and a retry sent from down there is aimed at a block that is now two or three
 * blocks above its hands - which is not a placement the server will ever accept, so the attempt is
 * spent finding that out. Vanilla allows about four and a half blocks from the eyes; four is inside
 * that with room for the position the server thinks the agent is at rather than the one it thinks
 * it is at.
 */
const ARMS_LENGTH = 4

/**
 * How long a block the agent changed stays its own doing, after the job that changed it is over.
 *
 * **A stretch's `planned` set does not survive being re-planned, and the tower does.** Once a
 * mend or a re-plan builds fresh stretches, their sets list only the work still to come - so an
 * update for a block laid a moment ago reads as news, mends the stretch, and the mend rebuilds the
 * sets and forgets a little more. An agent pillaring upwards makes one of these per rung and can
 * chase its own tail all the way up. This remembers what was actually done, across every re-plan.
 */
const MINE_MS = 5_000

/**
 * How many jobs may fail in a row before the journey is what is wrong.
 *
 * **A failing job re-plans, and a job that fails the instant it starts re-plans instantly.** Left
 * alone that is a search a tick, for ever, and a log line each - which is exactly what a tool the
 * agent cannot swing produced. A handful of tries is generous for anything transient; past that the
 * agent is not being obstructed, it is being asked for something it cannot do.
 */
const GIVING_UP = 5

/** One stretch of route, and the unit a change re-plans. */
interface Section {
  steps: Walk[]
  /** Whether these steps came from a finished search. A guess may be walked, not built on. */
  settled: boolean
  /**
   * Every block this stretch means to change, as `x,y,z`.
   *
   * **What makes "ignore the agent's own changes" exact rather than a guess.** Upstream re-planned
   * on every block update near the route, so an agent building a tower threw the route away at every
   * rung - which is where the constant re-planning came from, and with it every chance for a
   * half-thought search to send it up a different column. The route already knows every block it
   * intends to lay and break; a change at one of those is the plan working, not news about the world.
   *
   * Worked out once, when the stretch is drawn, and never again - the steps have their work shifted
   * off them as it is done, and a set that followed them would forget the block at the exact moment
   * the update announcing it arrived.
   */
  planned: ReadonlySet<string>
  /** Where the stretch ends, which is what a mend of it has to reach. */
  end: Walk
}

/** One block being laid or broken. */
interface Job {
  /** Which generation of the stretch being walked asked for it. */
  era: number
  what: 'laying' | 'breaking'
  at: WorldVec
  since: number
  /** How long this particular piece of work is worth waiting for. See {@link DIG_SLACK}. */
  patience: number
}

/** A stretch being thought about again. */
interface Mend {
  search: Search
  index: number
}

/**
 * How far below the agent's feet a square in water can be and still be risen to rather than sunk to.
 *
 * A swimmer holding jump bobs with its feet about half a block into the top square of water, so the
 * square it is floating in reads as a little below it - and letting go there sinks it out of the
 * square it was already in.
 */
const SURFACING = 0.5

/**
 * What a tick of sprinting in water keeps of its horizontal speed, against what paddling keeps.
 *
 * **The half of swimming prismarine's physics leaves out.** Vanilla damps horizontal speed in water
 * by 0.9 a tick while sprinting and by 0.8 otherwise, which is the whole difference between swimming
 * and paddling - near enough twice the top speed. The physics applies 0.8 whatever is held, so a
 * sprint in water was a key pressed for nothing. Scaling what it left by the ratio, after each tick
 * it sprinted through, is exactly vanilla's: the stroke is the same, only less of it is lost.
 * Vertical speed is damped the same either way, so it is left alone.
 */
const SPRINT_SWIM = 0.9 / 0.8

/**
 * What a tick of diving takes off a swimmer's vertical speed.
 *
 * Vanilla's for a player holding sneak in water, which prismarine's physics does not model - it only
 * knows that jump rises. Left to sink on its own a swimmer drops a tenth of a block a tick, slower
 * than it crosses the water, so it arrived above every square of a descent and circled it on the way
 * down. Holding sneak instead would not do: the physics slows every stroke to a third for a crouch
 * that in water is not one.
 */
const DIVE = 0.04

/** Whether the agent is in water, by the physics' own reading of it. */
function swimming(bot: Bot): boolean {
  return (bot.entity as unknown as { isInWater?: boolean } | undefined)?.isInWater === true
}

export class Driver {
  private goal: Goal | undefined

  /** The whole journey being thought about, when it is. */
  private plotting: Search | undefined
  /** One stretch being thought about again, when one is. */
  private mending: Mend | undefined

  /** What comes after a route that stops short, being looked for. See {@link LOOKAHEAD}. */
  private extending: Search | undefined

  /**
   * The square a search for the rest of the journey has already failed from.
   *
   * **Asking the same question again the next tick is not looking ahead, it is a busy loop.** A
   * search that finds no way on costs everything it can reach before it says so, and the answer does
   * not change while the route ends in the same square. It is dropped whenever the route does, so
   * arriving there and planning afresh - with the world that far out finally loaded - still happens.
   */
  private grown: string | undefined

  /**
   * Whether the route in hand stops short of where the agent was sent.
   *
   * **The difference between arriving and running out of route**, which nothing used to tell apart:
   * a search that timed out handed back the best stretch it had found, the agent walked it, ran out
   * of steps and reported that it had arrived - somewhere that was not the destination. Now the end
   * of a short route is where the next search starts from.
   */
  private short = false

  /** How long one slice of thinking may be, from the rules the current route was planned under. */
  private slice = 0

  private sections: Section[] = []

  private job: Job | undefined

  /** How often the stretch being walked has been replaced. What tells a job if it still belongs. */
  private era = 0

  /** When the agent last got somewhere, which is what a stall is measured against. */
  private movedAt = 0

  /** When it last said what it decided, so a decision a tick is one line a second. */
  private narrated = 0

  /** Jobs that have failed since the agent last got anywhere. */
  private failures = 0

  /** Blocks this agent changed itself, and when they stop being its own doing. See {@link MINE_MS}. */
  private readonly mine = new Map<string, number>()

  /** Whether the square being walked to is one the agent has to stop in. Kept out of the sprint. */
  private arriving = false

  /**
   * Whether a jump that only works at a run is coming up, so speed is worth carrying.
   *
   * **The other half of the same question, and the two are not opposites.** Most squares want the
   * gentlest jump that reaches, because a sprint jump carries most of a block past a short hop and
   * the agent lands beyond what it aimed at - over the edge, in the case that killed one. A run-up
   * is the exception: a gap upstream marks as parkour cannot be cleared from a standing start, so
   * the squares before it are the run, and letting go of the sprint on one of them is what leaves
   * the agent at the lip of a three block gap with walking pace to jump it with.
   */
  private hurrying = false

  /** The heading a jump left the ground on, held until it lands. */
  private flying: number | undefined

  /** Ticks spent getting into position for a block, printed when it is laid. Diagnostic. */
  private rung: { at: string; frames: Frame[] } | undefined

  /** A jump in progress, being played back against what the simulation said. Diagnostic. */
  private flight: { to: string; predicted: Frame[]; real: Frame[]; landed?: number } | undefined

  /**
   * Whether the agent is in the middle of being brought to a stand.
   *
   * Held until {@link brake} says it is still, rather than asked again every tick - see where it
   * is set. A brake that is re-decided is a brake that alternates with a walk.
   */
  private stopping = false

  /**
   * The steps after the one being walked to, so a landing can be checked against the route.
   *
   * Kept rather than passed, because {@link decide} is handed one square and the question a
   * landing asks is about the journey: coming down a square early or a square late is fine if
   * the route goes there, and is a fall if it does not.
   */
  private ahead: readonly Walk[] = []

  /** Ticks spent braking into the last square, so an agent that never settles still arrives. */
  private landing = 0

  /** Whether the last decision was to swim down to a square below. See {@link DIVE}. */
  private diving = false

  /**
   * The square the agent gave up on and planned again from, so it only does that once.
   *
   * Cleared by taking a step, because an agent that got somewhere is not the agent this is
   * about. A latch that clears on the next tick latches nothing - see the column walk in
   * {@link composing}, which is what that mistake looked like from outside.
   */
  private stranded: string | undefined

  /** Whether a tower has already been re-planned once for starting in the wrong column. */

  /** Whether the last finished search could not reach the goal at all. */
  private hopeless = false

  /** How many blocks the agent had to build with when it last planned. */
  private carrying = 0

  private readonly onTick = (): void => this.tick()
  private readonly onBlock = (before: unknown, after: unknown): void => this.changed(before, after)

  constructor(
    private readonly id: number,
    private readonly bot: Bot,
    private readonly rules: () => Rules,
    private readonly report: Driven,
    /**
     * The one queue for the agent's hands.
     *
     * Laying and breaking are ordinary work: important enough to happen, and the first thing that
     * should be put down when the agent needs a totem or a meal. See `schedule.ts`.
     */
    private readonly hands: Schedule,
    /**
     * How a step is judged walkable, which is upstream's player physics run forward.
     *
     * A parameter rather than a field built here because it is the one thing in this file that needs
     * a whole world behind it to answer at all - and because flight, which has no ground to simulate
     * standing on, will hand in its own.
     */
    private readonly physics: Simulation = new Jumping(bot),
  ) {}

  start(): void {
    const events = this.bot as unknown as { on(name: string, handler: (...args: never[]) => void): void }
    events.on('physicsTick', this.onTick as (...args: never[]) => void)
    events.on('blockUpdate', this.onBlock as (...args: never[]) => void)
  }

  stop(): void {
    const events = this.bot as unknown as {
      removeListener(name: string, handler: (...args: never[]) => void): void
    }
    events.removeListener('physicsTick', this.onTick as (...args: never[]) => void)
    events.removeListener('blockUpdate', this.onBlock as (...args: never[]) => void)

    this.halt()
  }

  /** Whether it is on its way somewhere. */
  moving(): boolean {
    return this.goal !== undefined
  }

  /**
   * Whether the route it is on still has blocks to lay or break.
   *
   * **A tower is one job per rung, and the queue only sees the rung it is on.** Between two of them
   * nothing is queued, so anything less important is free to take the hands - and it does, for as
   * long as it takes, while the agent stands on its half-built pillar waiting to jump again. Fair
   * per job, wrong across a sequence of them. This is how housekeeping is told the sequence is not
   * over.
   */
  building(): boolean {
    if (!this.goal) return false
    if (this.job) return true

    return this.sections.some((section) => section.steps.some((step) => step.toPlace.length + step.toBreak.length > 0))
  }

  /** Go there. Replaces whatever it was doing. */
  go(goal: Goal): void {
    this.goal = goal
    this.hopeless = false
    this.plan()
  }

  /** Stop where it is. Not a failure - it is an outcome somebody asked for. */
  halt(): void {
    this.clear()
    this.still()
  }

  /** Thinks the whole journey through again, from where the agent is standing. */
  private plan(): void {
    const goal = this.goal
    if (!goal || !this.bot.entity) return

    const { movements, reach, slice, budget } = this.rules()

    this.sections = []
    this.mending = undefined
    this.extending = undefined
    this.short = false
    this.grown = undefined
    this.slice = slice
    this.era++
    this.movedAt = Date.now()
    this.arriving = false

    const from = standingAt(this.bot, movements)

    // What it has to build with, said out loud. An agent that cannot climb cannot reach anything
    // above it, and a search that spends its whole budget discovering that looks from outside
    // exactly like an agent standing still for no reason.
    this.carrying = movements.countScaffoldingItems()

    log.debug(
      `Agent ${this.id} is planning from ${from.x} ${from.y} ${from.z} with ${this.carrying} blocks to build with`,
    )

    this.plotting = new Search(from, walkingFrom(movements), goal, { budget, slice, reach, measured: MEASURED })
  }

  /**
   * One tick, and the edge everything the engine does is caught at.
   *
   * **A throw in here used to be the whole host.** This runs from a `physicsTick` handler, so an
   * exception raised anywhere below - in the rules, in the simulation, in a job - unwinds through
   * mineflayer's emitter and out of the process, taking every *other* agent's session with it. One
   * agent that cannot work out where to walk is a journey that fails, and nothing more than that.
   */
  private tick(): void {
    try {
      // The tick just simulated, before anything below changes the controls for the next one.
      const moving = this.bot.entity?.velocity
      if (moving && swimming(this.bot) && this.bot.getControlState('sprint')) {
        moving.x *= SPRINT_SWIM
        moving.z *= SPRINT_SWIM
      }
      if (moving && swimming(this.bot) && this.diving) moving.y -= DIVE

      this.record()
      this.think()
    } catch (err) {
      log.warn(`Agent ${this.id} could not work out what to do next: ${(err as Error).message}`)
      this.give('it could not work out how to get there')
    }
  }

  /**
   * Plays a jump back a tick at a time against what the simulation said it would do.
   *
   * Diagnostic, and temporary. Six hypotheses about one jump have each been argued from a once a
   * second line and each been wrong; this prints the thing itself.
   */
  /**
   * What a finished search cost, once per search.
   *
   * Diagnostic, and silent unless {@link MEASURED}. Three numbers decide what to do about a slow search and none of them is visible
   * from outside it: how many squares it expanded, how much of the wall clock it was actually
   * allowed to think for, and how much of *that* went into the neighbour source rather than the
   * search. A search that is slow because the world is hard to read, one that expands far too
   * much, and one that is simply throttled all look the same from a stopwatch.
   */
  private cost(what: string, search: Search, found: Route): void {
    if (!MEASURED) return

    const { slices, thought, asking, asked } = search.spent
    const waited = Date.now() - (search as unknown as { startedAt: number }).startedAt

    log.debug(
      `Agent ${this.id} ${what} ${found.outcome} in ${waited}ms: ${found.looked} squares for ` +
        `${found.steps.length} steps, thinking ${thought}ms of it over ${slices} slice(s) ` +
        `(${waited > 0 ? Math.round((thought / waited) * 100) : 0}% of the clock), of which ` +
        `${asking}ms was ${asked} call(s) to the rules`,
    )
  }

  private record(): void {
    const flight = this.flight
    const entity = this.bot.entity
    if (!flight || !entity) return

    const held = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
      .filter((name) => {
        try {
          return this.bot.getControlState(name as Parameters<Bot['getControlState']>[0])
        } catch {
          return false
        }
      })
      .map((name) => name[0])
      .join('')

    flight.real.push({
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
      speed: Math.hypot(entity.velocity?.x ?? 0, entity.velocity?.z ?? 0),
      onGround: entity.onGround === true,
      held,
      yaw: entity.yaw,
    })

    /*
     * **The landing is not the end of it.**
     *
     * A jump that lands where it was aimed can still slide off the block it landed on, and that
     * happens entirely after the flight is over - so a recorder that stopped at touchdown was
     * blind to the half of it worth watching. Kept running for a while afterwards, the dump shows
     * the coast: what was held, how fast it was still going, and which tick it left the square.
     */
    if (entity.onGround === true && flight.real.length > 1) flight.landed ??= flight.real.length

    const settled = flight.landed !== undefined && flight.real.length - flight.landed >= AFTER_TICKS
    if (!settled && flight.real.length < JUMP_TICKS + AFTER_TICKS) return

    this.flight = undefined

    const rows = Math.max(flight.real.length, flight.predicted.length)
    const lines: string[] = []

    for (let at = 0; at < rows; at++) {
      const was = flight.real[at]
      const said = flight.predicted[at]

      lines.push(
        `  ${String(at).padStart(2)} ` +
          (was
            ? `${was.x.toFixed(3)} ${was.y.toFixed(3)} ${was.z.toFixed(3)} ${was.speed.toFixed(3)} ` +
              `${was.onGround ? 'gnd' : 'air'} ${(was.held ?? '').padEnd(7)} ` +
              `yaw ${(was.yaw ?? 0).toFixed(2)}`
            : ''.padEnd(52)) +
          ` | ` +
          (said
            ? `${said.x.toFixed(3)} ${said.y.toFixed(3)} ${said.z.toFixed(3)} ${said.speed.toFixed(3)} ` +
              `${said.onGround ? 'gnd' : 'air'}`
            : ''),
      )
    }

    log.debug(
      `Agent ${this.id} flight for ${flight.to}, real | simulated:\n` +
        `   t x y z speed ground held yaw | x y z speed ground\n` +
        lines.join('\n'),
    )
  }

  private think(): void {
    if (!this.goal || !this.bot.entity) return

    // A job owns the agent while it runs. Nothing below may move it or walk a route under it - which
    // is the whole of why it can no longer walk one way while building another.
    if (this.job) {
      this.mind(this.job)
      return
    }

    // Thought before movement, so a route that settles this tick is acted on this tick.
    if (this.plotting) this.plot()
    else if (this.extending) this.grow()
    else if (this.mending) this.mend()

    if (this.sections.length === 0) {
      // **A search already in flight is the answer to having no route**, and planning over the top
      // of one is how a journey used to throw away everything it had worked out the moment it ran
      // out of steps to walk.
      if (!this.plotting && !this.extending) this.plan()

      // Waiting for a route is not being stuck. Same reasoning as an unsettled stretch, and the
      // same clock: this one is for walking, and the search's own budget watches the search.
      this.movedAt = Date.now()
      this.still()
      return
    }

    this.walk()
  }

  /** One slice of thinking about the whole journey. */
  private plot(): void {
    const search = this.plotting
    if (!search) return

    const found = search.run(this.thinking())

    if (found.outcome === 'partial') {
      // A guess, and labelled as one: worth walking, because the next slice corrects it, and not
      // worth spending a block on. Every stretch stays unsettled until the search finishes.
      this.cut(found.steps as Walk[], false)
      return
    }

    this.cost('planned', search, found)
    this.plotting = undefined

    if (found.steps.length === 0) {
      // **What the rules actually offered from the square it started in.** A goal above the agent
      // is reached by climbing and nothing else, so if the rules hand back no move straight up, no
      // amount of searching finds one - it spends the whole budget on the ground and fails saying
      // nothing. Which guard inside `getMoveUp` refused is not visible from here; whether it
      // refused at all is, and that is the difference between a broken search and an agent that
      // cannot climb from where it stands.
      const because = this.whyNot()

      this.give(
        because ?? (found.outcome === 'timeout' ? 'the search ran out of time' : 'there is no route there'),
      )
      return
    }

    /*
     * **`nowhere` twice running is not a route, it is the answer.**
     *
     * A search that exhausts everything and still cannot reach the goal hands back the closest it
     * managed. Walking that is right once - it may be a stretch of a longer journey, or the world may
     * have more of itself loaded by the time the agent gets there. Walking it *again* from where it
     * stops is the same search with the same answer, and the agent shuffles a few blocks forward for
     * ever. Measured: an agent with ten blocks of scaffolding and a goal twenty-six up spends a
     * hundred thousand squares finding out it cannot get there, then does it again.
     *
     * `timeout` is different and is always walked: it means the search ran out of clock, not out of
     * world, and the next one starts from further along.
     */
    if (found.outcome === 'nowhere') {
      if (this.hopeless) {
        this.give('there is no route there')
        return
      }

      this.hopeless = true
    } else {
      this.hopeless = false
    }

    // Anything but `found` ends somewhere that is not the goal, so the route is walked and then
    // carried on from where it ends rather than being mistaken for an arrival. See {@link grow}.
    this.short = found.outcome !== 'found'

    // The best that could be found, and nothing better is coming, so it is as settled as `found`.
    this.cut(found.steps as Walk[], true)

    if (found.outcome === 'nowhere') this.report.closest()
  }

  /**
   * Asks the rules what they would allow from where the agent is standing, and says so.
   *
   * **Only when a search has found nothing**, because that is the one case where the answer is not
   * visible from anywhere else: every guard that can refuse a move lives inside upstream's rules and
   * refusing is silent - the move simply is not in the list. Which guard fired is still invisible,
   * but *that* none of them let the agent climb is not, and it separates a search that is broken from
   * an agent that cannot leave the square it is on.
   *
   * Answers a reason worth telling an operator when the numbers name one, and nothing when they do
   * not - a guess dressed as an explanation is worse than "there is no route there".
   */
  private whyNot(): string | undefined {
    try {
      const { movements } = this.rules()
      const from = standingAt(this.bot, movements)
      const offered = walkingFrom(movements)(from)
      const upward = offered.filter((step) => step.x === from.x && step.z === from.z && step.y > from.y)

      log.warn(
        `Agent ${this.id} found nothing from ${from.x} ${from.y} ${from.z}: ${offered.length} moves ` +
          `offered, ${upward.length} of them straight up, ${this.carrying} blocks to build with`,
      )

      // The world is not there to search. A different fault entirely, and worth not confusing.
      if (offered.length === 0) return 'the world around it has not arrived yet'

      // **Measured, not assumed.** `countScaffoldingItems` was checked against every version this
      // host loads and answers correctly; nothing to climb with means nothing in the pack.
      if (upward.length === 0 && this.carrying === 0) return 'it has run out of blocks to build with'

      return undefined
    } catch (err) {
      log.debug(`Agent ${this.id} could not say why it found nothing: ${(err as Error).message}`)
      return undefined
    }
  }

  /** One slice of thinking about a single stretch again. */
  private mend(): void {
    const mending = this.mending
    if (!mending) return

    const found = mending.search.run()
    // Still thinking. The old steps carry on being walked, and stay unbuildable while they do.
    if (found.outcome === 'partial') return

    this.cost('mended', mending.search, found)
    this.mending = undefined

    const held = this.sections[mending.index]
    if (!held) return

    if (found.steps.length === 0) {
      log.debug(`Agent ${this.id} could not mend the stretch that changed, so it is planning again`)
      this.plan()
      return
    }

    this.sections[mending.index] = sectionOf(found.steps as Walk[], held.end, true)

    // The stretch under the agent's feet was replaced, so anything begun for the old one is over.
    if (mending.index === 0) this.era++

    this.movedAt = Date.now()
    this.draw()
  }

  /**
   * One slice of thinking about what comes after a route that stops short.
   *
   * **Carrying on rather than starting again.** A journey longer than one search can finish used to
   * end at the last square that search reached: the agent walked there, called it arrival, and only
   * an operator sending it again got it any further - and that next search started from scratch,
   * having learnt nothing from the first. This one starts where the last one stopped and what it
   * finds is added to the end of the route, so a long walk is one journey made of several searches
   * rather than several journeys.
   */
  private grow(): void {
    const growing = this.extending
    if (!growing) return

    const found = growing.run(this.thinking())
    if (found.outcome === 'partial') return

    this.extending = undefined
    this.cost('extended', growing, found)

    if (found.steps.length === 0) {
      // Nowhere to go on to. Whether that ends the journey depends on whether the agent is standing
      // there yet: from a stretch away it is an answer about a place the agent cannot see properly,
      // and the world in between arrives as it walks.
      log.debug(`Agent ${this.id} could not find a way on from the end of its route`)
      this.grown = this.sections[this.sections.length - 1]?.end.hash
      if (this.sections.length === 0) this.give('there is no route there')
      return
    }

    this.short = found.outcome !== 'found'
    this.grown = undefined
    this.append(found.steps as Walk[])

    if (found.outcome === 'nowhere') this.report.closest()
  }

  /**
   * Starts looking for the rest of the journey, before the agent runs out of route to walk.
   *
   * Only ever one search at a time: a stretch being mended and the whole journey being re-planned
   * both answer this question too, and better, because they know about whatever changed.
   */
  private reachOn(): void {
    const goal = this.goal
    if (!goal || !this.short) return
    if (this.plotting || this.mending || this.extending) return

    const last = this.sections[this.sections.length - 1]
    if (!last?.settled) return
    if (last.end.hash === this.grown) return

    let left = 0
    for (const section of this.sections) left += section.steps.length
    if (left > LOOKAHEAD) return

    const { movements, reach, slice, budget } = this.rules()
    this.slice = slice

    // From the square the route ends in, carrying the blocks the route expects to have left by
    // then - so what comes back joins on, and prices its own building honestly.
    log.debug(
      `Agent ${this.id} is looking for a way on from ${last.end.x} ${last.end.y} ${last.end.z}, ` +
        `${left} steps ahead of it`,
    )

    this.extending = new Search(last.end, walkingFrom(movements), goal, { budget, slice, reach, measured: MEASURED })
  }

  /**
   * How long a slice may be, which is all of the tick the agent is not using to walk.
   *
   * **Standing still is standing still, whatever it is waiting for.** This used to read only the
   * empty route, so an agent that had one and could not act on it - a block being broken, a
   * stretch still being thought about - searched at walking pace while doing nothing at all.
   *
   * Measured on a dig: 3.7 seconds of silence between one block and the next, no narration and no
   * movement, the whole of it waiting for a four node route to settle. Digging spends almost every
   * tick like that, which is why breaking a column read as slower than a player doing it by hand.
   */
  private thinking(): number {
    const waiting = this.sections.length === 0 || this.job !== undefined || this.sections[0]?.settled === false

    return waiting ? this.slice * STANDING_STILL : this.slice
  }

  /**
   * Adds stretches onto the end of the route rather than replacing it.
   *
   * Deliberately not an era: nothing under the agent's feet changed, so a placement already in the
   * air still belongs to the stretch that asked for it.
   */
  private append(steps: Walk[]): void {
    keepWhatItStandsOn(steps, this.id)

    for (let at = 0; at < steps.length; at += SECTION) {
      const slice = steps.slice(at, at + SECTION)
      const end = slice[slice.length - 1]
      if (!end) break
      this.sections.push(sectionOf(slice, end, true))
    }

    this.movedAt = Date.now()
    this.draw()
  }

  /** Cuts a fresh route into stretches and takes it. */
  private cut(steps: Walk[], settled: boolean): void {
    keepWhatItStandsOn(steps, this.id)

    const sections: Section[] = []

    for (let at = 0; at < steps.length; at += SECTION) {
      const slice = steps.slice(at, at + SECTION)
      const end = slice[slice.length - 1]
      if (!end) break
      sections.push(sectionOf(slice, end, settled))
    }

    this.sections = sections
    this.era++
    this.movedAt = Date.now()
    this.draw()
  }

  private draw(): void {
    this.report.route(
      this.sections.flatMap((section) => section.steps),
      this.sections.every((section) => section.settled),
    )
  }

  private walk(): void {
    const section = this.sections[0]
    const at = this.bot.entity?.position
    if (!section || !at) return

    // Decided afresh by every swimming tick, so a dive does not outlive the square it was for.
    this.diving = false

    this.reachOn()

    const step = section.steps[0]
    if (step && this.strayed(step, at)) {
      log.warn(
        `Agent ${this.id} came off its route: it is at ${at.x.toFixed(2)} ${at.y.toFixed(2)} ` +
          `${at.z.toFixed(2)} and the square it was walking to is ${step.x} ${step.y} ${step.z}`,
      )
      this.plan()
      return
    }

    if (!step) {
      this.sections.shift()
      if (this.sections.length === 0) this.finished()
      return
    }

    // **Nothing acts on a guess.** An unfinished search hands out a different best-so-far every
    // slice, and an agent that walked each of them paced two blocks back and forth on the spot until
    // one settled. Waiting looks like waiting; that looked broken. The route is still drawn while
    // this happens, so the map shows the thinking.
    if (!section.settled) {
      this.still()

      /*
       * **Thinking is not being stuck**, and the stall clock is held rather than read.
       *
       * Ground with a lot of up and down in it takes real time to search, and the agent is meant to
       * be standing still while that happens. Counting it against the stall timer meant a search
       * longer than a few seconds tripped it - and tripping it re-plans, which throws that search
       * away and starts another one that will take just as long. A route through anything difficult
       * could never finish.
       *
       * What watches a search that will not end is the search's own budget: it gives up on its own
       * and answers `timeout`, with the best route it managed. This clock is for walking.
       */
      this.movedAt = Date.now()
      return
    }

    // **Do not run at a square the agent has to stop in.** The step after this one pillars straight
    // up out of the square being walked to, and arriving at a sprint is most of a block of stopping
    // distance - which is the overshoot, before any braking gets a chance. A hole is the same
    // problem lying down: see {@link plunging}. So is the end of the journey, where there is no next
    // **The tick a gap jump ends.** {@link flying} is set only by a parkour takeoff and cleared
    // here rather than in {@link decide}, because the branches below return without reaching it.
    // **The route as it is on this tick.** Every branch below returns early on some of them, so
    // reading this where the walking happens left it a tick or more behind - and a stale answer
    // reads a straight run as a corner. Measured: the agent braked to a stand after every landing
    // and ran up each gap from 0.000 with half a block of runway.
    this.ahead = section.steps.slice(1, LOOK_AHEAD_LANDING + 1)

    // A jump into water comes down in it, and is as over as one that came down on a block.
    const wading = swimming(this.bot)
    const landed = this.flying !== undefined && (this.bot.entity?.onGround === true || wading)
    if (landed) this.flying = undefined

    /*
     * **A stop that has been started is finished.**
     *
     * Both brakes below ask whether the agent is going too fast *right now*, and a brake works, so
     * one tick of it drops the speed under the threshold and the next tick decides everything is
     * fine and presses forward again. Recorded from a landing that would not stay on its block:
     * `f` at 0.201, `b` at 0.056, `f` at 0.084 - a counter-press and a walk trading the agent back
     * and forth while it left the square. That is the tug of war {@link overshooting} was written
     * to avoid on distance, arriving instead on speed.
     *
     * So stopping is a state, not a tick: once either brake engages the agent is brought to a
     * stand, and {@link brake} says when that is done.
     */
    if (this.bot.entity?.onGround === true && this.stopping) {
      if (this.brake()) return

      this.stopping = false
    }

    // square to carry the speed into.
    const last = this.sections.length === 1 && section.steps.length === 1
    /*
     * **Anything the next square has to build is a reason to arrive still.**
     *
     * A rung is the obvious one, and it is not the only one: a bridge laid off the edge of the next
     * square needs the agent standing on that square while it places, and a sprint carries it off
     * the far side first. Measured from one: the route meant to lay the block it was about to land
     * on, and the block went down after the agent had already gone past where it would have been.
     */
    const next = section.steps[1]
    const building = next !== undefined && (next.toPlace.length > 0 || next.toBreak.length > 0)
    this.arriving = building || last || this.plunging(step, at)

    // Two squares of warning, because one is not a run-up. A staircase into a gap has to still be
    // moving when it gets there, and the sprint has to be picked up before the last step.
    this.hurrying = !this.arriving && this.runUpNeeded(section.steps)

    /*
     * **A jump over a gap is finished before anything else is begun.**
     *
     * Everything in the branch below lets go of the controls to do its work: {@link begin} calls
     * {@link still}, which is `clearControlStates`, and {@link composing} brakes. On the ground
     * that is the point of them. One tick after a takeoff it is the jump.
     *
     * Recorded from the one it cost: a sprint jump left the ground and the tick after it the
     * route reached a square with a block to lay, so every control went off. The next tick set
     * `forward` again and the airborne gate in {@link decide} - rightly - returned before
     * anything could set `sprint`, so the rest of the flight was a walk. It was chosen on a
     * simulation of a sprint: 0.058 a tick against 0.236, 1.4 blocks covered against 2.9, and
     * the far side of the gap never arrived.
     *
     * {@link flying} is a gap jump specifically, which is what makes this safe for a tower: a
     * rung is laid from inside a jump on purpose, and that jump never sets it.
     */
    const midJump = this.flying !== undefined && this.bot.entity?.onGround !== true

    if (!midJump && (step.toBreak.length > 0 || step.toPlace.length > 0)) {
      /*
       * **Mining in mid-air takes five times as long.**
       *
       * Vanilla divides the speed by five for a player who is not standing on something, and
       * digging straight down leaves the agent falling into the hole it has just made - so every
       * block after the first was mined on the way past it.
       *
       * Measured on a column of dirt by hand: 0.82 of a second for the one it stood on, then
       * 3.77, 3.76 and 3.75 for the rest. Dirt is 0.75 by hand, so those are the penalty exactly,
       * and it is why breaking read as slower than a player doing the same thing.
       *
       * Waiting costs the tick or two of the fall and nothing else; the clock is held for the
       * same reason it is held while lining up, since falling to the floor is not being stuck.
       */
      if (step.toBreak.length > 0 && this.bot.entity?.onGround !== true) {
        this.movedAt = Date.now()
        return
      }

      // Looking at its own feet, once, and then left alone: the block goes in underneath it and
      // there is nothing else to watch. Set here rather than at the moment of placing so the agent
      // is already looking the right way by the time the jump reaches the top.
      if (step.toPlace.some((spot) => spot.dx === 0 && spot.dz === 0 && spot.dy === 1)) {
        this.bot.look(this.bot.entity.yaw, AT_ITS_FEET, true)
      }

      if (this.composing(step, at)) {
        this.holding(step, at)

        /*
         * **Getting into position is progress, and the stall clock was counting it against the
         * agent.**
         *
         * The same argument an unsettled stretch already makes: this clock is for an agent that
         * has stopped getting anywhere, and one walking itself into the column it is about to
         * pillar up is doing exactly what it was asked to.
         *
         * Measured, it was the difference between one search and two. Lining up took 75 ticks -
         * see {@link centre}, which crabs - and the clock fires at 3.5 seconds, so a route that
         * cost 6.5 seconds to find was thrown away a quarter of a second before the first block
         * would have gone down, and the whole search ran again. Thirteen seconds of standing
         * still, of which none was the towering.
         */
        this.movedAt = Date.now()
        return
      }

      this.settled(step)
      this.begin(step)
      return
    }

    if (this.reached(step, at)) {
      /*
       * **The end of a journey is stopped at, not coasted through.**
       *
       * {@link done} lets go of the controls, and letting go is not braking: Minecraft sheds four
       * tenths of the speed a tick, so a release at a sprint travels most of a block further.
       * Recorded from an arrival - every control off at 0.270 a tick, and it skated 0.59 blocks
       * across the square before it stopped, coming to rest a hundredth of a block from the far
       * edge of the one it had landed on. Nothing was holding it. That is the slide.
       *
       * So the last square is braked in before it is called an arrival. It costs the tick or two a
       * counter-strafe takes, and the agent ends up where it was sent rather than a coast past it.
       */
      const ending = section.steps.length === 1 && this.sections.length === 1

      /*
       * **A journey is not over while the agent is still in the air.**
       *
       * {@link reached} counts a gap as cleared the moment the agent is over the square, which is
       * right for walking the route on and wrong for ending it: {@link done} lets go of the
       * controls, and {@link think} stops thinking once the goal is cleared, so a last jump
       * declared finished in mid-flight lands with nothing holding it at all.
       *
       * Recorded from one: arrival was reported 0.03 of a second before touchdown, the trace
       * shows every control released from the tick it landed, and it coasted 0.54 of a block off
       * the square it had just landed on. The brake below never got a chance - there was no
       * longer a journey for it to belong to.
       */
      // A swimmer is never on the ground, and a journey that ends in water still ends.
      if (ending && this.bot.entity?.onGround !== true && !wading) return

      if (ending && this.bot.entity?.onGround === true && this.landing < HOLD_UP && this.brake()) {
        this.landing++
        return
      }

      this.landing = 0
      this.stopping = false
      section.steps.shift()
      this.movedAt = Date.now()
      this.failures = 0
      this.stranded = undefined
      if (section.steps.length === 0 && this.sections.length === 1) this.finished()
      return
    }

    /*
     * **Braking only when it would otherwise sail past.**
     *
     * The last square of a journey is the one place nothing further pulls the agent back on course,
     * so coasting into it leaves it standing wherever it happened to stop.
     *
     * The trap is braking on *distance*: brake inside a block of the goal and the agent slows, stops
     * being worth braking, walks again, and comes back - a tug of war that settles wherever the two
     * balance, which is short of where it was sent. So the question is not "is it close" but "would
     * it overshoot": distance left against how far this speed carries. Faster means braking sooner,
     * slower means walking on, and the two never fight.
     */
    /*
     * **Braked into every square it has to stand still in, not just the last one.**
     *
     * A rung is built from wherever the agent happens to have stopped, so coasting into the square
     * below it means arriving off the middle and correcting afterwards - and correcting afterwards
     * is the pause with the little sideways shuffles in it, once per tower. Slowing on the way in
     * costs a few ticks and puts the agent on the spot it was aimed at, which is where it was always
     * meant to be by the time it jumps.
     *
     * Still only when it *would* overshoot, never on distance alone - see {@link overshooting}.
     */
    // **On the ground only.** Braking is a counter-strafe - see {@link brake} - and a
    // counter-strafe in mid-flight is the one control that turns a jump into a fall.
    if (this.bot.entity?.onGround === true && this.arriving && this.overshooting(step, at)) {
      this.stopping = true
      this.brake()
      return
    }

    this.head(step)
    this.futility()
  }

  /**
   * Whether the agent is standing in a square rather than merely passing through it.
   *
   * **Climbing needs the ground under it, which is what a tower kept falling off.** Partway up a jump
   * the feet are already within a block of the step above, so a purely distance-based test calls that
   * arrival - and the driver moves on and starts the next placement while the agent is still falling
   * into the very square it would be placing in. The gate then waits for room that is never made,
   * gives up, and the agent drops off what it has built.
   */
  /**
   * Whether the agent is not yet in a fit state to lay the block ahead of it.
   *
   * Two shapes of placement, and they want opposite things.
   *
   * **A tower** goes into the square the agent is standing in, and it needs the agent *still*. A
   * jump keeps whatever horizontal speed it started with - there is no braking in the air - so
   * pillaring while still walking lands off the middle, and the correction for that is itself a
   * walk, which is still going when the next jump starts. That ladder of corrections is what read
   * as an agent climbing the edge of its own tower.
   *
   * **A bridge** goes sideways off the block underfoot, and it needs the agent *at the edge*, turned
   * around and looking down over it. Placed from anywhere else the agent is asking for a block in
   * mid-air with nothing to build against, which the server refuses.
   */
  private composing(step: Walk, at: { x: number; y: number; z: number }): boolean {
    const laying = step.toPlace[0]
    if (!laying) return false

    // Sideways off the block underfoot: a bridge.
    if (laying.dy === 0 && laying.y === Math.floor(at.y) - 1) return this.edging(laying, at)

    const going = { x: laying.x + laying.dx, y: laying.y + laying.dy, z: laying.z + laying.dz }
    const stood = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) }

    // A tower and nothing else: straight up, off the block under the agent's own feet, landing at
    // the level it is standing at. A block laid at that level in a *different* column is a step up
    // onto - the agent has to be outside it to place it, and walking into it would be walking into
    // the air where it is going to be.
    if (laying.dx !== 0 || laying.dz !== 0 || laying.dy !== 1) return false
    if (going.y !== stood.y) return false

    /*
     * **A block out of the column is walked, not re-planned.**
     *
     * This used to throw the route away and search again from where the agent stood, on the
     * argument that the route was stale - drawn from where the agent used to be, which it had
     * walked past while the search settled - and that walking back would only overshoot the
     * other way. {@link centre} could not stop at the time, so that was true.
     *
     * It stops now, and the re-plan turned out to cost what it was meant to save. Recorded from
     * a tower: the agent stood still at -534030 104 -1213587 wanting a rung at -534029, so every
     * search planned from a standing agent returned the same answer and the disagreement was
     * never stale at all. Three full journey searches in five seconds, 4314 squares each, all
     * identical, none of which moved the agent an inch - and the latch meant to allow only one
     * of them was cleared on the very next tick by the reset below it, so it latched nothing.
     *
     * The walk was already written and sitting underneath it: {@link centre} is aimed at the
     * middle of the column the route wants, and a block away is simply a long correction. It is
     * one square of walking against a search of several thousand.
     */

    /*
     * In the column, and two things left before it jumps: **over the middle of it, and still.**
     *
     * Over the middle because a jump goes straight up, so wherever the agent is standing is where
     * the whole tower goes - and a pillar built from the lip of each block is one the agent has to
     * keep catching itself on. Still because a jump keeps whatever it starts with and there is no
     * braking in the air.
     */
    const middle = { x: going.x + 0.5, z: going.z + 0.5 }
    const off = Math.hypot(middle.x - at.x, middle.z - at.z)

    // Walked towards and braked into, rather than waited out. See {@link BRAKING}: waiting is what
    // carried the agent out of the square it was supposed to pillar up from in the first place.
    return this.centre(middle.x - at.x, middle.z - at.z)
  }

  /**
   * Puts the agent over the middle of a square and stops it there. Answers whether it is still busy.
   *
   * **Walked and braked, never crouched.** This used to shuffle across crouched, because a walked
   * step is two tenths of a block and the whole correction is smaller than that, so walking turned
   * being off one side into being off the other. Crouching lands it - and costs more than it is
   * worth: a crouched agent is a third as fast, will not walk off a ledge it is meant to drop from,
   * and seeds every physics question the next tick asks with a control the answer depends on.
   *
   * What replaces it is the arithmetic the brake already uses: press towards the middle while there
   * is room to stop, and counter-strafe as soon as carrying on would overshoot. That converges from
   * either side without a crouch, because stopping is something this agent can now do deliberately.
   *
   * In the agent's own frame, because turning to face the middle is exactly what a tower cannot have
   * - see {@link WORTH_TURNING}.
   */
  private centre(dx: number, dz: number): boolean {
    const bot = this.bot
    const off = Math.hypot(dx, dz)
    const moving = bot.entity?.velocity
    const speed = moving ? Math.hypot(moving.x, moving.z) : 0

    // Near enough, or moving fast enough that another step would carry it past: stop instead.
    if (off <= OFF_CENTRE || (speed > BRAKING && off < speed * STOPPING)) return this.brake()

    const yaw = bot.entity.yaw
    const ahead = alongFacing(dx, dz, yaw)
    const beside = acrossFacing(dx, dz, yaw)

    bot.setControlState('sprint', false)
    bot.setControlState('sneak', false)
    bot.setControlState('jump', false)

    /*
     * **An axis that is already right is left alone.**
     *
     * These were bare sign tests, and a key is pressed for a whole tick: a walked tick covers
     * about 0.13 of a block, so any error smaller than that is overshot and reversed on the next
     * one. Recorded from a tower lining up, the agent started dead on the column's x and wandered
     * to 0.30 off it and back while it crossed in z - right, right, left, left, right - taking 75
     * ticks to cover a block and a third at 0.055 a tick where walking is 0.13.
     *
     * Below a half tick there is nothing a press can do but make it worse, and friction closes it
     * for free.
     */
    bot.setControlState('forward', ahead > A_STEP)
    bot.setControlState('back', ahead < -A_STEP)
    bot.setControlState('right', beside > A_STEP)
    bot.setControlState('left', beside < -A_STEP)

    return true
  }

  /**
   * Kills sideways drift, so the agent travels along the line it is facing.
   *
   * **A jump keeps whatever it takes off with, sideways included.** An agent that is walking a
   * fraction crabwise - which every turn, every landing and every corrected overshoot leaves it
   * doing - jumps along that same diagonal, and its box is 0.6 wide in a square of 1. There is a
   * fifth of a block either side, so a drift too small to see puts a shoulder into the column next
   * door: measured from one, the agent laid a rung, jumped, and stopped dead against a block to its
   * right that the route never went near.
   *
   * Pressing the opposite side key is what a player does, and unlike crouching it costs no speed -
   * which matters, because the reason to be moving at all is usually a gap ahead.
   *
   * Left alone when something deliberate is already strafing: the brake and {@link centre} are both
   * sideways corrections of their own, and this must not argue with them.
   *
   * **On the ground only, which is where the drift is worth taking out.** Read the sentence this
   * comment opens with: a jump keeps what it takes off with, so the drift is dealt with *before*
   * the takeoff or not at all. In the air a side key removes almost none of it - air
   * acceleration is about 0.02 a tick - and it costs a great deal, because Minecraft normalises
   * the movement input: forward and a strafe together leave about seven tenths of the thrust
   * pointing forward. {@link Simulation.lands} chose the jump on a simulation holding forward
   * and nothing else, so every tick of strafing in the air is the jump falling short of the
   * answer it was picked for.
   *
   * Measured on the one jump of a course that failed: the seven gaps around it were taken from a
   * standstill at 0.06 with no drift to correct, and landed where the simulation said. This one
   * came off a jump in the other axis and turned ninety degrees, so it took off at 0.203 with
   * real drift - the only flight where this fired. Predicted 3.83 blocks, travelled 3.25, at an
   * average of 0.217 a tick against the 0.27 the answer needed. Seven tenths of the air
   * acceleration is that difference, and 0.58 of a block short of a one block landing is the
   * void.
   */
  private holdTheLine(): void {
    const bot = this.bot
    const moving = bot.entity?.velocity
    if (!moving) return

    if (bot.entity?.onGround !== true) return

    /*
     * **Not on the tick the jump goes out.**
     *
     * This runs after {@link decide}, so a strafe pressed here is held through the takeoff -
     * and Minecraft normalises the movement input, which leaves about seven tenths of the
     * thrust pointing forward on the one tick where all of it matters. Recorded from two jumps
     * on the same course: the one that worked had `f j s` down at takeoff and went from 0.059
     * to 0.382 a tick, the one that failed had `f r j s` and went from 0.203 to 0.302. The
     * difference is about 1.3 blocks of jump, which is the difference between the far side and
     * the near face of it.
     *
     * The drift is still worth taking out on every other tick of the run-up, which is what
     * straightens the line the jump is eventually taken along.
     */
    try {
      if (bot.getControlState('jump')) return
    } catch {
      return
    }

    try {
      if (bot.getControlState('left') || bot.getControlState('right')) return
    } catch {
      return
    }

    const beside = acrossFacing(moving.x, moving.z, bot.entity.yaw)
    if (Math.abs(beside) <= DRIFTING) return

    bot.setControlState(beside > 0 ? 'left' : 'right', true)
  }

  /**
   * Whether a jump that only works at a run is close enough that the speed has to be there already.
   *
   * Two squares, which is what a run-up is worth: the step being taken now and the one after it. Any
   * further ahead and every staircase in the world would be sprinted down, which is how an agent
   * lands a block past what it aimed at.
   */
  private runUpNeeded(steps: readonly Walk[]): boolean {
    return steps.slice(1, LOOK_AHEAD_RUN_UP + 1).some((step) => step.parkour === true)
  }

  /**
   * Whether the agent has come off its route rather than merely fallen behind it.
   *
   * **The one thing the stall clock is bad at.** A missed jump leaves the agent somewhere the route
   * never goes, usually a long way down, and everything below carries on steering towards a square
   * that is now above its head: measured from one, thirty blocks of falling spent deciding it was
   * "centred already" on a square it could no longer see, and four seconds before anything noticed.
   */
  private strayed(step: Walk, at: { x: number; y: number; z: number }): boolean {
    if (at.y < step.y - FELL) return true

    const stood = standsAt(step)
    return Math.hypot(stood.x - at.x, stood.z - at.z) > LOST
  }

  /**
   * How far the agent can still walk before it is off the square it is standing on.
   *
   * Along the way it is facing, which is the way it is about to move. What matters at a gap is the
   * last moment a jump can still be taken from solid ground.
   */
  private roomToRun(at: { x: number; z: number }): number {
    const yaw = this.bot.entity?.yaw ?? 0
    const ahead = { x: -Math.sin(yaw), z: -Math.cos(yaw) }

    const across = at.x - Math.floor(at.x)
    const along = at.z - Math.floor(at.z)

    let room = Infinity
    if (Math.abs(ahead.x) > 0.001) room = Math.min(room, (ahead.x > 0 ? 1 - across : across) / Math.abs(ahead.x))
    if (Math.abs(ahead.z) > 0.001) room = Math.min(room, (ahead.z > 0 ? 1 - along : along) / Math.abs(ahead.z))

    return room
  }

  /**
   * Whether the square ahead is reached by dropping into a hole rather than by walking to it.
   *
   * **A hole one square wide only swallows an agent that is over it.** The agent is 0.6 wide in a
   * block of space, so there is a fifth of a block either side where nothing is under it - and any
   * speed at all crosses that in a tick or two, which lands it on the far lip instead. From there
   * the square it wants is behind it, so it turns round, comes back at the same speed and misses
   * again: measured, eight seconds of pacing across a shaft it was standing beside the whole time.
   *
   * So a drop is a square to stop in, exactly like the one a tower is built from - held back from a
   * sprint, and braked into rather than coasted at. Crouching is *not* part of the answer, however
   * much this looks like every other alignment problem in this file: sneaking is what stops an agent
   * walking off a ledge, and a ledge is the thing it is trying to walk off.
   *
   * Two blocks down rather than one, because a single step down is walked off the edge like any
   * other step and every ordinary descent is made of those. On the ground, because once it is
   * falling there is nothing left to decide.
   */
  private plunging(step: Walk, at: { y: number }): boolean {
    if (this.bot.entity?.onGround !== true) return false
    return step.y < Math.floor(at.y) - 1
  }

  /**
   * Walks the agent back to the middle of the square it is standing on, for room to jump from.
   *
   * Answers whether it is doing that, so a caller can say so and leave it to get on with it. On
   * the middle already, there is nothing to buy and the answer is no.
   *
   * It cannot walk the agent off anything: the target is the middle of the square it is already
   * standing in, and {@link centre} stops it there rather than letting it coast past.
   */
  private roomBehind(at: { x: number; y: number; z: number }): boolean {
    const middle = { x: Math.floor(at.x) + 0.5, z: Math.floor(at.z) + 0.5 }
    const off = Math.hypot(middle.x - at.x, middle.z - at.z)

    if (off <= OFF_CENTRE) return false

    return this.centre(middle.x - at.x, middle.z - at.z)
  }

  /** Whether carrying on at this speed would take the agent past the square it is heading for. */
  private overshooting(step: Walk, at: { x: number; y: number; z: number }): boolean {
    const moving = this.bot.entity?.velocity
    if (!moving) return false

    const speed = Math.hypot(moving.x, moving.z)
    if (speed <= BRAKING) return false

    const stood = standsAt(step)
    return Math.hypot(stood.x - at.x, stood.z - at.z) < speed * STOPPING
  }

  /**
   * Stops, rather than letting go and coasting.
   *
   * **Releasing a key is not braking.** Minecraft sheds only four tenths of the speed a tick, so an
   * agent that stops by letting go of forward travels most of a block further - which is every
   * overshoot in this file: past the square it meant to pillar from, past the node it meant to turn
   * at, past the place it was sent to.
   *
   * So it presses the keys that oppose the way it is actually going. The velocity is resolved into
   * the agent's own frame - what is forward and what is sideways *to it* - and the opposite controls
   * are held. That is a counter-strafe, it is what a player does, and it stops inside a tick or two.
   *
   * **Without turning.** Facing the direction of travel to press back would be simpler and would
   * undo the one thing a tower needs, which is a heading that does not change. See
   * {@link WORTH_TURNING}.
   *
   * Answers whether it is still moving enough to be worth doing anything about.
   */
  private brake(): boolean {
    const bot = this.bot
    const moving = bot.entity?.velocity
    if (!moving) return false

    const speed = Math.hypot(moving.x, moving.z)

    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    bot.setControlState('sprint', false)

    if (speed <= SETTLED) return false

    // Below this, friction finishes the job faster than a counter-press, which would push it the
    // other way and start the whole thing again in reverse.
    if (speed <= BRAKING) return true

    const yaw = bot.entity.yaw
    const ahead = alongFacing(moving.x, moving.z, yaw)
    const beside = acrossFacing(moving.x, moving.z, yaw)

    if (Math.abs(ahead) > SETTLED) bot.setControlState(ahead > 0 ? 'back' : 'forward', true)
    if (Math.abs(beside) > SETTLED) bot.setControlState(beside > 0 ? 'left' : 'right', true)

    return true
  }

  /**
   * Backs onto the edge of the block a bridge is built off, crouched.
   *
   * Upstream's routine, kept because it is right and because dropping it is what had the agent
   * asking to place blocks into thin air. Backwards rather than forwards so the agent is looking at
   * the face it is about to build on, and crouched so that walking to the very edge of a block with
   * nothing beyond it does not simply walk off it.
   */
  private edging(laying: Placement, at: { x: number; y: number; z: number }): boolean {
    const bot = this.bot

    // **Crouched first, before anything else.** The agent walks up to a gap at full speed, and the
    // last of the distance to the edge is the part with nothing under it. Waiting until it is at the
    // edge to crouch is waiting until after it has walked off.
    bot.setControlState('sneak', true)

    const sideways = laying.dx !== 0
    const facing = sideways ? laying.dx : laying.dz
    const here = sideways ? at.x : at.z

    // How far across its own block the agent has got, in the direction the block is going.
    const across = here - Math.floor(here)
    const reached = facing > 0 ? across : 1 - across

    if (reached >= AT_EDGE) {
      bot.setControlState('back', false)
      return false
    }

    // Turned away from the gap and walking backwards into it, crouched. Backwards because the face
    // being built on is the one behind the agent once it is out there, and crouched because the
    // last of that distance is over nothing.
    const edge = new WorldVec(laying.x + laying.dx + 0.5, laying.y, laying.z + laying.dz + 0.5)

    // Turned away from the gap, looking down over the edge. Animated rather than snapped, which is
    // what an onlooker expects - and which is part of why bridging is still not right.
    bot.look(Math.atan2(-(at.x - edge.x), -(at.z - edge.z)), OVER_THE_EDGE)

    // **Let go of forward first.** Walking is what got the agent here, and `forward` and `back` held
    // together cancel exactly: the agent turns round, crouches, and then stands there apparently
    // thinking about it until something else gives up.
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
    bot.setControlState('back', true)
    return true
  }

  private reached(step: Walk, at: { x: number; y: number; z: number }): boolean {
    const stood = standsAt(step)

    /*
     * **A jump lands on the square or it does not, and anywhere on it counts.**
     *
     * Every other step is arrived at within a third of a block of the middle, which is what keeps
     * the agent on its line. A gap cleared by a hair does not meet that: the agent comes down on the
     * lip, half a block from the middle, and the step it has just finished is still the step it is
     * being asked about - so the parkour branch takes the jump again, from the edge this time, and
     * sails off the far side. Landing is the end of that move; where on the block is the next move's
     * problem, and it has a whole square to sort it out in.
     */
    if (step.parkour === true && this.bot.entity?.onGround === true) {
      const onIt = Math.floor(at.x) === step.x && Math.floor(at.z) === step.z
      if (onIt && Math.abs(stood.y - at.y) < HIGH) return true
    }

    if (Math.abs(stood.x - at.x) > NEAR || Math.abs(stood.z - at.z) > NEAR) return false
    if (Math.abs(stood.y - at.y) >= HIGH) return false

    // Going up: not there until it has landed. Level ground and drops are reached on the way.
    return stood.y <= at.y || this.bot.entity?.onGround === true
  }

  /**
   * Points the agent at the next square and decides how to get there.
   *
   * The decision is upstream's simulation, not ours: it runs the real physics forward to see whether
   * a straight run reaches the square, whether it needs a jump, and whether it can be sprinted. That
   * is exactly the kind of hard-won thing worth keeping, and it only ever reads the first square, so
   * it is handed one rather than the whole route.
   */
  private head(step: Walk): void {
    const how = this.decide(step)

    // After the decision, because the decision clears the side keys before asking the simulation
    // anything - and what it is asking is whether the agent can get there walking straight.
    this.holdTheLine()

    this.chose(step, how)
  }

  /**
   * Says what a jump over a gap was taken on, once per jump.
   *
   * Not rate limited like {@link chose}, because a jump is over in twelve ticks and the once a
   * second line lands in the middle of it or after it. What went wrong with a jump is always the
   * speed it left with against where the simulation said that would put it, and neither of those
   * is visible from anywhere else.
   */
  private launched(step: Walk, at: WorldVec, put: WorldVec | undefined, sprinting: boolean): void {
    const stood = standsAt(step)
    this.flying = Math.atan2(-(stood.x - at.x), -(stood.z - at.z))

    this.flight = {
      to: `${step.x} ${step.y} ${step.z}`,
      predicted: this.physics.traced?.([standsAt(step) as unknown as WorldVec], sprinting) ?? [],
      real: [],
    }

    const moving = this.bot.entity?.velocity

    log.debug(
      `Agent ${this.id} left the ground at ${at.x.toFixed(2)} ${at.y.toFixed(2)} ${at.z.toFixed(2)} ` +
        `for ${step.x} ${step.y} ${step.z}, ${sprinting ? 'sprinting' : 'walking'}, carrying ` +
        `${Math.hypot(moving?.x ?? 0, moving?.z ?? 0).toFixed(3)}, to come down at ` +
        (put ? `${put.x.toFixed(2)} ${put.z.toFixed(2)}` : 'somewhere it did not say'),
    )
  }

  /**
   * Says what it decided to do about the square ahead, at most once a second.
   *
   * **Because every guess about this has been wrong.** What the agent is *doing* is visible from
   * outside; which of the several ways it can refuse to move it took is not, and the difference
   * between "the simulation says no", "nothing was pressed" and "it is waiting for something" is the
   * whole question. Rate limited, because it is one line a tick otherwise.
   */
  private chose(step: Walk, how: string): void {
    const now = Date.now()
    if (now - this.narrated < NARRATE_MS) return
    this.narrated = now

    const at = this.bot.entity?.position
    const moving = this.bot.entity?.velocity

    log.debug(
      `Agent ${this.id} heading for ${step.x} ${step.y} ${step.z} from ` +
        `${at?.x.toFixed(2)} ${at?.y.toFixed(2)} ${at?.z.toFixed(2)}: ${how}, ` +
        `moving ${Math.hypot(moving?.x ?? 0, moving?.z ?? 0).toFixed(3)}, ` +
        `${this.bot.entity?.onGround ? 'on the ground' : 'airborne'}`,
    )
  }

  private decide(step: Walk): string {
    const bot = this.bot
    const at = bot.entity.position
    const stood = standsAt(step)
    const to = new WorldVec(stood.x, stood.y, stood.z)
    const aim = [to]

    const dx = to.x - at.x
    const dz = to.z - at.z

    /*
     * **Nothing to face, so nothing is faced.**
     *
     * Two ways a square gives no direction, and a tower hits both. It is the *same column* the agent
     * is already standing in, so there is no way to turn towards it - and aiming at its middle from
     * inside it means turning towards a point up to half a block away that moves as the agent does,
     * which is a heading that changes every tick. That is the spinning on top of a pillar: not one
     * bad angle, a new one every tick, and each one a turn that has to play out before mineflayer
     * will send a placement.
     *
     * The distance check on its own was not enough - half a block clears it easily.
     */
    /*
     * **Skipping the turn, not the move.**
     *
     * A square in the agent's own column gives no direction to face - see {@link WORTH_TURNING} - and
     * this used to answer that by leaving `head` altogether. Which also skipped the walking and the
     * jumping: a step straight up onto something already there got no controls at all, and the agent
     * stood under it doing nothing while the route waited for it to arrive.
     *
     * Only the heading is left alone. Everything below still runs.
     */
    /*
     * **A jump flies the heading it left on, and a walk re-aims every tick.**
     *
     * Re-aiming is right on the ground, where the agent is steering. In the air it is what
     * bends a jump into an arc - the bearing swings as the agent drifts off the line, and the
     * thrust swings with it - and {@link Jumping.flownAt} does not model an arc, because a
     * straight line is the jump worth choosing. Measured over one course, the straight jumps
     * bent a hundredth of a block off the line and the corners bent 0.09 to 0.32.
     */
    const column = Math.floor(at.x) === step.x && Math.floor(at.z) === step.z
    if (bot.entity.onGround === true) this.flying = undefined

    /*
     * **Swimming is not falling, and it is not a jump.**
     *
     * A swimmer is never on the ground, so every branch below took one for a body in the air: in its
     * own column it was "dropping onto its own square" and let go of everything - which in water is
     * sinking - and anywhere else it was a jump "left to finish", which never lands. Water is steered
     * like the ground it is not: towards the square, rising with jump held while the square is level
     * or above, and sinking with it let go while the square is below.
     *
     * **Sprinting, where sprinting is allowed**, which in water is swimming: about twice the speed of
     * paddling. See {@link SPRINT_SWIM} for the half of it the physics does not know about.
     */
    if (swimming(bot)) {
      this.flying = undefined
      const rising = to.y >= at.y - SURFACING

      if (column) {
        /*
         * **Straight up or down its own square has nothing to face.** Turning to the middle of the
         * square it is already in is a heading that moves as the agent does - a new one every tick -
         * and on a descent that alternated straight and across steps, it swung round to that middle
         * and back out again at every one. So it is slid back to the middle in its own frame, the way
         * a tower lines up, and the heading is left where the last square across put it.
         */
        this.centre(dx, dz)
      } else {
        if (Math.hypot(dx, dz) > WORTH_TURNING) bot.look(Math.atan2(-dx, -dz), 0)
        bot.setControlState('forward', true)
        bot.setControlState('back', false)
        bot.setControlState('left', false)
        bot.setControlState('right', false)
        bot.setControlState('sneak', false)
        bot.setControlState('sprint', this.rules().sprint)
      }

      // After lining up, which lets go of jump along with everything else.
      bot.setControlState('jump', rising)
      this.diving = !rising

      if (column) return rising ? 'swimming up its own square' : 'diving down its own square'
      return rising ? 'swimming there' : 'swimming down to it'
    }

    /*
     * **A drop straight down is not steered, because there is nowhere to steer it to.**
     *
     * Everything below this presses `forward` and re-aims the heading, and it runs *before* the
     * airborne gate further down - so it ran on every tick of a fall too. A jump wants that: the
     * gate argues, rightly, that `forward` and a fixed bearing are what the simulation held when
     * it chose the jump, so the flight has to keep holding them.
     *
     * A fall was never simulated and never chose anything. The agent steps off a ledge or digs
     * out from under itself, and from there the thrust is a guess held for the length of the
     * drop - air control is about 0.02 a tick, 0.026 sprinting, and nothing clears the sprint on
     * the way past, so whatever it was carrying when it left the ground it keeps all the way
     * down. Into a shaft the walls hide it; into open air it is a drop that does not land where
     * it was dropped, which is rare exactly because most of them are shafts.
     *
     * Only where the route wants the agent to come down on its own square: off-column the fall
     * genuinely has somewhere to be, and an ordinary step down keeps the momentum it walked off
     * with. {@link flying} tells the two apart - every takeoff sets it through {@link launched},
     * and a fall is the case where nothing did.
     */
    if (bot.entity.onGround !== true && this.flying === undefined && column) {
      bot.setControlState('forward', false)
      bot.setControlState('back', false)
      bot.setControlState('left', false)
      bot.setControlState('right', false)
      bot.setControlState('sprint', false)

      return 'dropping onto its own square, so nothing is held on the way down'
    }

    if (this.flying !== undefined) bot.look(this.flying, 0)
    else if (!column && Math.hypot(dx, dz) > WORTH_TURNING) bot.look(Math.atan2(-dx, -dz), 0)
    bot.setControlState('forward', true)
    bot.setControlState('jump', false)

    /*
     * **Standing up before asking whether it can get there.**
     *
     * The checks below run the real physics forward, and they start that simulation from the
     * controls the agent is holding *now* - crouch included. So a tick spent crouching makes the
     * next square look harder to reach, which is answered by crouching again: the agent settles into
     * shuffling on the spot, sneaking, never moving, while the simulation agrees with itself that
     * nothing is possible.
     *
     * The question these want answered is whether it can get there walking, so it asks as an agent
     * that is walking.
     */
    bot.setControlState('sneak', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)

    const sprint = this.rules().sprint

    /*
     * **Nothing is decided in the air. Everything below is about how to leave the ground.**
     *
     * The jump was chosen on {@link Simulation.lands}, which simulates one fixed set of controls
     * all the way to the landing. Every control changed after takeoff is a control that answer
     * did not have, and the agent then flies a different jump from the one it was given.
     *
     * Both branches below do exactly that from the air, and both were measured doing it:
     *
     * - `canStraightLine(aim, true)` is *true* mid-flight, because its two hundred ticks include
     *   landing and walking the rest - so it turned the sprint back on one tick after every walk
     *   jump. Over one course, all fifteen sprint jumps landed within 0.005 of the simulation and
     *   all seven walk jumps landed 0.29 to 1.43 blocks past it. The last of those was 0.42 past,
     *   which is one square past, which is the gap.
     * - The fallback at the bottom shuffles towards the middle of the agent's square, which
     *   presses `back` against the direction of travel. Measured: a jump that left at 0.203 for a
     *   square 3.8 blocks away was 1.3 blocks along at 0.034 half a second later, and fell 79.
     *
     * Nothing above can reach a square from the air anyway - the block the simulation would push
     * off is below the agent and receding - so there is no decision here to lose. `forward` is on
     * and the heading is aimed, from the top of this method, which is what the simulation held.
     */
    if (bot.entity.onGround !== true) return 'in the air, so the jump is left to finish'

    /*
     * **A gap is jumped from the ledge, never walked off it.**
     *
     * `canStraightLine` answers two questions with one yes: *walking gets you there*, and *walk a
     * few more ticks, then jump, and that gets you there*. Every branch below treats a yes as "run
     * at it" and none of them ever takes the jump the second answer is built on - which is fine over
     * ground, where the worst case is a late jump, and fatal at a gap, where the ticks the
     * simulation wanted to spend running are ticks of thin air. Measured from one: an agent reached
     * a three block gap at 0.11 a tick, kept running because a jump *later* would have worked, and
     * fell thirty blocks.
     *
     * So for a move upstream marks as parkour the jumps are asked first, and running is only allowed
     * while there is still block underfoot to run on. When there is not and no jump reaches, it
     * stops at the edge: a stall is a re-plan, and a re-plan is survivable.
     */
    // Already standing on the square this jump was for - see {@link reached}. Jumping again from
    // here is the second jump that carries it off the far edge.
    const onTheStep = Math.floor(at.x) === step.x && Math.floor(at.z) === step.z

    if (step.parkour === true && bot.entity.onGround && !onTheStep) {
      /*
       * **Pointed at it before leaving the ground.**
       *
       * The simulation that says a jump reaches puts its player on the bearing before the first
       * tick - `getController` assigns `state.yaw` outright. The agent cannot: `bot.look` animates,
       * so a jump decided while it is still turning takes off along the heading it had, and three
       * blocks later that is the edge of the block rather than the middle of it. Waiting costs the
       * ticks the turn takes and nothing else, because the turn was already under way.
       */
      const bearing = Math.atan2(-dx, -dz)
      if (Math.abs(turnLeft(bot.entity.yaw, bearing)) > FACING) {
        bot.setControlState('sprint', false)
        return 'turning to face the gap before jumping it'
      }

      /*
       * **The gentlest jump that comes down on the square, and no jump that does not.**
       *
       * Both halves matter and both were wrong. Asking {@link Simulation.lands} instead of
       * `canSprintJump` is what stops a jump being taken because its arc *passes over* the
       * landing block on the way somewhere else. Asking for the walk first is what stops the
       * agent using a sprint on a gap that does not need one: with the landing checked, a walk
       * that answers at all answers with a landing on the square, and it is the shorter of the
       * two arcs, so it is the one with room to spare on the far side.
       *
       * The sprint is let go of explicitly for the walked one. It used not to be, and a run-up
       * that had just set it left it set: the simulation was asked about a walk jump and the
       * agent then performed a sprint jump, which is most of a block further than the answer it
       * was given.
       */
      /*
       * **The height is half of what a landing is, and leaving it out was fatal.**
       *
       * A gap has a floor a long way down, and that floor is directly beneath the square being
       * jumped to. Comparing only the column therefore calls the bottom of the pit a landing on
       * the block above it, and the jump gets taken *because* the simulation predicted a fall.
       *
       * Recorded tick by tick from the jump this was found on: the simulation had the agent
       * hitting the block's near face at z -1213630.700, dropping thirty six blocks, and coming
       * to rest at y 107 - and its x and z floored to the target square exactly as a good
       * landing would. The agent then flew that trajectory to the tenth of a block.
       *
       * Upstream's own tolerance for arriving is a block of height, so that is the one used.
       */
      /*
       * **Landing on the level, rather than landing on the square.**
       *
       * The height is the half of this that earns its keep: the jump that took an agent down a
       * thirty six block hole came back with `y 107` against a target of `y 143`, and a landing
       * that is not at the route's own level is a fall however tidy its column looks.
       *
       * Insisting on the *column* as well is what deadlocked a two block gap. Recorded from one:
       * aiming at -1213613.50, a walk came down at -1213612.94 and a run at -1213614.36 - both
       * on solid ground at y 143, straddling the one block square between them. Neither was
       * allowed, nothing else reaches, and the agent stood on the ledge re-planning.
       *
       * **So a square the route goes to, rather than the one square it was aimed at.**
       * {@link caughtUp} carries a journey on from whatever square the agent actually came down
       * on - but only where there is a route to carry on from. Accepting any landing at the right
       * height instead is a jump into the dark, and it went there immediately: a landing one
       * square past the last step of a run, at the right height, on nothing. The agent braked to
       * a stand at -1213610.695 with its box reaching -1213610.995, five thousandths past the
       * edge of the block, and dropped eighty seven.
       */
      const going = new Set([step, ...this.ahead].map((one) => `${one.x},${one.z}`))

      const onTheRoute = (put: WorldVec | undefined): put is WorldVec =>
        put !== undefined &&
        Math.abs(put.y - to.y) < 1 &&
        going.has(`${Math.floor(put.x)},${Math.floor(put.z)}`)

      const wide = (put: WorldVec) => Math.hypot(put.x - to.x, put.z - to.z)

      const walked = this.physics.lands(aim, false)
      const run = sprint ? this.physics.lands(aim, true) : undefined

      // The gentler one unless the run genuinely lands closer, which is the old preference with
      // the column requirement taken out of it.
      if (onTheRoute(walked) && (!onTheRoute(run) || wide(walked) <= wide(run))) {
        bot.setControlState('jump', true)
        bot.setControlState('sprint', false)
        this.launched(step, at, walked, false)
        return 'jumping the gap'
      }

      if (onTheRoute(run)) {
        bot.setControlState('jump', true)
        bot.setControlState('sprint', true)
        this.launched(step, at, run, true)
        return 'sprint jumping the gap'
      }

      const room = this.roomToRun(at)
      if (room <= ROOM_TO_RUN) {
        /*
         * **Room is bought by backing up, not waited for.**
         *
         * Standing on the lip is the worst place to jump from and the only place this used to be
         * able to do it from: the gap is measured from where the agent is, so a takeoff at the
         * edge is a longer jump than the same one from the middle, with no ground left to build
         * speed on. Reported from a course, an agent braked onto an edge and then refused the way
         * it had just come - a shorter jump than the one that put it there - and stood until it
         * was told to stop.
         *
         * A block is a block wide, so the middle of its own square is always available and is
         * always further from the gap. {@link centre} walks it there and stops it there, which is
         * both the run-up and the aim.
         */
        if (this.roomBehind(at)) return `backing off the edge of a gap for room to jump it`

        this.brake()
        return `at the edge of a gap it cannot jump yet, so stopping (${room.toFixed(2)} of block left)`
      }

      if (sprint && this.physics.canStraightLine(aim, true)) {
        bot.setControlState('sprint', true)
        return `running up to the gap (${room.toFixed(2)} of block left)`
      }

      /*
       * **A gap answers for itself, and does not fall through to the ladder below.**
       *
       * Everything after this block asks upstream whether a jump *reaches*, and reaching is
       * satisfied by an arc that crosses the square on its way past - see {@link Jumping}. So a
       * jump refused up here for coming down in the void was picked up four branches later and
       * taken anyway, which made the landing check worth nothing at the only square it is for.
       *
       * Holding the block is the honest answer instead: the stall clock re-plans in three seconds
       * with the agent still on it, and a re-plan from a block is a route. A re-plan from the
       * bottom of the drop is a walk back.
       */
      // Nothing reaches from here, and here is a choice: see {@link roomBehind}.
      if (this.roomBehind(at)) return `backing off a gap nothing reaches, for room to try again`

      /*
       * **Nothing reaches, and nothing is left to buy, so it is the route that is wrong.**
       *
       * Holding the block was the honest answer while the stall clock was the only thing that
       * could re-plan, and it cost three and a half seconds of an agent standing still every
       * time. The clock is for an agent that has stopped getting anywhere without knowing why;
       * this one knows exactly why, and has already checked the two things that could fix it -
       * a walk, a run, and the room to back up for either.
       *
       * Recorded from a head: upstream offers a parkour jump onto anything `physical`, which
       * reads `boundingBox` and so counts a player head as a full cube, and it files the node
       * a whole block above it. The real surface is half that, so the simulation lands the
       * agent short of the square the route means, every time, from a pillar with no run-up.
       * No amount of standing there changes the answer.
       *
       * **Once per square.** The search may hand back the same route - it priced that jump on
       * the same bad block - and re-planning on every tick of it is how an agent does nothing
       * at all very expensively. One go, then the block is held as before and the clock has it.
       */
      const here = `${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}`

      if (this.stranded !== here) {
        this.stranded = here
        this.brake()
        this.plan()

        return `nothing lands on the far side of this gap, so planning again from the block`
      }

      this.brake()
      const said = (put: WorldVec | undefined) =>
        put ? `${put.x.toFixed(2)} ${put.y.toFixed(2)} ${put.z.toFixed(2)}` : 'nowhere'

      return (
        `at a gap nothing lands on the far side of, so holding the block (${room.toFixed(2)} left, ` +
        `aiming ${to.x.toFixed(2)} ${to.y.toFixed(2)} ${to.z.toFixed(2)}, ` +
        `a walk puts it at ${said(walked)}, a run at ${said(run)})`
      )
    }

    /*
     * **Not running *into* a square it has to stop in - but still jumping to reach one.**
     *
     * Sprinting is held back on the approach to a rung so the agent is not carrying a sprint's worth
     * of momentum into the square it has to pillar out of. That belongs on the *run*, and it was
     * applied to the jump as well - so a gap that only a sprint jump clears became uncrossable purely
     * because a tower happened to start on the far side of it. The agent stood at the edge shuffling
     * while every option it was allowed to consider said no.
     *
     * A sprint jump that is needed is needed. What it lands with is a problem for the brake, which
     * is what the brake is for.
     */
    if (sprint && !this.arriving && this.physics.canStraightLine(aim, true)) {
      bot.setControlState('sprint', true)
      return 'running straight there'
    }

    if (this.physics.canStraightLine(aim)) {
      bot.setControlState('sprint', false)
      return 'walking straight there'
    }

    /*
     * **Every jump waits for the turn, not only the ones over a gap.**
     *
     * The parkour branch above has had this since a jump taken mid-rotation left along the old
     * heading and clipped the far block. Nothing below it did, and everything below it jumps
     * too - a step up, a hop, a sprint jump onto the next square - so a route that turns a corner
     * onto a step took that step while still coming round. Measured on the course, all twenty
     * nine gap jumps left within 0.005 of a radian of their bearing and the ones through here
     * were not measured at all, because only a gap says it left the ground.
     *
     * The simulations below have the same blind spot the parkour ones did: upstream's controller
     * snaps its player onto the bearing before the first tick, so every one of them answers about
     * a jump taken by an agent that is already pointed the right way.
     *
     * Only the jumps wait. Walking and running are steering, and steering while turning is what
     * turning is for - both branches above are left alone.
     */
    if (!column && Math.abs(turnLeft(bot.entity.yaw, Math.atan2(-dx, -dz))) > FACING) {
      bot.setControlState('sprint', false)
      return 'turning to face the square before jumping to it'
    }

    /*
     * **The gentlest jump that reaches - into a square the agent has to land softly in.**
     *
     * Upstream asks whether a sprint jump would work before it asks whether a walk would, so every
     * step up and every one block gap gets taken at a run, and a sprint jump carries far enough past
     * a one block hop to land beyond the square it was aimed at. Where the agent has to stop - a
     * rung it must pillar from, a hole it has to drop into, the end of the journey - landing where
     * it meant to is worth more than the tick it saves.
     */
    if (this.arriving && this.physics.canWalkJump(aim)) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', false)
      this.launched(step, at, this.physics.lands(aim, false), false)
      return 'jumping there, softly, because it has to stop'
    }


    /*
     * **The sprint is kept only where the route is about to need it.**
     *
     * Both halves of this have been got wrong in turn. Preferring the gentle jump everywhere makes a
     * staircase cost the agent its momentum - each step up lets go of the sprint, and a flight of
     * them arrives at the top at 0.14 a tick where a sprint is 0.28, with nothing left to run at the
     * gap with. Preferring the sprint everywhere lands it a block past a two block hop, which is off
     * the far side of the block it aimed at.
     *
     * So the question is not which jump is nicer, it is whether anything after this square needs the
     * speed. Upstream marks the moves that do - see {@link Walk.parkour} - and only those.
     */
    if (sprint && this.hurrying && this.physics.canSprintJump(aim)) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', true)
      this.launched(step, at, this.physics.lands(aim, true), true)
      return 'sprint jumping there, because a run-up is coming'
    }

    // Nothing ahead needs the speed, so take the jump that lands where it was aimed.
    if (this.physics.canWalkJump(aim)) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', false)
      this.launched(step, at, this.physics.lands(aim, false), false)
      return 'jumping there'
    }

    // A gap a walk will not clear. The sprint is not a choice here, it is the only thing that
    // reaches - and what it lands with is the brake's problem.
    if (sprint && this.physics.canSprintJump(aim)) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', true)
      this.launched(step, at, this.physics.lands(aim, true), true)
      return 'sprint jumping there'
    }

    /*
     * **The run-up, tried last rather than not at all.**
     *
     * A gap of several blocks is not cleared from standing, however hard the agent jumps. What
     * clears it is a few ticks of running and *then* a jump - and upstream only offers that inside
     * the sprinting straight-line check, which is the very thing held back when a tower starts on
     * the landing square.
     *
     * So the agent stood at the edge of a four block gap, centred, still, with the only move that
     * would work ruled out for a reason that applies to what happens *after* it lands. Arriving fast
     * somewhere it then has to stop is the brake's problem, and the brake is good at it now. Not
     * arriving at all is nobody's.
     *
     * Still last, so that on every ordinary approach the walk is preferred and the agent does not
     * come into a rung at a sprint.
     */
    if (sprint && this.arriving && this.physics.canStraightLine(aim, true)) {
      bot.setControlState('sprint', true)
      return 'running at it, because nothing slower reaches'
    }

    /*
     * **Nothing the simulation will accept from here - so move, rather than stop.**
     *
     * Every branch above asks whether the next square can be reached *from where the agent is
     * standing*, and the usual reason the answer is no is that it is standing on the lip of the
     * block it just landed on. A jump that overshoots leaves it half a block off, and from there the
     * simulation refuses the next one - especially a turn, where the run-up is across the corner
     * rather than along an edge.
     *
     * Letting go of the controls there is the worst thing available: standing still does not change
     * the position it is objecting to, so the answer stays no, the stall timer re-plans, the same
     * route comes back and the agent freezes again. Backing into the middle of its own square gives
     * the next attempt its run-up, which is what a person does when they clip a jump.
     */
    const middle = { x: Math.floor(at.x) + 0.5, z: Math.floor(at.z) + 0.5 }
    const off = Math.hypot(middle.x - at.x, middle.z - at.z)

    if (off > OFF_CENTRE) {
      this.centre(middle.x - at.x, middle.z - at.z)
      return `nothing reachable, backing to the middle of its square (${off.toFixed(2)} off)`
    }

    // Centred and still refused. Now it really is stuck, and the stall timer is the right answer.
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
    return 'nothing reachable, and centred already - stuck'
  }

  /**
   * Records a tick spent getting ready to lay a block, for {@link settled} to print.
   *
   * Diagnostic, and the same trick the flight recorder plays. {@link composing} can hold a step
   * up for seconds at a time - walking to the middle of a column, braking, waiting for the drift
   * to die - and the once a second narration says only that the agent is standing still, which is
   * exactly as much as it said about a jump before the flights were played back tick by tick.
   */
  private holding(step: Walk, at: { x: number; y: number; z: number }): void {
    const laying = step.toPlace[0]
    if (!laying) return

    const going = { x: laying.x + laying.dx, y: laying.y + laying.dy, z: laying.z + laying.dz }
    const held = HELD.filter((name) => {
      try {
        return this.bot.getControlState(name)
      } catch {
        return false
      }
    })
      .map((name) => name[0])
      .join('')

    const moving = this.bot.entity?.velocity

    this.rung ??= { at: `${going.x} ${going.y} ${going.z}`, frames: [] }
    if (this.rung.frames.length >= RUNG_TICKS) return

    this.rung.frames.push({
      x: at.x,
      y: at.y,
      z: at.z,
      speed: Math.hypot(moving?.x ?? 0, moving?.z ?? 0),
      onGround: this.bot.entity?.onGround === true,
      held,
      off: Math.hypot(going.x + 0.5 - at.x, going.z + 0.5 - at.z),
    })
  }

  /** Prints what a block cost to get into position for, once it is finally being laid. */
  private settled(step: Walk): void {
    const waited = this.rung
    this.rung = undefined

    if (!waited || waited.frames.length === 0) return

    const lines = waited.frames.map(
      (was, tick) =>
        `  ${String(tick).padStart(3)} ${was.x.toFixed(3)} ${was.y.toFixed(3)} ${was.z.toFixed(3)} ` +
        `${was.speed.toFixed(3)} ${(was.off ?? 0).toFixed(3)} ` +
        `${was.onGround ? 'gnd' : 'air'} ${was.held ?? ''}`,
    )

    log.debug(
      `Agent ${this.id} spent ${waited.frames.length} ticks getting into ${waited.at} to lay in it:\n` +
        `    t x y z speed off ground held\n` +
        lines.join('\n'),
    )
  }

  /** Starts the next piece of work on the square ahead. Breaking comes before laying. */
  private begin(step: Walk): void {
    this.still()

    const era = this.era

    const breaking = step.toBreak[0]
    if (breaking) {
      const at = new WorldVec(breaking.x, breaking.y, breaking.z)
      this.job = { era, what: 'breaking', at, since: Date.now(), patience: this.longEnough(at) }
      void this.settle(
        this.hands.add({
          name: 'breaking a block on the way',
          rank: RANK.BUILD,
          run: (signal) => this.break(at, era, signal),
        }),
        era,
        step,
        'toBreak',
      )
      return
    }

    const laying = step.toPlace[0]
    if (!laying) return

    const at = new WorldVec(laying.x + laying.dx, laying.y + laying.dy, laying.z + laying.dz)
    this.job = { era, what: 'laying', at, since: Date.now(), patience: JOB_MS }
    void this.settle(
      this.hands.add({
        name: 'laying a block on the way',
        rank: RANK.BUILD,
        run: (signal) => this.place(laying, era, signal),
      }),
      era,
      step,
      'toPlace',
    )
  }

  /**
   * Sees a piece of work through, and decides what its outcome means.
   *
   * **The one place a job's result is allowed to touch the world it came back to.** A job that
   * outlived its stretch changes nothing at all: not the route, not the controls, not the stall
   * clock. That is the whole of the fix for an agent walking one way and building another.
   */
  private async settle(work: Promise<void>, era: number, step: Walk, kind: 'toBreak' | 'toPlace'): Promise<void> {
    let failed: string | undefined

    try {
      await work
    } catch (err) {
      failed = (err as Error).message
    }

    if (this.era !== era) {
      log.debug(`Agent ${this.id} dropped a job it began for a stretch that is gone`)
      return
    }

    const done = this.job
    this.job = undefined

    if (failed !== undefined) {
      log.debug(`Agent ${this.id} could not finish ${done?.what ?? 'a job'}: ${failed}`)

      if (++this.failures >= GIVING_UP) {
        this.give(`it could not ${done?.what === 'breaking' ? 'break' : 'place'} a block on the way`)
        return
      }

      this.plan()
      return
    }

    // Ours, and nobody else is holding it. The stretch's `planned` set is left alone: it has to go
    // on remembering this block, so the update announcing it does not read as news.
    ;(step[kind] as unknown[]).shift()
    this.movedAt = Date.now()
    this.failures = 0

    // Remembered past the stretch that asked for it, so a re-plan cannot forget whose block it is.
    if (done) this.mine.set(`${done.at.x},${done.at.y},${done.at.z}`, Date.now() + MINE_MS)

    // One block fewer to do. Cheap to say: the journey layer holds this and sends at most one a
    // second, so a redraw per block laid costs nothing and keeps what is drawn true.
    this.draw()
  }

  /** Lays one block. */
  private async place(spot: Placement, era: number, signal: AbortSignal): Promise<void> {
    const bot = this.bot

    const reference = bot.blockAt(new WorldVec(spot.x, spot.y, spot.z))
    if (!reference) throw new Error('there is nothing there to build against')

    if (spot.useOne) {
      await bot.activateBlock(reference)
      return
    }

    const item = this.rules().movements.getScaffoldingItem()
    if (!item) throw new Error('it has nothing left to build with')

    // **Jumping starts before equipping, not after.** The arc takes ticks and equipping does not, so
    // holding it first means the window to place is already opening by the time there is something in
    // hand - which is what a player does, and why a player's tower goes up at one block a jump.
    if (spot.jump) bot.setControlState('jump', true)

    // **Both reasons to jump, not one.** Standing in the square the block goes in is one - the gate
    // in `bot.ts` holds the jump for that, because it is the thing that can see it. A move that means
    // to land on the block it is placing is the other, and there the agent is *beside* the square
    // rather than in it, so the gate lets it straight through and nothing lifts it to where the face
    // it must build against is reachable. That is the placement that goes out from one block over
    // and comes back refused.
    if (spot.jump) bot.setControlState('jump', true)

    // Crouched for a block laid off the side of the one underfoot, so that turning to face it does
    // not walk the agent off the edge it is standing on.
    if (spot.dy === 0) bot.setControlState('sneak', true)

    await bot.equip(item, 'hand')

    // **The seam upstream could not reach.** Equipping is asynchronous, and the stretch can be
    // replaced while it runs. Checked here, at the last moment before the request goes out, so a
    // placement whose route is gone is never sent rather than being sent at coordinates nobody is
    // walking towards.
    if (this.era !== era) throw new Error('the route that asked for this is gone')

    // Something that matters more wants the hands. The block is not laid, so there is nothing to
    // undo: the queue puts this back and it starts again with the jump held from the top.
    if (signal.aborted) throw new Error('put down for something that matters more')

    const face = new WorldVec(spot.dx, spot.dy, spot.dz)

    try {
      // **Keep asking.** The gate in `bot.ts` holds each request until the agent's own box is out of
      // the square the block goes in, and sends it the instant it is - but a jump only offers that
      // window for a few ticks, and a server that refuses one closes it. Missing it is a reason to
      // jump again, not a reason to throw away the tower and think about the route afresh.
      for (let go = 1; ; go++) {
        try {
          await bot.placeBlock(reference, face)
          return
        } catch (err) {
          if (this.era !== era) throw new Error('the route that asked for this is gone')
          if (go >= ATTEMPTS) throw err

          // A refusal drops the agent back down, and asking again from there aims at a block it can
          // no longer touch. Better to hand the route back than to spend a jump on a placement the
          // server was always going to refuse.
          if (!this.withinArmsLength(reference.position)) {
            throw new Error('it is too far from the block it was building against')
          }

          log.debug(`Agent ${this.id} did not get to place at ${spot.x} ${spot.y} ${spot.z}, going round again`)
          // The jump is still held, so the next window is already on its way.
        }
      }
    } finally {
      bot.setControlState('jump', false)
      bot.setControlState('sneak', false)
    }
  }

  /** Whether the agent could actually touch that block from where it is standing. */
  private withinArmsLength(at: WorldVec): boolean {
    const eyes = this.bot.entity?.position
    if (!eyes) return false

    const dx = at.x + 0.5 - eyes.x
    const dy = at.y + 0.5 - (eyes.y + (this.bot.entity.height ?? 1.62))
    const dz = at.z + 0.5 - eyes.z

    return Math.hypot(dx, dy, dz) <= ARMS_LENGTH
  }

  /** Breaks one block, with the best thing the agent is carrying for it. */
  private async break(at: WorldVec, era: number, signal: AbortSignal): Promise<void> {
    const bot = this.bot

    const block = bot.blockAt(at)
    if (!block) throw new Error('there is nothing there to break')

    const tool = await reachFor(bot, block, this.id)
    log.debug(`Agent ${this.id} is breaking ${block.name} with ${tool?.name ?? 'its hands'}`)

    // The same seam as laying: equipping is asynchronous and the stretch can be replaced while it
    // runs, and a dig sent into a route nobody is walking is a hole somebody has to fill in.
    if (this.era !== era) throw new Error('the route that asked for this is gone')
    if (signal.aborted) throw new Error('put down for something that matters more')

    await bot.dig(block, true)
  }

  /** A job is running. The only question is whether it is still running or merely hung. */
  /** How long the block at this square is worth waiting for, by the agent's own arithmetic. */
  private longEnough(at: WorldVec): number {
    const block = this.bot.blockAt(at)
    if (!block) return JOB_MS

    try {
      const takes = this.bot.digTime(block)
      return Number.isFinite(takes) ? Math.max(JOB_MS, takes * DIG_SLACK) : JOB_MS
    } catch {
      // The same arithmetic that fails on unreadable enchantments. A guess is not worth a stall.
      return JOB_MS
    }
  }

  private mind(job: Job): void {
    if (Date.now() - job.since < job.patience) return

    log.warn(`Agent ${this.id} gave up on ${job.what} at ${job.at.x} ${job.at.y} ${job.at.z}`)

    // Dropped rather than cancelled: the request is with the server and cannot be recalled. Moving
    // the era on is what makes its answer, whenever it comes, land on nobody.
    this.job = undefined
    this.plan()
  }

  /**
   * Something in the world changed.
   *
   * Two questions, in order, and most changes fail the first: **was this us**, and **does it touch
   * the route at all**. Only what survives both costs a search, and then only of the one stretch it
   * landed in.
   */
  private changed(before: unknown, after: unknown): void {
    if (!this.goal || this.sections.length === 0) return

    const was = before as { position?: WorldVec; type?: number } | null
    const now = after as { type?: number } | null
    if (!was?.position || !now || was.type === now.type) return

    const at = was.position
    const key = `${at.x},${at.y},${at.z}`

    // A block the route means to lay or break. The plan working is not news about the world.
    for (const section of this.sections) if (section.planned.has(key)) return

    // Or one it already did, however many times the route has been re-planned since.
    const until = this.mine.get(key)
    if (until !== undefined) {
      if (until > Date.now()) return
      this.mine.delete(key)
    }

    const index = this.sections.findIndex((section) => beside(section.steps, at))
    if (index < 0) return

    this.mendFrom(index, at)
  }

  /** Thinks one stretch through again, between the two ends it already has. */
  private mendFrom(index: number, at: { x: number; y: number; z: number }): void {
    const section = this.sections[index]
    if (!section || !this.bot.entity) return

    // Already thinking about the whole journey; that answer covers this one.
    if (this.plotting) return

    // Two stretches disturbed at once is a world changing faster than mending keeps up with, and the
    // honest answer to that is one search rather than a queue of them.
    if (this.mending && this.mending.index !== index) {
      log.debug(`Agent ${this.id} had a second stretch change while mending one, so it is planning again`)
      this.plan()
      return
    }

    if (this.mending) return

    const { movements, reach, slice, budget, lean } = this.rules()

    // From where the agent stands for the stretch under its feet, and from the end of the one before
    // for any other - so what comes back joins onto what is already being walked.
    const from = index === 0 ? standingAt(this.bot, movements) : this.sections[index - 1]?.end
    if (!from) return

    log.debug(
      `Agent ${this.id} is thinking again about stretch ${index + 1} of ${this.sections.length}: ` +
        `the world changed at ${at.x} ${at.y} ${at.z}`,
    )

    section.settled = false

    this.mending = {
      index,
      search: new Search(from, walkingFrom(movements), within(section.end.x, section.end.y, section.end.z, 0.5, lean), {
        budget,
        slice,
        reach,
        measured: MEASURED,
      }),
    }
  }

  /**
   * Whether the agent has stopped getting anywhere.
   *
   * **Ahead of the work rather than after it**, which is the whole difference from upstream's. Its
   * timer sat below the early returns of the digging and placing branches, so the one stall it
   * needed to catch - a placement the server never answered - was the one stall it structurally
   * could not see.
   */
  private futility(): void {
    if (Date.now() - this.movedAt < STUCK_MS) return

    log.warn(`Agent ${this.id} stopped making progress and is planning again`)
    this.report.stalled()
    this.plan()
  }

  /**
   * The route ran out, which is only sometimes arriving.
   *
   * A route that reached the goal ends the journey. One that stopped short ends nothing: it is where
   * the next search starts, and {@link think} either waits for the one already in flight or starts
   * one from here.
   */
  private finished(): void {
    if (!this.short) {
      this.done()
      return
    }

    log.debug(`Agent ${this.id} walked to the end of a route that stops short, and is looking further`)
    this.movedAt = Date.now()
    this.still()
  }

  private done(): void {
    this.clear()
    this.still()
    this.report.arrived()
  }

  private give(why: string): void {
    this.clear()
    this.still()
    this.report.lost(why)
  }

  private clear(): void {
    this.goal = undefined
    this.plotting = undefined
    this.mending = undefined
    this.extending = undefined
    this.short = false
    this.grown = undefined
    this.sections = []
    this.job = undefined
    this.mine.clear()
    this.era++
  }

  private still(): void {
    try {
      this.bot.clearControlStates()
    } catch {
      // The agent may already be gone, in which case there is nothing left to let go of.
    }
  }
}

/** One stretch, with the blocks it means to change worked out once and kept. */
function sectionOf(steps: Walk[], end: Walk, settled: boolean): Section {
  const planned = new Set<string>()

  for (const step of steps) {
    for (const spot of step.toPlace) planned.add(`${spot.x + spot.dx},${spot.y + spot.dy},${spot.z + spot.dz}`)
    for (const spot of step.toBreak) planned.add(`${spot.x},${spot.y},${spot.z}`)
  }

  return { steps, end, settled, planned }
}

/** Whether a square is close enough to a stretch to matter to it. */
function beside(steps: readonly Walk[], at: { x: number; y: number; z: number }): boolean {
  return steps.some(
    (step) =>
      Math.abs(step.x - at.x) <= BESIDE && Math.abs(step.y - at.y) <= ABOVE && Math.abs(step.z - at.z) <= BESIDE,
  )
}


/**
 * Takes back any part of a route that would break the ground it later walks on.
 *
 * **The search thinks the world holds still.** It works out what to break from the world as it is
 * *now*, for every square it considers, and nothing tells it that an earlier step of the same route
 * already took that block away. Upstream has the same hole. What comes out is a plan that digs
 * through a floor and then, twenty steps later, expects to stand on it - and the agent does exactly
 * that, falls, and the whole route is re-planned from wherever it lands.
 *
 * Fixing it properly means giving the search a world that changes as it explores, which is a real
 * piece of work and costs something on every square considered. This is the cheap half of it, and
 * it is the half that matters: a block the route means to stand on is not a block the route may
 * break, so that break is dropped. Nothing else about the step changes. If the block genuinely was
 * in the way, that step fails on its own and the ordinary machinery plans again - which is a far
 * better outcome than digging away the floor and finding out by falling through it.
 */
export function keepWhatItStandsOn(steps: Walk[], id: number): void {
  if (steps.length === 0) return

  /*
   * **A square the route walks into is one the agent is inside**, not one it stands on: digging
   * straight down makes the block under one step the position of the next. Its support is a block
   * lower, and that block is protected on its own account. Read as ground, every break below the
   * first is a square some step means to stand on, and all of them were dropped - measured,
   * thirteen at once. What was left dug one block and walked into solid rock.
   */
  const walkedInto = new Set(steps.map((step) => `${step.x},${step.y},${step.z}`))

  /*
   * **Later, and only later.**
   *
   * A square is ground for the steps that come *after* it is stood on, not for the whole route.
   * A drop clears several blocks at once, so the step breaking them is a long way below the step
   * that was standing on top of them - and read without an order, that is a route digging away
   * its own floor.
   *
   * Measured on a descent: the break at y 158 was wanted by the step at y 156 and dropped because
   * the step at y 159 had stood on it, three blocks back. The route ran out of breaks before it
   * ran out of squares, so the agent was asked to reach a step through solid ground and stood
   * there until the clock re-planned and found the break again.
   *
   * Walked backwards for that reason: what a step may not break is whatever the squares behind it
   * in this loop - ahead of it on the route - still need to be solid, its own floor included.
   */
  const later = new Set<string>()
  let taken = 0
  const gone: string[] = []

  for (let at = steps.length - 1; at >= 0; at--) {
    const step = steps[at]!
    const under = `${step.x},${step.y - 1},${step.z}`

    if (!walkedInto.has(under)) later.add(under)

    /*
     * **Unless the route puts one back.** A tower clears the block two above its head to have room
     * to jump, and the next rung stands at exactly that height - on a block this same route lays
     * there a moment later. Breaking and then rebuilding a square is not a route destroying its
     * own floor, it is how pillaring through a ceiling works, and treating it as the former left
     * the agent under a block it was never allowed to remove, unable to clear its own square.
     */
    for (const spot of step.toPlace) {
      later.delete(`${spot.x + spot.dx},${spot.y + spot.dy},${spot.z + spot.dz}`)
    }

    if (step.toBreak.length === 0) continue

    const keeping = step.toBreak.filter((spot) => !later.has(`${spot.x},${spot.y},${spot.z}`))
    if (keeping.length === step.toBreak.length) continue

    for (const spot of step.toBreak) {
      if (!later.has(`${spot.x},${spot.y},${spot.z}`)) continue

      gone.push(`${spot.x} ${spot.y} ${spot.z}, wanted by the step at ${step.x} ${step.y} ${step.z}`)
    }

    taken += step.toBreak.length - keeping.length
    // The arrays are the search's own and nobody else holds them.
    ;(step.toBreak as unknown[]).length = 0
    ;(step.toBreak as unknown[]).push(...keeping)
  }

  if (taken > 0) {
    log.debug(
      `Agent ${id} dropped ${taken} break(s) from its route: a later step stands on them - ` +
        gone.join('; '),
    )
  }
}

/**
 * How much of a direction is straight ahead of the agent.
 *
 * Facing is `(-sin yaw, -cos yaw)`, which is mineflayer's convention and prismarine-physics' too.
 */
/** How far one heading is from another, in radians, the short way round. */
function turnLeft(from: number, to: number): number {
  let turn = (to - from) % (Math.PI * 2)
  if (turn > Math.PI) turn -= Math.PI * 2
  if (turn < -Math.PI) turn += Math.PI * 2
  return turn
}

function alongFacing(x: number, z: number, yaw: number): number {
  return x * -Math.sin(yaw) + z * -Math.cos(yaw)
}

/**
 * How much of a direction is off the agent's right shoulder.
 *
 * **Facing turned a quarter to the right, which is `(cos yaw, -sin yaw)`** - and having that
 * backwards is not a subtle failure. Every sideways correction then pushes the way it was trying to
 * get away from: a shuffle towards the middle of a square oscillates around it for ever, half a
 * block out and never closing, and a brake across the direction of travel speeds it up.
 *
 * Checked at yaw zero, where the agent faces north - `(0, -1)` - and its right hand points east.
 * This answers `(1, 0)`, which is east.
 */
function acrossFacing(x: number, z: number, yaw: number): number {
  return x * Math.cos(yaw) + z * -Math.sin(yaw)
}
