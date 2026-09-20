/**
 * What an operator has told an agent about putting blocks down.
 *
 * Read per pass rather than captured, like the pathfinding settings: these are numbers somebody
 * changes while watching an agent build, and one that needed a reconnect to take effect would look
 * broken at exactly the moment it was being tried.
 */
export interface BuildSettings {
  /**
   * How far from the agent's eyes a block may be and still be placed, in blocks.
   *
   * The only number here the *server* also has an opinion about: vanilla refuses an interaction
   * past its own limit, so setting this higher does not place further, it places nothing and logs a
   * failure for every block it tried.
   */
  reach: number
  /**
   * How far past the next block the agent looks for others it could place from where it stands.
   *
   * The printer always has one next block — the piece's order decides which — but standing still
   * and placing only that one wastes the reach it already has. This is how many entries past it are
   * considered, and it is a count rather than a distance because the order is a sequence: the
   * blocks near in it are the ones whose supports are already standing.
   */
  window: number
  /** Blocks a second, at most. Vanilla has no limit of its own; a server's packet ceiling does. */
  rate: number
  /**
   * Whether to right-click a block after placing it to finish the state off — a repeater's delay,
   * a comparator's mode, a trapdoor left open.
   *
   * On unless turned off. It costs a click per block that needs one and is the difference between
   * a redstone build that looks right and one that works.
   */
  tune: boolean
  /**
   * Whether to place a block with nothing beside it to place it against.
   *
   * **A click, not a rule.** A placement is a packet naming a square, a face of it and where on
   * that face — and a server checks that the block may *be* where it would land, not that anything
   * was really clicked. So a square with nothing standing around it can still be filled, by
   * clicking the empty square itself: air is replaceable, so the block goes in where the click was.
   *
   * Offered only for blocks whose state owes nothing to the face they were placed against — see
   * `anyFace` in `plan.ts`. A torch, a ladder, a stair take their facing from what they were put
   * on, and one placed against nothing would be a different block from the one the piece asked for.
   *
   * On, because the alternative is losing a block every time a piece wants one whose neighbours
   * come later in the order. A server that does check the click refuses it, which costs the one
   * click the refusal was going to cost anyway.
   */
  airPlace: boolean
}

/** Vanilla's own reach for a block, which is what the server will actually accept. */
export const DEFAULT_REACH = 4.5

/**
 * Past this the server refuses every placement anyway.
 *
 * Creative reaches five blocks and survival four and a half; the half block of slack over the
 * larger of the two is for an agent whose position the server has not caught up with.
 */
export const MOST_REACH = 5.5

/** How many blocks past the next one are considered. One chunk layer's worth, roughly. */
export const DEFAULT_WINDOW = 2048

/** Past this the sweep costs more than the placements it finds. */
export const MOST_WINDOW = 65_536

/** Blocks a second when nobody has said. Comfortably under what a server will take. */
export const DEFAULT_RATE = 12

/** A ceiling rather than a judgement: past this the limiter, not the printer, decides. */
export const MOST_RATE = 100


export function buildSettingsFrom(values: Record<string, string>): BuildSettings {
  return {
    reach: number(values['build.reach'], DEFAULT_REACH, 1, MOST_REACH),
    window: Math.round(number(values['build.window'], DEFAULT_WINDOW, 1, MOST_WINDOW)),
    rate: number(values['build.rate'], DEFAULT_RATE, 1, MOST_RATE),
    // Unset is on, so the key means "turn this off" rather than "turn this on" - which is the
    // right way round for a thing that is part of building correctly.
    tune: values['build.tune'] !== 'false',
    // Unset is on, for the same reason: it is part of getting the piece built rather than a trick
    // somebody opts into.
    airPlace: values['build.airPlace'] !== 'false',
  }
}

/** A setting that is not a number in range is not a setting: it is left at the default. */
function number(value: string | undefined, fallback: number, low: number, high: number): number {
  // Blank counts as unset, which is what the interface writes when an operator clears a box —
  // and what `Number` would otherwise read as zero, quietly clamping the setting to its floor.
  const text = value?.trim()
  if (!text) return fallback

  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return fallback

  return Math.min(Math.max(parsed, low), high)
}
