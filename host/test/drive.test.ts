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

  it('shuffles to the middle before pillaring out of a square', () => {
    const world = fakeBot([rung()])

    // Arrived at the edge, the way momentum leaves an agent that stopped by letting go.
    world.standAt(0.05, 64, 0.05)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 65, 0, 0.5))
    world.tick()

    expect(world.did).toContain('sneak')
    expect(world.did).not.toContain('equip')
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

  it('builds once it is standing in the middle', () => {
    const world = fakeBot([rung()])

    world.standAt(0.5, 64, 0.5)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 65, 0, 0.5))
    world.tick()

    expect(world.did).toContain('equip')
    expect(world.did).not.toContain('sneak')
  })

  it('does not nudge an agent off the edge it is bridging from', () => {
    // A block going into a square the agent is not standing in is a bridge, and the edge is exactly
    // where it has to be to see the face it builds against.
    const world = fakeBot([ahead({ toPlace: [{ x: 0, y: 64, z: 2, dx: 0, dy: -1, dz: 0 }] })])

    world.standAt(0.05, 64, 0.05)

    const driver = new Driver(1, world.bot, world.rules, world.report, hands(), onFoot)
    driver.start()
    driver.go(within(0, 64, 1, 0.5))
    world.tick()

    expect(world.did).not.toContain('sneak')
    expect(world.did).toContain('equip')
  })

  it('lays the block the square ahead is waiting on', () => {
    const spot = { x: 0, y: 63, z: 1, dx: 0, dy: 1, dz: 0 }
    const { world } = driving([ahead({ toPlace: [spot] })])

    expect(world.said.routes.at(-1)).toMatchObject({ settled: true, steps: 1 })
    expect(world.did).toContain('equip')
  })

  it('breaks the block the square ahead is waiting on', () => {
    const { world } = driving([ahead({ toBreak: [{ x: 0, y: 64, z: 1 }] })])

    expect(world.did).toContain('equip')
  })

  it('breaks before it builds, when a square wants both', async () => {
    const spot = { x: 0, y: 63, z: 1, dx: 0, dy: 1, dz: 0 }
    const { world } = driving([ahead({ toBreak: [{ x: 0, y: 65, z: 1 }], toPlace: [spot] })])

    world.equipping.settle()
    await flush()

    // The dig goes out. The placement waits for the square above it to be clear first.
    expect(world.did).toContain('dig')
    expect(world.did).not.toContain('place')
  })

  it('never sends a placement whose route died while it was equipping', async () => {
    const spot = { x: 0, y: 63, z: 1, dx: 0, dy: 1, dz: 0 }
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
    const spot = { x: 0, y: 63, z: 1, dx: 0, dy: 1, dz: 0 }
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
    const spot = { x: 0, y: 63, z: 1, dx: 0, dy: 1, dz: 0 }
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
    const spot = { x: 0, y: 63, z: 1, dx: 0, dy: 1, dz: 0 }
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
    const spot = { x: 0, y: 63, z: 1, dx: 0, dy: 1, dz: 0 }
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

  it('says there is no route when the search cannot find one', () => {
    const { world } = driving([])

    expect(world.said.lost).toEqual(['there is no route there'])
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
    const spot = { x: 0, y: 63, z: 1, dx: 0, dy: 1, dz: 0 }
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
    const spot = { x: 0, y: 63, z: 1, dx: 0, dy: 1, dz: 0, jump: true }
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
