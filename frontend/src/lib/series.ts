/**
 * Turning a list of numbers into the shapes a chart is made of.
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

/** A value at a moment, which is all a line on a time axis is made of. */
export interface TimePoint {
  at: number
  value: number
}

/**
 * A line across a fixed stretch of time, and its wash, in a [width] × [height] box.
 *
 * Unlike `linePath` the scale is given rather than fitted: the bottom is zero and the top is
 * [ceiling], so two lines on one chart are measured against the same thing, and a flat line of
 * zeros lies on the floor where it belongs. Points outside the stretch are left out.
 */
export function timePath(
  points: TimePoint[],
  from: number,
  to: number,
  ceiling: number,
  width: number,
  height: number,
): { line: string; area: string } {
  const span = to - from || 1
  const top = ceiling || 1
  const inside = points.filter((point) => point.at >= from && point.at <= to)
  if (!inside.length) return { line: '', area: '' }

  const xy = inside.map((point) => ({
    x: Number((((point.at - from) / span) * width).toFixed(1)),
    y: Number((height - (Math.max(0, point.value) / top) * height).toFixed(1)),
  }))
  const line = xy.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')
  const area = `${line} L${xy.at(-1)!.x} ${height} L${xy[0]!.x} ${height} Z`
  return { line, area }
}

/**
 * The top of a scale that fits [value]: the next 1, 2 or 5 of its order of magnitude, so the
 * labels read as round numbers. Never zero, so an empty chart still has a scale to draw.
 */
export function niceCeiling(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}
