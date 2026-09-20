import { describe, expect, it } from 'vitest'
import { Vec3 as WorldVec } from 'vec3'
import type { Bot } from 'mineflayer'

import {
  awayFrom,
  type BlockAt,
  clearLine,
  cornerSpeed,
  FlightDriver,
  type FlightReport,
  type FlightRules,
  flyingFrom,
  standable,
  straighten,
  takeoff,
  turnSpeed,
} from '../src/agent/path/fly.ts'
import { cell } from '../src/agent/path/fly.ts'

const STONE = { name: 'stone', boundingBox: 'block' }
const AIR = { name: 'air', boundingBox: 'empty' }

/**
 * Stone up to y 63, air above, and whatever else a test says. Nothing past `edge` has been sent, and
 * nothing above y 96 - a world without a ceiling is an unbounded search for anything unreachable.
 */
function world(extra: Record<string, typeof STONE> = {}, edge = 64): BlockAt {
  return (x, y, z) => {
    if (Math.abs(x) > edge || Math.abs(z) > edge || y > 96) return null
    return extra[`${x},${y},${z}`] ?? (y <= 63 ? STONE : AIR)
  }
}

/** A wall of stone across x = `at`, from z -`half` to `half`, `height` high above the ground. */
function wall(at: number, half: number, height: number): Record<string, typeof STONE> {
  const blocks: Record<string, typeof STONE> = {}
  for (let z = -half; z <= half; z++) for (let y = 64; y < 64 + height; y++) blocks[`${at},${y},${z}`] = STONE
  return blocks
}

describe('the air a player fits in', () => {
  it('offers every direction in open air', () => {
    expect(flyingFrom(world())(cell(0, 70, 0))).toHaveLength(26)
  })

  it('does not cut the corner of a block', () => {
    // A block beside the square: the diagonal past it would clip its edge.
    const offered = flyingFrom(world({ '1,70,0': STONE }))(cell(0, 70, 0))
    const hashes = offered.map((step) => step.hash)

    expect(hashes).not.toContain('1,70,0')
    expect(hashes).not.toContain('1,70,1')
    expect(hashes).toContain('0,70,1')
  })

  it('treats a world that has not been sent as closed', () => {
    const offered = flyingFrom(world({}, 0))(cell(0, 70, 0))
    expect(offered.every((step) => step.x === 0 && step.z === 0)).toBe(true)
  })

  it('lands only on ground that does not hurt', () => {
    expect(standable(world(), 0, 64, 0)).toBe(true)
    expect(standable(world(), 0, 70, 0)).toBe(false)
    expect(standable(world({ '0,63,0': { name: 'magma_block', boundingBox: 'block' } }), 0, 64, 0)).toBe(false)
  })

  /**
   * A square a block is about to go in: open air by every reading of the world, and the one place
   * the agent must not be.
   */
  it('stays out of a square it was told to keep out of, and the one under it', () => {
    const keepOut = (x: number, y: number, z: number): boolean => x === 1 && y === 70 && z === 0
    const hashes = flyingFrom(world(), keepOut)(cell(0, 70, 0)).map((step) => step.hash)

    expect(hashes).not.toContain('1,70,0')
    expect(hashes).not.toContain('1,69,0')
    // Over it and away from it are both still offered: only the square and its body are refused.
    expect(hashes).toContain('0,71,0')
    expect(hashes).toContain('-1,70,0')
  })

  it('does not sweep a diagonal through one either', () => {
    const keepOut = (x: number, y: number, z: number): boolean => x === 1 && y === 70 && z === 0
    const hashes = flyingFrom(world(), keepOut)(cell(0, 70, 0)).map((step) => step.hash)

    // The move one across and one along passes through the keep-out square on its way.
    expect(hashes).not.toContain('1,70,1')
    expect(hashes).toContain('0,70,1')
  })
})

describe('corners', () => {
  it('keeps its speed straight on, a quarter of it round a right angle, and none for a turn back', () => {
    const at = { x: 0, y: 64, z: 0 }
    const corner = { x: 10, y: 64, z: 0 }

    expect(cornerSpeed(at, corner, { x: 20, y: 64, z: 0 }, 1)).toBeCloseTo(1)
    expect(cornerSpeed(at, corner, { x: 10, y: 64, z: 10 }, 1)).toBeCloseTo(0.25)
    expect(cornerSpeed(at, corner, { x: 0, y: 64, z: 0 }, 1)).toBeCloseTo(0)
  })

  /** Taken at what the angle alone allowed, a right angle at speed ran five blocks past the corner. */
  it('takes a corner no faster than it can turn within a step of it', () => {
    const at = { x: 0, y: 64, z: 0 }
    const corner = { x: 10, y: 64, z: 0 }
    const accel = 0.1

    expect(turnSpeed(at, corner, { x: 20, y: 64, z: 0 }, accel)).toBe(Infinity)

    // Slowed to this, the time the turn takes carries it past the corner by no more than a third of a block.
    const right = turnSpeed(at, corner, { x: 10, y: 64, z: 10 }, accel)
    const ticks = (right * Math.SQRT2) / accel
    expect((right * ticks) / 2).toBeLessThanOrEqual(0.36)
    expect(right).toBeLessThan(turnSpeed(at, corner, { x: 20, y: 64, z: 5 }, accel))
  })
})

describe('straight lines', () => {
  it('sees through open air and not through a wall', () => {
    const blocks = world(wall(5, 3, 4))
    expect(clearLine(blocks, { x: 0.5, y: 64, z: 0.5 }, { x: 4.2, y: 64, z: 0.5 })).toBe(true)
    expect(clearLine(blocks, { x: 0.5, y: 64, z: 0.5 }, { x: 9.5, y: 64, z: 0.5 })).toBe(false)
    expect(clearLine(blocks, { x: 0.5, y: 70, z: 0.5 }, { x: 9.5, y: 70, z: 0.5 })).toBe(true)
  })

  /** A line through the squares beside a pool put the agent face first in it the moment it drifted. */
  it('keeps clear of lava beside the line, not only out of it', () => {
    const LAVA = { name: 'lava', boundingBox: 'empty' }
    const blocks = world({ '5,64,1': LAVA })

    expect(clearLine(blocks, { x: 0.5, y: 64.1, z: 0.5 }, { x: 9.5, y: 64.1, z: 0.5 })).toBe(false)
    expect(clearLine(blocks, { x: 0.5, y: 64.1, z: -2.5 }, { x: 9.5, y: 64.1, z: -2.5 })).toBe(true)
  })

  it('flies a staircase of squares as the fewest legs the air allows', () => {
    const steps = [0, 1, 2, 3, 4].map((i) => ({ x: i + 0.5, y: 64, z: i + 0.5 }))
    expect(straighten(steps, () => true)).toEqual([steps[0], steps[4]])
  })
})

describe('whether a waypoint is flown', () => {
  const allowed = { mayFly: true, speed: 0.05 }
  const refused = { mayFly: false, speed: 0.05 }

  it('flies what the server allows, and walks when flight was not asked for', () => {
    expect(takeoff({ mode: 'walk', forceFly: true, flyCommand: '/fly' }, allowed, false)).toBe('walk')
    expect(takeoff({ mode: 'fly', forceFly: false, flyCommand: '' }, allowed, false)).toBe('fly')
    expect(takeoff({ mode: 'fly', forceFly: false, flyCommand: '' }, refused, false)).toBe('walk')
  })

  it('asks with the command before forcing, and only once', () => {
    expect(takeoff({ mode: 'fly', forceFly: true, flyCommand: '/fly' }, refused, false)).toBe('ask')
    expect(takeoff({ mode: 'fly', forceFly: true, flyCommand: '/fly' }, refused, true)).toBe('fly')
    expect(takeoff({ mode: 'fly', forceFly: false, flyCommand: '/fly' }, refused, true)).toBe('walk')
  })

  /** Most of these commands toggle, so running one on an agent that may already fly takes flight away. */
  it('does not run the command when flight is already allowed', () => {
    expect(takeoff({ mode: 'fly', forceFly: false, flyCommand: '/fly' }, allowed, false)).toBe('fly')
  })
})

/** A bot whose physics is a position moved by its velocity, with gravity and a floor at y 64. */
function flyer(blocks: BlockAt, forced: boolean, overrides: Partial<FlightRules> = {}) {
  const listeners: Array<() => void> = []
  const written: Array<{ name: string; flags: number }> = []
  const entity = {
    position: new WorldVec(0.5, 64, 0.5),
    velocity: new WorldVec(0, 0, 0),
    onGround: true,
  }
  const physics = { gravity: 0.08 }

  const bot = {
    entity,
    physics,
    _client: { write: (name: string, params: { flags: number }) => written.push({ name, flags: params.flags }) },
    blockAt: (at: WorldVec) => blocks(at.x, at.y, at.z),
    on: (_name: string, handler: () => void) => listeners.push(handler),
    removeListener: () => {},
    clearControlStates: () => {},
    look: async () => {},
  }

  const said = { routes: [] as number[], arrived: 0, lost: [] as string[], grounded: [] as string[], closest: 0 }
  const report: FlightReport = {
    route: (steps) => said.routes.push(steps.length),
    arrived: () => said.arrived++,
    lost: (why) => said.lost.push(why),
    closest: () => said.closest++,
    stalled: () => {},
    grounded: (why) => said.grounded.push(why),
  }

  const rules: FlightRules = {
    reach: 64,
    slice: 50,
    budget: 5_000,
    sprint: true,
    lean: 1.5,
    forced,
    speed: 0.05,
    boost: 1,
    ...overrides,
  }
  const driver = new FlightDriver(1, bot as unknown as Bot, () => rules, report)
  driver.start()

  let lowest = Infinity
  let lowestY = Infinity
  let airborne = 0

  /** One tick the way mineflayer runs one: the physics moves the body, then the tick is raised. */
  const tick = () => {
    entity.position = entity.position.plus(entity.velocity)
    entity.velocity.y -= physics.gravity
    if (entity.position.y <= 64) {
      entity.position = new WorldVec(entity.position.x, 64, entity.position.z)
      entity.velocity.y = Math.max(0, entity.velocity.y)
      entity.onGround = true
    } else {
      entity.onGround = false
    }
    for (const handler of listeners) handler()
    if (driver.claimsGround()) {
      lowest = Math.min(lowest, entity.velocity.y)
      // Once it has had time to climb clear of the floor it took off from.
      if (++airborne > 20) lowestY = Math.min(lowestY, entity.position.y)
    }
  }

  return { driver, entity, physics, written, said, tick, lowest: () => lowest, lowestY: () => lowestY }
}

describe('flying', () => {
  it('flies straight to a clear spot, lands and puts gravity back', () => {
    const agent = flyer(world(), false)
    agent.driver.go({ x: 12, y: 64, z: 0 }, 1)

    for (let at = 0; at < 400 && agent.said.arrived === 0; at++) agent.tick()

    expect(agent.said.arrived).toBe(1)
    // From the agent to the spot: a line of one point is not a line, and drew nothing in the 3D view.
    expect(agent.said.routes).toEqual([2])
    expect(Math.hypot(agent.entity.position.x - 12.5, agent.entity.position.z - 0.5)).toBeLessThan(1)
    expect(agent.physics.gravity).toBe(0.08)
    // Granted flight says so, the way a client does, and says when it stops.
    expect(agent.written).toEqual([
      { name: 'abilities', flags: 2 },
      { name: 'abilities', flags: 0 },
    ])
  })

  /**
   * The printer's case, end to end through the engine: the square the next block goes in is open
   * air with finished ground under it, which is exactly what a flight picks to land in.
   */
  it('does not come to rest in a square it was told to keep out of', () => {
    const agent = flyer(world(), false, {
      keepOut: (x: number, y: number, z: number) => x === 12 && y === 64 && z === 0,
    })
    agent.driver.go({ x: 12, y: 64, z: 0 }, 1)

    for (let at = 0; at < 400 && agent.said.arrived === 0; at++) agent.tick()

    const at = agent.entity.position
    expect(agent.said.arrived).toBe(1)
    expect([Math.floor(at.x), Math.floor(at.y), Math.floor(at.z)]).not.toEqual([12, 64, 0])
    expect(Math.hypot(at.x - 12.5, at.z - 0.5)).toBeLessThan(2)
  })

  it('flies to a spot in open air along a straight line, and holds there', () => {
    const agent = flyer(world(), false)
    const from = { x: 0.5, y: 64, z: 0.5 }
    const to = { x: 16.5, y: 72, z: 0.5 }
    agent.driver.go({ x: 16, y: 72, z: 0 }, 1)

    let furthest = 0
    for (let at = 0; at < 400 && agent.said.arrived === 0; at++) {
      agent.tick()
      furthest = Math.max(furthest, awayFrom(agent.entity.position, from, to))
    }

    expect(agent.said.arrived).toBe(1)
    // Climbing and crossing together, so the line drawn is the line flown rather than a level run
    // with the height made up at the end.
    expect(furthest).toBeLessThan(0.5)

    // Nothing under it, so it holds there rather than dropping.
    for (let at = 0; at < 60; at++) agent.tick()
    expect(agent.entity.position.y).toBeCloseTo(72, 0)
    expect(agent.physics.gravity).toBe(0)

    agent.driver.stop()
    expect(agent.physics.gravity).toBe(0.08)
  })

  /**
   * Braked late rather than crept into. Sixty blocks is ten ticks to reach speed, about fifty at it and
   * under ten to stop - where braking a tenth of the distance a tick took nearly ninety.
   */
  it('covers a long flight at speed and only brakes at the end', () => {
    const agent = flyer(world(), false)
    agent.driver.go({ x: 60, y: 64, z: 0 }, 1)

    let ticks = 0
    while (ticks < 400 && agent.said.arrived === 0) {
      agent.tick()
      ticks++
    }

    expect(agent.said.arrived).toBe(1)
    expect(ticks).toBeLessThan(75)
  })

  it('flies faster by the speed multiplier', () => {
    const agent = flyer(world(), false, { boost: 2 })
    agent.driver.go({ x: 60, y: 64, z: 0 }, 1)

    let ticks = 0
    while (ticks < 400 && agent.said.arrived === 0) {
      agent.tick()
      ticks++
    }

    expect(agent.said.arrived).toBe(1)
    expect(ticks).toBeLessThan(45)
  })

  /**
   * A thousand blocks off is somewhere the server has not sent, so there is nowhere near it to aim at
   * and a search for it can only run out of time. Stretch after stretch instead, without stopping.
   */
  it('flies towards somewhere far away a stretch at a time, without searching', () => {
    const agent = flyer(world(wall(30, 20, 6), 400), false)
    agent.driver.go({ x: 1_000, y: 64, z: 0 }, 1)

    for (let at = 0; at < 120; at++) agent.tick()

    expect(agent.entity.position.x).toBeGreaterThan(60)
    expect(agent.said.grounded).toEqual([])
    expect(agent.said.routes.every((points) => points >= 2)).toBe(true)
  })

  /** The server sends the world as the agent moves, so the edge of it is somewhere to wait, not to give up. */
  it('waits at the edge of the world it has been sent rather than giving up on flying', () => {
    const agent = flyer(world({}, 40), false)
    agent.driver.go({ x: 1_000, y: 64, z: 0 }, 1)

    for (let at = 0; at < 300; at++) agent.tick()

    expect(agent.said.grounded).toEqual([])
    expect(agent.entity.position.x).toBeGreaterThan(20)
    expect(agent.entity.position.x).toBeLessThan(41)
    expect(agent.driver.moving()).toBe(true)
  })

  it('goes over a wall it cannot fly through', () => {
    const agent = flyer(world(wall(6, 8, 5)), false)
    agent.driver.go({ x: 12, y: 64, z: 0 }, 1)

    for (let at = 0; at < 1_000 && agent.said.arrived === 0; at++) agent.tick()

    expect(agent.said.arrived).toBe(1)
    expect(agent.said.routes[0]).toBeGreaterThan(1)
    expect(agent.entity.position.x).toBeGreaterThan(11)
  })

  /** A search small enough that it cannot get over this wall: only the climb over the top can. */
  it('climbs over a tall wall close by and comes down on the far side, without searching', () => {
    const agent = flyer(world(wall(6, 30, 20)), false, { reach: 2, budget: 200 })
    agent.driver.go({ x: 12, y: 64, z: 0 }, 1)

    for (let at = 0; at < 1_000 && agent.said.arrived === 0 && agent.said.grounded.length === 0; at++) agent.tick()

    expect(agent.said.grounded).toEqual([])
    expect(agent.said.arrived).toBe(1)
    expect(agent.entity.position.x).toBeGreaterThan(11)
  })

  /**
   * One tower in the way that reaches the top of the world ruled out flying high anywhere near it, and
   * the flight went past it skimming the ground.
   */
  it('turns a high stretch round something too tall to fly over, and stays high', () => {
    const tower: Record<string, typeof STONE> = {}
    for (let x = 40; x <= 42; x++) for (let z = -8; z <= 8; z++) for (let y = 64; y <= 96; y++) tower[`${x},${y},${z}`] = STONE

    const agent = flyer(world(tower, 400), false)
    agent.driver.go({ x: 1_000, y: 64, z: 0 }, 1)

    for (let at = 0; at < 300 && agent.entity.position.x < 40; at++) agent.tick()

    expect(agent.said.grounded).toEqual([])
    expect(agent.entity.position.x).toBeGreaterThanOrEqual(40)
    expect(agent.entity.position.y).toBeGreaterThan(70)
  })

  /**
   * A wall with a way through it was flown through like a maze rather than over, and a flight that did
   * climb over one came straight back down on the far side - to climb again at the next.
   */
  it('climbs over a wall rather than threading a gap in it, and stays up once past', () => {
    const blocks: Record<string, typeof STONE> = {}
    for (let x = 30; x <= 31; x++) {
      for (let z = -60; z <= 60; z++) {
        for (let y = 64; y <= 90; y++) if (!(Math.abs(z) <= 1 && y <= 65)) blocks[`${x},${y},${z}`] = STONE
      }
    }

    const agent = flyer(world(blocks, 400), false)
    agent.driver.go({ x: 1_000, y: 64, z: 0 }, 1)

    for (let at = 0; at < 400 && agent.entity.position.x < 30; at++) agent.tick()
    expect(agent.entity.position.y).toBeGreaterThan(88)

    for (let at = 0; at < 400 && agent.entity.position.x < 120; at++) agent.tick()
    expect(agent.said.grounded).toEqual([])
    expect(agent.entity.position.x).toBeGreaterThanOrEqual(120)
    expect(agent.entity.position.y).toBeGreaterThan(88)
  })

  /**
   * Taller than anything the ground under it says to clear, and closer than the shortest stretch, so
   * the height it wants is blocked at every length and only a higher one is not. A search this small
   * cannot get over it: only climbing can.
   */
  it('climbs higher than it wanted when that height is blocked', () => {
    const tall = (x: number, y: number, z: number) => {
      if (Math.abs(x) > 400 || Math.abs(z) > 400 || y > 200) return null
      if (x >= 10 && x <= 11 && Math.abs(z) <= 60 && y <= 130) return STONE
      return y <= 63 ? STONE : AIR
    }

    const agent = flyer(tall, false, { reach: 2, budget: 50 })
    agent.driver.go({ x: 1_000, y: 64, z: 0 }, 1)

    for (let at = 0; at < 600 && agent.entity.position.x < 10; at++) agent.tick()

    expect(agent.said.grounded).toEqual([])
    expect(agent.entity.position.x).toBeGreaterThanOrEqual(10)
    expect(agent.entity.position.y).toBeGreaterThan(130)
  })

  /** Straight up and then across is a right angle, taken at a crawl: every climb stopped dead at the top. */
  it('climbs along the way rather than straight up, where a wall ahead rules out one straight line', () => {
    const blocks: Record<string, typeof STONE> = {}
    for (let x = 30; x <= 31; x++) for (let z = -60; z <= 60; z++) for (let y = 64; y <= 90; y++) blocks[`${x},${y},${z}`] = STONE

    const agent = flyer(world(blocks, 400), false)
    agent.driver.go({ x: 1_000, y: 64, z: 0 }, 1)

    for (let at = 0; at < 400 && agent.entity.position.y < 90; at++) agent.tick()

    expect(agent.entity.position.y).toBeGreaterThanOrEqual(90)
    expect(agent.entity.position.x).toBeGreaterThan(10)
  })

  /** Cruising high until forty blocks out, and then coming down almost straight, at the speed a flight sinks. */
  it('glides down towards its destination instead of dropping onto it at the end', () => {
    const blocks: Record<string, typeof STONE> = {}
    for (let x = 20; x <= 21; x++) for (let z = -60; z <= 60; z++) for (let y = 64; y <= 90; y++) blocks[`${x},${y},${z}`] = STONE

    const agent = flyer(world(blocks, 400), false)
    agent.driver.go({ x: 200, y: 64, z: 0 }, 1)

    for (let at = 0; at < 600 && agent.entity.position.x < 30; at++) agent.tick()
    expect(agent.entity.position.y).toBeGreaterThan(88)

    for (let at = 0; at < 600 && agent.entity.position.x < 160; at++) agent.tick()
    expect(agent.said.grounded).toEqual([])
    expect(agent.entity.position.x).toBeGreaterThanOrEqual(160)
    expect(agent.entity.position.y).toBeLessThan(85)

    for (let at = 0; at < 600 && agent.said.arrived === 0; at++) agent.tick()
    expect(agent.said.arrived).toBe(1)
  })

  /**
   * A destination the server has not sent yet has no spot to aim a way down at, so the stretches have
   * to start coming down on their own - by the height the destination was given at.
   */
  it('starts gliding down towards a destination that has not been sent yet', () => {
    const blocks: Record<string, typeof STONE> = {}
    for (let x = 20; x <= 21; x++) for (let z = -60; z <= 60; z++) for (let y = 64; y <= 90; y++) blocks[`${x},${y},${z}`] = STONE

    // Past the edge of what has been sent, so there is no spot there to aim a way down at.
    const agent = flyer(world(blocks, 150), false)
    agent.driver.go({ x: 200, y: 64, z: 0 }, 1)

    for (let at = 0; at < 600 && agent.entity.position.x < 30; at++) agent.tick()
    expect(agent.entity.position.y).toBeGreaterThan(88)

    // Sixty blocks out, where the glide down to y 64 is twenty-odd blocks up.
    for (let at = 0; at < 600 && agent.entity.position.x < 140; at++) agent.tick()
    expect(agent.entity.position.x).toBeGreaterThanOrEqual(140)
    expect(agent.entity.position.y).toBeLessThan(88)
  })

  /**
   * The height a climb over something wants counts everything above the way, a canopy included, and
   * flown at, it sent an agent thirty blocks up to cross a wall two high.
   */
  it('climbs over a low wall only as high as it takes, not up to what is above the way', () => {
    const blocks: Record<string, typeof STONE> = {}
    for (let z = -8; z <= 8; z++) for (let y = 64; y <= 65; y++) blocks[`10,${y},${z}`] = STONE
    for (let x = 4; x <= 16; x++) for (let z = -8; z <= 8; z++) blocks[`${x},85,${z}`] = STONE

    const agent = flyer(world(blocks), false)
    agent.driver.go({ x: 20, y: 64, z: 0 }, 1)

    let highest = 0
    for (let at = 0; at < 600 && agent.said.arrived === 0; at++) {
      agent.tick()
      highest = Math.max(highest, agent.entity.position.y)
    }

    expect(agent.said.arrived).toBe(1)
    expect(agent.said.grounded).toEqual([])
    expect(highest).toBeLessThan(75)
  })

  /**
   * A descent tried at four fixed slopes, none of which cleared a wall a little short of the spot, fell
   * back to straight down: level all the way across, then a drop the height of the climb - an L.
   */
  it('comes down along the shortest line the air allows, not across and then straight down', () => {
    const blocks: Record<string, typeof STONE> = {}
    for (let z = -8; z <= 8; z++) for (let y = 64; y <= 80; y++) blocks[`25,${y},${z}`] = STONE

    const agent = flyer(world(blocks), false)
    agent.driver.go({ x: 0, y: 90, z: 0 }, 1)
    for (let at = 0; at < 400 && agent.said.arrived === 0; at++) agent.tick()
    expect(agent.entity.position.y).toBeGreaterThan(89)

    agent.driver.go({ x: 35, y: 64, z: 0 }, 1)
    for (let at = 0; at < 600 && agent.entity.position.y > 75; at++) agent.tick()

    // Still coming down at a slope when it passes y 75, rather than already over the spot and dropping.
    expect(agent.entity.position.y).toBeLessThanOrEqual(75)
    expect(agent.entity.position.x).toBeLessThan(34)

    for (let at = 0; at < 600 && agent.said.arrived < 2; at++) agent.tick()
    expect(agent.said.arrived).toBe(2)
  })

  /**
   * No lower than the higher end, a spot under an overhang was reached by flying level all the way
   * across and dropping the whole height onto it - or not at all, when even that was blocked.
   */
  it('comes down part of the way first when that is the way in, under an overhang', () => {
    const blocks: Record<string, typeof STONE> = {}
    // From x 5, so the straight line down to the spot runs into it as well.
    for (let x = 5; x <= 40; x++) for (let z = -8; z <= 8; z++) blocks[`${x},80,${z}`] = STONE

    // A search this small cannot find the way in by itself.
    const agent = flyer(world(blocks), false, { reach: 2, budget: 50 })
    agent.driver.go({ x: 0, y: 92, z: 0 }, 1)
    for (let at = 0; at < 400 && agent.said.arrived === 0; at++) agent.tick()
    expect(agent.entity.position.y).toBeGreaterThan(91)

    agent.driver.go({ x: 35, y: 64, z: 0 }, 1)
    let underneath = true
    for (let at = 0; at < 800 && agent.said.arrived < 2 && agent.said.grounded.length === 0; at++) {
      agent.tick()
      const { x, y } = agent.entity.position
      if (x >= 5 && y >= 79) underneath = false
    }

    expect(agent.said.grounded).toEqual([])
    expect(agent.said.arrived).toBe(2)
    expect(underneath).toBe(true)
  })

  /** Skimming the ground, every hill in the line is something to climb over or search round. */
  it('cruises well above the ground on a long flight', () => {
    const agent = flyer(world({}, 400), false)
    agent.driver.go({ x: 1_000, y: 64, z: 0 }, 1)

    let highest = 0
    for (let at = 0; at < 200; at++) {
      agent.tick()
      highest = Math.max(highest, agent.entity.position.y)
    }

    expect(highest).toBeGreaterThan(74)
    expect(agent.entity.position.x).toBeGreaterThan(60)
    expect(agent.said.grounded).toEqual([])
  })

  it('dips now and then when forced, claims the ground, and tells the server nothing', () => {
    // Somewhere to land, forty blocks off: a flight long enough to need a dip, not a spot in mid-air that
    // nothing can be landed on.
    const agent = flyer(world(), true)
    agent.driver.go({ x: 0, y: 64, z: 40 }, 1)

    for (let at = 0; at < 120; at++) agent.tick()

    expect(agent.lowest()).toBeLessThan(0)
    expect(agent.written).toEqual([])
    // Clear of the floor it is flying over for all of it, dips included - flush with it, a dip put the
    // feet into the next block along and the flight hung there.
    expect(agent.lowestY()).toBeGreaterThan(64)
  })

  it('hands the journey back to walking when the air has no way there', () => {
    // Sealed in: a box of stone around the spot, with nothing to land on inside it.
    const sealed: Record<string, typeof STONE> = {}
    for (let x = 19; x <= 21; x++) for (let y = 63; y <= 67; y++) for (let z = -1; z <= 1; z++) sealed[`${x},${y},${z}`] = STONE

    // Nowhere to find costs the whole budget, so this one gets a short budget and a small world rather
    // than a race against the test runner's own clock.
    const agent = flyer(world(sealed, 24), false, { budget: 1_000 })
    agent.driver.go({ x: 20, y: 65, z: 0 }, 1)

    for (let at = 0; at < 400 && agent.said.grounded.length === 0; at++) agent.tick()

    expect(agent.said.grounded).toHaveLength(1)
    expect(agent.physics.gravity).toBe(0.08)
  })

  /** Water counted as closed, so an agent that started in it had nowhere with room and never took off. */
  it('flies out of water it starts in', () => {
    const WATER = { name: 'water', boundingBox: 'empty' }
    const lake: Record<string, typeof STONE> = {}
    for (let x = -3; x <= 20; x++) for (let y = 64; y <= 70; y++) for (let z = -4; z <= 4; z++) lake[`${x},${y},${z}`] = WATER

    const agent = flyer(world(lake), false)
    agent.driver.go({ x: 30, y: 64, z: 0 }, 1)

    for (let at = 0; at < 600 && agent.said.arrived === 0 && agent.said.grounded.length === 0; at++) agent.tick()

    expect(agent.said.grounded).toEqual([])
    expect(agent.said.arrived).toBe(1)
    expect(agent.entity.position.x).toBeGreaterThan(29)
  })

  /** Gravity back on two hundred blocks up was a fall into whatever was under it, lava included. */
  it('comes down to the ground before handing an abandoned flight back to walking', () => {
    const sealed: Record<string, typeof STONE> = {}
    for (let x = 19; x <= 21; x++) for (let y = 63; y <= 67; y++) for (let z = -1; z <= 1; z++) sealed[`${x},${y},${z}`] = STONE

    const agent = flyer(world(sealed, 24), false, { budget: 1_000 })
    agent.driver.go({ x: 0, y: 80, z: 0 }, 1)
    for (let at = 0; at < 400 && agent.said.arrived === 0; at++) agent.tick()
    expect(agent.entity.position.y).toBeGreaterThan(79)

    agent.driver.go({ x: 20, y: 65, z: 0 }, 1)
    for (let at = 0; at < 1_000 && agent.said.grounded.length === 0; at++) agent.tick()

    expect(agent.said.grounded).toHaveLength(1)
    // Handed over standing on the ground, not at the height it gave up at.
    expect(agent.entity.position.y).toBeLessThan(64.5)
    expect(agent.physics.gravity).toBe(0.08)
  })

  /** With lava under it, dropping is the one thing worse than staying up. */
  it('holds in the air and gives up the journey when what is under it is lava', () => {
    const LAVA = { name: 'lava', boundingBox: 'empty' }
    // A lake of it, so wherever the flight gets to before it gives up, lava is what is under it.
    const blocks: Record<string, typeof STONE> = {}
    for (let x = -24; x <= 24; x++) for (let z = -24; z <= 24; z++) blocks[`${x},63,${z}`] = LAVA
    for (let x = 19; x <= 21; x++) for (let y = 63; y <= 67; y++) for (let z = -1; z <= 1; z++) blocks[`${x},${y},${z}`] = STONE

    const agent = flyer(world(blocks, 24), false, { budget: 1_000 })
    agent.driver.go({ x: 0, y: 80, z: 0 }, 1)
    for (let at = 0; at < 400 && agent.said.arrived === 0; at++) agent.tick()

    agent.driver.go({ x: 20, y: 65, z: 0 }, 1)
    for (let at = 0; at < 1_000 && agent.said.lost.length + agent.said.grounded.length === 0; at++) agent.tick()
    for (let at = 0; at < 40; at++) agent.tick()

    expect(agent.said.grounded).toEqual([])
    expect(agent.said.lost).toHaveLength(1)
    // Still up where it gave up - over the lake, not in it. Its floor is y 64, which is the lava's top.
    expect(agent.entity.position.y).toBeGreaterThan(64.9)
    expect(agent.physics.gravity).toBe(0)
  })
})
