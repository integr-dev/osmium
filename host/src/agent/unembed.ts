/**
 * Keeps an agent's hull off the faces of the blocks around it.
 *
 * **Measured, not guessed.** A Paper server refuses movement that vanilla accepts from the same
 * client, and with a listener on `PlayerFailMoveEvent` it says why:
 *
 * ```
 * REFUSED intemeow CLIPPED_INTO_BLOCK: from 5.5229 -59.0000 -6.3119 -> 5.5224 -59.0000 -6.3000
 * ```
 *
 * A centimetre sideways, no vertical movement, and the destination puts the hull's edge on exactly
 * `-6.0000` - the block boundary. **Paper counts resting flush against a face as being inside it.**
 * Vanilla does not, which is why the same client is fine there and why a human player never trips it:
 * a real client's physics does not land exactly on the boundary.
 *
 * mineflayer's does, every time. `AABB.computeOffsetX` and its two siblings clamp movement to
 * `this.maxX - other.minX` - exactly touching, no epsilon - so every collision it resolves ends
 * flush, and on Paper every one of those is refused and set back. From outside that is an agent
 * welded to a wall, unable to jump, free only in the direction with nothing in it.
 *
 * So the hull is kept a couple of millimetres clear of any face it would otherwise rest on. That is
 * what a real client's position looks like, and it costs nothing anywhere else.
 *
 * The same functions have a second defect worth knowing about, which is why this started as a fix
 * for penetration: each clamps only when the hull is *already clear* of the box:
 *
 * ```js
 * } else if (offsetX < 0.0 && other.minX >= this.maxX) {
 *   offsetX = Math.max(this.maxX - other.minX, offsetX)
 * }
 * ```
 *
 * So the moment a hull overlaps a block by any amount, that axis stops being resolved at all: the
 * guard is false, the offset passes through untouched, and the agent is free to sink further in.
 * There is no path back out, because the same test that would push it out is the one that requires
 * it to be out already. Vanilla's `Shapes.collide` has no such precondition.
 *
 * So an overlap, once it happens, is permanent. It is not what was actually biting here - the hull
 * was never measurably inside anything - but it is a real hole and the correction below closes both.
 *
 * See PrismarineJS/mineflayer#3882 and #3887, both open, neither with a cause.
 *
 * Everything here is pure. What the world contains is the caller's to look up.
 */

/** A box in world coordinates. Blocks arrive as these; so does the agent's hull. */
export interface Box {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export interface Point {
  x: number
  y: number
  z: number
}

/** A player, as the game measures one: 0.6 across, 1.8 tall, standing on its own position. */
export const HULL_WIDTH = 0.6
export const HULL_HEIGHT = 1.8

/**
 * How much overlap is worth correcting.
 *
 * Below this it is arithmetic rather than penetration - the difference between two ways of adding
 * the same numbers - and a correction that fired on it would fight the physics every tick for no
 * gain. Flush contact is not overlap and is left exactly alone: standing against a wall is what an
 * agent does all day.
 */
export const LEAST = 1e-6

/**
 * How far past the face the hull is put once it is being moved anyway.
 *
 * Small enough not to be a teleport and large enough to survive the next tick's arithmetic, so one
 * correction ends the situation rather than starting a cycle of them.
 */
export const CLEARANCE = 0.002

/**
 * The deepest embedding worth undoing.
 *
 * Past this the agent is not clipped into a face, it is *inside* something - a block placed on it,
 * a door closed through it - and shoving it half a block sideways is a guess about which way it
 * ought to have gone. That case is for the caller to report, not for this to silently fix.
 */
export const MOST = 0.6

/** The box an agent standing at this point occupies. */
export function hullAt(at: Point, width = HULL_WIDTH, height = HULL_HEIGHT): Box {
  const half = width / 2

  return {
    minX: at.x - half,
    minY: at.y,
    minZ: at.z - half,
    maxX: at.x + half,
    maxY: at.y + height,
    maxZ: at.z + half,
  }
}

/**
 * The hull as the correction tests it: wider by the clearance, sideways only.
 *
 * **Sideways only, and that is the whole subtlety.** A hull rests on the floor with its underside
 * exactly on the block's top face, which is the same flush contact being corrected horizontally -
 * and correcting it would leave every agent hovering two millimetres above the ground forever,
 * never landing, never reading as grounded. Standing on something is not the case that gets refused;
 * walking into it is.
 */
function widened(hull: Box, gap: number): Box {
  if (gap <= 0) return hull

  return {
    ...hull,
    minX: hull.minX - gap,
    maxX: hull.maxX + gap,
    minZ: hull.minZ - gap,
    maxZ: hull.maxZ + gap,
  }
}

/** Whether two boxes genuinely overlap. Touching is not overlapping. */
function overlaps(hull: Box, box: Box): boolean {
  return (
    hull.maxX - box.minX > LEAST &&
    box.maxX - hull.minX > LEAST &&
    hull.maxY - box.minY > LEAST &&
    box.maxY - hull.minY > LEAST &&
    hull.maxZ - box.minZ > LEAST &&
    box.maxZ - hull.minZ > LEAST
  )
}

/** One way out of one box: the axis and direction that leaves soonest. */
interface Escape {
  axis: 'x' | 'y' | 'z'
  by: number
}

/**
 * The shallowest way out of a box the hull is inside.
 *
 * Six candidates, one per face, and the smallest wins - which is what makes a hull that has clipped
 * a wall come back out sideways rather than being launched over it.
 */
function shallowest(hull: Box, box: Box): Escape {
  const options: Escape[] = [
    { axis: 'x', by: box.maxX - hull.minX + CLEARANCE },
    { axis: 'x', by: -(hull.maxX - box.minX + CLEARANCE) },
    { axis: 'y', by: box.maxY - hull.minY + CLEARANCE },
    { axis: 'y', by: -(hull.maxY - box.minY + CLEARANCE) },
    { axis: 'z', by: box.maxZ - hull.minZ + CLEARANCE },
    { axis: 'z', by: -(hull.maxZ - box.minZ + CLEARANCE) },
  ]

  return options.reduce((best, option) => (Math.abs(option.by) < Math.abs(best.by) ? option : best))
}

export interface Freed {
  /** Where the agent should be instead. */
  at: Point
  /** How far it had to move, for whoever is logging why. */
  by: number
}

/**
 * Where an agent should stand, given where it is and what is solid around it.
 *
 * Nothing when it is not inside anything, which is almost always - so a caller can treat an answer
 * as the exceptional event it is rather than writing a position every tick.
 *
 * **Repeated, because leaving one box can enter another.** A hull clipped into the corner where two
 * blocks meet is out of neither until both are answered, and pushing out of the first alone would
 * hand back a position still inside the second. A handful of passes settles every real case; a
 * situation that survives all of them is one where every direction is blocked, and that is not
 * something to keep pushing at.
 */
export function freed(
  at: Point,
  solids: readonly Box[],
  gap = 0,
  width = HULL_WIDTH,
  height = HULL_HEIGHT,
): Freed | undefined {
  let now: Point = { x: at.x, y: at.y, z: at.z }
  let moved = false

  for (let pass = 0; pass < PASSES; pass++) {
    const hull = widened(hullAt(now, width, height), gap)
    const inside = solids.filter((box) => overlaps(hull, box))
    if (inside.length === 0) break

    // The deepest one first: escaping the shallowest can push the hull further into a worse
    // neighbour, where escaping the worst tends to leave the rest already answered.
    const worst = inside.reduce((deepest, box) =>
      Math.abs(shallowest(hull, box).by) > Math.abs(shallowest(hull, deepest).by) ? box : deepest,
    )

    const out = shallowest(hull, worst)
    if (Math.abs(out.by) > MOST) return undefined

    now = { ...now, [out.axis]: now[out.axis] + out.by }
    moved = true
  }

  if (!moved) return undefined

  const by = Math.hypot(now.x - at.x, now.y - at.y, now.z - at.z)
  return by > LEAST ? { at: now, by } : undefined
}

/**
 * How many times to try leaving.
 *
 * Four covers a corner of three blocks with one to spare. More would only ever help a hull that is
 * boxed in on every side, which no amount of pushing fixes.
 */
const PASSES = 4
