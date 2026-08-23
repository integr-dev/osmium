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
