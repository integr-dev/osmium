import type { BuildResponse } from '../api/builds'
import type { BuildJob, JobType } from '../api/jobs'
import type { Region } from '../api/regions'
import { footprintOf, worldId } from './placement'

/**
 * Where the fleet's work stands in one world, for the map and the 3D view.
 *
 * **Two kinds, drawn two ways.** A plan's box is where somebody has said a build will go; a job's is
 * where work is happening. The map dashes the first and draws the second solid, in the colour of
 * whatever kind of work it is — and the 3D view does the same — so both read this one list rather
 * than working out twice which plans belong in which world.
 */
export interface PlacedBox {
  /** Stable across updates, and distinct between a plan and a job of it. */
  id: string
  label: string
  /** Inclusive at both ends. */
  box: Cuboid
  planned: boolean
  /** What is being done inside it, which is what it is drawn in the colour of. */
  type: JobType
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
  regions: readonly Region[] = [],
): PlacedBox[] {
  const boxes: PlacedBox[] = []
  const here = worldId(dimension)
  // A plan being worked here is drawn as its job. Both would be the same box twice, the dashed one
  // under the solid one, saying nothing the solid one does not. Kept apart by kind, because a
  // build plan and a region plan number themselves separately.
  const underway = new Set<number>()
  const working = new Set<number>()

  for (const job of jobs) {
    if (!STANDING.has(job.state) || job.serverAddress !== server) continue
    if (worldId(job.dimension ?? DEFAULT_WORLD) !== here) continue

    // A build's box is the footprint of a file that was turned; a region job *is* its box, given in
    // world coordinates and half-open. One of the two is always there, and which one says which
    // kind of job this is — but only for a build is the schematic's size the right answer.
    const box = job.regionMax
      ? {
          west: job.placement.x,
          east: job.regionMax.x - 1,
          north: job.placement.z,
          south: job.regionMax.z - 1,
          low: job.placement.y,
          high: job.regionMax.y - 1,
        }
      : job.size && footprintOf(job.placement, job.size, job.rotation)
    if (!box) continue

    if (job.buildId !== null) underway.add(job.buildId)
    if (job.regionId !== null) working.add(job.regionId)
    boxes.push({
      id: `job-${job.id}`,
      label: job.name,
      box,
      planned: false,
      type: job.type,
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
      type: 'BUILD',
      sections: [],
    })
  }

  /**
   * A region plan is its box, so there is nothing to work out — and nothing optional about where
   * it is: a region always names its server and its world, where a build plan may name neither.
   */
  for (const region of regions) {
    // Unplaced, or not yet told which world it is in: a plan somebody has named and not been out
    // to measure is on no map, the same way an unplaced build plan is.
    if (working.has(region.id) || !region.placement || !region.regionMax) continue
    if (region.serverAddress !== server || !region.dimension) continue
    if (worldId(region.dimension) !== here) continue

    boxes.push({
      id: `region-${region.id}`,
      label: region.name,
      box: {
        west: region.placement.x,
        east: region.regionMax.x - 1,
        north: region.placement.z,
        south: region.regionMax.z - 1,
        low: region.placement.y,
        high: region.regionMax.y - 1,
      },
      planned: true,
      type: region.type,
      sections: [],
    })
  }

  return boxes
}
