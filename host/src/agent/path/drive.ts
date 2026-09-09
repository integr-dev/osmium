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
import { type Goal, Search } from './search.ts'

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
export interface Simulation {
  canStraightLine(aim: readonly WorldVec[], sprint?: boolean): boolean
  canSprintJump(aim: readonly WorldVec[], after?: number): boolean
  canWalkJump(aim: readonly WorldVec[], after?: number): boolean
}

const Physics = untypedPhysics as unknown as new (bot: Bot) => Simulation

/** What the driver tells whoever asked for the journey. */
export interface Driven {
  /** The route was drawn or redrawn. `settled` is false while a stretch is still being thought about. */
  route(steps: readonly Walk[], settled: boolean): void
  /** It is standing where it was sent. */
  arrived(): void
  /** It cannot get there, and why. */
  lost(why: string): void
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

/** How close to a square counts as standing in it. Upstream's numbers, and its simulation's. */
const NEAR = 0.35

/**
 * How far off the middle of a square is worth correcting before building a tower out of it.
 *
 * **An agent arrives at a square wherever its momentum left it.** Walking stops by letting go of the
 * controls, not by braking, so the last step before a pillar ends up anywhere in the square - and
 * measured, that is regularly four tenths of a block out, which is the edge. Towering from there
 * looks like an agent shuffling up the side of its own column, and it is also how a placement ends
 * up aimed at a face the server does not agree is reachable.
 *
 * A person centres up before they pillar. This is that.
 */
const OFF_CENTRE = 0.15

/**
 * How much sideways drift is still worth waiting out before jumping.
 *
 * **A tower jump has to be straight up, and a jump keeps whatever it started with.** Minecraft has no
 * air braking: the horizontal speed the agent has at the moment it leaves the ground is the speed it
 * lands with, so a pillar begun while still walking lands off the middle - and the correction for
 * that is itself a walk, which is moving again by the time the next jump starts. That is the
 * ladder of corrections, each one an answer to the last, that reads as an agent going edge to edge
 * all the way up its own tower.
 *
 * Centring alone does not fix it, because centring *is* movement. The agent has to be in the middle
 * **and** standing still. Ground friction is 0.6 a tick, so this is two or three ticks of waiting.
 */
const SETTLED = 0.02
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

export class Driver {
  private goal: Goal | undefined

  /** The whole journey being thought about, when it is. */
  private plotting: Search | undefined
  /** One stretch being thought about again, when one is. */
  private mending: Mend | undefined

  private sections: Section[] = []

  private job: Job | undefined

  /** How often the stretch being walked has been replaced. What tells a job if it still belongs. */
  private era = 0

  /** When the agent last got somewhere, which is what a stall is measured against. */
  private movedAt = 0

  /** Jobs that have failed since the agent last got anywhere. */
  private failures = 0

  /** Blocks this agent changed itself, and when they stop being its own doing. See {@link MINE_MS}. */
  private readonly mine = new Map<string, number>()

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
    private readonly physics: Simulation = new Physics(bot),
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

  /** Go there. Replaces whatever it was doing. */
  go(goal: Goal): void {
    this.goal = goal
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
    this.era++
    this.movedAt = Date.now()

    this.plotting = new Search(standingAt(this.bot, movements), walkingFrom(movements), goal, {
      budget,
      slice,
      reach,
    })
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
      this.think()
    } catch (err) {
      log.warn(`Agent ${this.id} could not work out what to do next: ${(err as Error).message}`)
      this.give('it could not work out how to get there')
    }
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
    else if (this.mending) this.mend()

    if (this.sections.length === 0) {
      if (!this.plotting) this.plan()
      this.still()
      return
    }

    this.walk()
  }

  /** One slice of thinking about the whole journey. */
  private plot(): void {
    const search = this.plotting
    if (!search) return

    const found = search.run()

    if (found.outcome === 'partial') {
      // A guess, and labelled as one: worth walking, because the next slice corrects it, and not
      // worth spending a block on. Every stretch stays unsettled until the search finishes.
      this.cut(found.steps as Walk[], false)
      return
    }

    this.plotting = undefined

    if (found.steps.length === 0) {
      this.give(found.outcome === 'timeout' ? 'the search ran out of time' : 'there is no route there')
      return
    }

    // `nowhere` and `timeout` with a route are the best that could be found and nothing better is
    // coming, so they are as settled as `found` is.
    this.cut(found.steps as Walk[], true)
  }

  /** One slice of thinking about a single stretch again. */
  private mend(): void {
    const mending = this.mending
    if (!mending) return

    const found = mending.search.run()
    // Still thinking. The old steps carry on being walked, and stay unbuildable while they do.
    if (found.outcome === 'partial') return

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

  /** Cuts a fresh route into stretches and takes it. */
  private cut(steps: Walk[], settled: boolean): void {
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

    const step = section.steps[0]
    if (!step) {
      this.sections.shift()
      if (this.sections.length === 0) this.done()
      return
    }

    // **Nothing acts on a guess.** An unfinished search hands out a different best-so-far every
    // slice, and an agent that walked each of them paced two blocks back and forth on the spot until
    // one settled. Waiting looks like waiting; that looked broken. The route is still drawn while
    // this happens, so the map shows the thinking.
    if (!section.settled) {
      this.still()
      // Still watched. Standing still while a search thinks is right; standing still for ever
      // because one never finishes is the failure this whole branch can otherwise hide.
      this.futility()
      return
    }

    if (step.toBreak.length > 0 || step.toPlace.length > 0) {
      if (this.centring(step, at)) {
        this.futility()
        return
      }

      this.begin(step)
      return
    }

    if (this.reached(step, at)) {
      section.steps.shift()
      this.movedAt = Date.now()
      this.failures = 0
      if (section.steps.length === 0 && this.sections.length === 1) this.done()
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
   * Shuffles into the middle of the square a tower is about to be built out of.
   *
   * Answers whether it is still doing that, so the caller waits rather than building from the edge.
   * Sneaking rather than walking: the whole correction is under half a block and a walked step is
   * two tenths, which turns being off one side into being off the other.
   *
   * Only for a block going into the square the agent is *standing in*. A bridge is placed from the
   * edge on purpose, and nudging the agent off it would be the opposite of helpful.
   */
  private centring(step: Walk, at: { x: number; y: number; z: number }): boolean {
    const laying = step.toPlace[0]
    if (!laying) return false

    const going = { x: laying.x + laying.dx, y: laying.y + laying.dy, z: laying.z + laying.dz }
    const stood = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) }
    if (going.x !== stood.x || going.y !== stood.y || going.z !== stood.z) return false

    const middle = { x: going.x + 0.5, z: going.z + 0.5 }
    const dx = middle.x - at.x
    const dz = middle.z - at.z

    if (Math.hypot(dx, dz) > OFF_CENTRE) {
      this.bot.look(Math.atan2(-dx, -dz), 0)
      this.bot.setControlState('sneak', true)
      this.bot.setControlState('forward', true)
      return true
    }

    // In the middle. Now stop, and *stay* stopped for a tick or two: see {@link SETTLED}. Letting go
    // of the controls is not stopping, and the jump that follows carries whatever is left.
    this.still()

    const drifting = this.bot.entity?.velocity
    if (!drifting) return false

    return Math.hypot(drifting.x, drifting.z) > SETTLED
  }

  private reached(step: Walk, at: { x: number; y: number; z: number }): boolean {
    const stood = standsAt(step)

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
    const bot = this.bot
    const at = bot.entity.position
    const stood = standsAt(step)
    const to = new WorldVec(stood.x, stood.y, stood.z)
    const aim = [to]

    bot.look(Math.atan2(-(to.x - at.x), -(to.z - at.z)), 0)
    bot.setControlState('forward', true)
    bot.setControlState('jump', false)

    const sprint = this.rules().sprint

    if ((bot.entity as unknown as { isInWater?: boolean }).isInWater) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', false)
      return
    }

    if (sprint && this.physics.canStraightLine(aim, true)) {
      bot.setControlState('sprint', true)
      return
    }

    if (this.physics.canStraightLine(aim)) {
      bot.setControlState('sprint', false)
      return
    }

    // **The gentlest jump that reaches, not the fastest.** Upstream asks whether a sprint jump would
    // work before it asks whether a walk would, so every step up and every one block gap gets taken
    // at a run - and a sprint jump carries far enough past a one block hop to land beyond the square
    // it was aimed at. Landing where it meant to is worth more to this agent than the tick it saves,
    // and a real gap still gets the sprint, because a walk will not clear it.
    if (this.physics.canWalkJump(aim)) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', false)
      return
    }

    if (sprint && this.physics.canSprintJump(aim)) {
      bot.setControlState('jump', true)
      bot.setControlState('sprint', true)
      return
    }

    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
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

          log.debug(`Agent ${this.id} did not get to place at ${spot.x} ${spot.y} ${spot.z}, going round again`)
          // The jump is still held, so the next window is already on its way.
        }
      }
    } finally {
      bot.setControlState('jump', false)
      bot.setControlState('sneak', false)
    }
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

    const { movements, reach, slice, budget } = this.rules()

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
      search: new Search(from, walkingFrom(movements), within(section.end.x, section.end.y, section.end.z, 0.5), {
        budget,
        slice,
        reach,
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
