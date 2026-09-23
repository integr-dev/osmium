import mineflayer, { type Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { createRequire } from 'node:module'
import type { Item } from 'prismarine-item'

import type { BlockPos } from '../protocol/wire.ts'
import { standingOf } from '../agent/build/printer.ts'
import { formatSpec } from '../agent/build/plan.ts'

/**
 * Asks the server what a placement turns into.
 *
 * The rig says *that* a rule in `plan.ts` is wrong; this says what the right one is. It puts one
 * block down from one face, once per direction the agent can look, and prints the state that came
 * out — which is the whole derivation, measured rather than remembered.
 *
 * It is how the plan's awkward entries were settled in the first place, and it is the first thing
 * to reach for when a family starts failing: a table of six lines answers "does this block face the
 * agent or away from it" in one run, where reading vanilla's source answers it in an afternoon and
 * sometimes wrongly.
 */

export type Support = 'floor' | 'wall' | 'ceiling'

export interface ProbeOptions {
  host: string
  port: number
  username: string
  version: string
  /** Somewhere nothing else is standing. The probe clears a few blocks around it every time. */
  at: BlockPos
  /** Items to try, by name. A block name is usually its own item — see `materials.ts`. */
  items: string[]
  /** Which neighbour to click. */
  from: Support
  /**
   * Click the empty square itself rather than the neighbour, with the same face and the same point
   * in the world, and put up nothing around it - what the printer does when nothing is standing.
   * Run with and without it and the two tables should agree, or refuse.
   */
  air?: boolean
}

export interface Trial {
  /** What the agent was looking at, as a word. */
  look: string
  /** The state that came out, in the same spelling a palette uses. */
  state: string
}

export interface ProbeResult {
  item: string
  from: Support
  trials: Trial[]
}

/** The six directions an agent can look along, as Minecraft's own yaw and pitch. */
const LOOKS: [string, number, number][] = [
  ['south', 0, 0],
  ['west', 90, 0],
  ['north', 180, 0],
  ['east', 270, 0],
  ['up', 0, -90],
  ['down', 0, 90],
]

export async function probe(options: ProbeOptions): Promise<ProbeResult[]> {
  const bot = mineflayer.createBot({
    host: options.host,
    port: options.port,
    username: options.username,
    version: options.version,
    auth: 'offline',
  })

  await new Promise<void>((resolve, reject) => {
    bot.once('spawn', () => resolve())
    bot.once('error', reject)
    bot.once('kicked', (why) => reject(new Error(`kicked: ${JSON.stringify(why)}`)))
  })

  try {
    bot.chat('/gamemode creative')
    await pause(400)
    bot.creative.startFlying()

    const target = new Vec3(options.at.x, options.at.y, options.at.z)
    // Three above rather than on top: a player standing in the square is the one position from
    // which the block that goes there cannot be placed.
    bot.chat(`/tp @s ${target.x + 0.5} ${target.y + 3} ${target.z + 0.5}`)
    await pause(900)
    await bot.waitForChunksToLoad()

    const out: ProbeResult[] = []
    for (const item of options.items) {
      out.push({ item, from: options.from, trials: await trial(bot, target, item, options.from, options.air ?? false) })
    }

    return out
  } finally {
    bot.quit()
  }
}

async function trial(bot: Bot, target: Vec3, item: string, from: Support, air: boolean): Promise<Trial[]> {
  const made = bot.registry.itemsByName[item]
  if (!made) return [{ look: '-', state: `no item called ${item} in this version` }]

  const trials: Trial[] = []

  for (const [look, yaw, pitch] of LOOKS) {
    // Waited for rather than slept through: a stale reading is a wrong answer that looks exactly
    // like a real one, and this whole tool exists to be believed.
    bot.chat(`/fill ${target.x - 1} ${target.y} ${target.z - 1} ${target.x + 1} ${target.y + 2} ${target.z + 1} air`)
    // Nothing to stand on or hang from when it is placed in air: that is the case being measured.
    if (!air) {
      bot.chat(`/setblock ${target.x} ${target.y - 1} ${target.z} stone`)
      bot.chat(`/setblock ${target.x - 1} ${target.y} ${target.z} stone`)
      bot.chat(`/setblock ${target.x} ${target.y + 1} ${target.z} stone`)
    }

    if (!(await until(() => bot.blockAt(target)?.name === 'air', 2_000))) {
      trials.push({ look, state: 'the square could not be cleared' })
      continue
    }

    bot.setQuickBarSlot(0)
    // The count matters: a stack past what the item allows is thrown away by the server without a
    // word, and the probe then measures whatever was in the agent's hand before.
    await bot.creative.setInventorySlot(36, makeItem(bot, made.id, made.stackSize ?? 1))
    await pause(80)

    snap(bot, yaw, pitch)
    await pause(60)

    const aimed = aim(target, from)
    const { normal } = aimed
    // In air the square itself is clicked, and the point moves with it: the same point in the
    // world is one block over from where the neighbour measured it. See `airCursor` in plan.ts.
    const reference = air ? target : aimed.reference
    const cursor = air ? aimed.cursor.plus(aimed.reference.minus(target)) : aimed.cursor
    const block = bot.blockAt(reference)
    if (!block) {
      trials.push({ look, state: 'nothing to click' })
      continue
    }

    try {
      await place(bot, block, normal, cursor)
    } catch (err) {
      trials.push({ look, state: `refused: ${(err as Error).message}` })
      continue
    }

    await until(() => bot.blockAt(target)?.name !== 'air', 1_000)
    const standing = bot.blockAt(target)
    trials.push({ look, state: standing ? formatSpec(standingOf(standing)) : 'air' })
  }

  return trials
}

/** Which neighbour to click, and where on it. */
function aim(target: Vec3, from: Support): { reference: Vec3; normal: Vec3; cursor: Vec3 } {
  if (from === 'wall') {
    return {
      reference: target.offset(-1, 0, 0),
      normal: new Vec3(1, 0, 0),
      cursor: new Vec3(1, 0.5, 0.5),
    }
  }

  if (from === 'ceiling') {
    return {
      reference: target.offset(0, 1, 0),
      normal: new Vec3(0, -1, 0),
      cursor: new Vec3(0.5, 0, 0.5),
    }
  }

  return { reference: target.offset(0, -1, 0), normal: new Vec3(0, 1, 0), cursor: new Vec3(0.5, 1, 0.5) }
}

/** The same snap the printer uses — see `agent/build/printer.ts`. */
function snap(bot: Bot, yaw: number, pitch: number): void {
  const turned = Math.PI - (yaw * Math.PI) / 180
  const tilted = (-pitch * Math.PI) / 180
  const onGround = bot.entity.onGround

  bot._client.write('look', { yaw, pitch, onGround, flags: { onGround, hasHorizontalCollision: undefined } })

  bot.entity.yaw = turned + 1
  void bot.look(turned, tilted, true)
}

async function place(bot: Bot, reference: unknown, normal: Vec3, cursor: Vec3): Promise<void> {
  const inner = bot as unknown as {
    _genericPlace(
      reference: unknown,
      normal: Vec3,
      options: { delta: Vec3; forceLook: 'ignore'; swingArm: 'right' },
    ): Promise<unknown>
  }

  await inner._genericPlace(reference, normal, { delta: cursor, forceLook: 'ignore', swingArm: 'right' })
}

type ItemClass = new (id: number, count: number) => Item

function makeItem(bot: Bot, id: number, count: number): Item {
  const load = createRequire(import.meta.url)('prismarine-item') as (registry: unknown) => ItemClass
  return new (load(bot.registry))(id, count)
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (test()) return true
    if (Date.now() >= deadline) return false
    await pause(25)
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
