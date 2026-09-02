/**
 * Panning and zooming a picture that is bigger than the box it is shown in.
 *
 * Screen space, not diagram space: `x` and `y` are pixels the content is offset by and `k` is what
 * it is multiplied by, which is exactly what a CSS transform takes. Doing the arithmetic against
 * the diagram's own coordinates would mean every caller reproducing the mapping between the two.
 *
 * Pure, so the part that is easy to get wrong — a zoom that walks the diagram off the screen —
 * is the part that is tested.
 */
export interface View {
  x: number
  y: number
  k: number
}

/**
 * Below the minimum a fleet is unreadable dots; above the maximum a node fills the box. Both are
 * generous rather than tight, because the useful range depends on how many hosts there are.
 *
 * The defaults, rather than the only values. A world map is drawn at one pixel per block and is
 * read at both ends of a far wider range - a build at four pixels a block, a continent at an
 * eighth - so the limits travel with the call. See {@link Limits}.
 */
export const MIN_SCALE = 0.4
export const MAX_SCALE = 4

/** How far a particular picture may be zoomed. */
export interface Limits {
  min: number
  max: number
}

const DEFAULT_LIMITS: Limits = { min: MIN_SCALE, max: MAX_SCALE }

export const IDENTITY: View = { x: 0, y: 0, k: 1 }

export function clampScale(k: number, limits: Limits = DEFAULT_LIMITS): number {
  return Math.min(limits.max, Math.max(limits.min, k))
}

/**
 * Zooms by [factor] about the point ([px], [py]) in the box's own pixels.
 *
 * **What is under the pointer stays under the pointer.** Zooming about the centre instead is the
 * version that has an operator chasing the node they were looking at across the panel, and the
 * offset here is what stops it: the point is held still and the rest of the picture moves around it.
 *
 * The ratio is taken from the *clamped* scale, so a wheel turn at either end of the range moves
 * nothing at all rather than sliding the picture while refusing to resize it.
 */
export function zoomAt(view: View, px: number, py: number, factor: number, limits?: Limits): View {
  const k = clampScale(view.k * factor, limits)
  const ratio = k / view.k

  return {
    k,
    x: px - (px - view.x) * ratio,
    y: py - (py - view.y) * ratio,
  }
}

export function panBy(view: View, dx: number, dy: number): View {
  return { ...view, x: view.x + dx, y: view.y + dy }
}

/**
 * The view that puts a picture of [width] by [height] in the middle of a box of [boxWidth] by
 * [boxHeight], scaled down if it does not fit and never scaled up past its natural size.
 *
 * Never enlarged, because a four-node fleet blown up to fill a panel reads as a fault rather than
 * as a small fleet.
 */
export function fit(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
  limits?: Limits,
): View {
  if (width <= 0 || height <= 0) return IDENTITY

  const k = clampScale(Math.min(1, boxWidth / width, boxHeight / height), limits)

  return { k, x: (boxWidth - width * k) / 2, y: (boxHeight - height * k) / 2 }
}
