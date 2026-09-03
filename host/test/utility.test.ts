import { describe, expect, it, vi } from 'vitest'

import {
  antiHungerFrom,
  carriedIn,
  distanceFrom,
  duplication,
  edible,
  grounded,
  modeFrom,
  within,
  type Carried,
} from '../src/agent/utility.ts'

/**
 * The modules decide three things and do the rest by talking to mineflayer. These are the three,
 * pulled out so they can be asked directly rather than by putting an agent in a server and starving
 * it.
 */

const food = (name: string, foodPoints: number): Carried => ({ name, foodPoints })
const thing = (name: string): Carried => ({ name, foodPoints: undefined })

const STEAK = food('cooked_beef', 8)
const CARROT = food('carrot', 3)
const GAPPLE = food('golden_apple', 4)
const NOTCH = food('enchanted_golden_apple', 4)

describe('what to eat', () => {
  it('does not eat a fed agent in one piece', () => {
    expect(edible([STEAK], 20, 20)).toBeUndefined()
    expect(edible([STEAK], 20, 17)).toBe(STEAK)
  })

  /** Eighteen is where the game stops healing, so seventeen is where being fed starts to matter. */
  it('eats before hunger stops the healing', () => {
    expect(edible([STEAK], 20, 18)).toBeUndefined()
    expect(edible([STEAK], 20, 17)).toBe(STEAK)
  })

  /** The heal half: full stomach, hurt agent, and food is what buys the regeneration. */
  it('eats because it is hurt, not only because it is hungry', () => {
    expect(edible([STEAK], 13, 20)).toBe(STEAK)
    expect(edible([STEAK], 14, 20)).toBeUndefined()
  })

  it('eats the largest ordinary food rather than a handful of small ones', () => {
    expect(edible([CARROT, STEAK], 20, 10)).toBe(STEAK)
  })

  /**
   * A golden apple is worth more than the hunger it fills, so an agent that walked a long way must
   * not quietly eat a chest of them.
   */
  it('saves golden apples for being badly hurt', () => {
    expect(edible([STEAK, GAPPLE], 20, 10)).toBe(STEAK)
    expect(edible([STEAK, GAPPLE], 7, 10)).toBe(GAPPLE)
    expect(edible([STEAK, NOTCH], 7, 10)).toBe(NOTCH)
  })

  /** Dying holding one saves nothing, and starving holding one is the same argument. */
  it('eats a golden apple rather than nothing at all', () => {
    expect(edible([GAPPLE], 20, 10)).toBe(GAPPLE)
  })

  it('does not try to eat what is not food', () => {
    expect(edible([thing('cobblestone'), thing('totem_of_undying')], 5, 5)).toBeUndefined()
    expect(edible([], 5, 5)).toBeUndefined()
  })
})

/**
 * Why NoFall did nothing at all: the movement packet changed shape. Up to 1.21.2 it carried
 * `onGround: bool`; from 1.21.4 it carries `flags`, a bitfield whose first bit is `onGround`. The
 * code looked only for the boolean, so on any current server it found nothing to change and every
 * packet went out honest.
 */
describe('claiming solid ground', () => {
  it('sets the old boolean field', () => {
    expect(grounded({ x: 1, y: 2, z: 3, onGround: false })).toEqual({ x: 1, y: 2, z: 3, onGround: true })
  })

  /**
   * **The shape mineflayer actually sends**, copied from `physics.js`, which fills in both fields
   * from one shared object every time. Testing them separately is what let the real bug through:
   * answering on the first match set the legacy boolean the protocol no longer serialises and left
   * `flags.onGround` false, so the claim went into a field nobody reads.
   */
  it('sets both fields, because mineflayer fills in both', () => {
    const sent = {
      x: 1,
      y: 2,
      z: 3,
      onGround: false,
      flags: { onGround: false, hasHorizontalCollision: undefined },
    }

    expect(grounded(sent)).toEqual({
      x: 1,
      y: 2,
      z: 3,
      onGround: true,
      flags: { onGround: true, hasHorizontalCollision: undefined },
    })
  })

  /** 1.21.4 and later. This is the one that was being missed. */
  it('sets the bit inside the newer flags field', () => {
    expect(grounded({ x: 1, flags: { onGround: false, hasHorizontalCollision: true } })).toEqual({
      x: 1,
      flags: { onGround: true, hasHorizontalCollision: true },
    })
  })

  it('sets the bit when the flags arrive as a number', () => {
    expect(grounded({ flags: 0b10 })).toEqual({ flags: 0b11 })
  })

  /** Nothing to do, and the caller can tell that from a change. */
  it('answers nothing when the packet already says so', () => {
    expect(grounded({ onGround: true })).toBeUndefined()
    expect(grounded({ flags: { onGround: true } })).toBeUndefined()
    expect(grounded({ flags: 0b01 })).toBeUndefined()
    expect(grounded({ yaw: 90 })).toBeUndefined()
  })

  /** The original is left alone, since it is the object mineflayer is about to reuse. */
  it('does not change the packet it was given', () => {
    const packet = { flags: { onGround: false } }

    grounded(packet)

    expect(packet.flags.onGround).toBe(false)
  })
})

describe('reading the anti-hunger setting', () => {
  it('takes the three it knows', () => {
    expect(antiHungerFrom('careful')).toBe('careful')
    expect(antiHungerFrom('spoof')).toBe('spoof')
    expect(antiHungerFrom('off')).toBe('off')
  })

  /** Unset is off, and so is anything a newer Osmium wrote that this build cannot name. */
  it('is off for anything it cannot name', () => {
    expect(antiHungerFrom(undefined)).toBe('off')
    expect(antiHungerFrom('')).toBe('off')
    expect(antiHungerFrom('  ')).toBe('off')
    expect(antiHungerFrom('aggressive')).toBe('off')
  })
})

describe('reading a module mode', () => {
  it('takes the three it knows', () => {
    expect(modeFrom('on')).toBe('on')
    expect(modeFrom('dupe')).toBe('dupe')
    expect(modeFrom('off')).toBe('off')
  })

  /** Unset is off. So is a mode written by a newer Osmium, which must not be guessed at. */
  it('is off for anything it cannot name', () => {
    expect(modeFrom(undefined)).toBe('off')
    expect(modeFrom('')).toBe('off')
    expect(modeFrom('always')).toBe('off')
  })
})

describe('reading a flee distance', () => {
  it('takes a distance', () => {
    expect(distanceFrom('32')).toBe(32)
    expect(distanceFrom(' 8.5 ')).toBe(8.5)
  })

  /** Off is the answer to a blank box and to anything that is not a distance. */
  it('is off for anything that is not one', () => {
    expect(distanceFrom(undefined)).toBe(0)
    expect(distanceFrom('')).toBe(0)
    expect(distanceFrom('near')).toBe(0)
    expect(distanceFrom('0')).toBe(0)
    expect(distanceFrom('-16')).toBe(0)
  })
})

describe('what to pass /dupe', () => {
  /**
   * The multiplier applies to the **stack in hand**, not to everything the agent owns. Working it out
   * of the total is what made this useless for totems: four of them, target eight, "so double it" -
   * and `/dupe 2` on a stack of one gains exactly one totem while the fight spends one. Break-even,
   * and the live log said `Duped item 2 times` eleven times over before the agent died.
   */
  it('asks for what is missing, not for a multiple of the total', () => {
    // A totem does not stack, so the hand holds one and every copy is a whole totem.
    expect(duplication(4, 1, 8)).toBe(5)
    expect(duplication(7, 1, 8)).toBe(2)
    expect(duplication(1, 1, 8)).toBe(8)
  })

  /** Whatever the shortfall, one command covers it. */
  it('reaches the target from any count', () => {
    for (let count = 1; count < 8; count += 1) {
      const times = duplication(count, 1, 8)
      expect(count + (times ?? 1) - 1).toBe(8)
    }
  })

  /** A bigger stack in hand carries more per copy, so it needs fewer. */
  it('counts a full stack as a full stack', () => {
    expect(duplication(32, 32, 64)).toBe(2)
    expect(duplication(16, 8, 64)).toBe(7)
  })

  it('says nothing when there is nothing to do', () => {
    expect(duplication(0, 1, 64)).toBeUndefined()
    expect(duplication(64, 64, 64)).toBeUndefined()
    expect(duplication(100, 64, 64)).toBeUndefined()
    expect(duplication(8, 0, 64)).toBeUndefined()
  })

  /**
   * The low-water mark is a separate rule from the multiplier, and has to be: correcting the
   * multiplier to reach the target from any count took the mark with it, which would have meant one
   * command per pop.
   */
  it('swings between the target and half of it, one command per swing', () => {
    const target = 8
    let count = target
    let lowest = count
    let commands = 0

    for (let used = 0; used < 200; used += 1) {
      count -= 1
      lowest = Math.min(lowest, count)

      if (count * 2 > target) continue

      const times = duplication(count, 1, target)
      if (times === undefined) continue

      commands += 1
      count += times - 1
      expect(count).toBe(target)
    }

    expect(lowest).toBe(target / 2)
    expect(commands).toBe(200 / (target / 2))
  })
})

/**
 * The bug this exists for: auto-totem puts the totem in the off hand, and mineflayer's own
 * `items()` stops at slot 44. On the last totem the count came back as none, so the restock that
 * exists to prevent running out found nothing to multiply and did nothing.
 */
describe('what the agent is carrying', () => {
  /** Slots 0-4 crafting, 5-8 armour, 9-35 backpack, 36-44 hotbar, 45 off hand. */
  function window(filled: Record<number, string>) {
    const slots: (string | null)[] = Array.from({ length: 46 }, () => null)
    for (const [slot, item] of Object.entries(filled)) slots[Number(slot)] = item
    return slots
  }

  it('counts the off hand, which items() leaves out', () => {
    expect(carriedIn(window({ 45: 'totem_of_undying' }))).toEqual(['totem_of_undying'])
  })

  it('counts the backpack and the hotbar', () => {
    expect(carriedIn(window({ 9: 'bread', 36: 'cooked_beef', 44: 'stone' }))).toEqual([
      'bread',
      'cooked_beef',
      'stone',
    ])
  })

  /** A chestplate is not stock, and half a recipe is not either. */
  it('leaves out the armour and the crafting grid', () => {
    expect(carriedIn(window({ 0: 'stick', 3: 'plank', 5: 'diamond_helmet', 8: 'diamond_boots' }))).toEqual([])
  })

  it('is empty for an empty inventory', () => {
    expect(carriedIn(window({}))).toEqual([])
    expect(carriedIn([])).toEqual([])
  })
})

/**
 * The plugin copies the main hand, and the off hand when the main hand is empty. So duping what is
 * already in the off hand is a matter of selecting an empty square rather than moving anything —
 * which is what an agent under fire can afford to do, and what stops the command overtaking its own
 * inventory click.
 */
describe('finding an empty hand', () => {
  function window(filled: Record<number, string>) {
    const slots: (string | null)[] = Array.from({ length: 46 }, () => null)
    for (const [slot, item] of Object.entries(filled)) slots[Number(slot)] = item
    return slots
  }

  /** `setQuickBarSlot` counts from the left of the hotbar, not from the window's slot numbers. */
  function emptyHand(slots: readonly (string | null)[]): number | undefined {
    for (let slot = 36; slot <= 44; slot += 1) if (!slots[slot]) return slot - 36
    return undefined
  }

  it('finds the first empty hotbar square', () => {
    expect(emptyHand(window({ 36: 'sword', 37: 'pick' }))).toBe(2)
    expect(emptyHand(window({}))).toBe(0)
  })

  it('ignores the backpack and the off hand, which cannot be held', () => {
    const full = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [36 + i, 'stone']))
    expect(emptyHand(window({ ...full, 9: null as unknown as string, 45: 'totem_of_undying' }))).toBeUndefined()
  })

  /** Nowhere to put an empty hand means falling back to holding the item, not duping into thin air. */
  it('says nothing when the hotbar is full', () => {
    const full = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [36 + i, 'stone']))
    expect(emptyHand(window(full))).toBeUndefined()
  })
})

/**
 * Which of several identical totems to copy.
 *
 * The off hand is refilled from the **first** one in the backpack, so duping that one puts the
 * command and the refill on the same square — and in a fight fast enough to need the dupe, the totem
 * is gone from under the command before it lands. That is what "You must be holding an item in your
 * hand" looked like from the server's side.
 */
describe('which pile to copy', () => {
  /** `carriedIn` walks the slots in order, so the array is already in slot order. */
  function chosen(counts: number[]): number {
    const most = Math.max(...counts)
    return counts.length - 1 - [...counts].reverse().findIndex((count) => count === most)
  }

  it('takes the last of them when every pile is the same size', () => {
    // Totems do not stack, so every "pile" is one — and the last is the one nothing else will take.
    expect(chosen([1, 1, 1, 1])).toBe(3)
  })

  it('still takes the biggest, so one command moves the most', () => {
    expect(chosen([8, 64, 32])).toBe(1)
  })

  it('breaks a tie towards the far end', () => {
    expect(chosen([64, 12, 64])).toBe(2)
  })
})

/**
 * Eight totems is right for standing around and wrong under end crystals: the test that prompted
 * this spent eleven in under a minute and died at the target it had been given. So the target
 * follows the fight.
 */
describe('how many totems a fight calls for', () => {
  const WINDOW = 20_000
  const STEP = 3
  const BASE = 8
  const MAX = 32

  function target(pops: number[], now: number): number {
    const recent = pops.filter((at) => at >= now - WINDOW)
    return Math.min(MAX, BASE * 2 ** Math.floor(recent.length / STEP))
  }

  const at = (...seconds: number[]) => seconds.map((second) => second * 1000)

  it('asks for the base when nothing is happening', () => {
    expect(target([], 60_000)).toBe(8)
    expect(target(at(1, 2), 10_000)).toBe(8)
  })

  it('doubles as the pops add up', () => {
    expect(target(at(1, 2, 3), 10_000)).toBe(16)
    expect(target(at(1, 2, 3, 4, 5, 6), 10_000)).toBe(32)
  })

  /** A ceiling, because a totem does not stack and thirty-two of them is most of a backpack. */
  it('stops at the ceiling however bad it gets', () => {
    expect(target(at(...Array.from({ length: 40 }, (_, i) => i / 2)), 20_000)).toBe(32)
  })

  /** It comes back down on its own rather than hoarding for the rest of the session. */
  it('falls back once the fight is over', () => {
    const fight = at(1, 2, 3, 4, 5, 6)

    expect(target(fight, 10_000)).toBe(32)
    expect(target(fight, 40_000)).toBe(8)
  })
})

/**
 * The wedge this exists for: mineflayer's `clickWindow` ends in `waitForWindowUpdate`, which waits
 * for the server to echo the slot and has no timeout. A click the server treats as a no-op therefore
 * leaves a promise that never settles — and a module that guards itself with "an operation is in
 * flight" is then in flight forever. The agent stopped putting totems in its off hand at all and died
 * on the next hit with a backpack full of them.
 */
describe('giving an inventory call a deadline', () => {
  it('answers with the result when the call finishes', async () => {
    await expect(within(Promise.resolve('done'))).resolves.toBe('done')
  })

  /** An abandoned click is expected here, not exceptional, so it must not surface as a rejection. */
  it('answers with nothing when the call fails', async () => {
    await expect(within(Promise.reject(new Error('server rejected the click')))).resolves.toBeUndefined()
  })

  it('answers with nothing when the call never settles', async () => {
    vi.useFakeTimers()

    try {
      const answer = within(new Promise<string>(() => {}))
      await vi.advanceTimersByTimeAsync(2_000)

      await expect(answer).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
