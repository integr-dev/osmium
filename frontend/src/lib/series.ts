/**
 * Turning a list of numbers into the two shapes a sparkline is made of, and time stamps into hourly
 * counts.
 *
 * Geometry only, so it can be tested without a DOM. Everything is drawn into a unit box and stretched
 * by the SVG's `preserveAspectRatio="none"`, with `vector-effect="non-scaling-stroke"` keeping the
 * line 2px however wide the box ends up.
 */
export const VIEW_WIDTH = 100
export const VIEW_HEIGHT = 30

/**
 * Half the stroke, kept clear at the top and bottom. Without it the highest and lowest points are
 * clipped in half by the edge of the box, which reads as a flat spot rather than a peak.
 */
const INSET = 2

/** The line through [values], or an empty path when there is nothing to draw. */
export function linePath(values: number[]): string {
  const points = pointsOf(values)
  if (!points.length) return ''
  return points.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')
}

/** The same line closed down to the baseline, for the wash underneath it. */
export function areaPath(values: number[]): string {
  const points = pointsOf(values)
  if (!points.length) return ''
  const last = points[points.length - 1]!
  return `${linePath(values)} L${last.x} ${VIEW_HEIGHT} L${points[0]!.x} ${VIEW_HEIGHT} Z`
}

function pointsOf(values: number[]): { x: number; y: number }[] {
  if (values.length === 0) return []

  const low = Math.min(...values)
  const high = Math.max(...values)
  // A flat series has no range to scale against. Drawn down the middle rather than at the floor,
  // which would read as zero, or at the ceiling, which would read as a maximum.
  const span = high - low || 1
  const flat = high === low

  const step = values.length === 1 ? 0 : VIEW_WIDTH / (values.length - 1)
  const usable = VIEW_HEIGHT - INSET * 2

  return values.map((value, index) => ({
    x: values.length === 1 ? VIEW_WIDTH / 2 : Number((index * step).toFixed(2)),
    y: Number(
      (flat ? VIEW_HEIGHT / 2 : INSET + usable - ((value - low) / span) * usable).toFixed(2),
    ),
  }))
}

export interface HourBucket {
  /** The start of the hour, as an epoch millisecond value. */
  at: number
  count: number
}

/**
 * How many of [times] fall in each of the last [hours] whole hours, oldest first.
 *
 * Bucketed on the hour rather than on rolling offsets from now, so the bars stop sliding sideways
 * every second and a reader can match one to a clock. Anything outside the window is dropped rather
 * than folded into the end bucket, which would put a spike on the oldest bar every time.
 */
export function bucketByHour(times: number[], now: number, hours: number): HourBucket[] {
  const hour = 3_600_000
  const end = Math.floor(now / hour) * hour
  const start = end - (hours - 1) * hour

  const buckets: HourBucket[] = []
  for (let at = start; at <= end; at += hour) buckets.push({ at, count: 0 })

  for (const time of times) {
    const index = Math.floor((time - start) / hour)
    if (index >= 0 && index < buckets.length) buckets[index]!.count += 1
  }

  return buckets
}
