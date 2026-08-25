import type { BuildJob, JobSegment, SegmentState } from '../api/jobs'

/**
 * What a job adds up to.
 *
 * Arithmetic over what the response already carries, so it is computed where it is read rather
 * than asked for — the same reasoning as the placement offset and the material totals.
 */

/**
 * A percentage that never lies at either end.
 *
 * Rounding is toward zero deliberately: a build one block short of finished should not read as
 * 100%, because "done" is the one number an operator acts on. An empty total is 0 rather than
 * NaN — a job with nothing in it has not been started, not fully built.
 */
export function percentOf(placed: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.floor((placed / total) * 100))
}

export interface JobSummary {
  placed: number
  total: number
  percent: number
  /** Per state, so the header can say what is happening without listing every piece. */
  counts: Record<SegmentState, number>
  /**
   * Pieces nobody is on and nobody has finished.
   *
   * `PENDING` and `FAILED` together, because they need the same act from an operator — give this to
   * somebody — even though they arrived here for opposite reasons.
   */
  waiting: JobSegment[]
}

const EMPTY_COUNTS: Record<SegmentState, number> = {
  PENDING: 0,
  ASSIGNED: 0,
  BUILDING: 0,
  DONE: 0,
  FAILED: 0,
}

export function summarise(job: BuildJob): JobSummary {
  const counts = { ...EMPTY_COUNTS }
  for (const segment of job.segments) counts[segment.state] += 1

  return {
    placed: job.blocksPlaced,
    total: job.totalBlocks,
    percent: percentOf(job.blocksPlaced, job.totalBlocks),
    counts,
    waiting: job.segments.filter(
      (segment) => segment.state === 'PENDING' || segment.state === 'FAILED',
    ),
  }
}

/**
 * What a set of jobs adds up to: how far along, how fast, and how much longer.
 *
 * **This replaced an invented rate.** The dashboard used to multiply builders by a constant — 38
 * blocks a minute, with no basis at all — against a schematic nobody had started. Every number here
 * comes from what hosts have reported against segments they were actually given.
 */
export interface JobFigures {
  placed: number
  total: number
  percent: number
  /** Observed, not assumed. Zero until something has been placed over measurable time. */
  perMinute: number
  /** Null when nothing is moving, which is most of the time. An estimate needs a rate. */
  etaMinutes: number | null
}

/**
 * @param jobs the jobs in scope — one server’s, or the whole fleet’s.
 * @param now taken as an argument rather than read, so the arithmetic is testable.
 */
export function jobFigures(jobs: BuildJob[], now: number = Date.now()): JobFigures {
  const placed = jobs.reduce((sum, job) => sum + job.blocksPlaced, 0)
  const total = jobs.reduce((sum, job) => sum + job.totalBlocks, 0)

  /**
   * Measured over the time each job has been open, and only over jobs that are building.
   *
   * A paused job dilutes nothing because it is not counted: its blocks stay in `placed`, where they
   * belong, but the minutes it spent stopped are not minutes anybody was working. A finished job is
   * left out for the same reason — its rate is history, and averaging it in makes a fleet that has
   * just started look faster than it is.
   */
  const working = jobs.filter((job) => job.state === 'ACTIVE')

  const minutes = working.reduce((sum, job) => {
    const elapsed = (now - new Date(job.startedAt).getTime()) / 60_000
    return sum + Math.max(0, elapsed)
  }, 0)

  const placedByWorking = working.reduce((sum, job) => sum + job.blocksPlaced, 0)

  // A job seconds old has placed something over almost no time, which is a rate in the millions.
  // Waiting for a little elapsed time is the difference between a throughput and a division by
  // nearly zero.
  const perMinute = minutes >= MEASURABLE_MINUTES ? Math.round(placedByWorking / minutes) : 0

  const remaining = working.reduce((sum, job) => sum + (job.totalBlocks - job.blocksPlaced), 0)

  return {
    placed,
    total,
    percent: percentOf(placed, total),
    perMinute,
    etaMinutes: perMinute > 0 ? Math.max(0, Math.round(remaining / perMinute)) : null,
  }
}

/** Below this the elapsed time is too short to divide by and mean anything. */
const MEASURABLE_MINUTES = 0.25
