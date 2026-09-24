import { api, errorMessage } from './client'
import type { components } from './schema'
import type { Placement, Size } from './builds'
import type { BuildJob, JobType } from './jobs'
import type { SplitMode, SplitResponse } from './schematics'

/**
 * Region plans: a box of world to be dug out or charted.
 *
 * **The region half of `builds.ts`.** A build plan is a schematic, a placement and the rules it
 * goes up under; this is the same idea with the file taken out, because there is no file — two
 * corners read off the world are the whole description of the work.
 *
 * The one place it parts company with a build plan is that the server and the world are required.
 * A schematic is a shape that exists on its own and can be drawn before anybody knows where it is
 * going; six coordinates are only a place once they say which world they were read in.
 */

/** Never `BUILD`: a build comes from a file, and a plan for one is a build. */
export type RegionType = Exclude<JobType, 'BUILD'>

/**
 * One corner of a region as an operator reads it off the world: inclusive, either way round.
 *
 * Two opposite corners rather than a minimum and a maximum. Somebody standing at two ends of a
 * hole has no idea which of the two numbers is the smaller, and making them find out is a form the
 * interface can fill in itself.
 */
export interface Corner {
  x: number
  y: number
  z: number
}

export type Region = Omit<
  Required<components['schemas']['RegionResponse']>,
  'type' | 'placement' | 'regionMax' | 'size' | 'blocks' | 'height' | 'serverAddress' | 'dimension'
> & {
  type: RegionType
  /**
   * Null until somebody has been out to measure it, exactly as a build plan may be unplaced. What
   * that costs is the ability to start a job of it, which the backend refuses.
   */
  placement: Placement | null
  /** The far corner, exclusive — the first block outside the box. */
  regionMax: Placement | null
  size: Size | null
  blocks: number | null
  /** The height the agents fly, for a survey. Null while the region has no box. */
  height: number | null
  serverAddress: string | null
  dimension: string | null
}

export async function listRegions(): Promise<Region[]> {
  const { data, error } = await api.GET('/api/regions')
  if (error) throw new Error(errorMessage(error))
  return (data ?? []) as Region[]
}

/**
 * Writes one down. Only the name and the kind are needed.
 *
 * Everything else can be settled later, as on a build plan: deciding to dig somewhere comes before
 * knowing exactly where, and a plan that refuses to be saved until every field is filled in is a
 * plan nobody writes.
 */
export async function createRegion(body: {
  name: string
  type: RegionType
  from?: Corner
  to?: Corner
  serverAddress?: string
  dimension?: string
  rising?: boolean
}): Promise<Region> {
  const { data, error } = await api.POST('/api/regions', { body })
  if (error) throw new Error(errorMessage(error))
  return data as Region
}

/**
 * Edits one. Omitted fields are left as they are, and the corners move as a pair — one corner of a
 * new box beside one of the old describes somewhere nobody chose.
 *
 * A blank server or world clears it, and `unplace` takes the corners off, both the way a build
 * plan's do: JSON cannot tell a missing field from a null one.
 */
export async function updateRegion(
  id: number,
  body: {
    name?: string
    from?: Corner
    to?: Corner
    unplace?: boolean
    serverAddress?: string
    dimension?: string
    rising?: boolean
  },
): Promise<Region> {
  const { data, error } = await api.PATCH('/api/regions/{id}', { params: { path: { id } }, body })
  if (error) throw new Error(errorMessage(error))
  return data as Region
}

/** Refused by the backend while a job of it is running: pause that first. */
export async function deleteRegion(id: number): Promise<void> {
  const { error } = await api.DELETE('/api/regions/{id}', { params: { path: { id } } })
  if (error) throw new Error(errorMessage(error))
}

/**
 * Divides a region without starting anything, so the pieces can be looked at first.
 *
 * **Asked of the backend rather than worked out here**, exactly as a schematic's split is. The
 * division is arithmetic either side could do, and that is the trap: a preview computed a second
 * way is a picture of a division nobody is going to be given, and the first time the two disagreed
 * the interface would be lying about the thing it exists to show.
 */
export async function previewRegionSplit(
  regionId: number,
  body: { mode: SplitMode; parts: number },
): Promise<SplitResponse> {
  const { data, error } = await api.POST('/api/regions/{regionId}/split', {
    params: { path: { regionId } },
    body,
  })
  if (error) throw new Error(errorMessage(error))
  return data as SplitResponse
}

/**
 * Starts working a region: a box emptied, or a footprint charted.
 *
 * No box, no world and no server — all four come from the plan, and a second place to say them is a
 * second place for them to be wrong. The server in particular is **not** derived from the crew, as
 * a build job's is: a box typed against one world's landscape must not be dug in another because
 * somebody ticked a different agent.
 */
export async function startRegionJob(
  regionId: number,
  body: {
    mode: SplitMode
    agentIds: number[]
    parts?: number
    /** The order every piece is worked in. A survey has one sensible sweep and ignores it. */
    order?: string
    segmentOrders?: Record<number, string>
  },
): Promise<BuildJob> {
  const { data, error } = await api.POST('/api/regions/{regionId}/jobs', {
    params: { path: { regionId } },
    body,
  })
  if (error) throw new Error(errorMessage(error))
  return data as BuildJob
}
