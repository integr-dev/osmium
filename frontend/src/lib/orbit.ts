/**
 * How an orbit camera should pan and zoom, given what it is looking at.
 *
 * **`OrbitControls` measures both against the wrong thing.** A drag moves the world by an amount
 * worked out from the distance to the pivot, and a wheel notch multiplies that same distance by a
 * fixed fraction:
 *
 * ```js
 * targetDistance = |camera - target|
 * panStep = 2 * pixels * targetDistance * tan(fov / 2) / height
 * radius *= Math.pow(0.95, zoomSpeed)
 * ```
 *
 * In a viewer whose pivot is stuck to an agent, that distance is not the distance to anything on
 * the screen. Zoom in on the agent and the pivot is three blocks away, so a full drag moves the
 * world three blocks and a notch moves a twentieth of three blocks - while the landscape filling
 * the view is fifty blocks off and shifts by almost nothing. Zoom out and the pivot is sixty away
 * and the same gestures move the world properly. So the further in, the less either of them does.
 *
 * Both are answered by measuring against **the thing being looked at** rather than the pivot, and
 * the viewer already casts a ray into the world for its hover:
 *
 * - {@link panRate} rescales upstream's drag so what is under the pointer travels with it.
 * - {@link dollyToward} replaces upstream's wheel entirely, because holding a point still under
 *   the cursor is not something a rate can do - it is a different move.
 *
 * Pure, because the arithmetic is the part worth being sure of and a camera is not.
 */

/** Anything with three coordinates. The viewer's cameras and vectors all qualify. */
export interface Point {
  x: number
  y: number
  z: number
}

/**
 * The most the pivot distance may be multiplied by, which is a guard and not a preference.
 *
 * There is nothing to stop the ratio being enormous: a camera sitting on top of an agent has a
 * pivot distance near zero, and dividing by it gives a number with no useful meaning. Sixty four
 * is far past any real view - a pivot on an agent five blocks off with ground eighty blocks behind
 * it asks for sixteen - so ordinary use never reaches it and a degenerate camera cannot produce
 * nonsense.
 *
 * Deliberately generous, because the first version of this capped at eight and clamped the very
 * case it was written for.
 */
export const MOST = 64

/**
 * The least it may be multiplied by, so a view of something close is not sped up.
 *
 * Standing the camera in front of a wall is the case this protects: the wall is nearer than the
 * pivot, the ratio is below one, and slowing the drag down there is right - a block of world
 * movement crosses most of the screen. The rate is only ever raised towards what is being looked
 * at, never below upstream's own.
 */
export const LEAST = 1

/**
 * How much of the distance to what is under the cursor one wheel notch closes.
 *
 * A notch is 100 units of `deltaY` on most mice, so this is about a tenth of the way in per notch.
 * A fifth was the first try and read as lunging: the glide makes each one land as movement rather
 * than as a jump, and movement that covers a fifth of the remaining distance is a lot of movement.
 * Trackpads send small deltas continuously and get the same curve for free, which is the reason
 * this is per-pixel rather than per-notch.
 */
export const PER_PIXEL = 0.001

/**
 * The most one wheel event may change the distance by, as a multiple.
 *
 * A trackpad fling arrives as one enormous `deltaY`, and a browser sending `deltaMode` in lines or
 * pages sends numbers on a different scale entirely. Without a clamp either one is a camera on the
 * far side of the world in a single event.
 */
export const MOST_AT_ONCE = 4

/**
 * How close the camera may get to what it is zooming at, in blocks.
 *
 * Zoom-to-cursor closes on a point on a surface, so without a floor the camera ends up inside the
 * block it was aimed at and the view fills with the inside of a face. A little over the near plane
 * and a little under a block, so lining up on one still works.
 */
export const CLOSEST = 0.75

/**
 * How much of the zoom still owed is spent each frame.
 *
 * A wheel notch is a discrete thing and a camera arriving at its answer in one frame is a jump,
 * however right the answer is. Spending a fifth of what is left each frame puts nineteen twentieths
 * of it in a fifth of a second at sixty frames, which reads as the camera moving rather than the
 * picture changing - and it keeps the wheel responsive, because the first frame is already a fifth
 * of the way there.
 */
export const GLIDE = 0.2

/**
 * Close enough to the zoom it was asked for to stop, as a share of the distance.
 *
 * A thousandth. Geometric easing never actually arrives, and a camera creeping the last
 * hundred-thousandth of a block for ever is a render loop that never goes idle.
 */
export const ARRIVED = 0.001

/**
 * How much of what is on screen a drag should be measured against, as a multiple of the pivot.
 *
 * One when there is nothing to measure - no ray hit, a pivot at zero - which leaves whatever the
 * caller was going to do alone. That is the sky: pointed at nothing, upstream's own behaviour is as
 * good an answer as any, and it is the one that cannot surprise anybody.
 */
export function reachFor(depth: number | undefined, pivot: number): number {
  if (depth === undefined || !Number.isFinite(depth) || depth <= 0) return LEAST
  if (!Number.isFinite(pivot) || pivot <= 0) return LEAST

  return Math.min(MOST, Math.max(LEAST, depth / pivot))
}

/**
 * `panSpeed` for a camera [pivot] blocks from what it orbits, looking at something [depth] away.
 *
 * The step upstream takes is proportional to the pivot distance, so multiplying the speed by the
 * ratio makes it proportional to the depth instead - which is what puts a fixed number of pixels
 * of what you are looking at under a fixed number of pixels of drag. The pivot cancels: the step
 * is the base rate times the depth, whatever the camera is orbiting and however close it is to it.
 */
export function panRate(base: number, depth: number | undefined, pivot: number): number {
  return base * reachFor(depth, pivot)
}

/**
 * What one wheel event should multiply the distance to the cursor by.
 *
 * Above one is away. Exponential in the delta, so the same flick covers the same *proportion* of
 * the distance wherever the camera is, and so that any two events add up to the same place as the
 * one event that spans them - which is what makes a trackpad feel continuous instead of steppy.
 */
export function zoomFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY)) return 1

  return Math.min(MOST_AT_ONCE, Math.max(1 / MOST_AT_ONCE, Math.exp(deltaY * PER_PIXEL)))
}

function scaledFrom(at: Point, point: Point, by: number): Point {
  return {
    x: at.x + (point.x - at.x) * by,
    y: at.y + (point.y - at.y) * by,
    z: at.z + (point.z - at.z) * by,
  }
}

/**
 * Where the camera and its pivot go when the wheel is turned with [at] under the cursor.
 *
 * **What is under the pointer stays under the pointer**, which is the whole of what makes zooming
 * in a 3D viewer feel like a tool rather than a slider. Both the camera and the pivot are scaled
 * about that point, so the direction the camera looks does not change - only how far away it is -
 * and orbiting afterwards still turns about something sensible.
 *
 * Two things fall out of it for free, and both are things a rate-based zoom has to be told:
 *
 * - **It slows down as it arrives.** The step is a share of the distance to the surface, so
 *   approaching one costs progressively less distance, which is what stops a wheel overshooting a
 *   block it was being lined up on.
 * - **It cannot go through anything it is aimed at**, because {@link CLOSEST} is a floor on the
 *   distance to that point rather than to the pivot.
 *
 * Zooming out is left unclamped: there is nothing to collide with behind the camera, and a viewer
 * that would not let go of a wall it had been pushed up against would be worse than one that does.
 */
/**
 * One frame of a zoom, and what is left of it afterwards.
 *
 * **Zoom is eased where a drag is damped**, and for the same reason: the answer arriving all at
 * once is a jump. It is eased in the *log* of the distance rather than the distance, because that
 * is the shape zooming has - a fifth of the way in per frame, whatever the scale - and because it
 * makes the easing compose exactly the way {@link zoomFactor} does. A notch that arrives while an
 * earlier one is still gliding multiplies into it and the two finish together, which is what a
 * wheel spun in one motion should feel like.
 *
 * Answers a step to apply now and the remainder to keep, and gives back a remainder of exactly one
 * once it is inside {@link ARRIVED} - so the caller has something honest to test to stop.
 */
export function easeZoom(left: number, share: number = GLIDE): { step: number; left: number } {
  if (!Number.isFinite(left) || left <= 0) return { step: 1, left: 1 }

  const owed = Math.log(left)
  if (Math.abs(owed) <= ARRIVED) return { step: left, left: 1 }

  const step = Math.exp(owed * share)

  return { step, left: left / step }
}

export function dollyToward(
  camera: Point,
  target: Point,
  at: Point,
  factor: number,
): { camera: Point; target: Point } {
  const away = Math.hypot(camera.x - at.x, camera.y - at.y, camera.z - at.z)

  // Already inside whatever it is aimed at, or aimed at itself. Backing out is still allowed;
  // there is nothing sensible to scale towards.
  if (!Number.isFinite(away) || away <= 0) return { camera, target }

  const closest = factor < 1 ? Math.max(factor, CLOSEST / away) : factor

  return {
    camera: scaledFrom(at, camera, closest),
    target: scaledFrom(at, target, closest),
  }
}
