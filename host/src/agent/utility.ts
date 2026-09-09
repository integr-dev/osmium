import type { Bot } from 'mineflayer'

import { log } from '../log.ts'
import { RANK, type Schedule } from './schedule.ts'

/**
 * The utility modules: staying alive, and staying fed, without an operator watching.
 *
 * **Two of these are bypasses and two are not**, and the difference is worth keeping in mind because
 * it decides what a server can do about them. Auto-eat and auto-totem do what a player does, only
 * without being told; nothing about them is a lie. NoFall and the `spoof` half of anti-hunger tell
 * the server something untrue, which works and is exactly the shape an anticheat plugin looks for.
 * A ban is the one consequence in this project that cannot be undone, so they are off unless
 * somebody turns them on, and the interface says so where they are turned on.
 *
 * Everything here reads its settings through a getter rather than capturing them, like
 * `unscaleVelocity` does: these are toggles an operator flips while watching an agent, and a module
 * that needed a reconnect to notice would look broken at exactly the moment it was being tried.
 */

/** What an agent has been told to run. */
export interface Utilities {
  noFall: boolean
  /** `off`, `careful` - never sprint - or `spoof`, which sprints without admitting it. */
  antiHunger: AntiHunger
  autoEat: Mode
  autoTotem: Mode
  /** How close an untrusted player may come before the agent leaves. Zero is off. */
  fleeDistance: number
}

/** What the host does for a module besides read its setting. */
export interface UtilityHooks {
  /** Whether this name is one the agent will stand next to. */
  trusted: (name: string) => boolean
  /** Somebody it will not stand next to is here. Reported, and the session ended. */
  flee: (who: string, distance: number) => void
}

/**
 * How much a stock-keeping module is allowed to do about running out.
 *
 * `on` uses what the agent is carrying and stops when that is gone. `dupe` tops it back up with the
 * server's own `/dupe`, which is a plugin on some servers and an offence on others - so it is a
 * third mode rather than a default, and an operator picks it knowing which kind of server they are
 * standing on.
 */
export const MODES = ['off', 'on', 'dupe'] as const
export type Mode = (typeof MODES)[number]

export function modeFrom(written: string | undefined): Mode {
  const word = written?.trim()
  return (MODES as readonly string[]).includes(word ?? '') ? (word as Mode) : 'off'
}

/** A distance an operator wrote, or zero for anything that is not one. */
export function distanceFrom(written: string | undefined): number {
  const metres = Number(written?.trim())
  return Number.isFinite(metres) && metres > 0 ? metres : 0
}

export const ANTI_HUNGER = ['off', 'careful', 'spoof'] as const
export type AntiHunger = (typeof ANTI_HUNGER)[number]

export function antiHungerFrom(written: string | undefined): AntiHunger {
  const word = written?.trim()
  return (ANTI_HUNGER as readonly string[]).includes(word ?? '') ? (word as AntiHunger) : 'off'
}

/**
 * Under this the agent eats.
 *
 * Eighteen, because eighteen is exactly where the game stops regenerating health. Eating at the
 * first point below it keeps the agent inside the band where a scratch heals itself, which is most
 * of what "auto heal" turns out to mean - the rest is the golden apple.
 */
const FOOD_LOW = 18

/** Hurt enough to want the regeneration that being fed buys. */
const HEALTH_LOW = 14

/** Hurt enough to spend a golden apple, which is a real cost rather than a snack. */
const HEALTH_DIRE = 8

/** Twenty is full, and the bar is drawn in halves of one point. */
const HEALTH_FULL = 20

/** The two the game treats as medicine rather than as food. */
const GOLDEN = new Set(['golden_apple', 'enchanted_golden_apple'])

/**
 * Food that costs more than it gives, and is therefore not food.
 *
 * **The registry cannot tell you this.** `foods` carries `foodPoints` and `saturation` and nothing
 * about what eating one does to you, so a spider eye reads as two points of dinner and rotten flesh
 * as four - better than a carrot. An agent eating what it finds would poison itself on the way home,
 * and auto-eat exists to keep an agent alive rather than to keep a number topped up.
 *
 * Named rather than reasoned about, because the reasons do not generalise: poison for the eye and
 * the potato, hunger for the flesh, poison and nausea and hunger together for the pufferfish, and a
 * one-in-three chance of the same for raw chicken - which is a coin flip an unattended agent has no
 * business taking for two points. Chorus fruit does no damage at all and is here anyway: it
 * teleports whoever eats it up to eight blocks, which for an agent halfway across a bridge it built
 * is worse than being hungry.
 *
 * Suspicious stew is left out on purpose. What it does is in its components rather than its name, so
 * a bowl of it may be six points of dinner or may be poison, and refusing the good ones is a smaller
 * loss than this list can honestly avoid.
 */
const HARMFUL = new Set([
  'spider_eye',
  'poisonous_potato',
  'rotten_flesh',
  'pufferfish',
  'chicken',
  'chorus_fruit',
  'suspicious_stew',
])

const TOTEM = 'totem_of_undying'

/**
 * The effects a golden apple grants, by the id the protocol uses.
 *
 * An agent that has these has already eaten one. Without checking, [edible] answers "under eight
 * health, eat a golden apple" on every pass while the health bar takes its time coming back, and the
 * agent works through the stack in the time the first one was still doing its job.
 */
const ABSORPTION = 22
const REGENERATION = 10

/**
 * How long to leave between meals.
 *
 * Eating takes 1.6 seconds in game, so anything faster than this is the module starting a meal that
 * the last one has not finished. The effects a golden apple grants are the better signal and this is
 * the backstop for when they have not arrived yet - the server sends them a tick or two later, and
 * every pass in between reads "still hurt, eat another".
 */
const MEAL_EVERY = 2_000

/**
 * How much of each kind to keep, in items rather than stacks because items are what `/dupe`
 * multiplies. Eight totems rather than sixteen: they do not stack, so each one is a square of the
 * backpack, and eight is enough to survive anything that is not going to kill the agent anyway.
 *
 * **There is no separate "low" mark, and there cannot usefully be one.** Duping multiplies, so the
 * only counts it can do anything with are the ones at or under half the target - at twelve of
 * sixteen the multiplier rounds to one and the command would be a no-op. Half the target *is* the
 * low mark, which is also the earliest point at which topping up is possible, so the module tops up
 * the moment it can rather than waiting until the situation is dire. Stock therefore swings between
 * the target and half of it, and never falls below half.
 */
const STOCK = { food: 64, totem: 8 } as const

/**
 * How long a `/dupe` is given to land before it is treated as having failed.
 *
 * **Not a gap between dupes, and not a cooldown.** The command is not instant, and under end
 * crystals the count keeps falling while the last one is still in flight - so without this the
 * module reads "still only four" every half second and asks several times over for one lot of
 * totems. One question at a time is what stops that.
 *
 * Three quarters of a second: longer than a pass, short enough that a fight can still be kept up
 * with. Measured against a totem every 400ms, it sends about one command every 1.3 seconds and
 * holds the stock at three rather than letting it reach zero; against a quiet fight it sends three
 * in five minutes.
 */
const DUPE_LANDS = 750

/**
 * How long a totem pop counts towards judging how hard a fight is.
 *
 * Twenty seconds: long enough that a crystal exchange reads as one fight rather than as a series of
 * unrelated moments, short enough that the agent is back to carrying eight a few seconds after it
 * ends rather than hoarding thirty-two for the rest of the session.
 */
const FIGHT_WINDOW = 20_000

/**
 * How many pops inside that window it takes to double the target, and how far it may double.
 *
 * Eight totems is right for standing around and wrong for end crystals - the test that prompted this
 * spent eleven in under a minute and died holding the target it had been given. So the target is not
 * a constant: every three pops doubles it, up to four times what it started at, and it falls back on
 * its own as the window empties.
 */
const FIGHT_STEP = 3
const STOCK_MAX = 32

/**
 * How often the modules look at the agent, when nothing has told them to look sooner.
 *
 * Twice a second: faster than a person, slower than a tick. This is the net rather than the
 * mechanism - the totem refills on the event that emptied the hand, and eating is not urgent to the
 * half second.
 */
const TICK = 500

/** The server's word for "that entity just used a totem", which is the moment the hand goes empty. */
const TOTEM_POPPED = 35

/**
 * Claims solid ground in a movement packet, in **every** field that might carry the claim.
 *
 * Up to 1.21.2 the packet carried `onGround: bool`; from 1.21.4 it carries `flags`, a
 * `MovementFlags` bitfield whose first bit is `onGround`. Looking only for the boolean was the first
 * reason NoFall did nothing: on a current server that field is not serialised at all.
 *
 * **Setting whichever one is found and stopping was the second reason.** mineflayer fills in both,
 * unconditionally, from one shared object:
 *
 * ```js
 * lastSent.onGround = onGround
 * lastSent.flags = { onGround, hasHorizontalCollision: undefined } // 1.21.3+
 * ```
 *
 * So a packet always has the legacy boolean whether or not this version writes it out. Answering on
 * the first match meant setting the field the protocol ignores and leaving the one it reads exactly
 * as it was - a lie told into a field nobody opens. Every field gets it, and which one goes on the
 * wire is the serialiser's business.
 *
 * Answers nothing when there was nothing to change, so a caller can tell that from a rewrite.
 */
export function grounded(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const changed = { ...params }
  let claimed = false

  if (changed.onGround === false) {
    changed.onGround = true
    claimed = true
  }

  const flags = changed.flags

  if (typeof flags === 'object' && flags !== null && (flags as { onGround?: unknown }).onGround === false) {
    changed.flags = { ...(flags as object), onGround: true }
    claimed = true
  }

  // Some builds hand the bitfield across as a number rather than as its fields.
  if (typeof flags === 'number' && (flags & 1) === 0) {
    changed.flags = flags | 1
    claimed = true
  }

  return claimed ? changed : undefined
}

/** mineflayer's own word for the two hands, which `equip` takes. */
type Hand = 'hand' | 'off-hand'

/** The item an agent is carrying, as much of it as anything here needs. */
export interface Carried {
  name: string
  /** What the registry says this restores, or undefined for something that is not food. */
  foodPoints: number | undefined
}

/**
 * What to eat, or nothing when there is no reason to eat or nothing to eat.
 *
 * **Golden apples are for being hurt, not for being hungry.** They are the one food worth more than
 * the hunger they fill, so spending one because an agent walked a long way would be an agent quietly
 * eating a chest of valuables. Below [HEALTH_DIRE] that reverses: the point of a gapple is the
 * absorption and the regeneration, and an agent that dies holding one has saved nothing.
 *
 * Ordinary food is chosen by what it restores, largest first, because the alternative is an agent
 * eating forty carrots to do what two steaks would.
 */
export function edible(
  carried: readonly Carried[],
  health: number,
  food: number,
  /** Whether a golden apple is already working. One at a time is the whole of the rule. */
  medicated = false,
): Carried | undefined {
  const hurt = health < HEALTH_LOW
  if (food >= FOOD_LOW && !hurt) return undefined

  const foods = carried.filter((item) => item.foodPoints !== undefined && !HARMFUL.has(item.name))
  const plain = foods.filter((item) => !GOLDEN.has(item.name))
  const golden = foods.filter((item) => GOLDEN.has(item.name))

  // Dire first: the apple is the answer to the health, and the hunger is beside the point. Once,
  // and not again until it has worn off.
  if (health < HEALTH_DIRE && golden.length && !medicated) return golden[0]

  const best = [...plain].sort((left, right) => (right.foodPoints ?? 0) - (left.foodPoints ?? 0))[0]
  if (best) return best

  // Nothing else to eat. An agent starving with a gapple in its pocket should eat the gapple - but
  // only one at a time, the same rule as above. This fallback was the way round the guard: with no
  // ordinary food in the bag it is the branch that always runs, and it ate six enchanted apples in
  // three seconds while the first was still working.
  return medicated ? undefined : golden[0]
}

/**
 * What to pass `/dupe`, or nothing when there is no point asking.
 *
 * **The multiplier applies to the stack in hand, not to everything the agent owns**, and getting
 * that backwards is what made this useless for totems. A totem does not stack, so the hand holds
 * one: `/dupe 2` on it produces two totems and adds exactly **one** to the supply. Working the
 * multiplier out of the total - four totems, target eight, so double it - asked for `/dupe 2` and
 * gained one, over and over, while the fight spent one each time. Break-even, and an agent that dies
 * with the command apparently working perfectly. The live log said `Duped item 2 times` eleven times
 * in a row.
 *
 * So: how short the agent is, divided by what one command can copy at a time, plus the one that was
 * already there. Four totems short with one in hand is `/dupe 5`; half a stack of steak short with a
 * full stack in hand is `/dupe 2`.
 *
 * Overshoots when the held stack is larger than the shortfall, which is a stack of food arriving
 * slightly early rather than a problem. Under two is not worth sending: multiplying by one copies
 * nothing.
 */
/**
 * Whether an item counts as the food an agent keeps in stock.
 *
 * **A golden apple is not stock.** [edible] already draws that line - it is medicine, spent on being
 * badly hurt rather than on being hungry - and the restocking has to draw it in the same place. It
 * did not: it counted every food alike and copied the biggest pile, and a gapple stacks to sixty-four
 * where steak rarely does. So the command meant to top up dinner went after the valuables instead.
 *
 * Nothing here refuses to *eat* one. This is only about what is counted and what is copied.
 */
export function stocked(name: string, foodPoints: number | undefined): boolean {
  return foodPoints !== undefined && !GOLDEN.has(name) && !HARMFUL.has(name)
}

export function duplication(count: number, held: number, target: number): number | undefined {
  if (count < 1 || held < 1 || count >= target) return undefined

  const times = 1 + Math.ceil((target - count) / held)
  return times >= 2 ? times : undefined
}

/**
 * Everything the agent is carrying, **the off hand included**.
 *
 * mineflayer's `items()` covers slots 9 to 44 - the backpack and the hotbar - and stops there, so
 * the off hand is invisible to it. That is a reasonable default and the wrong one here: auto-totem
 * puts a totem in the off hand, and counting with `items()` then reports one fewer than the agent
 * has. On the last totem it reports **none**, so the restock that exists to prevent exactly that
 * finds nothing to multiply and does nothing. Down to one totem, and the module quietly stops.
 *
 * The armour and the crafting grid stay out. A chestplate is not stock and the two squares of a
 * half-assembled recipe are not either.
 */
export function carriedIn<T>(slots: readonly (T | null | undefined)[]): T[] {
  const held: T[] = []

  for (let slot = BACKPACK_FIRST; slot <= OFFHAND_SLOT; slot += 1) {
    const item = slots[slot]
    if (item) held.push(item)
  }

  return held
}

/**
 * How long any single inventory operation is given before it is abandoned.
 *
 * **mineflayer's window clicks can never finish.** On versions past the transaction packet,
 * `clickWindow` ends in `waitForWindowUpdate`, which waits for the server to echo the slot and has
 * no timeout of its own - so a click the server treats as a no-op leaves a promise that never
 * settles. One of those inside a module that guards itself with "an operation is in flight" is a
 * module that is in flight forever: the agent stopped putting totems in its off hand at all, and
 * died on the next hit with a backpack full of them.
 *
 * So nothing here awaits mineflayer without a deadline. Two seconds is far longer than a click that
 * is going to work, and the pass half a second later simply tries again.
 */
const CLICK_TIMEOUT = 2_000


/** What came of one attempt at something that talks to the server. */
export type Attempt<T> = { ok: true; value: T } | { ok: false; why: string }

/**
 * Runs [work] with a deadline, and says plainly whether it worked.
 *
 * **An answer of "nothing" used to mean both "it failed" and "it returned nothing"**, which for
 * `consume()` - whose success *is* nothing - made the two indistinguishable. So a rejected eat was
 * logged as a meal: the live log showed an agent eating eight enchanted golden apples in four
 * seconds, which is impossible at 1.6 seconds each, and the impossibility was the only clue that any
 * of them had failed. A swallowed error is worse than a loud one; it costs an evening.
 *
 * The rejection is still caught rather than left to surface later as an unhandled one - an abandoned
 * click is expected here - but the reason comes back with it.
 */
export async function within<T>(work: Promise<T>): Promise<Attempt<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      work.then(
        (value): Attempt<T> => ({ ok: true, value }),
        (failure): Attempt<T> => ({ ok: false, why: String(failure) }),
      ),
      new Promise<Attempt<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, why: 'no answer in time' }), CLICK_TIMEOUT)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The modules, attached to one session.
 *
 * Started and stopped with the session like the mapper and the inventory reporter, because every one
 * of these holds a listener or a timer against a bot that will be thrown away.
 */
export class AgentUtilities {
  private timer: ReturnType<typeof setInterval> | undefined

  /** True from the moment food is chosen until the hand is back, so the loop cannot overlap itself. */
  private busy = false

  /**
   * Whether the agent is standing still to eat.
   *
   * Read by whatever comes to place blocks. There is nothing to read it yet - the host holds
   * segments and does not build them - so this exists to be true before it is needed rather than to
   * be remembered afterwards.
   */
  get eating(): boolean {
    return this.busy
  }

  /*
   * **There is one cursor, and it is shared.** `window.selectedItem` holds whatever a click picked
   * up, and every window operation in mineflayer is pick-up-then-put-down against it. Two of them at
   * once - a totem going into the off hand while a golden apple is being moved into the main hand -
   * interleave their clicks and put items where neither meant. With food in the inventory that is
   * not a rare race: eating takes over a second, pops arrive whenever they arrive, and the refill is
   * driven by the pop rather than by the sweep.
   *
   * That used to be a boolean here, and one at a time was all it could say: whoever asked first got
   * the window and everybody else was turned away with a line in the log. One at a time was right
   * and first-come was not, so both now live in `schedule.ts`, which knows that a totem matters more
   * than a mouthful and takes the hands off one for the other.
   */

  /** When the last meal actually went down, so another cannot start on top of it. */
  private fed = 0

  /** True while an off-hand refill is in flight, so a burst of slot updates sends one click. */
  private filling = false

  private readonly onTick = (): void => {
    if (this.wanted().antiHunger === 'careful') this.bot.setControlState('sprint', false)
  }

  /**
   * The off hand emptied, so fill it now rather than at the next pass.
   *
   * **Half a second is a death.** A totem pops at one health and the next hit lands before a poll
   * comes round, which is the whole scenario the module exists for - so the refill hangs off the
   * two things that say the hand is empty rather than off the clock.
   *
   * Both, because they arrive at different times and either can be first. The server announces the
   * pop as an entity status the instant it applies it; the window update follows when the slot
   * change makes the round trip. Whichever wins, the other finds a totem already there and does
   * nothing.
   */
  private readonly onPopped = (packet: { entityId?: number; entityStatus?: number }): void => {
    if (packet.entityStatus !== TOTEM_POPPED || packet.entityId !== this.bot.entity?.id) return

    this.pops.push(Date.now())
    void this.refill()
  }

  private readonly onSlot = (): void => {
    void this.refill()
  }

  /** When the last `/dupe` went out, while its answer is still outstanding. */
  private sent = 0

  /** When each of the recent totem pops happened, for reading how hard the fight is. */
  private pops: number[] = []

  /** Set once the agent has decided to leave, so it decides once rather than every pass. */
  private fled = false

  /**
   * True while a pass is running, so two cannot overlap.
   *
   * Eating takes longer than the interval - well over a second of holding the item - so without
   * this the timer starts a second pass in the middle of the first. That pass finds `busy` set and
   * skips the restock, which meant an agent that was repeatedly hurt never got round to topping
   * anything up: the module that was supposed to keep it stocked was starved by the one keeping it
   * alive.
   */
  private passing = false

  constructor(
    private readonly agentId: number,
    private readonly bot: Bot,
    private readonly wanted: () => Utilities,
    private readonly hooks: UtilityHooks,
    /**
     * The one queue for the agent's hands.
     *
     * Shared with everything else that touches the inventory, which is the point: these modules used
     * to turn each other away with a boolean and a `the window was busy` line, so whichever asked
     * first won regardless of which mattered. See `schedule.ts`.
     */
    private readonly hands: Schedule,
  ) {}

  start(): void {
    if (this.timer) return

    this.spoof()
    this.bot.on('physicsTick', this.onTick)
    this.bot._client.on('entity_status', this.onPopped)
    this.bot.inventory.on('updateSlot', this.onSlot)
    this.timer = setInterval(() => void this.look(), TICK)

    log.debug(`Agent ${this.agentId} is running its utility modules`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined

    this.bot.removeListener('physicsTick', this.onTick)
    this.bot._client.removeListener('entity_status', this.onPopped)
    this.bot.inventory.removeListener('updateSlot', this.onSlot)
    this.busy = false
    this.filling = false
    this.fled = false
    this.pops = []
  }

  /**
   * The two lies, both told on the way out.
   *
   * Wrapping `write` rather than reacting to an event, because there is no event: these are packets
   * mineflayer is sending, and the only place to change what it says is between it and the socket.
   * The wrapper stays for the life of the session and asks the settings each time, so turning a
   * module off stops it lying rather than leaving one in place until the next connect.
   */
  private spoof(): void {
    const client = this.bot._client as unknown as {
      write: (name: string, params: Record<string, unknown>) => void
    }
    const write = client.write.bind(client)

    client.write = (name: string, params: Record<string, unknown>) => {
      const { noFall, antiHunger } = this.wanted()

      /*
       * NoFall: claim to be standing on the ground whenever the packet says otherwise.
       *
       * The server accumulates fall distance from what the client says about being airborne, so a
       * packet that says otherwise resets it and the landing costs nothing.
       *
       * **Every airborne packet, which is what Meteor's own packet mode does.** There was a velocity
       * threshold here, on the theory that only a real fall is worth lying about and a client
       * claiming ground every tick is easier to spot. Both halves of that were wrong in practice: the
       * server only resets the distance when it is told, so a lie that arrives late has already let
       * the damage accumulate - and the threshold made the module do nothing at all on a jump, which
       * is where most fall damage comes from in a fight.
       */
      if (noFall && MOVES.has(name)) {
        params = grounded(params) ?? params
      }

      /*
       * Anti-hunger, the spoof half: sprint without telling the server.
       *
       * Exhaustion is charged per metre at a rate that depends on whether the server believes the
       * player is sprinting, and it believes what this packet says. Dropping the start means the
       * agent moves at sprinting speed and is billed for walking.
       *
       * **This is the detectable one.** The speed is still sprinting speed and the server can see
       * that much for itself, so an anticheat that checks movement against declared state has
       * everything it needs. `careful` gives up the speed instead and tells no lies.
       */
      if (antiHunger === 'spoof' && name === 'entity_action' && params.actionId === START_SPRINTING) return

      write(name, params)
    }
  }

  /** One pass: leave if somebody is here, keep a totem in the off hand, eat, and top up. */
  private async look(): Promise<void> {
    if (this.passing) return
    this.passing = true

    const { autoTotem, autoEat } = this.wanted()

    try {
      // First, because the rest of it does not matter to an agent that is leaving.
      if (this.watch()) return

      if (autoTotem !== 'off') await this.totem()
      if (autoEat !== 'off') await this.eat()

      if (autoTotem === 'dupe') await this.restock(TOTEM, this.totemTarget())
      if (autoEat === 'dupe') await this.restock(undefined, STOCK.food)
    } catch (failure) {
      // A window read between sessions, a slot that moved underneath us, a server that refused the
      // click. The next pass is half a second away and starts from what is true then.
      log.debug(`Agent ${this.agentId} could not run a utility module: ${String(failure)}`)
    } finally {
      this.passing = false
    }
  }

  /**
   * Puts a totem in the off hand whenever there is not one there already.
   *
   * **Left exactly as it was before any of the restocking existed**, because it worked and three
   * attempts to improve it did not. What was tried, and why each failed, is in the host README; the
   * short version is that a staging click can hang forever and a swap packet the server ignores
   * raises nothing, so both replaced a working refill with silence.
   *
   * Anything added here in future has to answer one question first: after it runs, is a totem
   * actually in the off hand? A sent packet is not an answer.
   */
  private async totem(): Promise<void> {
    if (this.filling) return
    if (this.bot.inventory?.slots?.[OFFHAND_SLOT]?.name === TOTEM) return

    const spare = this.bot.inventory?.items()?.find((item) => item.name === TOTEM)
    if (!spare) return

    this.filling = true
    try {
      // Not "if nobody else is busy" any more. An agent with an empty off hand is one hit from the
      // end of its session, so this takes the hands off whatever had them and gives them back after.
      await this.hands.add({
        name: 'putting a totem in the off hand',
        rank: RANK.TOTEM,
        key: 'totem',
        run: async () => {
          const moved = await within(this.bot.equip(spare, 'off-hand' satisfies Hand))
          if (moved.ok) log.debug(`Agent ${this.agentId} moved a totem into its off hand`)
          else log.debug(`Agent ${this.agentId} could not fill its off hand: ${moved.why}`)
        },
      })
    } finally {
      this.filling = false
    }
  }

  /**
   * Leaves if somebody the operator has not vouched for is standing too close.
   *
   * **The trust list is the whole of the judgement.** A host cannot tell a friend from somebody
   * about to open a chest, and guessing from armour or from how long they have stood there is the
   * kind of cleverness that gets an unattended agent killed. Whoever is on the list may approach;
   * everybody else is a reason to leave.
   *
   * The agent's own account is not a stranger to itself. Other agents in the fleet are - they have
   * their own accounts and this host may not even own them - so an operator running several on one
   * server puts them on each other's lists, which is the same answer as for a friend.
   *
   * Decided once. Leaving takes a moment and the sweep keeps running through it, so without the
   * flag an agent would report the same person five times on the way out.
   */
  private watch(): boolean {
    const { fleeDistance } = this.wanted()
    if (!fleeDistance || this.fled) return false

    const here = this.bot.entity?.position
    if (!here) return false

    for (const [name, player] of Object.entries(this.bot.players ?? {})) {
      const at = player?.entity?.position
      if (!at || name === this.bot.username) continue
      if (this.hooks.trusted(name)) continue

      const distance = here.distanceTo(at)
      if (distance > fleeDistance) continue

      this.fled = true
      this.hooks.flee(name, distance)
      return true
    }

    return false
  }

  /**
   * Tops a stock back up with the server's own `/dupe`.
   *
   * `name` names one item; undefined means food, which is a kind rather than a thing - an agent
   * with two steaks and two carrots has four meals, and duping the steak is what it should do about
   * having fewer than it wants.
   *
   * **The command is run holding the item**, because that is what the plugin copies. The hand goes
   * back afterwards, for the same reason eating puts it back.
   *
   * Not reported as activity. It is a command the agent runs for itself every few minutes, and a
   * feed that says so is a feed with nothing else in it - the log has it at debug, where somebody
   * looking for it will look.
   */
  private async restock(name: string | undefined, target: number): Promise<void> {
    /*
     * **No `busy` or `filling` check here.** Those were meant to keep the restock out of the way of
     * eating and refilling, and in a fight they kept it out of the way of everything: eating sets one
     * and its own slot updates drive refills that set the other, so between the two there was never
     * an instant when the restock was allowed to look. It duped once before the fight and not again
     * during it - which is the opposite of when it is needed.
     *
     * The window lock already does this job properly, and does it for the few milliseconds a click
     * actually takes rather than for the second and a half a meal does.
     */

    const items = carriedIn(this.bot.inventory?.slots ?? [])
    const mine = items.filter((item) =>
      name === undefined
        ? stocked(item.name, this.bot.registry?.foods?.[item.type]?.foodPoints)
        : item.name === name,
    )

    const count = mine.reduce((total, item) => total + item.count, 0)
    if (Date.now() - this.sent < DUPE_LANDS) return

    /*
     * Half the target is the low-water mark, and it is a separate decision from the multiplier.
     *
     * The multiplier used to imply the mark - it could only act at or under half - and correcting it
     * to reach the target from any count took the mark away with it, which would have meant a
     * command per pop. So it is written down: top up when half of what is wanted is gone, and top up
     * all the way. Stock swings between the target and half of it, on one command per swing.
     */
    if (count * 2 > target) return

    /*
     * The biggest pile, and the **last** of them.
     *
     * Biggest because one command should move as much as it can. Last because of the order things
     * are spent in: the off hand is refilled from the first totem in the backpack, so duping that
     * one puts the command and the refill on the same square - and the totem is gone from under the
     * command exactly when the fight is fast enough to need it. The last one is the one nothing else
     * is about to take.
     *
     * `carriedIn` walks the slots in order, so the last match is the furthest from the refill.
     */
    const most = Math.max(...mine.map((item) => item.count))
    const holding = [...mine].reverse().find((item) => item.count === most)
    if (!holding) return

    const times = duplication(count, holding.count, target)
    if (times === undefined) return

    // Before the hands are claimed, because this refills the off hand and needs them itself.
    if (name === TOTEM) await this.totem()

    const held = this.bot.quickBarSlot

    /*
     * The whole sequence, under the same lock as eating.
     *
     * Selecting a square, checking what is in the hands and sending the command have to be one
     * uninterrupted thing. They were not, and auto-eat put a golden apple into the selected slot
     * between the check and the command - so `/dupe` copied the apple with the multiplier worked out
     * for totems. `Duped item 31 times`, a stack of apples, and an agent that still had two totems.
     */
    const ran = await this.atomically('duping', RANK.TIDY, async () => {
      try {
      /*
       * **A totem is copied out of the off hand, and never out of the main hand.**
       *
       * The held item is what pops first. So a totem moved into the main hand to be copied is the
       * very totem the next hit spends - and the command then arrives at a player holding nothing,
       * which is what "You must be holding an item in your hand" was saying all along. Worse, moving
       * it there is what emptied the off hand in the first place: the agent went into the next hit
       * with no totem in either hand, which is how a fight is lost rather than merely a command.
       *
       * So the off hand is made ready first and then left alone. The plugin copies the main hand,
       * and the off hand when the main hand is empty, so "make ready" is selecting an empty hotbar
       * square - one packet, moving nothing, safe in the middle of a fight in a way that shuffling
       * items is not. The totem stays where it can still save the agent while it is being copied.
       */
      if (name === TOTEM) {
        // Puts one there if the off hand is empty and a spare exists. Nothing to do if it does not.
        await this.totem()

        const ready = this.bot.inventory?.slots?.[OFFHAND_SLOT]
        if (ready?.name !== TOTEM) {
          log.debug(`Agent ${this.agentId} did not dupe a totem: none is in the off hand yet`)
          return
        }

        /*
         * Two ways to put a totem where the plugin will copy it, and the hotbar decides which.
         *
         * **An empty square, when there is one.** Selecting it empties the main hand, the plugin
         * falls back to the off hand, and nothing has been picked up or moved - which is what makes
         * this the one to prefer in the middle of a fight.
         *
         * **A spare held in the main hand, when there is not.** An agent in a fight has a full
         * hotbar, and the empty-square path then found nothing and quietly did nothing at all: the
         * totem restock had never once run under the conditions it exists for. Holding a spare costs
         * a click and is safe in a way that holding the *off-hand* totem is not - the held item pops
         * first, so what a hit spends is the copy about to be made while the off hand goes on
         * guarding the agent.
         */
        const square = this.emptyHand()

        if (square !== undefined) {
          this.bot.setQuickBarSlot(square)

          /*
           * The main hand has to be **empty**, not merely expected to be. The plugin copies it
           * whenever there is anything in it, so selecting a square that was empty a moment ago is
           * not the same as holding nothing now - and getting that wrong does not fail, it copies
           * the wrong item.
           */
          if (this.bot.heldItem) {
            log.debug(
              `Agent ${this.agentId} did not dupe a totem: holding ${this.bot.heldItem.name} in the main hand`,
            )
            return
          }
        } else {
          /*
           * Found by walking the squares rather than by reading `item.slot`.
           *
           * If that field were ever missing the comparison would pass and the search would happily
           * return the off-hand totem - the one thing this must never take. A loop that stops before
           * the off hand cannot make that mistake however the items are shaped.
           */
          const slots = this.bot.inventory?.slots ?? []
          let held: (typeof slots)[number] | undefined

          for (let slot = BACKPACK_FIRST; slot <= HOTBAR_LAST; slot += 1) {
            if (slots[slot]?.name === TOTEM) {
              held = slots[slot]
              break
            }
          }

          if (!held) {
            log.debug(`Agent ${this.agentId} did not dupe a totem: the hotbar is full and no spare to hold`)
            return
          }

          const inHand = await within(this.bot.equip(held, 'hand' satisfies Hand))
          if (!inHand.ok) {
            log.debug(`Agent ${this.agentId} could not hold a spare totem: ${inHand.why}`)
            return
          }

          if (this.bot.heldItem?.name !== TOTEM) {
            log.debug(`Agent ${this.agentId} did not dupe a totem: could not get a spare into the main hand`)
            return
          }
        }
      } else {
        const inHand = await within(this.bot.equip(holding, 'hand' satisfies Hand))
        if (!inHand.ok) {
          log.debug(`Agent ${this.agentId} could not hold ${holding.name}: ${inHand.why}`)
          return
        }

        /*
         * Checked rather than assumed. `equip` resolves when this side is satisfied, and what the
         * command needs is the *server* to agree - so the one thing worth confirming before spending
         * a line of public chat is that there is something to copy.
         */
        if (this.bot.heldItem?.name !== holding.name) {
          log.debug(`Agent ${this.agentId} did not dupe ${holding.name}: it is not in hand yet`)
          return
        }
      }

      // Before the hotbar is put back, so the command reaches the server while the hand is still
      // empty. Packets keep their order, so the restore in `finally` lands after it.
      this.bot.chat(`/dupe ${times}`)

      // Marked once the command has actually gone out, so the next pass waits for its answer.
      this.sent = Date.now()
      // Both hands and the selected square. What the plugin copies is decided by those, not by what
      // this code meant to copy - and when the two disagree, this line is the only thing that says so.
      log.debug(
        `Agent ${this.agentId} duped ${holding.name} x${times}, holding ${count}` +
          `, main=${this.bot.heldItem?.name ?? 'empty'}` +
          `, off=${this.bot.inventory?.slots?.[OFFHAND_SLOT]?.name ?? 'empty'}` +
          `, slot=${this.bot.quickBarSlot}`,
      )
      } finally {
        this.bot.setQuickBarSlot(held)
      }

      return true
    })

    // Said out loud, because a restock that never gets the window looks exactly like one that had
    // nothing to do - and telling those apart from the outside took three fights.
    if (ran === undefined) {
      log.debug(`Agent ${this.agentId} could not restock ${name ?? 'food'}`)
    }
  }

  /**
   * How many totems to keep, given how fast they are being spent.
   *
   * **A fight decides this, not a constant.** Eight is right for standing around and demonstrably
   * wrong under end crystals, where the agent spent eleven in under a minute and died at the target
   * it had been given. Every [FIGHT_STEP] pops inside [FIGHT_WINDOW] doubles what it aims for, to a
   * ceiling of [STOCK_MAX] - and because a totem does not stack, that ceiling is also a promise
   * about how much of the backpack this may take.
   *
   * It comes back down on its own. The window empties a few seconds after the fight does, and the
   * stock drains back to eight through ordinary use rather than being thrown away.
   */
  private totemTarget(): number {
    const since = Date.now() - FIGHT_WINDOW
    this.pops = this.pops.filter((at) => at >= since)

    const doublings = Math.floor(this.pops.length / FIGHT_STEP)
    return Math.min(STOCK_MAX, STOCK.totem * 2 ** doublings)
  }





  /**
   * A hotbar square with nothing in it, for duping what is in the off hand.
   *
   * The plugin reads the off hand only when the main hand is empty, and "empty" is a property of the
   * square that is selected rather than of the agent. Nothing here is moved: selecting an empty
   * square is a client-side choice the server is told about in one packet, which is what makes it
   * safe in the middle of a fight when moving items is not.
   */
  private emptyHand(): number | undefined {
    const slots = this.bot.inventory?.slots ?? []

    for (let slot = HOTBAR_FIRST; slot <= HOTBAR_LAST; slot += 1) {
      if (!slots[slot]) return slot - HOTBAR_FIRST
    }

    return undefined
  }

  /** The totem, on its own, for the events that cannot wait for the rest of a pass. */
  /**
   * Runs one piece of window work, or answers nothing when something else has the window.
   *
   * Everything inside is bounded by [within], because a lock a hung click never releases would stop
   * the agent eating, refilling or restocking for the rest of the session - which is a worse failure
   * than the interleaving this prevents.
   */
  /**
   * Runs something the queue may not split in half, and answers what it produced.
   *
   * {@link Schedule.add} settles with nothing, because most callers only need to know the work is
   * done. The dupe sequence needs its result, and needs to be indivisible - selecting a square,
   * checking the hands and sending the command are one thing, and auto-eat putting a golden apple
   * into the selected slot between the check and the command is how `/dupe` once copied an apple
   * with the multiplier worked out for totems.
   */
  private async atomically<T>(name: string, rank: number, work: () => Promise<T>): Promise<T | undefined> {
    let made: T | undefined

    await this.hands.add({
      name,
      rank,
      yields: false,
      run: async () => {
        made = await work()
      },
    })

    return made
  }

  private async refill(): Promise<void> {
    if (this.wanted().autoTotem === 'off') return

    try {
      await this.totem()
    } catch (failure) {
      // The next slot update or the next pass tries again, whichever comes first.
      log.debug(`Agent ${this.agentId} could not replace its totem: ${String(failure)}`)
    }
  }

  /**
   * Eats, standing still, and puts back what it was holding.
   *
   * **The agent stops moving first.** Eating takes over a second and a half of holding the item, and
   * an agent that walks through it arrives somewhere else having quietly not eaten. Every control
   * state is cleared and only the ones that were set are put back, so a module that fires mid-walk
   * does not leave the agent standing still afterwards.
   *
   * The hand goes back too. Which square is selected is the operator's, or the builder's, and an
   * agent that finished a meal holding bread instead of its stack of stone would be a module that
   * cost more than it saved.
   */
  /** Whether a golden apple is still working, so a second one would be thrown away. */
  private medicated(): boolean {
    const effects = (this.bot.entity as { effects?: Record<number, unknown> } | undefined)?.effects ?? {}

    return effects[ABSORPTION] !== undefined || effects[REGENERATION] !== undefined
  }

  private async eat(): Promise<void> {
    if (this.busy || this.bot.food === undefined) return
    if (Date.now() - this.fed < MEAL_EVERY) return

    const items = carriedIn(this.bot.inventory?.slots ?? [])
    const carried = items.map((item) => ({
      name: item.name,
      foodPoints: this.bot.registry?.foods?.[item.type]?.foodPoints,
    }))

    const wanted = edible(carried, this.bot.health ?? HEALTH_FULL, this.bot.food, this.medicated())
    if (!wanted) return

    const found = items.find((item) => item.name === wanted.name)
    if (!found) return

    this.busy = true
    const held = this.bot.quickBarSlot
    const moving = HELD_CONTROLS.filter((control) => this.bot.getControlState(control))

    try {
      this.bot.clearControlStates()

      await this.hands.add({
        name: 'eating',
        rank: RANK.HEAL,
        run: async (signal) => {
          try {
            const inHand = await within(this.bot.equip(found, 'hand' satisfies Hand))
            if (!inHand.ok) {
              log.debug(`Agent ${this.agentId} could not hold ${wanted.name}: ${inHand.why}`)
              return
            }

            // **The one place worth checking.** Eating is a swap and then a second and a half of
            // holding still, and a totem wanted in that window cannot wait for the mouthful. There
            // is no half-eaten apple to preserve: the queue puts this back and it starts again.
            if (signal.aborted) throw new Error('put down for something that matters more')

            const eaten = await within(this.bot.consume())
            if (!eaten.ok) {
              log.debug(`Agent ${this.agentId} could not eat ${wanted.name}: ${eaten.why}`)
              return
            }

            this.fed = Date.now()
            log.debug(`Agent ${this.agentId} ate ${wanted.name}`)
          } finally {
            // Inside the job. Putting the hotbar back only after letting go left a golden apple in
            // the selected slot for whatever took the hands next - which was the totem restock, and
            // it copied the apple with the multiplier worked out for totems.
            this.bot.setQuickBarSlot(held)
          }
        },
      })
    } finally {
      // In a `finally` because the reasons eating fails - a server that refuses it, a stack that ran
      // out mid-bite - are exactly the ones that would otherwise leave an agent rooted to the spot.
      for (const control of moving) this.bot.setControlState(control, true)
      this.busy = false
    }
  }
}

/** The packets that carry `onGround`, which is the field NoFall is about. */
const MOVES = new Set(['position', 'position_look', 'look', 'flying'])

/** `hasHorizontalCollision` in the `MovementFlags` bitfield, which is its second flag. */
const COLLIDED_BIT = 0b10

/** mineflayer's `entity_action` for starting a sprint, which is what the server prices movement by. */
const START_SPRINTING = 3


/** The off hand, as the window numbers it. Mirrors `OFFHAND` in `inventory.ts`. */
const OFFHAND_SLOT = 45

/** The first square of the backpack, which is where what an agent carries starts. */
const BACKPACK_FIRST = 9

/** The nine squares of the hotbar, which is what `setQuickBarSlot` indexes into. */
const HOTBAR_FIRST = 36
const HOTBAR_LAST = 44

/** The states worth putting back after a meal. Everything a caller can have set. */
const HELD_CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const
