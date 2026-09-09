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
function held<T>() {
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
  equipping: ReturnType<typeof held<void>>
  placing: ReturnType<typeof held<void>>
  digging: ReturnType<typeof held<void>>
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
  const equipping = held<void>()
  const placing = held<void>()
  const digging = held<void>()

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
    },
    setControlState: (name: string, on: boolean) => {
      if (on) did.push(name)
    },
    look() {},
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

  it('shuffles to the middle of the column before pillaring out of it', () => {
    const world = fakeBot([rung()])

    // Stopped near the lip of the square. A jump goes straight up, so wherever it stands is where
    // the whole tower goes - and a pillar built off the edge of each block is one it keeps having
    // to catch itself on.
    world.standAt(0.05, 64, 0.5)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 65, 0, 0.5))
    world.tick()

    // Crouched, and moving without turning: facing the middle is what a tower cannot have.
    expect(world.did).toContain('sneak')
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
    // simulation is objecting to, so it would say no for ever.
    expect(world.did).toContain('sneak')
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

  it('lets go of everything when told to stop', () => {
    const { world, driver } = driving([ahead()])

    driver.halt()

    expect(driver.moving()).toBe(false)
    expect(world.did).toContain('still')
  })
})
