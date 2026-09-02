import { describe, expect, it } from 'vitest'

import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'

import { ARMOUR_FIRST, OFFHAND, holdable, inventoryOf, movable } from '../src/agent/inventory.ts'

/**
 * What an inventory report says, read back out of it.
 *
 * The slot numbers are the whole point of this module - they are Minecraft's, they travel to a
 * browser, and they come back as a click. Every way of getting them wrong looks the same from the
 * outside: a grid that is drawn, and drawn one square out. So the fakes below put a known item in a
 * known square and the assertions read it back at the square it should have landed on.
 */

/** Enough of a `prismarine-item` to be reported. The real one carries fifty fields. */
function item(over: Partial<Item> = {}): Item {
  return {
    type: 1,
    slot: -1,
    count: 1,
    metadata: 0,
    name: 'stone',
    displayName: 'Stone',
    stackSize: 64,
    maxDurability: 0,
    durabilityUsed: 0,
    ...over,
  } as Item
}

/** Enough of a bot to have a window on its own inventory. */
function bot(slots: Record<number, Item>, held = 0): Bot {
  const window: Array<Item | null> = Array.from({ length: 46 }, () => null)
  for (const [slot, carried] of Object.entries(slots)) window[Number(slot)] = carried

  return { inventory: { slots: window }, quickBarSlot: held } as unknown as Bot
}

describe('movable', () => {
  it('accepts the armour, the backpack, the hotbar and the off hand', () => {
    for (const slot of [5, 8, 9, 35, 36, 44, 45]) expect(movable(slot)).toBe(true)
  })

  it('refuses the crafting grid and its output', () => {
    // Slot 0 is not a container at all: putting something into it is not a move a server can take.
    for (const slot of [0, 1, 4]) expect(movable(slot)).toBe(false)
  })

  it('refuses anything outside the window', () => {
    for (const slot of [-1, 46, 100]) expect(movable(slot)).toBe(false)
  })

  it('refuses a slot that is not a whole number', () => {
    // The number arrives from a browser, through JSON, where 36.5 is as ordinary as 36.
    expect(movable(36.5)).toBe(false)
    expect(movable(Number.NaN)).toBe(false)
  })
})

describe('holdable', () => {
  it('accepts the nine squares of the hotbar', () => {
    for (const slot of [36, 40, 44]) expect(holdable(slot)).toBe(true)
  })

  it('refuses everything else a move would accept', () => {
    // A hand change is a narrower thing than a move: the armour, the backpack and the off hand are
    // all legitimate places to put an item and none of them can be the one in hand.
    for (const slot of [5, 8, 9, 35, 45]) expect(holdable(slot)).toBe(false)
  })

  it('refuses a slot that is not a whole number', () => {
    expect(holdable(40.5)).toBe(false)
  })
})

describe('inventoryOf', () => {
  it('reports occupied squares only', () => {
    const read = inventoryOf(bot({ 36: item(), 9: item({ name: 'dirt', displayName: 'Dirt' }) }))

    expect(read.slots.map((held) => held.slot).sort((a, b) => a - b)).toEqual([9, 36])
  })

  it('reports the square it read from rather than the items own idea of it', () => {
    // The window keeps `item.slot` up to date and it agrees today. A stale one is a way for an item
    // to be drawn in a square it is not in, and there is no reason to trust it over the loop.
    const read = inventoryOf(bot({ 36: item({ slot: 9 }) }))

    expect(read.slots[0]?.slot).toBe(36)
  })

  it('carries the count and both names', () => {
    const read = inventoryOf(bot({ 36: item({ count: 42, name: 'oak_log', displayName: 'Oak Log' }) }))

    expect(read.slots[0]).toMatchObject({ count: 42, name: 'oak_log', displayName: 'Oak Log' })
  })

  it('carries wear as used out of total, for something that wears out', () => {
    const read = inventoryOf(bot({ 36: item({ maxDurability: 1561, durabilityUsed: 142 }) }))

    expect(read.slots[0]).toMatchObject({ damage: 142, maxDamage: 1561 })
  })

  it('carries no wear at all for something that does not', () => {
    // Absent rather than zero: "undamaged" and "not the kind of thing that takes damage" are
    // different answers, and a browser draws a bar for the first and nothing for the second.
    const read = inventoryOf(bot({ 36: item({ maxDurability: 0 }) }))

    expect(read.slots[0]).not.toHaveProperty('damage')
    expect(read.slots[0]).not.toHaveProperty('maxDamage')
  })

  it('reads the armour and the off hand', () => {
    const read = inventoryOf(bot({ [ARMOUR_FIRST]: item(), [OFFHAND]: item() }))

    expect(read.slots.map((held) => held.slot).sort((a, b) => a - b)).toEqual([ARMOUR_FIRST, OFFHAND])
  })

  it('leaves the crafting grid out', () => {
    // Those squares hold items only while a recipe is half-assembled, and reporting them would put
    // two squares on the screen that a click cannot do anything with.
    expect(inventoryOf(bot({ 0: item(), 1: item() })).slots).toEqual([])
  })

  it('reports which hotbar square is in hand, as an index rather than a slot', () => {
    expect(inventoryOf(bot({}, 3)).held).toBe(3)
  })

  it('reports an empty inventory as empty rather than as nothing', () => {
    expect(inventoryOf(bot({}))).toEqual({ slots: [], held: 0 })
  })
})
