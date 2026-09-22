import type { BuildResponse } from '../api/builds'
import type { BuildJob } from '../api/jobs'
import { footprintOf, worldId } from './placement'

/**
 * Where builds stand in one world, for the map and the 3D view.
 *
 * **Two kinds, drawn two ways.** A plan's box is where somebody has said a build will go; a job's is
 * where one is going up. The map dashes the first and draws the second solid, in the building
 * colour — and the 3D view does the same — so both read this one list rather than working out twice
 * which plans belong in which world.
 */
export interface PlacedBox {
  /** Stable across updates, and distinct between a plan and a job of it. */
  id: string
  label: string
  /** Inclusive at both ends. */
  box: Cuboid
  planned: boolean
  /**
   * The pieces a job was divided into, drawn inside its box. None for a plan: a plan is not divided
   * until a job of it starts, and the division is the job's.
   */
  sections: Section[]
}

/** A box of whole blocks, inclusive at both ends. */
export interface Cuboid {
  west: number
  east: number
  north: number
  south: number
  low: number
  high: number
}

export interface Section {
  box: Cuboid
  /** Finished, so it can be drawn as settled ground rather than as work still to do. */
  done: boolean
}

/**
 * A job that named no world is drawn in the overworld.
 *
 * Jobs started before plans could say which world they were for have none, and every one of them was
 * built where a server puts a player who joins — which is the overworld. Leaving them off the map
 * would hide the builds that are actually standing there.
 */
const DEFAULT_WORLD = 'overworld'

/** Unfinished rather than active: a paused job still holds its ground, and its box stays. */
const STANDING = new Set(['ACTIVE', 'PAUSED'])

export function buildBoxes(
  plans: readonly BuildResponse[],
  jobs: readonly BuildJob[],
  server: string,
  dimension: string,
): PlacedBox[] {
  const boxes: PlacedBox[] = []
  const here = worldId(dimension)
  // A plan being built here is drawn as its job. Both would be the same box twice, the dashed one
  // under the solid one, saying nothing the solid one does not.
  const underway = new Set<number>()

  for (const job of jobs) {
    if (!STANDING.has(job.state) || job.serverAddress !== server) continue
    if (worldId(job.dimension ?? DEFAULT_WORLD) !== here || !job.size) continue

    underway.add(job.buildId)
    boxes.push({
      id: `job-${job.id}`,
      label: job.buildName,
      box: footprintOf(job.placement, job.size, job.rotation),
      planned: false,
      // Already in world coordinates and already turned — the backend worked both out when it cut
      // them — and half-open, as the host is told them: the last block is one short of the maximum.
      sections: job.segments.map((segment) => ({
        box: {
          west: segment.minX,
          east: segment.maxX - 1,
          north: segment.minZ,
          south: segment.maxZ - 1,
          low: segment.minY,
          high: segment.maxY - 1,
        },
        done: segment.state === 'DONE',
      })),
    })
  }

  // A plan is drawn only where it says it is: one that names no server or world has not said which
  // map it belongs on, and putting it on all of them would be guessing.
  for (const plan of plans) {
    if (!plan.placement || !plan.size || underway.has(plan.id)) continue
    if (plan.serverAddress !== server || !plan.dimension || worldId(plan.dimension) !== here) continue

    boxes.push({
      id: `plan-${plan.id}`,
      label: plan.name,
      box: footprintOf(plan.placement, plan.size, plan.rotation),
      planned: true,
      sections: [],
    })
  }

  return boxes
}
