import { createHash } from 'node:crypto'

import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'

import { log } from '../log.ts'

/**
 * What an agent is carrying, and the two things an operator can do about it.
 *
 * The window an agent has open on its own inventory is the same one a player sees on `E`, so the
 * slot numbers here are Minecraft's own rather than a shape invented for the interface. That is
 * deliberate: a move is executed as a click on a slot, and any renumbering between the screen and
 * the click is a place for the two to disagree about which square somebody pointed at.
 *
 * Reported for the whole session, like the map and unlike the viewer. It is a few hundred bytes and
 * it only moves when items do, so there is nothing to gate behind somebody having the page open -
 * and an operator opening it wants to see what is there now, not to wait for a first report.
 */

/** The armour slots, top to bottom, as the window numbers them. */
export const ARMOUR_FIRST = 5
export const ARMOUR_LAST = 8

/** The 27 squares of the backpack. */
export const MAIN_FIRST = 9
export const MAIN_LAST = 35

/** The nine squares of the hotbar, left to right. */
export const HOTBAR_FIRST = 36
export const HOTBAR_LAST = 44

/** The off hand, which is its own place rather than part of the armour. */
export const OFFHAND = 45

/**
 * The window click that throws something on the ground, and its two buttons.
 *
 * Mode 4 is the only click that acts on the square it names without picking anything up, which is
 * what makes it the right one here: everything else in the protocol moves an item to the cursor
 * first, and the cursor has to go somewhere afterwards.
 */
export const DROP_CLICK = 4
export const DROP_ONE = 0
export const DROP_STACK = 1

/** Whether a slot is one of the nine the agent can hold. */
export function holdable(slot: number): boolean {
  return Number.isInteger(slot) && slot >= HOTBAR_FIRST && slot <= HOTBAR_LAST
}

/**
 * The slots an operator may touch.
 *
 * Everything except the 2x2 crafting grid and its output. Those hold items only while a recipe is
 * half-assembled, and the output square is not a container at all - putting something into it is
 * not a move the server has any way to accept.
 */
export function movable(slot: number): boolean {
  return Number.isInteger(slot) && slot >= ARMOUR_FIRST && slot <= OFFHAND
}

/** One occupied square. Empty squares are absent rather than null - see {@link Inventory}. */
export interface InventorySlot {
  /** Minecraft's own slot number, in the player window. */
  slot: number
  /** The id, for looking up an icon: `diamond_pickaxe`. */
  name: string
  /** What the game calls it, for reading: `Diamond Pickaxe`. */
  displayName: string
  count: number
  /** How much of the item's life is used up. Absent for anything that does not wear out. */
  damage?: number
  /** What {@link damage} is out of. Present exactly when `damage` is. */
  maxDamage?: number
}

/** Everything an agent is carrying, at one moment. */
export interface Inventory {
  /** Occupied squares only. A square not named here is empty, which is what a client draws. */
  slots: InventorySlot[]
  /** Which hotbar square is in hand, as an index from 0 to 8 rather than a window slot. */
  held: number
}

/**
 * The item in a slot, as much of it as travels.
 *
 * Durability is sent as used-out-of-total rather than as a percentage or a bar, because that is the
 * pair the game itself shows and the one an operator compares against. An item with no maximum -
 * a block, a stack of arrows - carries neither, so a client can tell "undamaged" from "not the kind
 * of thing that takes damage" without a sentinel.
 */
function slotFrom(item: Item, slot: number): InventorySlot {
  const worn = item.maxDurability > 0

  return {
    // The square it was read from, not `item.slot`. The window keeps that field up to date
    // and it agrees today - but the loop already knows where it looked, and a stale field is a way
    // for an item to be drawn in a square it is not in.
    slot,
    name: item.name,
    displayName: item.displayName,
    count: item.count,
    ...(worn ? { damage: item.durabilityUsed, maxDamage: item.maxDurability } : {}),
  }
}

/** Reads the window as it stands. */
export function inventoryOf(bot: Bot): Inventory {
  const slots: InventorySlot[] = []

  for (let slot = ARMOUR_FIRST; slot <= OFFHAND; slot++) {
    const item = bot.inventory.slots[slot]
    if (item) slots.push(slotFrom(item, slot))
  }

  return { slots, held: bot.quickBarSlot }
}

/**
 * How long to wait after a slot changes before reporting.
 *
 * Picking up a stack off the floor is several updates, and smelting or eating is one every tick.
 * Reporting once the changes have stopped turns a minute of mining into a report per pickup rather
 * than one per item.
 */
const SETTLE = 400

/** How often to look for a settled change. */
const TICK = 200

/**
 * Follows one agent's inventory and reports it when it changes.
 *
 * Deduplicated by digest rather than by trusting the events: `updateSlot` fires on every window
 * refresh the server sends, including the full one that follows a respawn, and most of those
 * describe an inventory identical to the one already reported.
 */
export class AgentInventory {
  /** When the last slot change came in, or 0 when nothing is waiting to be reported. */
  private touched = 0

  /** A digest of what was last sent, so an unchanged inventory is read but not resent. */
  private sent: string | undefined

  private timer: ReturnType<typeof setInterval> | undefined

  private readonly onSlot = (): void => {
    this.touched = Date.now()
  }

  constructor(
    private readonly agentId: number,
    private readonly bot: Bot,
    private readonly send: (inventory: Inventory) => void,
  ) {}

  start(): void {
    if (this.timer) return

    this.bot.inventory.on('updateSlot', this.onSlot)
    // Which square is in hand is part of the picture and changes without any slot changing.
    this.bot.on('heldItemChanged', this.onSlot)
    this.timer = setInterval(() => this.drain(), TICK)

    // Reported at once rather than on the first change. An agent that joins with a full inventory
    // and then stands still would otherwise show an empty one for as long as it stands there.
    this.touched = Date.now() - SETTLE

    log.debug(`Agent ${this.agentId} is reporting its inventory`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined

    this.bot.inventory.removeListener('updateSlot', this.onSlot)
    this.bot.removeListener('heldItemChanged', this.onSlot)

    this.touched = 0
    // The digest goes with the session. A new one starts by saying what it is carrying, whether or
    // not that happens to match what the last one ended with.
    this.sent = undefined
  }

  private drain(): void {
    if (!this.touched || Date.now() - this.touched < SETTLE) return
    this.touched = 0

    let inventory: Inventory
    try {
      inventory = inventoryOf(this.bot)
    } catch (failure) {
      // A window read between sessions, most likely. The next change reads it again.
      log.debug(`Agent ${this.agentId} could not read its inventory: ${String(failure)}`)
      return
    }

    const shape = createHash('sha1').update(JSON.stringify(inventory)).digest('base64')
    if (this.sent === shape) return
    this.sent = shape

    this.send(inventory)
  }

  /**
   * Asks for a report on the next pass, whether or not a slot has changed.
   *
   * Clears the digest as well, so this really does send. The digest exists to suppress a report
   * identical to the last one, and every caller here is asking precisely because the *receiver* may
   * no longer have that one - a command whose outcome needs confirming, or a backend that has
   * restarted since.
   */
  refresh(): void {
    this.sent = undefined
    this.touched = Date.now() - SETTLE
  }
}
