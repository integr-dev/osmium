import { TILE } from '../map.ts'

/**
 * How to fly a footprint so the whole of it is seen, and no more of it than once.
 *
 * **Charting is a side effect of being there.** `agent/map.ts` reads every chunk the server sends
 * and reports it, whether or not anybody asked — so a survey does not read the ground, it *arranges
 * to be sent it*. The whole of the work is therefore a flight path, and the only question a plan
 * has to answer is where an agent must go for the server to have sent it everything.
 *
 * **Which makes the view distance the whole of the arithmetic.** A server sends the chunks within
 * its view distance of the player and no others, so an agent standing still has already charted a
 * square of ground `2r + 1` chunks across. Lines flown `2r` chunks apart therefore cover the ground
 * between them without ever covering it twice, and the ends of each line stop `r` chunks short of
 * the edge, because the chunks beyond that were sent while the agent was still approaching. A plan
 * that ignored this would fly the same valley four times over and read it four times.
 */

/** A box of ground, half-open on [east] and [south], the way every box in Osmium is. */
export interface Footprint {
  west: number
  east: number
  north: number
  south: number
}

/** Somewhere an agent is sent, as a column: the height is the flight's, not the plan's. */
export interface Leg {
  x: number
  z: number
}

/**
 * The chunks a footprint covers, as `x,z` keys.
 *
 * Whole chunks, because that is the unit a server sends and the unit a tile is written in: a
 * footprint that ends halfway through a chunk is charted by charting the whole of it.
 */
export function chunksIn(box: Footprint): string[] {
  const keys: string[] = []
  for (let x = Math.floor(box.west / TILE); x <= Math.floor((box.east - 1) / TILE); x++) {
    for (let z = Math.floor(box.north / TILE); z <= Math.floor((box.south - 1) / TILE); z++) {
      keys.push(`${x},${z}`)
    }
  }
  return keys
}

/**
 * How far from an agent the ground is reliably sent, in blocks.
 *
 * One chunk short of what the server says, and never less than one. The outermost ring arrives
 * last and leaves first — an agent flying past the edge of its own view distance is gone before
 * that ring has settled — so counting on it is how a survey comes back with stripes of unread
 * ground between its lines. The ring is still charted when it does arrive; it is simply not what
 * the spacing is built on.
 */
export function reachOf(viewChunks: number): number {
  return Math.max(1, viewChunks - 1) * TILE
}

/**
 * The flight, as the columns to pass over in order.
 *
 * Lines run along the **longer** side, because every turn is an agent slowing to a stop and
 * starting again, and the long way round has fewer of them.
 *
 * Bands are even rather than a fixed `2r` with a remainder: an even split of the footprint into
 * `ceil(span / 2r)` bands flies the same number of lines as the greedy version and leaves no thin
 * last band, which is the one that gets flown for a strip of ground a few blocks wide.
 *
 * The line itself is inset by [reach] at both ends and never past the middle, so a footprint
 * narrower than what an agent sees is one hover in the centre of it rather than a flight from one
 * corner to the other — which is the case a segment of a divided survey usually is.
 *
 * Snaked, so the end of each line is the start of the next: the agent is already there.
 */
export function sweep(box: Footprint, reach: number): Leg[] {
  const width = box.east - box.west
  const depth = box.south - box.north
  if (width <= 0 || depth <= 0) return []

  const alongX = width >= depth
  const span = alongX ? width : depth
  const across = alongX ? depth : width
  const start = alongX ? box.west : box.north
  const side = alongX ? box.north : box.west

  const bands = Math.max(1, Math.ceil(across / (2 * reach)))
  const band = across / bands

  const middle = start + span / 2
  const from = Math.min(start + reach, middle)
  const to = Math.max(start + span - 1 - reach, middle)

  const legs: Leg[] = []
  for (let index = 0; index < bands; index++) {
    // The middle of the band: what the agent sees reaches `reach` either side of wherever it is,
    // and the middle is the only place that spends all of it inside the band.
    const line = Math.floor(side + band * (index + 0.5))
    const ends = index % 2 === 0 ? [from, to] : [to, from]

    for (const end of ends) {
      const at = Math.floor(end)
      legs.push(alongX ? { x: at, z: line } : { x: line, z: at })
    }
  }

  // A single hover reads as two identical legs, which is one waypoint and a second that is already
  // satisfied. Said once.
  return legs.filter((leg, index) => index === 0 || leg.x !== legs[index - 1]!.x || leg.z !== legs[index - 1]!.z)
}

/**
 * How much of a footprint a set of charted chunks accounts for, in columns of ground.
 *
 * Clipped to the footprint rather than counted as whole chunks: a segment is a strip cut out of a
 * survey, and the chunks at its edges are shared with the strip beside it. Counting them whole
 * would have every agent on a divided survey report more ground than it was given, and the job
 * reach its total before its middle was read.
 */
export function columnsCharted(box: Footprint, charted: Iterable<string>): number {
  let columns = 0
  for (const key of charted) {
    const [x, z] = key.split(',').map(Number)
    if (x === undefined || z === undefined || Number.isNaN(x) || Number.isNaN(z)) continue

    const west = Math.max(box.west, x * TILE)
    const east = Math.min(box.east, x * TILE + TILE)
    const north = Math.max(box.north, z * TILE)
    const south = Math.min(box.south, z * TILE + TILE)
    if (east <= west || south <= north) continue

    columns += (east - west) * (south - north)
  }
  return columns
}

/**
 * The chunks of a footprint nobody has charted, nearest the agent first.
 *
 * **A flight plan is an expectation, not a guarantee.** A server whose view distance is smaller
 * than it said, a chunk that arrived while the agent was turning and left before it settled, a
 * stretch the agent was pushed off course by — each leaves a hole, and a survey that called itself
 * done with holes in it would be a survey nobody can trust to mean anything. So what the plan
 * misses is flown to afterwards, one chunk at a time, which is slow and is meant to be: it is the
 * exception, and the plan is what keeps it rare.
 */
export function missing(box: Footprint, charted: ReadonlySet<string>, from: Leg): Leg[] {
  const holes = chunksIn(box)
    .filter((key) => !charted.has(key))
    .map((key) => {
      const [x, z] = key.split(',').map(Number)
      return { x: x! * TILE + TILE / 2, z: z! * TILE + TILE / 2 }
    })

  return holes.sort(
    (one, other) =>
      Math.max(Math.abs(one.x - from.x), Math.abs(one.z - from.z)) -
      Math.max(Math.abs(other.x - from.x), Math.abs(other.z - from.z)),
  )
}
