import { createRequire } from 'node:module'

import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'

import { log } from '../../log.ts'
import { RANK, type Schedule } from '../schedule.ts'
import { rankOf, type PlacementOrder } from '../order.ts'
import type { BlockPos } from '../../protocol/wire.ts'
import { blockCount, positionOf, stateAt, type Segment } from './segment.ts'
import { compare, describe, type Mismatch, type Standing } from './compare.ts'
import { itemFor } from './materials.ts'
import { bare, opposite, parseSpec, planFor, STEP, type Face, type Option, type Plan } from './plan.ts'
import type { BuildSettings } from './settings.ts'

/**
 * Puts a piece in the ground.
 *
 * **One next block, and everything else in reach of it on the same layer.** The piece's order
 * decides which block comes next — it is what the operator chose, and it is what keeps a build from
 * trying to place a block with nothing under it. But placing only that one and moving on would
 * spend the whole build travelling, so everything the agent can already reach goes down with it.
 *
 * **On the same layer, though.** Reach is a ball and a build is not: take everything inside it and
 * the agent works two courses at once, laying part of the next one before this one is finished —
 * which looks wrong, and puts blocks up before the things that are supposed to hold them. One
 * course at a time is what a person does, and it is what the cursor's own height already says.
 *
 * **And it never stops to arrive.** Where to go next is re-aimed as the cursor moves and is never
 * waited on: the agent places what it can reach *while* it travels, the way somebody flying along a
 * wall does. Waiting for each arrival is what makes a printer pause every few blocks, and the pause
 * is most of the build.
 *
 * **What it cannot reach it puts back rather than giving up on.** A block whose support has not
 * arrived yet, a square something is standing in, a placement the server refused: all of them go to
 * the back and are tried again on the next sweep, because a piece is not built in one pass and the
 * thing that was in the way is usually gone by the second. That is also why a plan never offers a
 * face that would produce the wrong state: waiting for the right support is correct, and placing a
 * hopper pointing at the floor because the wall behind it has not arrived yet is not.
 *
 * **Placing is not the end of it.** A repeater comes out of the hand on one tick whatever the
 * schematic wanted, and a comparator in compare mode; those are right-clicks after the fact. See
 * `plan.ts`, which says which properties a block cycles, and {@link Printer.tune} below.
 */

/** How far through a block the printer has got with it. */
const TODO = 0
const DONE = 1
/** Placed by something else — the upper half of a door, the head of a bed. */
const FREE = 2
/** Tried and could not, this sweep. */
const PARKED = 3

/**
 * How many times the whole piece is swept before what is left is called impossible.
 *
 * A sweep that places nothing has nothing to unblock the next one, so this is only ever reached by
 * a piece with something genuinely in the way. It is a ceiling on a loop, not a budget.
 */
const MOST_SWEEPS = 8

/** How long to wait for the server to show a block where one was just placed. */
const SETTLE_MS = 400

/** How often the world is looked at again while waiting for it. */
const POLL_MS = 10

/**
 * How long between two right-clicks on the same block.
 *
 * A server takes one interaction per tick, so a repeater clicked five times inside a tick advances
 * once. Long enough to be sure of a tick, and no longer.
 */
const CLICK_MS = 60

/** How many times the tuning pass re-reads a block and clicks again before leaving it. */
const TUNE_ROUNDS = 3

/** One server tick, which is the shortest wait worth making. */
const TICK_MS = 50

/**
 * How far the agent may have turned and still count as pointing where it was put.
 *
 * mineflayer quantises a look to about a sixth of a degree - it rounds to a real mouse's
 * sensitivity so that the movement does not read as machine-made - so the yaw read back is never
 * quite the one asked for. Anything past this is somebody else having turned the agent.
 */
const A_NUDGE = 0.01

/**
 * How many blocks are gathered before going back for more.
 *
 * The agent is travelling while the batch is placed, so a long one goes stale: by the time the
 * last entry comes up the agent has moved on and is nowhere near it. Small enough to stay true,
 * big enough that the sweep is not re-run per block.
 */
const BATCH = 8

/**
 * How many passes the cursor may stay out of reach before it is put to the back.
 *
 * Travel is the ordinary reason for it, so this has to be longer than a flight across a piece -
 * roughly a minute at a tick a pass. Shorter and the printer gives up on blocks it was on its way
 * to; the piece then finishes with holes in it and nothing said about why.
 */
const PATIENCE = 1_200

/**
 * How long to let a turn land before placing against it.
 *
 * **One tick, and it is not the client being slow.** The rotation is written to the socket
 * immediately before the click, in one synchronous breath, so they arrive in that order — and
 * the turn is still not the one the placement is judged against unless a tick passes between
 * them. Measured both ways on the rig, twice: with this wait every one of the 183 specimens
 * comes out right, and with it at zero fourteen of them come out facing whichever way the block
 * before them did.
 *
 * The turn itself is already instant — one packet, no smoothing, see {@link snap}. This is the
 * server's tick, not the client's, and it is only paid when the agent actually has to turn.
 */
const TURN_MS = 60

export type BuildOutcome = 'done' | 'failed' | 'stopped'

export interface PrinterHooks {
  /** Blocks this agent has placed, a total rather than a delta. Called whenever it moves. */
  progress(placed: number): void
  /**
   * Head for this square, and keep heading for it.
   *
   * Called on every pass with wherever the work now is, and expected to be cheap when that has
   * not changed. It does not answer, and nothing waits on it: how an agent travels is the
   * navigator's business, and a printer that waited for each arrival would spend the build
   * standing still. Placing happens whenever something is in reach, moving or not.
   */
  steer(to: BlockPos): void
  /** What the operator has configured, read per pass rather than captured. */
  settings(): BuildSettings
  /** Something an operator should see in the agent's activity. */
  tell(text: string, bad?: boolean): void
}

export class Printer {
  /** Block indices, in the order the piece is to be built. */
  private readonly queue: Int32Array
  private readonly status: Uint8Array
  private readonly attempts: Uint8Array

  private cursor = 0
  private placed = 0
  /** The last rotation sent, so a block facing the same way as the last one does not wait. */
  private aimed: string | undefined
  private reported = -1
  private sweeps = 0
  private laidThisSweep = 0
  /** Passes in a row with nothing to place, which is how a cursor nobody can reach is noticed. */
  private idle = 0
  /** Where the agent was last sent, so a move can be told from staying put. */
  private bound: string | undefined
  /** Sweeps in a row that placed nothing, which is the only honest sign of a piece that is stuck. */
  private fruitless = 0
  /** The rotation this printer last put on the wire, to notice when something else moves it. */
  private turned: number | undefined
  private stopped = false

  /**
   * States that came out different from what was asked for, counted by what was wrong with them.
   *
   * Kept rather than logged per block: a piece with one bad rule in `plan.ts` has that rule wrong
   * on every block of that kind, and thousands of identical lines say less than one line with a
   * count on it.
   */
  private readonly drift = new Map<string, number>()

  constructor(
    private readonly id: number,
    private readonly bot: Bot,
    private readonly segment: Segment,
    order: PlacementOrder,
    private readonly hands: Schedule,
    private readonly hooks: PrinterHooks,
  ) {
    this.queue = orderedQueue(segment, order)
    this.status = new Uint8Array(blockCount(segment))
    this.attempts = new Uint8Array(blockCount(segment))
  }

  /** How many blocks this agent has put down since it was handed the piece. */
  get count(): number {
    return this.placed
  }

  /** What came out different from the schematic, for whoever reads host logs. */
  get differences(): ReadonlyMap<string, number> {
    return this.drift
  }

  stop(): void {
    this.stopped = true
  }

  async run(): Promise<BuildOutcome> {
    log.info(`Agent ${this.id} is building ${blockCount(this.segment)} blocks`)

    while (!this.stopped) {
      this.skipSettled()

      if (this.cursor >= this.queue.length) {
        if (!this.nextSweep()) break
        this.idle = 0
        continue
      }

      const settings = this.hooks.settings()
      const index = this.queue[this.cursor]!

      // Re-aimed every pass and never waited on. The agent is usually already on its way, and
      // this is what keeps it pointed at the work as the work moves along the course.
      this.steer(this.standingSpot(this.positionOf(index)))

      const batch = this.inReach(settings)
      if (batch.length === 0) {
        // Still travelling, most of the time. A cursor that stays out of reach for this long is
        // one nothing can get to - a block walled in by the build around it - so it goes to the
        // back and the next sweep tries again once its neighbours have changed.
        this.idle += 1
        if (this.idle > PATIENCE) {
          this.park(index)
          this.idle = 0
        }
        await pause(TICK_MS)
        continue
      }

      this.idle = 0
      await this.hands.add({ name: 'build', rank: RANK.BUILD, run: (signal) => this.work(batch, settings, signal) })
    }

    this.report()
    if (this.stopped) return 'stopped'

    const missing = this.remaining()
    if (missing === 0) return 'done'

    this.hooks.tell(`${missing} blocks of this piece could not be placed`, true)
    return 'failed'
  }

  // ------------------------------------------------------------------ the sweep

  /** Moves the cursor to the next block that still wants placing. */
  private skipSettled(): void {
    while (this.cursor < this.queue.length && this.status[this.queue[this.cursor]!] !== TODO) {
      this.cursor += 1
    }
  }

  /**
   * Puts everything parked back and starts again, or says there is no point.
   *
   * A sweep that laid nothing cannot have unblocked anything, so going round again would do exactly
   * what the last one did. That, rather than the count, is what ends a piece that cannot be built.
   */
  private nextSweep(): boolean {
    const parked = this.status.reduce((count, state) => count + (state === PARKED ? 1 : 0), 0)
    if (parked === 0) return false

    // **A sweep that placed nothing is not the end of it.** The commonest reason a placement is
    // refused is the agent standing in the square it wanted - it cannot fill the hole it is
    // standing in - and by the next sweep it is somewhere else entirely. Giving up on the first
    // fruitless pass leaves exactly those blocks out, which reads as a printer that skips things
    // and never comes back for them. Two in a row means nothing is going to change.
    this.fruitless = this.laidThisSweep === 0 ? this.fruitless + 1 : 0
    if (this.fruitless >= 2) {
      log.warn(`Agent ${this.id} gave up on ${parked} blocks: two sweeps in a row placed nothing`)
      return false
    }

    if (this.sweeps >= MOST_SWEEPS) {
      log.warn(`Agent ${this.id} gave up on ${parked} blocks after ${this.sweeps} sweeps`)
      return false
    }

    log.info(`Agent ${this.id} is going round again for ${parked} blocks`)
    for (let index = 0; index < this.status.length; index += 1) {
      if (this.status[index] === PARKED) this.status[index] = TODO
    }

    this.sweeps += 1
    this.laidThisSweep = 0
    this.cursor = 0
    return true
  }

  /**
   * Everything on the course the cursor is on that the agent can reach from where it is.
   *
   * In the order the operator chose, so a batch placed all at once is still placed in that order -
   * which matters for the same reason the order does: what holds a block up has to be there first.
   *
   * Held to the cursor's own height. Reach is a ball, and everything inside it spans three courses
   * at a wall - so an unrestricted batch has the agent laying part of the next one before this one
   * is done, which is both wrong to watch and wrong to build.
   */
  private inReach(settings: BuildSettings): number[] {
    const at = this.bot.entity?.position
    if (!at) return []

    const eye = { x: at.x, y: at.y + eyeHeight(this.bot), z: at.z }
    const course = this.positionOf(this.queue[this.cursor]!).y

    const batch: number[] = []
    const end = Math.min(this.queue.length, this.cursor + settings.window)

    for (let step = this.cursor; step < end; step += 1) {
      const index = this.queue[step]!
      if (this.status[index] !== TODO) continue

      const block = this.positionOf(index)
      if (block.y !== course) continue
      if (!reaches(eye, block, settings.reach)) continue

      batch.push(index)
      if (batch.length >= BATCH) break
    }

    return batch
  }

  /**
   * Heads for a square, and forgets where the agent was pointing when it does.
   *
   * Being sent somewhere is also being turned: a server that moves a player sends a rotation
   * with the position, and a flight or a walk turns the agent as it goes. So the rotation this
   * printer last put on the wire is no longer the one the server has, and the next placement
   * has to say it again rather than assume it — which is one block in a few hundred coming out
   * facing whichever way the last one did.
   */
  private steer(to: BlockPos): void {
    const key = `${to.x},${to.y},${to.z}`
    if (key !== this.bound) {
      this.bound = key
      this.aimed = undefined
    }

    this.hooks.steer(to)
  }

  /** Whether there is something under a square to stop what goes in it falling out again. */
  private held(at: BlockPos): boolean {
    const under = this.bot.blockAt(new Vec3(at.x, at.y - 1, at.z))
    return under !== null && under.boundingBox === 'block'
  }

  /** Whether the agent can reach a square from wherever it is now. */
  private canReach(block: BlockPos, settings: BuildSettings): boolean {
    const at = this.bot.entity?.position
    if (!at) return false

    return reaches({ x: at.x, y: at.y + eyeHeight(this.bot), z: at.z }, block, settings.reach)
  }

  /**
   * Places a batch, then finishes off the ones that need a right-click.
   *
   * Two passes rather than one, because the two want opposite things of the agent: placing is done
   * crouched, so that a click on a chest puts a block against it rather than opening it, and
   * clicking a repeater to change its delay only works standing up. Crouching is a control state
   * that takes a tick to reach the server, so toggling it per block would be a tick per block spent
   * on nothing.
   */
  private async work(batch: readonly number[], settings: BuildSettings, signal: AbortSignal): Promise<void> {
    const tuning: number[] = []
    const gap = 1000 / settings.rate

    this.bot.setControlState('sneak', true)
    try {
      for (const index of batch) {
        if (signal.aborted || this.stopped) return
        if (this.status[index] !== TODO) continue

        // The agent is still moving while this runs, so a square that was in reach when the
        // batch was gathered may not be by the time its turn comes. Skipped rather than parked:
        // it is still wanted, and the next pass either has it in reach or does not.
        if (!this.canReach(this.positionOf(index), settings)) continue

        if (await this.lay(index)) tuning.push(index)
        await pause(gap)
      }
    } finally {
      this.bot.setControlState('sneak', false)
    }

    if (!settings.tune || tuning.length === 0) return

    // One tick for the server to see the agent stand up, or the first click opens nothing.
    await pause(100)
    for (const index of tuning) {
      if (signal.aborted || this.stopped) return
      if (!this.canReach(this.positionOf(index), settings)) continue
      await this.tune(index)
    }

    this.report()
  }

  // ------------------------------------------------------------------ one block

  /**
   * Places one block. Answers whether it still wants a right-click afterwards.
   *
   * **Only the block the cursor is on can fail.** Everything else in a batch is there because it
   * happened to be within reach on the way past, and most of the reasons one of those is refused
   * are reasons that stop being true a moment later - the support has not landed yet, the agent
   * is standing in the square, the server has not caught up with where it is. Putting such a
   * block to the back on that evidence spends the chance it never really had; the cursor is
   * coming to it anyway, and *that* attempt is the one that counts. What fails under the cursor
   * has been tried from the one position chosen for it, and is worth another sweep rather than
   * another pass.
   */
  private async lay(index: number): Promise<boolean> {
    const at = this.positionOf(index)
    const wanted = this.specOf(index)
    const plan = planFor(wanted)
    const name = bare(parseSpec(wanted).name)

    // Whether this is the block the order says is next, rather than one picked up in passing.
    const leading = index === this.queue[this.cursor]
    const refuse = (): false => {
      if (leading) this.park(index)
      return false
    }

    if (plan.free) {
      this.status[index] = FREE
      return false
    }

    const standing = this.bot.blockAt(vector(at))
    // How much of this square is already the right block. One for an ordinary block, and for the
    // ones that count how often they were placed - candles, snow, a slab that became a double -
    // however many are there, so a piece picked up part-built adds the rest rather than starting
    // again or calling it finished.
    const already = standing && bare(standing.name) === name ? stacked(standing) : 0

    if (already >= plan.copies) {
      this.settle(index, at, wanted, false)
      return plan.tune.length > 0
    }

    if (already === 0 && standing && !replaceable(standing)) {
      return refuse()
    }

    // Nothing to hold it up yet. Placing it anyway does not fail - the block goes in, reads
    // right, and is a block lower a tick later - so the check has to come first.
    if (plan.falls && !this.held(at)) {
      return refuse()
    }

    if (!(await this.hold(itemFor(wanted)))) {
      return refuse()
    }

    if (already === 0) {
      const option = this.choose(plan, at)
      if (!option) {
        return refuse()
      }
      if (!(await this.place(at, name, option))) {
        return refuse()
      }
    }

    // Everything past the first goes into the square itself rather than against a neighbour: that
    // is what a second slab in one square, a fourth candle and an eighth layer of snow all are.
    for (let copy = Math.max(already, 1); copy < plan.copies; copy += 1) {
      if (!(await this.stack(at, name))) break
    }

    const here = this.bot.blockAt(vector(at))
    if (!here || bare(here.name) !== name) {
      return refuse()
    }

    // Part of a stack is not a finished square. Put it back rather than calling it done: the next
    // sweep counts what is there and adds the rest, which is what the count above is for.
    if (stacked(here) < plan.copies) {
      return refuse()
    }

    this.settle(index, at, wanted, true)
    return plan.tune.length > 0
  }

  /**
   * Right-clicks a block until its cycling properties read what the schematic asked for.
   *
   * Counted rather than checked, because a block read a tick after it was clicked reads as it was
   * before — so a loop that clicks until the reading agrees never stops. It goes round a few times
   * instead: count the clicks from one honest reading, make them, read again, and stop when there
   * is nothing left to do or the rounds run out.
   */
  private async tune(index: number): Promise<void> {
    const at = this.positionOf(index)
    const wanted = this.specOf(index)
    const plan = planFor(wanted)
    if (plan.tune.length === 0) return

    const want = parseSpec(wanted).properties
    if (!(await this.freeHand())) return

    for (const knob of plan.tune) {
      const asked = want[knob.property]
      if (asked === undefined) continue

      for (let round = 0; round < TUNE_ROUNDS; round += 1) {
        const block = this.bot.blockAt(vector(at))
        if (!block) return

        const have = String((block.getProperties() as Record<string, unknown>)[knob.property] ?? '')
        const clicks = knob.clicks(have, asked)
        if (clicks === undefined || clicks === 0) break

        for (let click = 0; click < clicks; click += 1) {
          try {
            await this.bot.activateBlock(block)
          } catch (err) {
            log.debug(`Agent ${this.id} could not click ${at.x} ${at.y} ${at.z}: ${(err as Error).message}`)
            return
          }
          await pause(CLICK_MS)
        }
      }
    }

    this.review(at, wanted)
  }

  /**
   * Sends the click that puts a block down, and waits for the server to show it.
   *
   * The look is ours rather than mineflayer's: what the server derives from a placement is decided
   * by where the agent was looking when the packet arrived, so a library that helpfully looks at
   * the destination would place every stair facing the same way.
   */
  private async place(at: BlockPos, name: string, option: Option): Promise<boolean> {
    const against = STEP[option.against]
    const reference = this.bot.blockAt(new Vec3(at.x + against.x, at.y + against.y, at.z + against.z))
    if (!reference) return false

    // The normal of the face we click, which points from the reference block at the target.
    const normal = STEP[opposite(option.against)]
    const cursor = new Vec3(
      option.cursor?.x ?? 0.5 + normal.x * 0.5,
      option.cursor?.y ?? 0.5 + normal.y * 0.5,
      option.cursor?.z ?? 0.5 + normal.z * 0.5,
    )

    await this.aim(option)

    try {
      await placeRaw(this.bot, reference, new Vec3(normal.x, normal.y, normal.z), cursor)
    } catch (err) {
      log.debug(`Agent ${this.id} could not place at ${at.x} ${at.y} ${at.z}: ${(err as Error).message}`)
      return false
    }

    return this.until(() => {
      const block = this.bot.blockAt(vector(at))
      return block !== null && bare(block.name) === name
    }, SETTLE_MS)
  }

  /** Places into the square again, which is how one block counts how often it was placed. */
  private async stack(at: BlockPos, name: string): Promise<boolean> {
    const here = this.bot.blockAt(vector(at))
    if (!here) return false

    const before = stacked(here)
    try {
      await placeRaw(this.bot, here, UP, new Vec3(0.5, 1, 0.5))
    } catch (err) {
      log.debug(`Agent ${this.id} could not stack at ${at.x} ${at.y} ${at.z}: ${(err as Error).message}`)
      return false
    }

    return this.until(() => {
      const block = this.bot.blockAt(vector(at))
      return block !== null && bare(block.name) === name && stacked(block) > before
    }, SETTLE_MS)
  }

  /**
   * Points the agent where the state it is placing needs it to be pointed, at once.
   *
   * **Not `bot.look`.** Left to itself mineflayer turns the agent a few degrees a tick, so the
   * rotation the server has when the placement arrives is the one from several blocks ago — which
   * is a whole build placed one state behind, and looks exactly like a rule in `plan.ts` being the
   * wrong way round. Forcing it is worse: `force` records the rotation as already sent, so it never
   * goes out at all. A real client snaps its mouse and sends one packet, which is what {@link snap}
   * does — synchronously, so the rotation is on the wire before the click that reads it.
   */
  private async aim(option: Option): Promise<void> {
    const turn = rotationFor(this.bot, option)
    if (!turn) return

    // **The printer is not the only thing that turns the agent.** A flight or a walk faces the
    // way it is going, every tick, so between one placement and the next the rotation the server
    // holds is the navigator’s rather than the one aimed here. Remembering what was sent is only
    // worth anything while nothing else has moved the head, which is what this notices.
    if (this.turned !== undefined && Math.abs(this.bot.entity.yaw - this.turned) > A_NUDGE) {
      this.aimed = undefined
    }

    const key = `${turn.yaw}/${turn.pitch}`
    if (key === this.aimed) return

    snap(this.bot, turn.yaw, turn.pitch)
    this.aimed = key
    this.turned = this.bot.entity.yaw
    await pause(TURN_MS)
  }

  /**
   * Where to stand to place a block.
   *
   * **Not the block's own square.** A builder standing in the hole cannot fill it, and sending
   * the agent to the square the next block belongs in is sending it exactly where the work is —
   * which then blocks the placement, blocks the route out, and leaves the piece going round
   * sweep after sweep for blocks nobody can reach. That is not hypothetical: it is the
   * difference between the rig, which hovers over the build, and an agent that walks to a
   * coordinate and stands on it.
   *
   * A neighbour at the same height is where a player stands — feet on the layer just finished,
   * the next block at arm's length — and the ones the piece wants nothing in are the only ones
   * that stay clear for the rest of the build.
   */
  private standingSpot(target: BlockPos): BlockPos {
    for (const face of SIDEWAYS) {
      const step = STEP[face]
      const spot = { x: target.x + step.x, y: target.y, z: target.z + step.z }

      // Somewhere the piece will want a block is somewhere the agent will be in the way of.
      if (stateAt(this.segment, spot) !== undefined) continue
      if (stateAt(this.segment, { ...spot, y: spot.y + 1 }) !== undefined) continue

      const floor = this.bot.blockAt(new Vec3(spot.x, spot.y - 1, spot.z))
      if (!floor || floor.boundingBox !== 'block') continue

      const feet = this.bot.blockAt(new Vec3(spot.x, spot.y, spot.z))
      const head = this.bot.blockAt(new Vec3(spot.x, spot.y + 1, spot.z))
      if (feet && !replaceable(feet)) continue
      if (head && !replaceable(head)) continue

      return spot
    }

    // Nothing clear beside it — every neighbour is a block, which is the ordinary case for a
    // square down inside a build. One above the work, then, rather than the work itself: a fence,
    // a gate and a wall all stand a block and a half tall, so an agent hovering in the square
    // directly over one is standing in the space the block needs and the server refuses it. From
    // a square higher the whole course is still in reach and nothing is in its way.
    return { x: target.x, y: target.y + 1, z: target.z }
  }

  /** The first way of placing it whose reference block is already standing. */
  private choose(plan: Plan, at: BlockPos): Option | undefined {
    for (const option of plan.options) {
      const step = STEP[option.against]
      const block = this.bot.blockAt(new Vec3(at.x + step.x, at.y + step.y, at.z + step.z))
      if (block && block.boundingBox === 'block') return option
    }

    return undefined
  }

  // ------------------------------------------------------------------ the hand

  /** Puts the named item in the agent's hand, making one if the server allows it. */
  private async hold(item: string | undefined): Promise<boolean> {
    if (!item) return false
    if (this.bot.heldItem?.name === item) return true

    const carried = this.bot.inventory.items().find((held) => held.name === item)
    if (carried) {
      try {
        await this.bot.equip(carried, 'hand')
        return true
      } catch (err) {
        log.debug(`Agent ${this.id} could not hold ${item}: ${(err as Error).message}`)
        return false
      }
    }

    if (this.bot.game.gameMode !== 'creative') return false

    const made = this.bot.registry.itemsByName[item]
    if (!made) {
      log.debug(`Agent ${this.id} has no item called ${item} in this version`)
      return false
    }

    try {
      this.bot.setQuickBarSlot(0)
      await this.bot.creative.setInventorySlot(36, makeItem(this.bot, made.id, made.stackSize ?? 1))
      return this.bot.heldItem?.name === item
    } catch (err) {
      log.debug(`Agent ${this.id} could not conjure ${item}: ${(err as Error).message}`)
      return false
    }
  }

  /**
   * Empties the agent's hand, so a right-click changes a block rather than placing one on it.
   *
   * The last hotbar square rather than the first, because the first is where {@link Printer.hold}
   * keeps whatever is being built with, and emptying that would mean conjuring it again per block.
   */
  private async freeHand(): Promise<boolean> {
    if (this.bot.inventory.slots[44] !== null) {
      if (this.bot.game.gameMode !== 'creative') return false
      try {
        await this.bot.creative.setInventorySlot(44, null)
      } catch (err) {
        log.debug(`Agent ${this.id} could not empty a hand: ${(err as Error).message}`)
        return false
      }
    }

    this.bot.setQuickBarSlot(8)
    return true
  }

  // ------------------------------------------------------------------ bookkeeping

  private settle(index: number, at: BlockPos, wanted: string, ours: boolean): void {
    this.status[index] = DONE
    if (ours) {
      this.placed += 1
      this.laidThisSweep += 1
    }

    this.review(at, wanted)
    this.report()
  }

  /**
   * Records what came out different.
   *
   * The block is *there*, so it is not tried again — the plan that produced it would produce the
   * same thing next time. It is counted instead, by block and property, which is the reading that
   * says whether a rule in `plan.ts` is the wrong way round.
   */
  private review(at: BlockPos, wanted: string): void {
    const block = this.bot.blockAt(vector(at))
    const misses = compare(wanted, block ? standingOf(block) : undefined)
    if (misses.length === 0) return

    const name = bare(parseSpec(wanted).name)
    for (const miss of misses) {
      const key = `${name}.${miss.property}`
      const seen = this.drift.get(key) ?? 0
      this.drift.set(key, seen + 1)
      if (seen === 0) log.debug(`Agent ${this.id}: ${describe(at, [miss])}`)
    }
  }

  private park(index: number): void {
    this.attempts[index] = (this.attempts[index] ?? 0) + 1
    this.status[index] = PARKED
  }

  private remaining(): number {
    let left = 0
    for (const state of this.status) if (state !== DONE && state !== FREE) left += 1
    return left
  }

  private report(): void {
    if (this.placed === this.reported) return
    this.reported = this.placed
    this.hooks.progress(this.placed)
  }

  private positionOf(index: number): BlockPos {
    return positionOf(this.segment, this.segment.linear[index]! >>> 0)
  }

  private specOf(index: number): string {
    return this.segment.palette[this.segment.states[index]!]!
  }

  /** Watches the world until something is true, or until the time is up. */
  private async until(test: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms

    for (;;) {
      if (test()) return true
      if (Date.now() >= deadline) return false
      await pause(POLL_MS)
    }
  }
}

/**
 * The piece's blocks, sorted into the order they are to be placed in.
 *
 * Sorted once rather than walked per block: the order describes every position in the box, and a
 * sparse piece is a few thousand blocks in a box of a million. Ranking each block and sorting is
 * one pass; asking the order for its next position until it names one we hold is the whole box.
 */
export function orderedQueue(segment: Segment, order: PlacementOrder): Int32Array {
  const count = blockCount(segment)
  const max = {
    x: segment.min.x + segment.size.x - 1,
    y: segment.min.y + segment.size.y - 1,
    z: segment.min.z + segment.size.z - 1,
  }

  const ranks = new Float64Array(count)
  for (let index = 0; index < count; index += 1) {
    const at = positionOf(segment, segment.linear[index]! >>> 0)
    ranks[index] = rankOf(segment.min, max, order, at) ?? Number.MAX_SAFE_INTEGER
  }

  const queue = new Int32Array(count)
  for (let index = 0; index < count; index += 1) queue[index] = index

  return queue.sort((a, b) => ranks[a]! - ranks[b]!)
}

/**
 * Whether the agent can reach a block from where its eyes are.
 *
 * **To the nearest corner of the block, not to the middle of it.** That is what the server
 * measures, and the difference is most of a block: taking the centre refuses placements along the
 * edge of the reach that the server would have accepted, which reads as a printer that misses
 * blocks it was standing next to.
 */
function reaches(eye: { x: number; y: number; z: number }, block: BlockPos, reach: number): boolean {
  const dx = Math.max(block.x - eye.x, 0, eye.x - (block.x + 1))
  const dy = Math.max(block.y - eye.y, 0, eye.y - (block.y + 1))
  const dz = Math.max(block.z - eye.z, 0, eye.z - (block.z + 1))

  return dx * dx + dy * dy + dz * dz <= reach * reach
}

/** Whether a block can be built over without breaking it first. */
function replaceable(block: Block): boolean {
  const name = bare(block.name)
  return REPLACEABLE.has(name) || block.boundingBox === 'empty'
}

/**
 * What a placement goes straight through.
 *
 * `boundingBox === 'empty'` covers most of it — grass, flowers, signs — but not the three airs and
 * not water or lava, which have no collision and are still not something to place through by
 * accident anywhere except where the schematic wants a block.
 */
const REPLACEABLE = new Set([
  'air',
  'cave_air',
  'void_air',
  'water',
  'lava',
  'short_grass',
  'tall_grass',
  'snow',
  'fire',
  'soul_fire',
  'light',
  'structure_void',
])

/**
 * How many times this block has been placed into its square.
 *
 * One for an ordinary block. Blocks that count their own placements — candles, sea pickles, layers
 * of snow, a slab that has become a double — say so in a property, and that is what decides whether
 * a square that already holds the right block still wants another one.
 */
function stacked(block: Block): number {
  const props = block.getProperties() as Record<string, unknown>
  if (props['type'] === 'double') return 2

  for (const key of ['candles', 'pickles', 'layers']) {
    const value = Number(props[key])
    if (Number.isFinite(value) && value > 0) return value
  }

  return 1
}

/** What the world says is standing somewhere, in the shape {@link compare} reads. */
export function standingOf(block: Block): Standing {
  const properties: Record<string, string> = {}
  const raw = block.getProperties() as Record<string, unknown>
  for (const [key, value] of Object.entries(raw)) properties[key] = String(value)

  return { name: bare(block.name), properties }
}

function vector(at: BlockPos): Vec3 {
  return new Vec3(at.x, at.y, at.z)
}

const UP = new Vec3(0, 1, 0)

/** The four squares beside a block, which is where an agent stands to place it. */
const SIDEWAYS: Face[] = ['north', 'south', 'east', 'west']

/** Minecraft's own yaw: zero is south, and it turns clockwise from there. */
const NOTCH_YAW: Record<'north' | 'south' | 'east' | 'west', number> = {
  south: 0,
  west: 90,
  north: 180,
  east: 270,
}

function notchYaw(bot: Bot): number {
  return (180 - (bot.entity.yaw * 180) / Math.PI) % 360
}

/** Where the agent has to be pointing for this placement, or nothing when it does not matter. */
function rotationFor(bot: Bot, option: Option): { yaw: number; pitch: number } | undefined {
  if (option.rotation !== undefined) {
    // Standing signs, banners and heads take one of sixteen turns rather than one of four, so
    // the yaw is a number here rather than a direction. Vanilla reads it as
    // `floor((yaw + 180) * 16 / 360 + 0.5) & 15`, which this is the inverse of.
    return { yaw: option.rotation * 22.5 - 180, pitch: 0 }
  }

  if (option.nearest === 'up') return { yaw: notchYaw(bot), pitch: -90 }
  if (option.nearest === 'down') return { yaw: notchYaw(bot), pitch: 90 }

  const face = option.nearest ?? option.yaw
  if (!face || face === 'up' || face === 'down') return undefined

  return { yaw: NOTCH_YAW[face], pitch: 0 }
}

/**
 * Turns the agent and puts the rotation on the wire now.
 *
 * mineflayer's own `look` either slews over several ticks or, with `force`, records the rotation as
 * sent and never sends it — see {@link Printer.aim}. This sets what the library believes, so it
 * does not turn the agent back, and writes the packet itself.
 */
function snap(bot: Bot, yaw: number, pitch: number): void {
  const turned = Math.PI - (yaw * Math.PI) / 180
  const tilted = (-pitch * Math.PI) / 180

  const onGround = bot.entity.onGround

  // The rotation alone. The packet that carries a position too can be refused as a movement,
  // and a refused movement takes the turn down with it - which is one block in a few hundred
  // coming out facing the way the last one did.
  bot._client.write('look', {
    yaw,
    pitch,
    onGround,
    flags: { onGround, hasHorizontalCollision: undefined },
  })

  // Tells the library the turn has happened, so its own loop does not spend the next few ticks
  // slewing the agent round to a rotation the server already has.
  //
  // **The nudge is not superstition.** `look` records the rotation as sent only when it changes
  // something, and after the server has moved the agent the library's idea of where it is
  // pointing already matches what we are about to ask for while its idea of what it last *sent*
  // does not. Left alone, its loop then turns the agent away from where we just pointed it, for
  // the few ticks it takes to converge - which is one placement in a few hundred coming out
  // facing somewhere nobody asked for. Moving it first makes the call a change, which is the
  // only way from out here to correct what it believes.
  bot.entity.yaw = turned + 1
  void bot.look(turned, tilted, true)
}

/** Sends the placement, without letting mineflayer decide where to look. */
async function placeRaw(bot: Bot, reference: Block, normal: Vec3, cursor: Vec3): Promise<void> {
  const inner = bot as unknown as {
    _genericPlace(
      reference: Block,
      normal: Vec3,
      options: { delta: Vec3; forceLook: boolean | 'ignore'; swingArm?: 'right' | 'left' },
    ): Promise<unknown>
  }

  await inner._genericPlace(reference, normal, { delta: cursor, forceLook: 'ignore', swingArm: 'right' })
}

/** mineflayer keeps this on the entity but does not declare it, so it is read at the edge. */
function eyeHeight(bot: Bot): number {
  return (bot.entity as unknown as { eyeHeight?: number }).eyeHeight ?? 1.62
}

/**
 * prismarine-item is a factory over a registry rather than a class, so one is built per bot.
 *
 * Required rather than imported: every other use of the module in this host is a type-only import,
 * and this is the one place that needs the constructor itself.
 */
type ItemClass = new (id: number, count: number) => Item

const factories = new WeakMap<object, ItemClass>()

function makeItem(bot: Bot, id: number, count: number): Item {
  const key = bot as unknown as object
  let make = factories.get(key)

  if (!make) {
    const load = createRequire(import.meta.url)('prismarine-item') as (registry: unknown) => ItemClass
    make = load(bot.registry)
    factories.set(key, make)
  }

  return new make(id, count)
}

function pause(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type { Mismatch }
