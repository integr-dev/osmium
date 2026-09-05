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

export const MOST_DROP = 16

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
  }
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

/** A switch, which the interface writes as `true` and clears entirely rather than writing `false`. */
function flag(written: string | undefined): boolean {
  return written?.trim() === 'true'
}
