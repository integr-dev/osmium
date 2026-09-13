import { antiHungerFrom } from '../utility.ts'

/**
 * What an operator has told an agent about getting from one place to another.
 *
 * Read per plan rather than captured, like the utility modules: these are toggles somebody flips
 * while watching an agent walk into a wall, and one that needed a reconnect to take effect would
 * look broken at exactly the moment it was being tried.
 */
export interface PathSettings {
  /** How far from the agent the search may look, in blocks. */
  range: number
  /** May break blocks to get through. */
  dig: boolean
  /** May place blocks to cross, out of what it is carrying. */
  bridge: boolean
  /** May jump gaps rather than walking around them. */
  parkour: boolean
  /** The furthest it will step off, in blocks. */
  maxDrop: number
  /**
   * Whether it may sprint.
   *
   * Not a setting of its own: it is what `util.antiHunger` already decided. `careful` exists to
   * keep the agent from burning food, and sprinting is where the food goes - so a pathfinder that
   * sprinted anyway would quietly undo the module an operator turned on.
   *
   * Settled here rather than left to the two tick handlers to fight over. Both run on every
   * `physicsTick` and the later one wins, which is an answer that depends on the order two
   * unrelated things happened to be registered in.
   */
  sprint: boolean
  /**
   * How hard the search leans on the distance left - see `LEAN` in ground.ts for what that buys.
   *
   * Handed to an operator because the right trade is not the same everywhere. An agent picking its way
   * through a base wants the shortest line; a builder bridging long spans spends most of its search on
   * ground it cannot walk, where the default lean is half of what a step there really costs, and the
   * search fills in a huge area before it commits.
   */
  lean: number
  /** Walking, or flying wherever flying is possible - see `fly.ts`. */
  mode: 'walk' | 'fly'
  /** Whether to fly where the server has not granted flight. Only means anything in `fly` mode. */
  forceFly: boolean
  /** A command that asks the server for flight, such as `/fly`. Empty is none. See `takeoff` in fly.ts. */
  flyCommand: string
  /** What flying speed is multiplied by, between a tenth and ten. Unset is 1. */
  flySpeed: number
}

/**
 * How far the search looks when nobody has said.
 *
 * A server sends chunks a dozen wide at most, so a search allowed further than this is a search
 * spending its budget on ground the host cannot see. Roughly one view distance.
 */
export const DEFAULT_RANGE = 128

/** Past this a search is not slow, it is stuck; the cap is what keeps one agent off the tick. */
export const MOST_RANGE = 512

/** Vanilla's own safe step-off: four blocks is where fall damage starts. */
export const DEFAULT_DROP = 3

/**
 * The furthest a drop may be set to, which is the whole world rather than a judgement.
 *
 * **Sixteen was ours and it was wrong.** An operator who writes a hundred here has said something
 * definite - usually because no-fall is on and the drop costs nothing - and quietly holding them to
 * sixteen makes the agent refuse routes for a reason nothing reports. The two settings do not know
 * about each other, so this number is the only thing deciding, and it should mean what it says.
 *
 * A world is 384 blocks tall from the bottom of the overworld to the build limit, so the cap stops
 * being reachable inside one; it is here to keep a typo from becoming an infinity, not to have an
 * opinion about heights.
 */
export const MOST_DROP = 384

/** Where the route-quality setting sits when nobody has moved it. See {@link leanFor}. */
export const DEFAULT_HASTE = 50

/**
 * Everything under `path.`, from the flat map the backend relays.
 *
 * Absent is unset, which is the default rather than the off position - see `configuration.ts`.
 * `util.antiHunger` is read here too, and it is the one key from another group this reads: what it
 * decides about sprinting is a fact about how the agent moves, and the alternative is two modules
 * setting the same control state in an order neither of them chose.
 */
export function pathSettingsFrom(values: Record<string, string>): PathSettings {
  return {
    range: counted(values['path.range'], DEFAULT_RANGE, MOST_RANGE),
    dig: flag(values['path.dig']),
    bridge: flag(values['path.bridge']),
    parkour: flag(values['path.parkour']),
    maxDrop: counted(values['path.maxDrop'], DEFAULT_DROP, MOST_DROP),
    sprint: antiHungerFrom(values['util.antiHunger']) !== 'careful',
    lean: leanFor(values['path.haste']),
    // Anything but `fly` walks, which is what an agent nobody configured has always done.
    mode: values['path.mode']?.trim() === 'fly' ? 'fly' : 'walk',
    forceFly: flag(values['path.forceFly']),
    flyCommand: values['path.flyCommand']?.trim() ?? '',
    flySpeed: multiplier(values['path.flySpeed']),
  }
}

/**
 * The lean for a `path.haste` between 0 and 100.
 *
 * Through three points rather than along one line, because the two halves are different trades. Zero
 * is exact: an estimate that never overstates, so the route is the cheapest the rules allow however
 * long finding it takes. Fifty is 1.5, which is what this was before it was a setting, so an agent
 * nobody has configured plans exactly as it always did. A hundred is 3, which is what a step costs
 * where a block has to be laid to take it - measured on a bridge, the same route went from 4718 squares
 * expanded to 885, and routes over open ground come back noticeably less direct.
 *
 * Unset, blank or not a number is the default rather than an error, for the reason {@link counted}
 * gives.
 */
export function leanFor(written: string | undefined): number {
  const typed = written?.trim()
  const value = typed ? Number(typed) : Number.NaN
  const haste = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : DEFAULT_HASTE

  return haste <= 50 ? 1 + haste / 100 : 1.5 + ((haste - 50) / 50) * 1.5
}

/**
 * A whole number an operator wrote, held between one and `most`.
 *
 * Anything that is not one falls back rather than failing: a typo in a box is not a reason for an
 * agent to stop walking, and the fallback is the value the interface shows as the placeholder.
 */
function counted(written: string | undefined, fallback: number, most: number): number {
  const value = Math.floor(Number(written?.trim()))
  if (!Number.isFinite(value) || value < 1) return fallback
  return Math.min(value, most)
}

/**
 * A speed multiplier an operator wrote, held between a tenth and ten.
 *
 * Unset, blank or not a positive number is 1 - the fall back {@link counted} gives, for its reason.
 * Held at ten because past that a flight covers several blocks a tick, which the physics resolves
 * collisions for one tick at a time.
 */
export function multiplier(written: string | undefined): number {
  const value = Number(written?.trim())
  if (!written?.trim() || !Number.isFinite(value) || value <= 0) return 1
  return Math.min(10, Math.max(0.1, value))
}

/** A switch, which the interface writes as `true` and clears entirely rather than writing `false`. */
function flag(written: string | undefined): boolean {
  return written?.trim() === 'true'
}
