import { api, errorMessage } from './client'
import type { components } from './schema'
import type { Placement } from './builds'
import type { SplitMode } from './schematics'

/** Re-exported: a job is started with one, so callers of this module need not know where it lives. */
export type { SplitMode }

/**
 * Build jobs: a plan, frozen, being carried out.
 *
 * A job is not a view over its plan. The anchor and the substitutions here are the job's **own
 * copies**, taken when it started, so a plan edited afterwards describes the next job rather than
 * this one — which is why nothing in this module reads a build to fill in a gap.
 */

export type JobState = 'ACTIVE' | 'PAUSED' | 'DONE'
export type SegmentState = 'PENDING' | 'ASSIGNED' | 'BUILDING' | 'DONE' | 'FAILED'

/**
 * The two states are narrowed here rather than left as the `string` the generator produces.
 *
 * They are closed sets on the backend — database check constraints, not free text — and naming them
 * is what makes a `Record` over them exhaustive. That is the same net that has already caught a
 * missing audit action twice.
 */
export type JobSegment = Omit<
  Required<components['schemas']['JobSegmentResponse']>,
  'state' | 'agentId' | 'agentLabel' | 'lastReportAt' | 'failureReason'
> & {
  state: SegmentState
  /** Null while nobody holds it, and after the agent that did has been removed. */
  agentId: number | null
  agentLabel: string | null
  lastReportAt: string | null
  failureReason: string | null
}

export type BuildJob = Omit<
  Required<components['schemas']['BuildJobResponse']>,
  'state' | 'placement' | 'segments' | 'finishedAt'
> & {
  state: JobState
  placement: Placement
  segments: JobSegment[]
  /** Null while the job is active. */
  finishedAt: string | null
}

export async function listJobs(buildId?: number): Promise<BuildJob[]> {
  const { data, error } = await api.GET('/api/jobs', {
    params: { query: buildId === undefined ? {} : { buildId } },
  })
  if (error) throw new Error(errorMessage(error))
  return (data ?? []) as BuildJob[]
}

/**
 * Starts building a plan.
 *
 * The agents are the request: how many pieces the build is divided into is how many agents are
 * carrying them, and the server is derived from the agents themselves. Sending either separately
 * would be a second place to say something this list already says.
 */
export async function startJob(
  buildId: number,
  body: { mode: SplitMode; agentIds: number[] },
): Promise<BuildJob> {
  const { data, error } = await api.POST('/api/builds/{buildId}/jobs', {
    params: { path: { buildId } },
    body,
  })
  if (error) throw new Error(errorMessage(error))
  return data as BuildJob
}

/**
 * Stops a job, keeping its segments, its crew and its counts.
 *
 * Pause rather than cancel: a cancelled job could only be deleted, so stopping one and deciding
 * what to do about it were forced into a single irreversible act.
 */
export async function pauseJob(id: number): Promise<BuildJob> {
  const { data, error } = await api.POST('/api/jobs/{id}/pause', { params: { path: { id } } })
  if (error) throw new Error(errorMessage(error))
  return data as BuildJob
}

/** Picks it up where it stopped. Nothing is reassigned; the crew never left. */
export async function resumeJob(id: number): Promise<BuildJob> {
  const { data, error } = await api.POST('/api/jobs/{id}/resume', { params: { path: { id } } })
  if (error) throw new Error(errorMessage(error))
  return data as BuildJob
}

/**
 * Clears a job out of the list, and with it everything the job was holding.
 *
 * Only once it is not building — the backend refuses a live one. The trail keeps the start and the
 * pause either way, so this removes the card rather than the history.
 */
export async function deleteJob(id: number): Promise<void> {
  const { error } = await api.DELETE('/api/jobs/{id}', { params: { path: { id } } })
  if (error) throw new Error(errorMessage(error))
}

export async function assignSegment(
  jobId: number,
  segmentId: number,
  agentId: number,
): Promise<BuildJob> {
  const { data, error } = await api.POST('/api/jobs/{jobId}/segments/{segmentId}/assignment', {
    params: { path: { jobId, segmentId } },
    body: { agentId },
  })
  if (error) throw new Error(errorMessage(error))
  return data as BuildJob
}

/** Takes a segment back. It returns to the pool rather than being marked failed. */
export async function releaseSegment(jobId: number, segmentId: number): Promise<BuildJob> {
  const { data, error } = await api.DELETE('/api/jobs/{jobId}/segments/{segmentId}/assignment', {
    params: { path: { jobId, segmentId } },
  })
  if (error) throw new Error(errorMessage(error))
  return data as BuildJob
}
