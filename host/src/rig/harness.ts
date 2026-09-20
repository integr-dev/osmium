import mineflayer, { type Bot } from 'mineflayer'
import { Vec3 } from 'vec3'

import { log } from '../log.ts'
import { Schedule } from '../agent/schedule.ts'
import { DEFAULT_ORDER, parseOrder, type PlacementOrder } from '../agent/order.ts'
import { decodeSegment } from '../agent/build/segment.ts'
import { Printer, standingOf } from '../agent/build/printer.ts'
import { buildSettingsFrom } from '../agent/build/settings.ts'
import { compare, type Mismatch } from '../agent/build/compare.ts'
import { layout, pack, type Layout, type Plot } from './layout.ts'
import type { BlockPos } from '../protocol/wire.ts'

/**
 * Builds the torture schematic on a real server and says what came out wrong.
 *
 * **It drives the printer, not a copy of it.** The bytes it hands over are the bytes the backend
 * would serve, and the class that places them is the one an agent uses — so a rule this finds wrong
 * is wrong in production too, and a fix is a fix rather than something that has to be carried
 * across.
 *
 * **It teleports rather than walks.** Getting to the next block is the navigator's problem and it
 * has its own tests; mixing the two would mean a printer failure and a pathfinding failure reading
 * the same. The one thing the rig is measuring is what a placement turns into.
 */

export interface RigOptions {
  host: string
  port: number
  username: string
  version: string
  /** Where the build's north-west-bottom corner goes. */
  anchor: BlockPos
  order: PlacementOrder
  /** What the printer is configured with, as the settings map an operator would send. */
  settings: Record<string, string>
}

export interface Report {
  plots: number
  /** Plots whose every block came out as the schematic asked. */
  right: number
  /** Everything that did not, by plot. */
  wrong: { plot: string; at: BlockPos; misses: Mismatch[] }[]
  /** What the printer itself noticed while building, by block and property. */
  drift: [string, number][]
  placed: number
  outcome: string
  seconds: number
}

/**
 * Reads a build back without building it.
 *
 * The rig builds and checks in one go, which is right when the printer is what is being
 * tested — and wrong when the thing to check is a piece an agent placed hours ago through the
 * real pipeline. This is the second half on its own: fly the box, read every square, and say
 * what is standing where something else should be.
 */
export async function verifyBuild(options: RigOptions): Promise<Report> {
  const view = layout(options.anchor)
  const bot = await join(options)
  const started = Date.now()

  try {
    await survey(bot, view)
    const wrong = inspect(bot, view)

    return {
      plots: view.plots.length,
      right: view.plots.length - new Set(wrong.map((miss) => miss.plot)).size,
      wrong,
      drift: [],
      placed: view.blocks.length - wrong.length,
      outcome: 'read back',
      seconds: Math.round((Date.now() - started) / 100) / 10,
    }
  } finally {
    bot.quit()
  }
}

export async function runRig(options: RigOptions): Promise<Report> {
  const view = layout(options.anchor)
  const segment = decodeSegment(pack(view))

  const bot = await join(options)
  const started = Date.now()

  try {
    await prepare(bot, view)

    // The rig travels by teleport, so "head for it" is "be there" - but the printer asks on
    // every pass, and a `/tp` a tick would drown the server in commands. Only when it moves.
    let heading: string | undefined
    const aim = (to: BlockPos): void => {
      const key = `${to.x},${to.y},${to.z}`
      if (key === heading) return
      heading = key
      void teleport(bot, to)
    }

    const hands = new Schedule(0)
    const printer = new Printer(0, bot, segment, options.order, hands, {
      progress: (placed) => log.debug(`rig: ${placed} placed`),
      steer: (to) => aim(to),
      settings: () => buildSettingsFrom(options.settings),
      tell: (text, bad) => (bad ? log.warn(`rig: ${text}`) : log.info(`rig: ${text}`)),
    })

    const outcome = await printer.run()

    // A last look at the whole build from the middle of it, so every chunk is loaded before
    // anything is read back: a block in a chunk the client has not been sent reads as air, which
    // would report the entire far half of the grid as missing.
    await survey(bot, view)

    const wrong = inspect(bot, view)
    const right = view.plots.length - new Set(wrong.map((miss) => miss.plot)).size

    return {
      plots: view.plots.length,
      right,
      wrong,
      drift: [...printer.differences.entries()].sort((a, b) => b[1] - a[1]),
      placed: printer.count,
      outcome,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    }
  } finally {
    bot.quit()
  }
}

/** Connects and waits until the world is there to be built in. */
async function join(options: RigOptions): Promise<Bot> {
  const bot = mineflayer.createBot({
    host: options.host,
    port: options.port,
    username: options.username,
    version: options.version,
    auth: 'offline',
    // The rig is the only thing on this server and it is placing as fast as it can. Nothing here
    // needs the physics that keep an agent walking.
    checkTimeoutInterval: 120_000,
  })

  await new Promise<void>((resolve, reject) => {
    bot.once('spawn', () => resolve())
    bot.once('error', reject)
    bot.once('kicked', (why) => reject(new Error(`kicked: ${JSON.stringify(why)}`)))
  })

  await bot.waitForChunksToLoad()
  return bot
}

/**
 * What has to be switched off for a build to stay as it was placed.
 *
 * Every one of these is something that writes to the same blocks the printer does without anybody
 * asking: a creeper, a fire, grass creeping over the floor, snow settling on the top course. A
 * report is only about the printer if nothing else is editing its work.
 *
 * Commands rather than configuration, because gamerules belong to the world and not to
 * `server.properties` — and the rig is the one thing that always runs before a build and is always
 * operator. They stay set afterwards, so anything else building here inherits them.
 */
const STILL = [
  'doMobSpawning false',
  'doPatrolSpawning false',
  'doTraderSpawning false',
  'doInsomnia false',
  'disableRaids true',
  'mobGriefing false',
  'doFireTick false',
  'doWeatherCycle false',
  'doDaylightCycle false',
  'randomTickSpeed 0',
  'doEntityDrops false',
  'doTileDrops false',
  'keepInventory true',
]

/** Clears the box and puts the agent in the air over it, in creative, flying. */
async function prepare(bot: Bot, view: Layout): Promise<void> {
  const max = {
    x: view.min.x + view.size.x - 1,
    y: view.min.y + view.size.y + 2,
    z: view.min.z + view.size.z - 1,
  }

  bot.chat('/gamemode creative')
  for (const rule of STILL) bot.chat(`/gamerule ${rule}`)
  await wait(500)

  // A run has to start from the same world every time or a report is about the last run as much as
  // this one. The box is a few thousand blocks, which is inside what one `fill` will take.
  bot.chat(`/fill ${view.min.x} ${view.min.y} ${view.min.z} ${max.x} ${max.y} ${max.z} air`)
  await wait(600)

  bot.creative.startFlying()
  await teleport(bot, { x: view.min.x, y: view.min.y, z: view.min.z })
}

/**
 * Puts the agent over a block and waits for the server to agree it is there.
 *
 * One above rather than on top of it: standing in the square a block goes in is the one position
 * from which it cannot be placed, and every block higher than that is a block of reach spent
 * going down rather than out across the course. The same height a flying agent holds at in
 * production — see `HOVER` in `agent/bot.ts`.
 */
async function teleport(bot: Bot, to: BlockPos): Promise<boolean> {
  const aim = new Vec3(to.x + 0.5, to.y + 1, to.z + 0.5)
  bot.chat(`/tp @s ${aim.x} ${aim.y} ${aim.z}`)

  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (bot.entity?.position && bot.entity.position.distanceTo(aim) < 1.5) {
      // The chunks around a new position arrive after the position does, and a printer that reads
      // the world before they land sees air where its supports are.
      await bot.waitForChunksToLoad()
      return true
    }
    await wait(50)
  }

  return false
}

/**
 * Flies the length of the build so every chunk of it is loaded before it is read back.
 *
 * **It waits for the blocks, not for the teleport.** `waitForChunksToLoad` answers about the
 * column the agent is standing in and answers early; a survey that trusts it flies the whole box
 * in four seconds and then reports the far end as air, because the far end never arrived. So each
 * stop waits until the floor beneath it can actually be read, which is the only thing that says
 * the chunk is here.
 */
async function survey(bot: Bot, view: Layout): Promise<void> {
  const step = 8
  const missed: string[] = []

  for (let z = view.min.z; z <= view.min.z + view.size.z; z += step) {
    for (let x = view.min.x; x <= view.min.x + view.size.x; x += step) {
      // Well over the tallest pedestal: this is a pass to load chunks, and putting the agent
      // down inside what it is about to read is how a survey rearranges its own subject.
      await teleport(bot, { x, y: view.min.y + view.size.y + 4, z })

      const floor = new Vec3(x, view.min.y - 1, z)
      const deadline = Date.now() + 4_000
      while (bot.blockAt(floor) === null && Date.now() < deadline) await wait(50)
      if (bot.blockAt(floor) === null) missed.push(`${x} ${z}`)
    }
  }

  if (missed.length > 0) {
    log.warn(`rig: ${missed.length} columns never arrived, and read as empty: ${missed.slice(0, 6).join(", ")}`)
  }
}

/** Everything standing where the schematic asked for something else. */
function inspect(bot: Bot, view: Layout): Report['wrong'] {
  const owner = new Map<string, string>()
  for (const plot of view.plots) {
    for (let x = 0; x < 3; x += 1) {
      for (let y = 0; y < 4; y += 1) {
        for (let z = 0; z < 3; z += 1) {
          owner.set(key(plot.origin.x + x, plot.origin.y + y, plot.origin.z + z), plot.name)
        }
      }
    }
  }

  const wrong: Report['wrong'] = []
  for (const block of view.blocks) {
    const standing = bot.blockAt(new Vec3(block.at.x, block.at.y, block.at.z))
    const misses = compare(block.state, standing ? standingOf(standing) : undefined)
    if (misses.length === 0) continue

    wrong.push({
      plot: owner.get(key(block.at.x, block.at.y, block.at.z)) ?? 'scaffold',
      at: block.at,
      misses,
    })
  }

  return wrong
}

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reads the order off a command line, falling back to the one every piece gets by default. */
export function orderArgument(value: string | undefined): PlacementOrder {
  if (!value) return DEFAULT_ORDER
  return parseOrder(value) ?? DEFAULT_ORDER
}

export type { Layout, Plot }
