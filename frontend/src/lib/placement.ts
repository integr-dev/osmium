import { blockId } from './blockNames'
import type { Vec3 } from './box3d'

/**
 * Where a build stands, and what it is built out of.
 *
 * Both are arithmetic over things the interface already has — the placement on the plan, the
 * schematic's own origin, the material list — so neither is asked of the backend. Same reasoning as
 * the split: a pure function of what is already loaded is not a second endpoint, it is a function.
 *
 * Here rather than in a component because these are the parts that can be wrong without looking
 * wrong. An off-by-one offset still renders a building; it renders it in the wrong place.
 */

export interface Placement {
  x: number
  y: number
  z: number
}

/**
 * What to add to a schematic coordinate to get a world one.
 *
 * A placement is an **anchor for the minimum corner** — the coordinate an operator stands on and
 * reads off the screen — and the schematic carries its own origin from the file it was saved in.
 * The offset between them is what actually moves anything, and it is the number nobody should have
 * to work out by hand.
 */
export function offsetOf(placement: Placement, origin: Vec3): Vec3 {
  return {
    x: placement.x - origin.x,
    y: placement.y - origin.y,
    z: placement.z - origin.z,
  }
}

/** A schematic coordinate moved into the world. */
export function toWorld(point: Vec3, offset: Vec3): Vec3 {
  return { x: point.x + offset.x, y: point.y + offset.y, z: point.z + offset.z }
}

/** The turns a plan may have: quarter turns clockwise seen from above, in degrees. */
export const QUARTERS = [0, 90, 180, 270] as const
export type Quarter = (typeof QUARTERS)[number]

/** A turn as the API sent it, or none when it sent something that is not one. */
export function quarterOf(degrees: number | null | undefined): Quarter {
  return QUARTERS.find((turn) => turn === degrees) ?? 0
}

/**
 * The three worlds every server has, in the order a player meets them.
 *
 * **Spelled the way agents report them**, which is without the namespace: the map's worlds and an
 * agent's telemetry both say `overworld`. A plan that said `minecraft:overworld` matched neither,
 * and its box was drawn on no map at all.
 */
export const DIMENSIONS = ['overworld', 'the_nether', 'the_end'] as const

/**
 * The lowest block each world has.
 *
 * Where a survey that climbs starts from: it rises over whatever is in its way, so beginning at
 * the floor is beginning under the terrain and following it up. A survey that holds one height
 * has no use for this - it is told the height it flies.
 */
export const WORLD_FLOOR: Record<(typeof DIMENSIONS)[number], number> = {
  overworld: -64,
  the_nether: 0,
  the_end: 0,
}

/**
 * A world's name as the map and the agents spell it: no `minecraft:` in front.
 *
 * Compared through this rather than as written, because both spellings reach here — plans written
 * before the vocabulary was settled carry the namespace — and two names for one world is exactly
 * how a box goes missing without an error.
 */
export function worldId(name: string): string {
  return name.trim().replace(/^minecraft:/, '')
}

/**
 * A box of the schematic, moved into the world the way a job moves it: turned inside the
 * schematic's footprint, then anchored on the placement.
 *
 * **The backend's arithmetic, repeated because the numbers are read off the screen.** A job's pieces
 * are cut in the schematic's own space and turned when the job starts (`Rotation.box`); the split
 * step shows them before that, and a preview that shifted them without turning them would show a
 * turned plan's pieces somewhere the agents will not be. Half-open, as segments and regions both are:
 * the maximum is one past the last block.
 */
export function placeBox(
  min: Vec3,
  max: Vec3,
  placement: Placement,
  origin: Vec3,
  size: Vec3,
  rotation: number,
): { min: Vec3; max: Vec3 } {
  const ax = min.x - origin.x
  const bx = max.x - origin.x
  const az = min.z - origin.z
  const bz = max.z - origin.z

  const turned: Record<Quarter, [number, number, number, number]> = {
    0: [ax, bx, az, bz],
    90: [size.z - bz, size.z - az, ax, bx],
    180: [size.x - bx, size.x - ax, size.z - bz, size.z - az],
    270: [az, bz, size.x - bx, size.x - ax],
  }

  const [west, east, north, south] = turned[quarterOf(rotation)]
  return {
    min: { x: placement.x + west, y: placement.y + min.y - origin.y, z: placement.z + north },
    max: { x: placement.x + east, y: placement.y + max.y - origin.y, z: placement.z + south },
  }
}

/**
 * The blocks a placed build covers, as the map and the 3D view draw it: inclusive at both ends.
 *
 * **A turn swaps the two sides and moves nothing else.** The build turns inside its own box and the
 * placement stays on that box's minimum corner — the backend's arithmetic, in `Rotation.kt` — so the
 * footprint is the anchor plus the schematic's size with width and depth traded on an odd turn.
 * Drawing the unturned box for a turned plan would outline somewhere the build is not.
 */
export function footprintOf(
  placement: Placement,
  size: Vec3,
  rotation: number,
): { west: number; east: number; north: number; south: number; low: number; high: number } {
  const odd = quarterOf(rotation) % 180 === 90
  const wide = odd ? size.z : size.x
  const deep = odd ? size.x : size.z

  return {
    west: placement.x,
    east: placement.x + wide - 1,
    north: placement.z,
    south: placement.z + deep - 1,
    low: placement.y,
    high: placement.y + size.y - 1,
  }
}

export interface Substitution {
  from: string
  /** Null means place nothing at all, which is a rule rather than a missing value. */
  to: string | null
}

export interface Material {
  name: string
  blocks: number
}

/** A material line once the substitutions have been applied to it. */
export interface PlannedMaterial extends Material {
  /** What this line was before a rule renamed it. Absent when nothing touched it. */
  substitutedFrom?: string[]
  /** True when the rule for it says to place nothing, so the count is what will *not* be placed. */
  omitted?: boolean
}

/**
 * The material list as the build will actually consume it.
 *
 * Two things happen here and both matter to somebody counting out chests. Blocks replaced by the
 * same target **merge**, because three rules pointing at stone means one pile of stone and a list
 * that still showed three lines would be asking the reader to do the addition. Blocks replaced by
 * nothing are **kept and marked**, not dropped: what is being left out is exactly what an operator
 * wants to see before they agree to it, and a line that silently disappeared would read as a
 * material the schematic never had.
 *
 * Sorted by count, most first, which is the order the quantities are read in.
 */
export function plannedMaterials(
  materials: Material[],
  substitutions: Substitution[],
): PlannedMaterial[] {
  // Keyed on the bare id, because the two sides are written differently and mean the same thing:
  // a schematic names blocks `minecraft:stone` while the picker stores `stone`. Compared as plain
  // strings a rule matched nothing and substituted nothing, with no error — as far as the
  // arithmetic was concerned that block simply was not in the build.
  const rules = new Map(substitutions.map((rule) => [blockId(rule.from), rule.to]))
  const merged = new Map<string, PlannedMaterial>()

  for (const material of materials) {
    const id = blockId(material.name)
    const replaced = rules.has(id)
    const target = replaced ? rules.get(id) : material.name

    // Merged on the bare id as well, so two spellings of one block are one pile rather than two
    // lines a reader has to add up. Omitted blocks are keyed apart from placed ones, so replacing
    // one block with nothing while another keeps its own name cannot fold two fates into one line.
    const key = target === null || target === undefined ? `omit:${id}` : blockId(target)

    const existing = merged.get(key)
    if (existing) {
      existing.blocks += material.blocks
      if (replaced) existing.substitutedFrom = [...(existing.substitutedFrom ?? []), material.name]
      continue
    }

    merged.set(key, {
      name: target ?? material.name,
      blocks: material.blocks,
      ...(replaced ? { substitutedFrom: [material.name] } : {}),
      ...(target === null ? { omitted: true } : {}),
    })
  }

  return [...merged.values()].sort((a, b) => b.blocks - a.blocks)
}

/** How many blocks the build actually places, once anything substituted away is taken off. */
export function blocksToPlace(planned: PlannedMaterial[]): number {
  return planned.reduce((total, entry) => (entry.omitted ? total : total + entry.blocks), 0)
}

/**
 * Whether two rule sets say the same thing, which is not the same as being written the same way.
 *
 * Here rather than in the planner because it is the same kind of judgement as everything else in
 * this file, and because getting it wrong is invisible: it produces a form that insists it has
 * unsaved changes forever, which reads as a broken save rather than as a broken comparison.
 *
 * Two things do not count as a difference. **The namespace** — a rule seeded from a material list
 * carries `minecraft:stone` because that is what the file calls it, while the backend stores every
 * rule on the bare id so its one-rule-per-block constraint means what it says. And **the order**,
 * since substitutions come back as a collection with no promised order and a set of rules is not
 * different for having been listed differently.
 */
export function sameSubstitutions(left: Substitution[], right: Substitution[]): boolean {
  return canonical(left) === canonical(right)
}

function canonical(rules: Substitution[]): string {
  return JSON.stringify(
    rules
      .map((rule) => ({ from: blockId(rule.from), to: rule.to === null ? null : blockId(rule.to) }))
      .sort((a, b) => a.from.localeCompare(b.from)),
  )
}
