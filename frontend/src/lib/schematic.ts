/**
 * The isometric block field behind the sign-in screen.
 *
 * Decoration, but not arbitrary decoration: Osmium's whole job is placing a schematic block by
 * block, so the login screen shows one placing itself. The geometry lives here rather than in the
 * component because it is the part that can be wrong in a way nobody notices — a face drawn from
 * the wrong corner still renders, it just renders a shape that is not a cube, and a viewBox that
 * does not contain the field crops it silently.
 *
 * Laid out in **projected** space rather than on a grid that is projected afterwards. A square grid
 * is the obvious way to write this and gives the wrong answer: the projection squashes it
 * vertically, so what lands on screen is a 2:1 diamond. Choosing the cells by where they end up
 * makes the outline round.
 */

/** A single block, as the three face polygons an isometric cube needs. */
export interface Block {
  /** `points` for a `<polygon>`, in viewBox units. */
  top: string
  left: string
  right: string
  /** Seconds into the loop at which this block is placed. */
  delay: number
  /** 1 at the centre of the disc, falling towards the rim. Multiplies each face's opacity. */
  fade: number
}

export interface Field {
  /** Fits every block, so nothing is cropped by the projection. */
  viewBox: string
  blocks: Block[]
}

export interface FieldOptions {
  /** Radius of the disc, in viewBox units, measured to the centre of the outermost block. */
  radius: number
  /** Half-width of a block's top face. Everything else is derived from it. */
  size: number
  /** Seconds from the first block being placed to the last. */
  stagger: number
}

/**
 * How tall a block's side faces are, relative to `size`. Not a free choice: too short and the field
 * reads as a tiled floor rather than as blocks.
 */
const DEPTH = 0.62

/**
 * The share of cells left empty. A solid disc reads as a plate; gaps read as a structure partway
 * through being built, which is the thing being depicted.
 */
const GAP_SHARE = 0.28

/** How much of its opacity a block keeps at the rim. The disc ends rather than being cut off. */
const RIM_FADE = 0.3

/**
 * Builds the field. Deterministic — same options, same field — so which cells are empty does not
 * change between renders of the same page.
 */
export function schematicField(options: FieldOptions): Field {
  const { radius, size, stagger } = options
  const halfHeight = size / 2
  const depth = size * DEPTH

  // How far the lattice has to reach to cover the disc. Twice as many steps vertically as
  // horizontally, because a step covers half as much ground that way.
  const acrossReach = Math.floor(radius / size)
  const downReach = Math.floor(radius / halfHeight)

  const blocks: Block[] = []

  for (let down = -downReach; down <= downReach; down += 1) {
    for (let across = -acrossReach; across <= acrossReach; across += 1) {
      // The isometric lattice is a checkerboard: a block sits where the two grid axes meet, and
      // `across + down` is even at exactly those points. Without this the field is twice as dense
      // as a real one and the blocks interpenetrate.
      if ((across + down) % 2 !== 0) continue

      const x = across * size
      const y = down * halfHeight
      const reach = Math.sqrt(x * x + y * y) / radius
      if (reach > 1) continue

      if (noise(across, down) < GAP_SHARE) continue

      blocks.push({
        ...faces(x, y, size, halfHeight, depth),
        delay: placedAt(across, down, downReach, stagger),
        fade: round(1 - (1 - RIM_FADE) * reach),
      })
    }
  }

  return { viewBox: viewBox(radius, size, halfHeight, depth), blocks }
}

/**
 * The three visible faces. The two side faces share the front vertical edge at `x`, which is what
 * makes the pair read as one solid rather than as two panels.
 */
function faces(
  x: number,
  y: number,
  size: number,
  halfHeight: number,
  depth: number,
): Pick<Block, 'top' | 'left' | 'right'> {
  const points = (...pairs: Array<[number, number]>) =>
    pairs.map(([px, py]) => `${round(px)},${round(py)}`).join(' ')

  const near = halfHeight + depth

  return {
    top: points([x, y - halfHeight], [x + size, y], [x, y + halfHeight], [x - size, y]),
    left: points([x - size, y], [x, y + halfHeight], [x, y + near], [x - size, y + depth]),
    right: points([x + size, y], [x, y + halfHeight], [x, y + near], [x + size, y + depth]),
  }
}

/**
 * When a block is placed, in seconds.
 *
 * By depth, so the disc fills from the back forward the way a course of blocks is laid rather than
 * appearing at random. The offset within a course is bounded by the gap between courses, so it
 * softens the line without ever letting one course overtake the next.
 */
function placedAt(across: number, down: number, downReach: number, stagger: number): number {
  const courses = Math.max(1, 2 * downReach)
  const course = (down + downReach) / courses
  const withinCourse = noise(down, across) / courses
  return round(Math.min(1, course + withinCourse) * stagger)
}

/** Contains every face of the outermost block, in all four directions. */
function viewBox(radius: number, size: number, halfHeight: number, depth: number): string {
  const left = -radius - size
  const top = -radius - halfHeight
  const width = 2 * (radius + size)
  const height = 2 * radius + halfHeight + (halfHeight + depth)

  return [round(left), round(top), round(width), round(height)].join(' ')
}

/**
 * A value in [0, 1) for a cell. A plain modulo of the coordinates would repeat on a short period
 * and show up as stripes in the gaps, which is exactly the pattern the gaps exist to avoid.
 */
function noise(across: number, down: number): number {
  const mixed = Math.imul(across + 1, 73856093) ^ Math.imul(down + 1, 19349663)
  return ((mixed >>> 0) % 1000) / 1000
}

/** Two decimals is under a tenth of a viewBox unit and keeps the markup a third shorter. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}
