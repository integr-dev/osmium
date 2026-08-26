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
  'state' | 'agentId' | 'agentLabel' | 'lastReportAt' | 'failureReason' | 'releasedFrom'
> & {
  state: SegmentState
  /** Null while nobody holds it, and after the agent that did has been removed. */
  agentId: number | null
  agentLabel: string | null
  lastReportAt: string | null
  failureReason: string | null
  /** Who a live piece was taken from. Null unless it is being kept away from somebody. */
  releasedFrom: string | null
}

/** One agent working a job, whether or not it is holding a piece right now. */
export type JobAgent = Omit<Required<components['schemas']['JobAgentResponse']>, 'agentId'> & {
  /** Null once the agent has been deleted. */
  agentId: number | null
}

export type BuildJob = Omit<
  Required<components['schemas']['BuildJobResponse']>,
  'state' | 'placement' | 'segments' | 'pool' | 'finishedAt'
> & {
  state: JobState
  placement: Placement
  segments: JobSegment[]
  /**
   * Who is working it. Empty once it is finished — this is live membership, and who built which
   * piece is on the piece.
   */
  pool: JobAgent[]
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
 * The agents are a **pool**, and `parts` is separate from it. They used to be the same number,
 * because a piece was a share handed to an agent once; a piece is a unit of work now, so a build
 * can be divided finer than the crew and agents take the next one as they finish. Left out, it
 * still defaults to the size of the pool.
 *
 * The server is still not sent: one job is one server, and the pool already says which.
 */
export async function startJob(
  buildId: number,
  body: { mode: SplitMode; agentIds: number[]; parts?: number },
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

/**
 * Hands a piece back. The agent stays on the job.
 *
 * Which means it can come straight back to the same agent, and for a failed piece that is the
 * point: releasing one is the retry, done deliberately by whoever read the reason. Taking the
 * agent off the job is [leaveJob].
 */
export async function releaseSegment(jobId: number, segmentId: number): Promise<BuildJob> {
  const { data, error } = await api.DELETE('/api/jobs/{jobId}/segments/{segmentId}/assignment', {
    params: { path: { jobId, segmentId } },
  })
  if (error) throw new Error(errorMessage(error))
  return data as BuildJob
}

/**
 * Puts another agent on a running job.
 *
 * No segment: which piece it gets depends on what is free when it arrives, and that is the
 * scheduler's answer rather than the operator's.
 */
export async function addJobAgent(id: number, agentId: number): Promise<BuildJob> {
  const { data, error } = await api.POST('/api/jobs/{id}/agents', {
    params: { path: { id } },
    body: { agentId },
  })
  if (error) throw new Error(errorMessage(error))
  return data as BuildJob
}

/** Takes an agent off a job, and whatever it was holding with it. */
export async function leaveJob(id: number, agentId: number): Promise<BuildJob> {
  const { data, error } = await api.DELETE('/api/jobs/{id}/agents/{agentId}', {
    params: { path: { id, agentId } },
  })
  if (error) throw new Error(errorMessage(error))
  return data as BuildJob
}
