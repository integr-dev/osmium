/**
 * The lines a hover cursor is drawn from.
 *
 * **A full wireframe cube reads as debug output.** Twelve edges around a block is what a renderer
 * draws when it is showing you its working, and it is also the busiest possible thing to put on top
 * of a world made of cubes - every edge lands on an edge that is already there. Bracketing the
 * corners instead leaves the middle of each face clear, which is where whatever is being pointed at
 * actually is, and reads as an instrument rather than a mesh.
 *
 * Pure and in units of the block it wraps, so the viewer can hand it straight to a line geometry.
 */

/**
 * How far along each edge a corner reaches, as a share of the block.
 *
 * A quarter, so opposite arms take half the edge between them and leave the middle half of it open.
 * Much less and the corners stop reading as a box at all; much more and it is the wireframe again.
 */
export const ARM = 0.25

/** The eight corners of a unit cube centred on its own middle, as signs. */
const CORNERS = [-0.5, 0.5]

/**
 * Three arms at each of the eight corners of a block, as flat `x, y, z` triples - two per segment.
 *
 * [arm] is the share of the edge each one covers, and is clamped to half: at exactly half the arms
 * from neighbouring corners meet and the thing is a wireframe cube again, which is what this exists
 * not to be.
 */
export function cornerArms(arm: number = ARM): number[] {
  const reach = Math.min(0.5, Math.max(0, arm))
  const points: number[] = []

  for (const x of CORNERS) {
    for (const y of CORNERS) {
      for (const z of CORNERS) {
        // One arm per axis, each running back towards the middle of the edge it sits on. The sign
        // of the coordinate is which end it is, so subtracting it is always inwards.
        points.push(x, y, z, x - Math.sign(x) * reach, y, z)
        points.push(x, y, z, x, y - Math.sign(y) * reach, z)
        points.push(x, y, z, x, y, z - Math.sign(z) * reach)
      }
    }
  }

  return points
}

/**
 * Three segments through the middle of a block, one per axis, as flat `x, y, z` triples.
 *
 * The gimbal point: what the camera turns around and what a pan carries. It is a cross rather than
 * a dot because a dot says only where, and the thing worth knowing about a pivot is also which way
 * it is oriented as the view swings past it.
 *
 * A unit long, so the viewer scales it straight into blocks: at one it spans exactly the block it
 * is pivoting on, and it grows and shrinks with the world the way anything standing in it does.
 */
export function axisCross(): number[] {
  return [
    -0.5, 0, 0, 0.5, 0, 0,
    0, -0.5, 0, 0, 0.5, 0,
    0, 0, -0.5, 0, 0, 0.5,
  ]
}
