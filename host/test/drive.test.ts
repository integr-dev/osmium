import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'
import { Vec3 as WorldVec } from 'vec3'

import { Driver, type Driven, type Rules, type Simulation } from '../src/agent/path/drive.ts'
import { Schedule } from '../src/agent/schedule.ts'
import { within } from '../src/agent/path/ground.ts'

/**
 * A world one square wide, with whatever work is asked for waiting on the square ahead.
 *
 * Enough to drive the state machine and no more: the driver's faults were never about geometry, so
 * the neighbour source here is a single step rather than a Minecraft world. What it does have to be
 * is upstream-shaped, because that is what {@link Driver} passes through the search untouched.
 */
function ahead(work: { toPlace?: unknown[]; toBreak?: unknown[] } = {}) {
  return {
    x: 0,
    y: 64,
    z: 1,
    hash: '0,64,1',
    cost: 1,
    remainingBlocks: 8,
    toPlace: work.toPlace ?? [],
    toBreak: work.toBreak ?? [],
  }
}

/**
 * Lets every promise already settled actually run.
 *
 * A real turn of the loop rather than a count of microtasks: a job is several awaits deep behind a
 * held promise, and a test that guessed at the number of hops would pass whether or not the thing it
 * asserts is absent was ever going to happen.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A promise somebody else decides the fate of. */
function heldPromise<T>() {
  let settle: (value: T) => void = () => {}
  let fail: (why: Error) => void = () => {}

  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  return { promise, settle, fail }
}

interface Fake {
  bot: Bot
  rules: () => Rules
  said: {
    routes: Array<{ settled: boolean; steps: number }>
    arrived: number
    lost: string[]
    stalled: number
  }
  report: Driven
  tick(): void
  block(before: { x: number; y: number; z: number; type: number }, after: { type: number }): void
  did: string[]
  equipping: ReturnType<typeof heldPromise<void>>
  placing: ReturnType<typeof heldPromise<void>>
  digging: ReturnType<typeof heldPromise<void>>
  standAt(x: number, y: number, z: number, onGround?: boolean): void
  drift(x: number, z: number): void
  refuse(times: number): void
}

/**
 * A bot that is its position, its events and the four things a job actually does to the world.
 *
 * Equipping, placing and digging are each held open so a test can decide when - and in what order
 * relative to a re-plan - they come back. That ordering is the whole of what went wrong upstream.
 */
function fakeBot(neighbours: unknown[]): Fake {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const entity = {
    position: new WorldVec(0.5, 64, 0.5),
    velocity: new WorldVec(0, 0, 0),
    // Facing -z, which is what a yaw of zero means to mineflayer, so "forward" is a known direction.
    yaw: 0,
    pitch: 0,
    onGround: true,
    effects: {},
  }
  let refusals = 0

  const did: string[] = []
  const held: Record<string, boolean> = {}
  /** The heading asked for, waiting for the next tick to become the heading it has. */
  let turning: number | undefined
  const equipping = heldPromise<void>()
  const placing = heldPromise<void>()
  const digging = heldPromise<void>()

  const bot = {
    entity,
    // One tool, and nothing in hand, so that breaking has something to reach for and the equip
    // before a dig is a real one rather than the autotool deciding the hand is already right.
    inventory: { items: () => [{ type: 7, name: 'stone_pickaxe', nbt: null }] },
    heldItem: null,
    unequip: async () => {
      did.push('unequip')
    },
    on(name: string, handler: (...args: unknown[]) => void) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler])
    },
    removeListener() {},
    clearControlStates() {
      did.push('still')
      for (const name of Object.keys(held)) delete held[name]
    },
    setControlState: (name: string, on: boolean) => {
      held[name] = on
      if (on) did.push(name)
    },
    // Held as well as recorded, because the driver reads its own controls back: a correction that
    // is already strafing is one the drift damper must not argue with.
    getControlState: (name: string) => held[name] ?? false,
    look(yaw: number) {
      // Recorded because it is what tells walking from braking: aiming at the next square is the
      // first thing a walk does, and a brake never aims at all.
      did.push('look')
      // Asked for now, arrived at next tick, because `bot.look` animates. A jump decided while the
      // agent is still turning takes off along the heading it had, which is the whole reason the
      // driver waits to be pointed at a gap before it leaves the ground.
      turning = yaw
    },
    lookAt: async () => {},
    blockAt: (at: WorldVec) => ({
      position: at,
      type: 1,
      name: 'stone',
      boundingBox: 'block',
      // Quicker with the pickaxe than without, so the autotool has a reason to reach for it.
      digTime: (item: number | null) => (item === null ? 1_000 : 100),
    }),
    equip: async () => {
      did.push('equip')
      return equipping.promise
    },
    placeBlock: async () => {
      did.push('place')
      // A refused window, the way the gate in `bot.ts` reports one.
      if (refusals > 0) {
        refusals--
        throw new Error('the agent is standing where the block would go')
      }
      return placing.promise
    },
    dig: async () => {
      did.push('dig')
      return digging.promise
    },
    activateBlock: async () => {},
  }

  const said: Fake['said'] = { routes: [], arrived: 0, lost: [], stalled: 0 }

  return {
    bot: bot as unknown as Bot,
    did,
    equipping,
    placing,
    digging,
    said,
    report: {
      route: (steps, settled) => said.routes.push({ settled, steps: steps.length }),
      arrived: () => said.arrived++,
      lost: (why) => said.lost.push(why),
      stalled: () => said.stalled++,
    },
    rules: () => ({
      movements: {
        getNeighbors: () => neighbours,
        countScaffoldingItems: () => 8,
        getScaffoldingItem: () => ({ type: 4, name: 'cobblestone' }),
        emptyBlocks: new Set<number>(),
      } as unknown as Rules['movements'],
      reach: 128,
      sprint: false,
      slice: 50,
      budget: 5_000,
    }),
    tick() {
      if (turning !== undefined) {
        entity.yaw = turning
        turning = undefined
      }
      for (const handler of listeners.get('physicsTick') ?? []) handler()
    },
    block(before, after) {
      for (const handler of listeners.get('blockUpdate') ?? []) {
        handler({ position: new WorldVec(before.x, before.y, before.z), type: before.type }, after)
      }
    },
    standAt(x, y, z, onGround = true) {
      entity.position = new WorldVec(x, y, z)
      entity.onGround = onGround
    },
    drift(x: number, z: number) {
      entity.velocity = new WorldVec(x, 0, z)
    },
    refuse(times: number) {
      refusals = times
    },
  }
}

/**
 * A simulation that says every step can simply be walked.
 *
 * The real one runs prismarine's player physics forward and needs a whole world behind it to answer
 * at all. What it decides - walk, jump or sprint - is upstream's and is not what these tests are
 * about; they are about what the driver does with the answer.
 */
const onFoot: Simulation = {
  canStraightLine: () => true,
  canSprintJump: () => false,
  canWalkJump: () => false,
  lands: () => undefined,
}

/**
 * A simulation where every jump reaches and no walk does, which is a step up.
 *
 * Both jump branches say yes, so which one the driver takes is its own decision rather than the
 * physics', which is exactly what these tests are about.
 */
const jumpable: Simulation = {
  canStraightLine: () => false,
  canSprintJump: () => true,
  canWalkJump: () => true,
  // Both come down on the middle of the square, so which one the driver takes is its own
  // decision rather than the landing.
  lands: (aim) => aim[0],
}

/**
 * A simulation that refuses everything, the way it does from the lip of a block.
 *
 * Landing half a block off after a jump is the ordinary reason nothing is reachable - most of all
 * for a turn, where the run-up crosses the corner rather than running along an edge.
 */
const refusing: Simulation = {
  canStraightLine: () => false,
  canSprintJump: () => false,
  canWalkJump: () => false,
  lands: () => undefined,
}

/**
 * A real queue, not a stand-in.
 *
 * Laying and breaking go through the agent's hands like everything else does, and a fake that just
 * ran the work would test a driver nobody ships. Nothing else is queued in these tests, so the
 * ordering never bites - what is being checked is that the work still happens.
 */
function hands(): Schedule {
  return new Schedule(1)
}

/** A driver already given a goal one square ahead, with the search settled. */
function driving(neighbours: unknown[]) {
  const world = fakeBot(neighbours)
  const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)

  driver.start()
  driver.go(within(0, 64, 1, 0.5))
  world.tick()

  return { world, driver }
}

describe('Driver', () => {
  /**
   * One rung of a tower: a step directly above, built by laying a block in the agent's own square.
   *
   * Upstream's shape - the reference is the block *below* the agent's feet, and the face is up, so
   * what appears is the square the agent is standing in and it lands on top of it.
   */
  function rung() {
    return {
      x: 0,
      y: 65,
      z: 0,
      hash: '0,65,0',
      cost: 1,
      remainingBlocks: 8,
      toPlace: [{ x: 0, y: 63, z: 0, dx: 0, dy: 1, dz: 0, jump: true }],
      toBreak: [],
    }
  }

  it('walks to the middle of the column before pillaring out of it', () => {
    const world = fakeBot([rung()])

    // Stopped near the lip of the square. A jump goes straight up, so wherever it stands is where
    // the whole tower goes - and a pillar built off the edge of each block is one it keeps having
    // to catch itself on.
    world.standAt(0.05, 64, 0.5)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 65, 0, 0.5))
    world.tick()

    // Moved sideways without turning - facing the middle is what a tower cannot have - and walked
    // rather than crouched: a crouch is a third of walking pace, so the little correction that costs
    // one step took a second of shuffling and a stall before it.
    expect(world.did).toContain('right')
    expect(world.did).not.toContain('sneak')
    expect(world.did).not.toContain('equip')
  })

  it('brakes rather than coasting, so it stops inside the square', () => {
    const world = fakeBot([rung()])

    world.standAt(0.5, 64, 0.5)
    // A sprint, straight ahead of where it is facing. Friction alone sheds 0.6 a tick, which is
    // about two thirds of a block of travel before this counts as still - the agent would be out of
    // the column before it was allowed to build, which is the overshoot.
    world.drift(0, -0.28)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 65, 0, 0.5))
    world.tick()

    // Counter-strafed, not coasted: moving the way it faces means pressing the opposite key.
    expect(world.did).toContain('back')
    expect(world.did).not.toContain('equip')
  })

  it('brakes sideways without turning, because turning is what a tower cannot have', () => {
    const world = fakeBot([rung()])

    // Drifting west while facing north. Facing the drift to press back would spin it on the pillar,
    // which is the one thing a tower cannot do - so it strafes against it instead. East is the
    // agent's right when it faces north, and east is what opposes drifting west.
    world.standAt(0.5, 64, 0.5)
    world.drift(-0.28, 0)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 65, 0, 0.5))
    world.tick()

    expect(world.did).toContain('right')
    expect(world.did).not.toContain('back')
  })

  it('waits for the drift to die before it jumps', () => {
    const world = fakeBot([rung()])

    // In the middle, and still moving. A jump keeps whatever it starts with, so pillaring now lands
    // off the middle - and the correction for that is itself movement, which is the ladder of
    // corrections that reads as an agent climbing the edge of its own tower.
    world.standAt(0.5, 64, 0.5)
    world.drift(0.12, 0)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 65, 0, 0.5))
    world.tick()

    expect(world.did).not.toContain('equip')

    // Friction has done its work.
    world.drift(0.005, 0)
    world.tick()

    expect(world.did).toContain('equip')
  })

  it('plans again rather than walking back to a column it went past', () => {
    const world = fakeBot([rung()])

    // A block past the column. The route was drawn from where the agent was standing and it kept
    // walking while the search settled, which is how a tower ends up starting mid-stride. Walking
    // back is the same overshoot in the other direction, so the stale route goes instead.
    world.standAt(1.5, 64, 0.5)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 65, 0, 0.5))
    world.tick()

    expect(world.did).not.toContain('equip')
    expect((driver as unknown as { plotting: unknown }).plotting).toBeDefined()
  })

  it('does not hold up a step up onto the square ahead', () => {
    // A block laid at the agent's own level in the next column is a step up onto, placed from
    // outside it. Waiting for the agent to be still first was tried and stopped it moving at all.
    const world = fakeBot([ahead({ toPlace: [{ x: 0, y: 65, z: 1, dx: 0, dy: 1, dz: 0 }] })])

    world.standAt(0.5, 64, 0.5)
    world.drift(0, -0.28)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 64, 1, 0.5))
    world.tick()

    expect(world.did).toContain('equip')
  })

  it('backs onto the edge, crouched, before bridging off it', () => {
    // Upstream's shape for a bridge: the block underfoot, laid sideways into the gap ahead.
    const bridge = { x: 0, y: 63, z: 0, dx: 0, dy: 0, dz: 1 }
    const world = fakeBot([ahead({ toPlace: [bridge] })])

    world.standAt(0.5, 64, 0.5)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 64, 1, 0.5))
    world.tick()

    // Turned around and walking backwards to the edge, crouched so it cannot walk off it. Asking
    // for the block from where it stands would be asking for one in mid-air.
    expect(world.did).toContain('sneak')
    expect(world.did).toContain('back')
    expect(world.did).not.toContain('equip')
  })

  it('places once it is standing on the edge', () => {
    const bridge = { x: 0, y: 63, z: 0, dx: 0, dy: 0, dz: 1 }
    const world = fakeBot([ahead({ toPlace: [bridge] })])

    // On the edge the block is laid off.
    world.standAt(0.5, 64, 0.8)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 64, 1, 0.5))
    world.tick()

    expect(world.did).toContain('equip')
  })

  it('still walks and jumps towards a square in its own column', () => {
    // Nothing to face when the square is directly overhead, which is true of a step up onto whatever
    // is above it. Answering that by leaving `head` skipped the walking and the jumping too, and the
    // agent stood underneath doing nothing while the route waited for it to arrive.
    const overhead = {
      x: 0,
      y: 65,
      z: 0,
      hash: '0,65,0',
      cost: 1,
      remainingBlocks: 8,
      toPlace: [],
      toBreak: [],
    }

    const world = fakeBot([overhead])
    const hopping: Simulation = {
      canStraightLine: () => false,
      canWalkJump: () => true,
      canSprintJump: () => false,
      lands: (aim, sprint) => (sprint ? undefined : aim[0]),
    }

    world.standAt(0.5, 64, 0.5)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), hopping)
    driver.start()
    driver.go(within(0, 65, 0, 0.5))
    world.tick()

    expect(world.did).toContain('forward')
    expect(world.did).toContain('jump')
  })

  it('will still sprint-jump to a square a tower starts on', () => {
    // Sprinting is held back on the approach to a rung, so the agent does not carry a sprint into
    // the square it has to pillar out of. Applying that to the *jump* as well made a gap that only a
    // sprint jump clears uncrossable, purely because a tower began on the far side of it.
    const onlyBySprinting: Simulation = {
      canStraightLine: () => false,
      canWalkJump: () => false,
      canSprintJump: () => true,
      lands: (aim, sprint) => (sprint ? aim[0] : undefined),
    }

    const world = fakeBot([
      ahead(),
      {
        x: 0,
        y: 65,
        z: 1,
        hash: '0,65,1',
        cost: 1,
        remainingBlocks: 8,
        toPlace: [{ x: 0, y: 63, z: 1, dx: 0, dy: 1, dz: 0, jump: true }],
        toBreak: [],
      },
    ])

    const running = () => ({ ...world.rules(), sprint: true })
    const driver = new Driver(1, world.bot, running, world.report, hands(), onlyBySprinting)
    driver.start()
    driver.go(within(0, 64, 1, 0.5))

    // The first tick is the turn towards the square; the jump is the one after it.
    world.tick()
    world.tick()

    expect(world.did).toContain('sprint')
    expect(world.did).toContain('jump')
  })

  it('backs into the middle when nothing is reachable, rather than freezing', () => {
    const world = fakeBot([ahead()])

    // Landed on the outer lip of the block, which is where a jump that overshoots leaves it.
    world.standAt(0.05, 64, 0.05)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), refusing)
    driver.start()
    driver.go(within(0, 64, 1, 0.5))
    world.tick()

    // Letting go here is the worst move available: standing still does not change the position the
    // simulation is objecting to, so it would say no for ever. Walked, not crouched.
    expect(world.did).toContain('forward')
    expect(world.did).not.toContain('sneak')
  })

  it('lays the block the square ahead is waiting on', () => {
    const spot = { x: 0, y: 64, z: 1, dx: 0, dy: 1, dz: 0 }
    const { world } = driving([ahead({ toPlace: [spot] })])

    expect(world.said.routes.at(-1)).toMatchObject({ settled: true, steps: 1 })
    expect(world.did).toContain('equip')
  })

  it('breaks the block the square ahead is waiting on', () => {
    const { world } = driving([ahead({ toBreak: [{ x: 0, y: 64, z: 1 }] })])

    expect(world.did).toContain('equip')
  })

  it('breaks before it builds, when a square wants both', async () => {
    const spot = { x: 0, y: 64, z: 1, dx: 0, dy: 1, dz: 0 }
    const { world } = driving([ahead({ toBreak: [{ x: 0, y: 65, z: 1 }], toPlace: [spot] })])

    world.equipping.settle()
    await flush()

    // The dig goes out. The placement waits for the square above it to be clear first.
    expect(world.did).toContain('dig')
    expect(world.did).not.toContain('place')
  })

  it('never sends a placement whose route died while it was equipping', async () => {
    const spot = { x: 0, y: 64, z: 1, dx: 0, dy: 1, dz: 0 }
    const { world, driver } = driving([ahead({ toPlace: [spot] })])

    expect(world.did).toContain('equip')

    // The world changes under the route, so it is thrown away - and only then does the equip land.
    driver.go(within(9, 64, 9, 0.5))
    world.equipping.settle()
    await flush()

    expect(world.did).not.toContain('place')
  })

  it('never sends a dig whose route died while it was equipping', async () => {
    const { world, driver } = driving([ahead({ toBreak: [{ x: 0, y: 64, z: 1 }] })])

    expect(world.did).toContain('equip')

    driver.go(within(9, 64, 9, 0.5))
    world.equipping.settle()
    await flush()

    expect(world.did).not.toContain('dig')
  })

  it('does not re-plan for a block the route meant to lay', () => {
    const spot = { x: 0, y: 64, z: 1, dx: 0, dy: 1, dz: 0 }
    const { world } = driving([ahead({ toPlace: [spot] })])

    const drawn = world.said.routes.length

    // The block the route set out to lay turning up is the plan working, not news. Re-planning on
    // one of these is what threw the route away at every rung of a tower.
    world.block({ x: 0, y: 64, z: 1, type: 0 }, { type: 1 })

    expect(world.said.routes.length).toBe(drawn)
  })

  it('does not re-plan for a block the route meant to break', () => {
    const { world } = driving([ahead({ toBreak: [{ x: 0, y: 64, z: 1 }] })])

    const drawn = world.said.routes.length
    world.block({ x: 0, y: 64, z: 1, type: 1 }, { type: 0 })

    expect(world.said.routes.length).toBe(drawn)
  })

  it('goes on ignoring a planned block after the work is done', async () => {
    const spot = { x: 0, y: 64, z: 1, dx: 0, dy: 1, dz: 0 }
    const { world } = driving([ahead({ toPlace: [spot] })])

    world.equipping.settle()
    await flush()
    world.placing.settle()
    await flush()

    const drawn = world.said.routes.length

    // The step has had its work shifted off it by now. What remembers the block is the stretch, and
    // the update announcing a placement always lands after the placement resolves.
    world.block({ x: 0, y: 64, z: 1, type: 0 }, { type: 1 })

    expect(world.said.routes.length).toBe(drawn)
  })

  it('still knows its own block after the route has been re-planned', async () => {
    const spot = { x: 0, y: 64, z: 1, dx: 0, dy: 1, dz: 0 }
    const { world, driver } = driving([ahead({ toPlace: [spot] })])

    world.equipping.settle()
    await flush()
    world.placing.settle()
    await flush()

    // Something else forces a re-plan, so the stretch that meant to lay that block is gone and the
    // fresh one lists only work still to come. A late update for the laid block must still not count.
    driver.go(within(0, 64, 1, 0.5))
    const drawn = world.said.routes.length

    world.block({ x: 0, y: 64, z: 1, type: 0 }, { type: 1 })

    expect(world.said.routes.length).toBe(drawn)
  })

  it('re-plans for a block somebody else changed', () => {
    const { world } = driving([ahead()])

    const drawn = world.said.routes.length
    world.block({ x: 0, y: 64, z: 1, type: 1 }, { type: 0 })
    world.tick()

    expect(world.said.routes.length).toBeGreaterThan(drawn)
  })

  it('mends one stretch rather than the whole journey', () => {
    const { world, driver } = driving([ahead()])

    const stretches = (driver as unknown as { sections: unknown[] }).sections
    expect(stretches).toHaveLength(1)

    world.block({ x: 0, y: 64, z: 1, type: 1 }, { type: 0 })

    // A mend, not a re-plan: the journey search is not restarted, one stretch is.
    const inner = driver as unknown as { plotting: unknown; mending: { index: number } | undefined }
    expect(inner.plotting).toBeUndefined()
    expect(inner.mending?.index).toBe(0)
  })

  it('will not build on a stretch it is still thinking about', () => {
    const spot = { x: 0, y: 64, z: 1, dx: 0, dy: 1, dz: 0 }
    const { world, driver } = driving([ahead({ toPlace: [spot] })])

    const laid = world.did.filter((what) => what === 'equip').length

    // Something the route did not plan for changes, so the stretch is up for reconsideration.
    world.block({ x: 1, y: 64, z: 1, type: 1 }, { type: 0 })
    const inner = driver as unknown as { mending: unknown }
    expect(inner.mending).toBeDefined()

    world.tick()
    world.tick()

    expect(world.did.filter((what) => what === 'equip').length).toBe(laid)
  })

  it('ignores a change nowhere near the route', () => {
    const { world } = driving([ahead()])

    const drawn = world.said.routes.length
    world.block({ x: 40, y: 64, z: 40, type: 1 }, { type: 0 })

    expect(world.said.routes.length).toBe(drawn)
  })

  it('says it arrived once it is standing on the last square', () => {
    const { world } = driving([ahead()])

    world.standAt(0.5, 64, 1.5)
    world.tick()

    expect(world.said.arrived).toBe(1)
  })

  it('gives up when a second search also cannot reach the goal', () => {
    // The closest it can get is walked once - the world may have more of itself loaded by the time
    // the agent arrives. Planning again from where it stops is the same search with the same answer,
    // and the agent shuffles forward for ever.
    const world = fakeBot([ahead()])
    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)

    driver.start()
    driver.go(within(40, 64, 40, 0.5))
    world.tick()

    expect(world.said.lost).toEqual([])
    expect(world.said.routes.at(-1)?.steps).toBe(1)

    // A stall plans again, which is the loop this guards.
    const inner = driver as unknown as { movedAt: number }
    inner.movedAt = Date.now() - 60_000
    world.tick()
    world.tick()

    expect(world.said.lost).toEqual(['there is no route there'])
  })

  it('will not break the ground it later means to stand on', () => {
    // The search prices every square against the world as it is now, so a route can dig through a
    // floor at step one and expect to stand on it at step ten. The agent then falls through it.
    const digging = {
      x: 0,
      y: 64,
      z: 1,
      hash: '0,64,1',
      cost: 1,
      remainingBlocks: 8,
      toPlace: [],
      // The second of these is the block under the step itself - the floor it lands on.
      toBreak: [
        { x: 0, y: 65, z: 1 },
        { x: 0, y: 63, z: 1 },
      ],
    }

    const { world, driver } = driving([digging])

    const walked = driver as unknown as { sections: Array<{ steps: Array<{ toBreak: unknown[] }> }> }
    const breaking = walked.sections[0]?.steps[0]?.toBreak ?? []

    // The one at head height is still broken; the floor is not.
    expect(breaking).toEqual([{ x: 0, y: 65, z: 1 }])
    expect(world.said.lost).toEqual([])
  })

  it('still breaks a block it means to put back', () => {
    // A rung clears the block two above its head to have room to jump, and the next rung stands at
    // that height - on a block this same route lays there. Protecting it left the agent under a
    // ceiling it was never allowed to remove, unable to clear its own square.
    const clearing = {
      x: 0,
      y: 66,
      z: 0,
      hash: '0,66,0',
      cost: 1,
      remainingBlocks: 8,
      toPlace: [{ x: 0, y: 64, z: 0, dx: 0, dy: 1, dz: 0, jump: true }],
      toBreak: [{ x: 0, y: 66, z: 0 }],
    }

    const world = fakeBot([clearing])
    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 66, 0, 0.5))
    world.tick()

    const walked = driver as unknown as { sections: Array<{ steps: Array<{ toBreak: unknown[] }> }> }

    // 66 is where the next rung stands *and* where this route lays a block, so the break survives.
    expect(walked.sections[0]?.steps[0]?.toBreak).toHaveLength(1)
  })

  it('says it is building while the route still has blocks to lay', () => {
    // Housekeeping asks this before it takes the hands. A tower is one job per rung and the queue
    // only sees the rung it is on, so between two of them there is nothing queued - and anything
    // less important was stepping in for the best part of a second, every third block.
    const spot = { x: 0, y: 64, z: 1, dx: 0, dy: 1, dz: 0 }
    const { driver } = driving([ahead({ toPlace: [spot] })])

    expect(driver.building()).toBe(true)
  })

  it('is not building when the route is only walking', () => {
    const { driver } = driving([ahead()])

    expect(driver.building()).toBe(false)
  })

  it('tells the difference between no route and no world', () => {
    // A square the rules offer no move at all from is not a dead end - a dead end still has the way
    // back. It is a world that has not arrived, and saying "there is no route there" about it sends
    // whoever reads it looking for an obstacle that does not exist.
    const { world } = driving([])

    expect(world.said.lost).toEqual(['the world around it has not arrived yet'])
  })

  it('fails the journey rather than the process when the rules throw', () => {
    const world = fakeBot([])
    const driver = new Driver(
      1,
      world.bot,
      () => ({
        ...world.rules(),
        movements: {
          getNeighbors: () => {
            throw new Error('the rules asked the bot something it could not answer')
          },
          countScaffoldingItems: () => 8,
          getScaffoldingItem: () => null,
          emptyBlocks: new Set<number>(),
        } as unknown as Rules['movements'],
      }),
      world.report,
      hands(),
      onFoot,
    )

    driver.start()
    driver.go(within(0, 64, 1, 0.5))

    // This runs from a physicsTick handler, so a throw that got out would leave the process - and
    // every other agent's session in it - gone.
    expect(() => world.tick()).not.toThrow()
    expect(world.said.lost).toEqual(['it could not work out how to get there'])
  })

  it('does not count thinking against the stall clock', () => {
    const world = fakeBot([ahead()])
    const driver = new Driver(
      1,
      world.bot,
      // Never settles, the way ground with a lot of verticality in it does not settle quickly.
      () => ({ ...world.rules(), slice: -1 }),
      world.report,
      hands(),
      onFoot,
    )

    driver.start()
    driver.go(within(0, 64, 1, 0.5))

    // Long past the stall timer. Tripping it would re-plan, which throws the search away and starts
    // another that takes just as long - a route through anything difficult could never finish.
    const inner = driver as unknown as { movedAt: number }
    inner.movedAt = Date.now() - 60_000
    world.tick()

    expect(inner.movedAt).toBeGreaterThan(Date.now() - 1_000)
    expect(world.said.lost).toEqual([])
  })

  it('stands still rather than pacing while the search is still thinking', () => {
    const world = fakeBot([ahead()])
    const driver = new Driver(
      1,
      world.bot,
      // A slice of no time at all: every answer comes back unfinished.
      () => ({ ...world.rules(), slice: -1 }),
      world.report,
      hands(),
      onFoot,
    )

    driver.start()
    driver.go(within(0, 64, 1, 0.5))
    world.tick()
    world.tick()

    // Walking a guess that changes every slice is what paced the agent back and forth on the spot.
    expect(world.did.filter((what) => what !== 'still')).toEqual([])
  })

  it('is not at a step it is still jumping up towards', () => {
    const spot = { x: 0, y: 64, z: 1, dx: 0, dy: 1, dz: 0 }
    const { world, driver } = driving([ahead({ toPlace: [spot] })])

    // Partway up the jump: within a block of the step above, and not standing on anything.
    world.standAt(0.5, 64.8, 1.5, false)
    world.tick()

    const walked = driver as unknown as { sections: Array<{ steps: unknown[] }> }
    expect(walked.sections[0]?.steps).toHaveLength(1)
  })

  it('is at a step once it has landed on it', async () => {
    const { world, driver } = driving([ahead()])

    world.standAt(0.5, 64, 1.5, true)
    world.tick()

    expect(world.said.arrived).toBe(1)
    expect(driver.moving()).toBe(false)
  })

  it('asks again when the window to place is missed, rather than giving up the tower', async () => {
    const spot = { x: 0, y: 64, z: 1, dx: 0, dy: 1, dz: 0, jump: true }
    const world = fakeBot([ahead({ toPlace: [spot] })])
    world.refuse(2)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 64, 1, 0.5))
    world.tick()

    world.equipping.settle()
    await flush()
    world.placing.settle()
    await flush()

    // Two refused windows and a third that landed - one job, not three re-plans.
    expect(world.did.filter((what) => what === 'place')).toHaveLength(3)
    expect(world.said.lost).toEqual([])
  })

  /**
   * A corridor along +z, walled off after `far` squares.
   *
   * What a search of a journey longer than one budget looks like from the driver's side: a route
   * that stops somewhere short of where the agent was sent, with more world beyond it that nothing
   * has looked at yet. Moving the wall is how a test says "and then the rest of it arrived".
   */
  function corridor(far: () => number) {
    return (from: { x: number; y: number; z: number; remainingBlocks: number }) => {
      const z = from.z + 1
      if (z > far()) return []

      return [{ x: 0, y: 64, z, hash: `0,64,${z}`, cost: 1, remainingBlocks: 8, toPlace: [], toBreak: [] }]
    }
  }

  /** A driver walking a corridor, sent somewhere further along it than it can see. */
  function walkingUp(far: () => number, to: number) {
    const world = fakeBot([])
    const rules = () => ({ ...world.rules(), movements: { ...world.rules().movements, getNeighbors: corridor(far) } as unknown as Rules['movements'] })

    const driver = new Driver(1, world.bot, rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 64, to, 0.5))
    world.tick()

    /** Walks the agent to the middle of one square and lets the driver see it there. */
    const stepTo = (z: number) => {
      world.standAt(0.5, 64, z + 0.5)
      world.tick()
    }

    return { world, driver, stepTo }
  }

  it('carries a route on from where it stops, rather than calling that arrival', () => {
    // The route it can find ends at z=5; it was sent to z=12.
    let wall = 5
    const { world, driver, stepTo } = walkingUp(() => wall, 12)

    for (let z = 1; z <= 5; z++) stepTo(z)

    // Standing on the last square of a route that never reached the goal. Nothing has arrived.
    expect(world.said.arrived).toBe(0)
    expect(driver.moving()).toBe(true)

    // The rest of the world turns up, and the search already looking on from z=5 finds the goal.
    wall = 12
    world.tick()
    world.tick()

    for (let z = 6; z <= 12; z++) stepTo(z)

    expect(world.said.arrived).toBe(1)
  })

  it('looks for the rest of the journey before it runs out of route', () => {
    let wall = 5
    const { world, stepTo } = walkingUp(() => wall, 12)

    const drawn = world.said.routes.length
    wall = 12

    // One step walked, four still ahead of it - and the route is already longer than it was.
    stepTo(1)
    world.tick()

    expect(world.said.routes.length).toBeGreaterThan(drawn)
    expect(world.said.routes[world.said.routes.length - 1]?.steps).toBeGreaterThan(4)
  })

  it('gives up when there is no way on from where the route ends', () => {
    const wall = 5
    const { world, stepTo } = walkingUp(() => wall, 12)

    for (let z = 1; z <= 5; z++) stepTo(z)

    // Every tick from here is another chance to look; none of them may cost another whole search.
    for (const _ of [1, 2, 3, 4, 5]) world.tick()

    // One answer, not one per tick: the wall is still a wall, and re-asking costs a whole search.
    expect(world.said.lost).toHaveLength(1)
    expect(world.said.arrived).toBe(0)
  })

  /**
   * A route laid out square by square, each one offering only the next.
   *
   * Enough of a world to put a step in the *middle* of a route, which the single-square worlds above
   * cannot: the last square of a journey is braked into whatever it is, so a test about how the
   * agent comes into a hole has to have the hole somewhere other than the end.
   */
  function trail(squares: Array<{ x: number; y: number; z: number; parkour?: boolean }>) {
    const walk = squares.map((where) => ({
      ...where,
      hash: `${where.x},${where.y},${where.z}`,
      cost: 1,
      remainingBlocks: 8,
      toPlace: [],
      toBreak: [],
    }))

    return (at: { hash: string }) => {
      const on = walk.findIndex((square) => square.hash === at.hash)
      if (on < 0) return walk.slice(0, 1)
      return walk.slice(on + 1, on + 2)
    }
  }

  /** A driver walking a trail, coming into its first square at speed. */
  function coming(squares: Array<{ x: number; y: number; z: number }>) {
    const world = fakeBot([])
    const rules = () => ({
      ...world.rules(),
      movements: { ...world.rules().movements, getNeighbors: trail(squares) } as unknown as Rules['movements'],
    })

    // Most of the way across its own square and still moving, which is where every one of these
    // decisions is actually taken.
    world.standAt(0.5, 64, 0.9)
    world.drift(0, 0.25)

    const last = squares[squares.length - 1]!
    const driver = new Driver(1, world.bot, rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(last.x, last.y, last.z, 0.5))
    world.tick()

    return world
  }

  it('brakes into a hole rather than running over it', () => {
    // Three down and one along: a hole, not a step. A walk crosses the fifth of a block where
    // nothing is underneath it before it has fallen far enough to be committed, and lands on the
    // far lip - from where the square it wants is behind it, and it comes back at the same speed.
    const world = coming([
      { x: 0, y: 61, z: 1 },
      { x: 0, y: 61, z: 2 },
    ])

    // Stopped rather than aimed at: a brake presses against the way it is going and never looks.
    expect(world.did).not.toContain('look')
    expect(world.did).not.toContain('sprint')
  })

  it('walks off an ordinary step down without stopping first', () => {
    const world = coming([
      { x: 0, y: 63, z: 1 },
      { x: 0, y: 63, z: 2 },
    ])

    // Every descent is made of these, and braking at each one would be a staircase taken a step a
    // second. The simulation says it can walk there, so it aims at it and walks.
    expect(world.did).toContain('look')
  })

  /** A driver climbing a step, with whatever comes after it. */
  function climbing(squares: Array<{ x: number; y: number; z: number; parkour?: boolean }>) {
    const world = fakeBot([])
    const rules = () => ({
      ...world.rules(),
      sprint: true,
      movements: { ...world.rules().movements, getNeighbors: trail(squares) } as unknown as Rules['movements'],
    })

    world.standAt(0.5, 64, 0.5)

    const last = squares[squares.length - 1]!
    const driver = new Driver(1, world.bot, rules, world.report, hands(), jumpable)
    driver.start()
    driver.go(within(last.x, last.y, last.z, 0.5))

    // Two ticks: the squares are at +z and the fake bot starts facing -z, so the first is the
    // turn - no jump leaves the ground until the agent is pointed at where it is going.
    world.tick()
    world.tick()

    return world
  }

  it('takes the jump that lands where it aimed when nothing ahead needs the speed', () => {
    // A staircase into more staircase. A sprint jump carries most of a block past a short hop, and
    // a block past the square it aimed at is off the far side of it - which is how one died.
    const world = climbing([
      { x: 0, y: 65, z: 1 },
      { x: 0, y: 66, z: 2 },
    ])

    expect(world.did).toContain('jump')
    expect(world.did).not.toContain('sprint')
  })

  it('picks the sprint up before a gap that only a run clears', () => {
    // The same staircase, with a parkour jump two squares away. One square is not a run-up, so the
    // speed has to be there before the last step - which is what a flight of gentle jumps destroys.
    const world = climbing([
      { x: 0, y: 65, z: 1 },
      { x: 0, y: 65, z: 4, parkour: true },
    ])

    expect(world.did).toContain('jump')
    expect(world.did).toContain('sprint')
  })

  it('lands softly on the last square, where there is nothing to carry speed into', () => {
    const world = fakeBot([])
    const rules = () => ({
      ...world.rules(),
      sprint: true,
      movements: { ...world.rules().movements, getNeighbors: trail([{ x: 0, y: 65, z: 1 }]) } as unknown as Rules['movements'],
    })

    world.standAt(0.5, 64, 0.5)

    const driver = new Driver(1, world.bot, rules, world.report, hands(), jumpable)
    driver.start()
    driver.go(within(0, 65, 1, 0.5))

    // The first tick is the turn: the square is at +z and the fake bot starts facing -z.
    world.tick()
    world.tick()

    // A sprint jump carries most of a block past a one block hop, and there is no next square to
    // pull the agent back onto its line.
    expect(world.did).toContain('jump')
    expect(world.did).not.toContain('sprint')
  })

  it('takes the sideways drift out of a walk, so a jump goes where it is looking', () => {
    const world = fakeBot([ahead()])

    // Facing -z, and crabbing to its right. Its box is 0.6 wide in a square of 1, so a drift this
    // small still puts a shoulder into the column next door on the way up - which is the jump that
    // stopped dead against a block the route never went near.
    world.standAt(0.5, 64, 0.5)
    world.drift(0.12, -0.1)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 64, 1, 0.5))
    world.tick()

    // Pressed against the drift, and still walking: a crouch would cost the speed the next gap needs.
    expect(world.did).toContain('left')
    expect(world.did).not.toContain('sneak')
  })

  /**
   * A simulation that promises a jump only later, which is what a run-up looks like from inside.
   *
   * `canStraightLine` says yes for "walk a few ticks and *then* jump", and every jump-now question
   * says no. Over ground that is a late jump; at a gap it is the difference between jumping and
   * walking into thin air.
   */
  const laterOnly: Simulation = {
    canStraightLine: () => true,
    canSprintJump: () => false,
    canWalkJump: () => false,
    lands: () => undefined,
  }

  /**
   * A driver at the lip of a three block gap, with more route on the far side.
   *
   * The far side matters: a gap that ends the journey is a square the agent has to stop in, and the
   * whole sprint question is suppressed there - which is how the first version of this test passed
   * without the guard it was written for.
   */
  function atAGap(physics: Simulation) {
    const world = fakeBot([])
    const rules = () => ({
      ...world.rules(),
      sprint: true,
      movements: {
        ...world.rules().movements,
        getNeighbors: trail([
          { x: 0, y: 64, z: 3, parkour: true },
          { x: 0, y: 64, z: 4 },
        ]),
      } as unknown as Rules['movements'],
    })

    // A tenth of a block of ledge left, facing -z. Another step is thin air.
    world.standAt(0.5, 64, 0.1)

    const driver = new Driver(1, world.bot, rules, world.report, hands(), physics)
    driver.start()
    driver.go(within(0, 64, 4, 0.5))
    world.tick()

    return world
  }

  it('stops at the lip of a gap it cannot jump yet, rather than running off it', () => {
    // Measured from the agent this was written for: it reached a three block gap at 0.11 a tick,
    // kept running because a jump *later* would have worked, and fell thirty blocks. That later
    // jump is what `canStraightLine` says yes to, and nothing here ever takes it.
    const world = atAGap(laterOnly)

    expect(world.did).not.toContain('sprint')
    expect(world.did).not.toContain('jump')
  })

  it('waits for the turn before a step up, not only before a gap', () => {
    // The gap branch has waited for the turn since a jump taken mid-rotation left along the old
    // heading and clipped the far block. Every other jump - a step up, a hop, a sprint jump onto
    // the next square - went through the ladder below it, which never waited, and the
    // simulations there have the same blind spot: they snap their player onto the bearing before
    // the first tick.
    const world = fakeBot([])
    const rules = () => ({
      ...world.rules(),
      movements: {
        ...world.rules().movements,
        getNeighbors: trail([
          { x: 3, y: 65, z: 0 },
          { x: 4, y: 65, z: 0 },
        ]),
      } as unknown as Rules['movements'],
    })

    // Facing -z, which is a quarter turn away from the step, which is off to +x.
    world.standAt(0.5, 64, 0.5)

    const driver = new Driver(1, world.bot, rules, world.report, hands(), jumpable)
    driver.start()
    driver.go(within(4, 65, 0, 0.5))
    world.tick()

    expect(world.did).not.toContain('jump')

    // The turn lands on the next tick, the way mineflayer animates one.
    world.tick()

    expect(world.did).toContain('jump')
  })

  it('flies the heading it left the ground on, rather than arcing round to the square', () => {
    // Re-aiming every tick is right on the ground and bends a jump in the air: as the agent
    // drifts off the line the bearing swings and the thrust swings with it. Measured over one
    // course, the straight jumps bent a hundredth of a block off the line and the corners bent
    // 0.09 to 0.32 - and a 0.6 wide box has about a fifth of a block of slack in a square. The
    // landing question simulates a straight line, so a straight line is what has to be flown.
    const world = atAGap(jumpable)
    world.tick()

    expect(world.did).toContain('jump')

    // The bearing it left on: straight down +z, from the middle of the block it took off from.
    const left = world.bot.entity.yaw

    // Airborne and most of a block off the line, which is where re-aiming would swing hardest.
    world.standAt(1.4, 65.2, 2, false)
    world.tick()
    world.tick()

    expect(world.bot.entity.yaw).toBeCloseTo(left, 2)
  })

  it('turns to face a gap before leaving the ground, and jumps once it has', () => {
    const world = atAGap(jumpable)

    // The gap is behind where it happens to be looking, and turning is not instant. Jumping now
    // would take off along the old heading: three blocks later that is the edge of the block.
    expect(world.did).not.toContain('jump')

    world.tick()

    expect(world.did).toContain('jump')
  })

  it('will not take a jump that only passes over the square on its way past', () => {
    // The whole of what upstream asks is whether the arc comes within a third of a block of the
    // target at some tick of it - at any height, at any speed. An arc that crosses the square at
    // head height and comes down a block beyond it answers yes for the same reason as one that
    // lands on the middle, and over a gap the block beyond it is the void. Measured: a corner
    // taken at 0.292 was 0.98 past the far edge half a second later, on its way down 84 blocks.
    const flyingPast: Simulation = {
      canStraightLine: () => false,
      canWalkJump: () => true,
      canSprintJump: () => true,
      lands: (aim) => aim[0]?.offset(0, 0, 1),
    }

    const world = atAGap(flyingPast)
    world.tick()
    world.tick()

    expect(world.did).not.toContain('jump')
  })

  it('uses the sprint when it is the only jump that comes down on the square', () => {
    // The other half of the same rule: the gentler jump is preferred, and preferred is not the
    // same as taken regardless. A walk that falls short of a three block gap is not a landing.
    const onlyTheRun: Simulation = {
      canStraightLine: () => false,
      canWalkJump: () => true,
      canSprintJump: () => true,
      lands: (aim, sprint) => (sprint ? aim[0] : aim[0]?.offset(0, 0, -2)),
    }

    const world = atAGap(onlyTheRun)
    world.tick()

    expect(world.did).toContain('jump')
    expect(world.did).toContain('sprint')
  })

  it('will not take a jump the simulation puts down at the bottom of the gap', () => {
    // A gap has a floor, and that floor is directly under the square being jumped to - so a
    // landing thirty six blocks down floors to the same column as a good one. Recorded tick by
    // tick: the simulation had the agent hitting the block's near face, dropping to y 107, and
    // coming to rest at x and z that matched the target exactly. The jump was taken because the
    // simulation predicted a fall.
    const intoThePit: Simulation = {
      canStraightLine: () => false,
      canWalkJump: () => true,
      canSprintJump: () => true,
      lands: (aim) => aim[0]?.offset(0, -36, 0),
    }

    const world = atAGap(intoThePit)
    world.tick()
    world.tick()

    expect(world.did).not.toContain('jump')
  })

  it('does not strafe on the tick a jump goes out', () => {
    // The damper runs after the decision, so a strafe pressed on the takeoff tick is held through
    // it - and Minecraft normalises the movement input, leaving about seven tenths of the thrust
    // forward on the one tick where all of it matters. Recorded from two jumps on one course:
    // `f j s` at takeoff went 0.059 to 0.382 a tick, `f r j s` went 0.203 to 0.302.
    //
    // A step up rather than a gap, because a gap now sheds its sideways momentum before it jumps
    // at all - see the corner test above. Every other jump still leaves the ground from here.
    const world = fakeBot([])
    const rules = () => ({
      ...world.rules(),
      movements: {
        ...world.rules().movements,
        getNeighbors: trail([
          { x: 0, y: 65, z: 1 },
          { x: 0, y: 65, z: 2 },
        ]),
      } as unknown as Rules['movements'],
    })

    world.standAt(0.5, 64, 0.5)

    const driver = new Driver(1, world.bot, rules, world.report, hands(), jumpable)
    driver.start()
    driver.go(within(0, 65, 2, 0.5))

    // A tick for the heading to catch up, which the fake turn applies on the next one.
    world.tick()

    // Walking a fraction crabwise, which on any other tick is exactly what the damper is for.
    world.drift(0.2, 0.25)

    const before = world.did.length
    world.tick()
    const takeoff = world.did.slice(before)

    expect(takeoff).toContain('jump')
    expect(takeoff).not.toContain('left')
    expect(takeoff).not.toContain('right')
  })

  it('does not pick the sprint up again once a walk jump is in the air', () => {
    // `canStraightLine` asked with sprint is true from mid-flight, because its two hundred ticks
    // include the landing and the walk after it. So one tick after every walk jump the sprint
    // came back on, and the agent flew a jump it was never given: over one course all fifteen
    // sprint jumps landed within 0.005 of the simulation and all seven walk jumps landed 0.29
    // to 1.43 past it. The last was 0.42 past, one square past, into the gap.
    const world = fakeBot([])
    const rules = () => ({
      ...world.rules(),
      sprint: true,
      movements: {
        ...world.rules().movements,
        getNeighbors: trail([
          { x: 0, y: 64, z: 3, parkour: true },
          { x: 0, y: 64, z: 4 },
        ]),
      } as unknown as Rules['movements'],
    })

    // Says a straight run reaches, which is what it says to an agent halfway across a gap.
    const driver = new Driver(1, world.bot, rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 64, 4, 0.5))

    world.standAt(0.5, 65.2, 1.9, false)
    world.drift(0, 0.25)

    const before = world.did.length
    world.tick()

    expect(world.did.slice(before)).not.toContain('sprint')
  })

  it('does not strafe against its own drift while it is in the air', () => {
    // Taking the drift out is worth a side key on the ground and costs one in the air, because
    // Minecraft normalises the movement input: forward and a strafe together leave about seven
    // tenths of the thrust pointing forward, and the jump was chosen on a simulation holding
    // forward and nothing else. Measured on the one gap of a course that failed - the only
    // flight with drift to correct - the jump was picked for 3.83 blocks and travelled 3.25.
    const world = fakeBot([])
    const rules = () => ({
      ...world.rules(),
      movements: {
        ...world.rules().movements,
        getNeighbors: trail([
          { x: 0, y: 64, z: 3, parkour: true },
          { x: 0, y: 64, z: 4 },
        ]),
      } as unknown as Rules['movements'],
    })

    const driver = new Driver(1, world.bot, rules, world.report, hands(), refusing)
    driver.start()
    driver.go(within(0, 64, 4, 0.5))

    // A tick on the ground first, so the heading has caught up by the time it matters.
    world.standAt(0.5, 64, 0.5)
    world.tick()

    // Airborne, crossing the gap, carrying the sideways momentum a ninety degree turn leaves.
    world.standAt(0.5, 65.2, 1.9, false)
    world.drift(0.2, 0.25)

    const before = world.did.length
    world.tick()
    const inTheAir = world.did.slice(before)

    expect(inTheAir).not.toContain('left')
    expect(inTheAir).not.toContain('right')
  })

  it('never brakes a jump that is already in the air', () => {
    const world = fakeBot([])
    const rules = () => ({
      ...world.rules(),
      movements: {
        ...world.rules().movements,
        getNeighbors: trail([
          { x: 0, y: 64, z: 3, parkour: true },
          { x: 0, y: 64, z: 4 },
        ]),
      } as unknown as Rules['movements'],
    })

    // Refuses everything, which is what every simulation does while the agent is off the ground:
    // the block it would push off is below it and receding. So a flight always ends up at the
    // last branch of the ladder, whatever it is.
    const driver = new Driver(1, world.bot, rules, world.report, hands(), refusing)
    driver.start()
    driver.go(within(0, 64, 4, 0.5))

    // A tick on the ground first, because the fake turn lands on the next one exactly as
    // mineflayer’s does - without it the agent is still facing where it started.
    world.standAt(0.5, 64, 0.5)
    world.tick()

    // Now halfway across the gap, off the middle of the square it is passing over - which on the
    // ground is exactly the cue to shuffle back towards it - and travelling the way it is
    // looking, which is the direction a brake presses against.
    world.standAt(0.9, 65.2, 1.9, false)
    world.drift(0, 0.25)

    const before = world.did.length
    world.tick()
    const inTheAir = world.did.slice(before)

    // Measured with the takeoff line beside it: a jump that left the ground at 0.203 for a square
    // 3.8 blocks away was 1.3 blocks along at 0.034 half a second later, already below the height
    // it started from, and fell 79 blocks. Air acceleration is about 0.02 a tick, so twelve ticks
    // of counter-strafe is the whole of a jump.
    expect(inTheAir).not.toContain('back')
    expect(inTheAir).toContain('forward')
  })

  it('counts a gap cleared by a hair as cleared, rather than jumping again from the lip', () => {
    const world = atAGap(jumpable)
    const jumps = world.did.filter((what) => what === 'jump').length

    // Down on the far lip: half a block from the middle, which is not "arrived" for any ordinary
    // step - and asking for the middle from here means taking the same jump again, off the far side.
    world.standAt(0.5, 64, 3.92)
    world.tick()

    // No second jump went out, and the square is behind it: walking onto the next one finishes
    // the journey, which it cannot do while the driver still thinks the gap is ahead of it.
    expect(world.did.filter((what) => what === 'jump').length).toBe(jumps)

    world.standAt(0.5, 64, 4.5)
    world.tick()

    expect(world.said.arrived).toBe(1)
  })

  it('does not run into a square it has to build from', () => {
    // The square after this one lays the block the agent means to stand on next. A sprint carries
    // most of a block past where it stopped meaning to be, and the block goes down after the agent
    // has already gone by - which is a placement into thin air and a fall.
    const world = fakeBot([])
    const rules = () => ({
      ...world.rules(),
      sprint: true,
      movements: {
        ...world.rules().movements,
        getNeighbors: (at: { hash: string }) => {
          if (at.hash === '0,64,0') {
            return [{ x: 0, y: 64, z: 1, hash: '0,64,1', cost: 1, remainingBlocks: 8, toPlace: [], toBreak: [] }]
          }
          if (at.hash === '0,64,1') {
            return [
              {
                x: 0,
                y: 64,
                z: 2,
                hash: '0,64,2',
                cost: 3,
                remainingBlocks: 7,
                toPlace: [{ x: 0, y: 63, z: 1, dx: 0, dy: 0, dz: 1 }],
                toBreak: [],
              },
            ]
          }
          return []
        },
      } as unknown as Rules['movements'],
    })

    world.standAt(0.5, 64, 0.5)

    const driver = new Driver(1, world.bot, rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 64, 2, 0.5))
    world.tick()

    expect(world.did).not.toContain('sprint')
  })

  it('plans again the moment it finds itself under its own route', () => {
    const world = fakeBot([ahead()])

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 64, 1, 0.5))
    world.tick()

    const drawn = world.said.routes.length

    // A missed jump: thirty blocks below the square the route is still steering towards. Waiting for
    // the stall clock to work that out costs seconds of falling and deciding it is centred already.
    world.standAt(0.5, 34, 0.5)
    world.tick()
    world.tick()

    expect(world.said.routes.length).toBeGreaterThan(drawn)
  })

  it('lets go of everything when told to stop', () => {
    const { world, driver } = driving([ahead()])

    driver.halt()

    expect(driver.moving()).toBe(false)
    expect(world.did).toContain('still')
  })
})
