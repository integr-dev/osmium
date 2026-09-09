/**
 * What a path is on the wire, and how far along one an agent has got.
 *
 * Nothing here knows which engine drew the path. Walking is `drive.ts`, flying will be its own, and
 * the whole point of the split is that everything above the driver - the wire event, the two
 * renderers, the watchdog - sees one shape and one notion of progress.
 */

/**
 * One point on a path.
 *
 * Not a `BlockPos`: a walk node is the position an agent stands *at*, which is the middle of a block
 * and half a block along two axes. Rounding it to the block would put the drawn line through the
 * corner of every turn.
 */
export interface PathNode {
  x: number
  y: number
  z: number
}

/**
 * A block the route means to change, and which way.
 *
 * **A block, not a standing position.** Unlike {@link PathNode} these are squares in the world, and
 * they are drawn as the cube they are. The two are half a block apart on two axes and confusing
 * them is a bug this project has already paid for once - see `standsAt` in `ground.ts`.
 */
export interface PathWork {
  x: number
  y: number
  z: number
  kind: 'place' | 'break'
}

/** Two decimal places is a centimetre, which is finer than anything drawn from this. */
const PLACES = 100

/**
 * The path an engine computed, as the wire carries it.
 *
 * Rounded on the way out. A node arrives as a float with seventeen digits of it, and a three
 * hundred node path is most of a packet of noise nothing downstream can see.
 */
export function nodesOf(moves: ReadonlyArray<{ x: number; y: number; z: number }>): PathNode[] {
  return moves.map((move) => ({
    x: Math.round(move.x * PLACES) / PLACES,
    y: Math.round(move.y * PLACES) / PLACES,
    z: Math.round(move.z * PLACES) / PLACES,
  }))
}

/**
 * Which node the agent has reached, measured rather than counted.
 *
 * **Measured**, because the engine is not asked. The walking engine consumes its route as it goes
 * and a flyer will not, so anything read off an engine is a number that means something different
 * per engine - and progress is drawn by one renderer.
 *
 * **Never backwards.** A path that doubles back comes within a block of a node it left minutes ago,
 * and the nearest node to the agent is then one it has already walked. So the search starts where it
 * last was: progress is a claim about how far along the agent has got, and it cannot un-get there.
 */
export function advanced(nodes: readonly PathNode[], at: { x: number; y: number; z: number }, from: number): number {
  let best = Math.min(Math.max(from, 0), Math.max(nodes.length - 1, 0))
  let closest = Infinity

  for (let index = best; index < nodes.length; index++) {
    const node = nodes[index]
    if (!node) continue

    const dx = node.x - at.x
    const dy = node.y - at.y
    const dz = node.z - at.z
    const distance = dx * dx + dy * dy + dz * dz

    if (distance < closest) {
      closest = distance
      best = index
    }
  }

  return best
}
