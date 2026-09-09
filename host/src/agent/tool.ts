import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import nbt from 'prismarine-nbt'
import { Vec3 as WorldVec } from 'vec3'

import { log } from '../log.ts'

/**
 * Reaching for the right thing before breaking something.
 *
 * **Its own module because breaking a block is not a pathfinding idea.** The route happens to be the
 * first thing that needed it - an agent digging through a wall with a sword takes ten times as long
 * and looks broken while it does - but mining a vein, clearing a build site and harvesting a crop all
 * want exactly this and none of them want a pathfinder. So it takes a bot and a block and nothing
 * else, and knows nothing about why it is being asked.
 *
 * **Bare hands are one of the options**, which is what makes it an answer rather than a preference.
 * A sword is slower than a fist on almost everything, so an agent that only ever swaps *to* tools
 * ends up digging dirt with whatever it last fought with. The empty hand is scored alongside the
 * inventory, and winning it means putting down what is held.
 */

/** The part of a block this needs: how long it takes to break with a given thing. */
export interface Breakable {
  name: string
  digTime(
    item: number | null,
    creative: boolean,
    inWater: boolean,
    offGround: boolean,
    enchantments: unknown,
    effects: unknown,
  ): number
}

/** What the agent should be holding to break this, or nothing when its hands are quicker. */
export function bestFor(bot: Bot, block: Breakable): Item | undefined {
  const effects = bot.entity?.effects
  const time = (item: Item | undefined): number =>
    block.digTime(
      item ? item.type : null,
      false,
      false,
      false,
      item?.nbt ? ((nbt.simplify(item.nbt) as { Enchantments?: unknown }).Enchantments ?? []) : [],
      effects,
    )

  // The empty hand sets the bar, so nothing is picked up unless it actually beats not bothering.
  let quickest = time(undefined)
  let best: Item | undefined

  for (const item of bot.inventory?.items() ?? []) {
    const took = time(item)
    // Strictly quicker: a tie goes to whatever is already sorted first, and swapping for no gain is
    // a packet and a visible hand-wave for nothing.
    if (took >= quickest) continue

    quickest = took
    best = item
  }

  return best
}

/**
 * Puts the right thing in the agent's hand for breaking this, and says what that turned out to be.
 *
 * Does nothing at all when the hand is already right, which is the common case once an agent is
 * partway through a wall - and a swap it does not need is a packet, a visible hand-wave, and a
 * chance for the server to disagree about what is held.
 */
export async function reachFor(bot: Bot, block: Breakable, id?: number): Promise<Item | undefined> {
  const wanted = bestFor(bot, block)
  const held = bot.heldItem ?? undefined

  if (wanted?.type === held?.type) return held

  // **A hand that will not change is not a reason to give up the block.** Every swap goes through
  // whatever window happens to be open, and this host runs modules that open windows constantly - so
  // a refused swap is ordinary, and the honest answer is to break the thing with what is already
  // held rather than to fail the job and re-plan the route around a block the agent can reach.
  try {
    if (!wanted) {
      // Holding something worse than nothing. A sword against dirt is the usual way here.
      await bot.unequip('hand')
      return undefined
    }

    await bot.equip(wanted, 'hand')
    return wanted
  } catch (err) {
    log.debug(
      `Agent ${id ?? '?'} wanted ${wanted?.name ?? 'empty hands'} for ${block.name} and could not ` +
        `swap to it, so it is using ${held?.name ?? 'its hands'}: ${(err as Error).message}`,
    )
    return held
  }
}

/**
 * Keeps a dig from failing over enchantments nothing can read.
 *
 * **A gap between two dependencies, hit whenever an enchanted tool meets a new enough server.**
 * mineflayer works out how long a block takes by handing `heldItem.enchants` to prismarine-block,
 * which walks it with `for...of`. On versions that carry enchantments as an item *component*,
 * prismarine-item answers that getter with the component's data - an object, keyed by enchantment -
 * rather than the list every older version produced. So the dig throws `enchantments is not
 * iterable` before a single packet goes out, and an agent holding a good pickaxe cannot break
 * anything at all.
 *
 * Nothing here can fix either library, so the timing falls back to what the same block would take
 * with no enchantments. That is slower than the truth, and being slower only means waiting a little
 * longer than needed before the server confirms the break - which is the harmless direction.
 */
export function timeDigsProperly(bot: Bot, id: number): void {
  bot.once('inject_allowed', () => {
    const timed = bot.digTime?.bind(bot)
    if (!timed) return

    let told = false

    bot.digTime = (block) => {
      try {
        return timed(block)
      } catch (err) {
        if (!told) {
          told = true
          log.debug(`Agent ${id} cannot read the enchantments on what it is holding: ${(err as Error).message}`)
        }

        // Bare hands' arithmetic, with the held item still counted. Only the enchantments are lost.
        return block.digTime(bot.heldItem?.type ?? null, false, false, !bot.entity?.onGround, [], bot.entity?.effects)
      }
    }
  })
}

/**
 * Restores the speed a tool actually mines at, on versions whose data stopped saying.
 *
 * **Obsidian is unmineable to this agent without it, and not because of anything in Minecraft.**
 * prismarine-block works out how fast a tool is by looking the block's `material` up in
 * `registry.materials` and finding the held item in the table it gets back. That works while a
 * material names the tool that mines the block - `mineable/pickaxe` - and every ordinary block
 * still does. Blocks with a *minimum tier* no longer do: minecraft-data now tags obsidian
 * `incorrect_for_wooden_tool`, a table listing the tools that are **wrong** for it. No pickaxe is in
 * it, so every pickaxe is priced at bare-hand speed.
 *
 * Measured, on the registries this host actually loads:
 *
 * | version | obsidian, by hand | with a diamond pickaxe |
 * | --- | --- | --- |
 * | 1.20.4 | 250000 ms | 9400 ms |
 * | 1.21.4+ | 250000 ms | **75000 ms** |
 *
 * The pathfinder prices a dig at `1 + 3 * seconds` and refuses any step over 100, so 75 seconds is
 * a cost of 226 and obsidian simply drops out of every route. Nine seconds is 29, and it comes back.
 *
 * The correction is the data's own, not a table of tier numbers: a tool the block's `harvestTools`
 * vouches for is the right tool, and how fast it swings is whatever the `mineable/*` table that
 * lists it says. Nothing is invented, and a version that fixes its own data stops needing this,
 * because the first check finds the multiplier already applied and leaves the answer alone.
 */
export function speedUpTools(bot: Bot, id: number): void {
  const seen = Symbol.for('osmium.digTime')

  /**
   * **Kept trying, because there is nothing to patch until a chunk arrives.**
   *
   * The correction goes on the class every block shares, and the only way to that class is through a
   * block. At `spawn` the agent has a position and usually no world yet, so asking for the block under
   * its feet answers nothing - and giving up there is why obsidian stayed unmineable after this was
   * first written. Every chunk that lands is another chance, and the first one that works is the last
   * time this runs.
   */
  const install = (): boolean => {
    const block = bot.blockAt(bot.entity?.position ?? new WorldVec(0, 0, 0))
    if (!block) return false

    // One class behind every block this session, so wrapping it once covers the search, the
    // autotool and mineflayer's own waiting.
    const shape = Object.getPrototypeOf(block) as Record<string | symbol, unknown>
    if (shape[seen]) return true
    shape[seen] = true

    const timed = shape.digTime as (...args: unknown[]) => number
    let told = false

    shape.digTime = function (this: Breakable, ...args: unknown[]): number {
      const took = timed.apply(this, args)
      const speed = unpriced(bot, this, args[0] as number | null)
      if (speed <= 1) return took

      if (!told) {
        told = true
        log.debug(
          `Agent ${id} is correcting tool speeds this version no longer describes: ${this.name} ` +
            `went from ${Math.round(took)}ms to ${Math.round(took / speed)}ms`,
        )
      }

      // Time is inversely proportional to speed, and the original was computed at a speed of one.
      return took / speed
    }

    log.debug(`Agent ${id} can correct the tool speeds this version does not describe`)
    return true
  }

  const again = (): void => {
    if (!install()) return
    bot.removeListener('chunkColumnLoad', again as () => void)
  }

  bot.once('spawn', again)
  bot.on('chunkColumnLoad', again as () => void)
}

/** How fast the held tool really swings here, or 1 when the answer already accounted for it. */
function unpriced(bot: Bot, block: Breakable, held: number | null): number {
  if (!held) return 1

  const registry = bot.registry as unknown as {
    materials?: Record<string, Record<number, number>>
  }
  const materials = registry.materials
  if (!materials) return 1

  const named = block as unknown as { material?: string; harvestTools?: Record<number, boolean> }

  // Already priced: the block's own table knows this tool.
  if (named.material && materials[named.material]?.[held]) return 1

  // Not the right tool at all. Bare-hand speed is the correct answer for it.
  if (!named.harvestTools?.[held]) return 1

  // The right tool, priced nowhere. Whatever table does list it says how fast it swings.
  for (const [name, table] of Object.entries(materials)) {
    if (!name.startsWith('mineable/')) continue
    const speed = table[held]
    if (speed && speed > 1) return speed
  }

  return 1
}
