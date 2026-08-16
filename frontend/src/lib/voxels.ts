import type { Vec3 } from './box3d'

/**
 * Drawing a voxel model without sorting it.
 *
 * The preview is tens of thousands of cubes and it has to survive being dragged, so the two costs
 * that matter are how many faces are drawn and how they are ordered. Neither needs a depth buffer.
 *
 * **Order.** Axis-aligned cubes on a grid have an exact painter's order that depends only on which
 * octant the camera is in: walk each axis away from the viewer and a cube is always drawn after
 * everything it could be behind. Eight cases, decided once per frame, instead of sorting fifty
 * thousand centroids sixty times a second.
 *
 * **Count.** Three of a cube's six faces point away from any camera and the backend has already
 * dropped the ones with a neighbour, so what is left to draw is at most three per cube and usually
 * fewer.
 */

/** The six face directions, in the bit order the backend packs them into. */
export const FACE_NORMALS: Vec3[] = [
  { x: -1, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 },
]

/** Which way to walk each axis so that nearer cubes are drawn last. `1` ascending, `-1` descending. */
export interface DrawOrder {
  x: 1 | -1
  y: 1 | -1
  z: 1 | -1
}

/**
 * The iteration direction for a view.
 *
 * A cube is drawn after anything it may overlap when each axis is walked from the far side towards
 * the camera. Which side is far is the sign of that axis's depth once rotated — so this is three
 * comparisons, and the result is exact rather than an approximation of a sort.
 */
export function drawOrder(rotate: (point: Vec3) => Vec3): DrawOrder {
  // Larger depth is further away, the same convention the box projection sorts by. So an axis
  // whose positive direction leads away from the camera is walked *descending*: start at the far
  // end, finish at the near one, and every cube lands on top of whatever it might obscure.
  const away = (axis: Vec3) => (rotate(axis).z > 0 ? -1 : 1)

  return {
    x: away({ x: 1, y: 0, z: 0 }),
    y: away({ x: 0, y: 1, z: 0 }),
    z: away({ x: 0, y: 0, z: 1 }),
  }
}

/**
 * The faces of a cube worth drawing: exposed by the backend's mask, and turned towards the camera.
 *
 * Returned as a mask rather than a list so the hot loop tests a bit instead of allocating.
 */
export function visibleFaces(exposed: number, rotate: (point: Vec3) => Vec3): number {
  let mask = 0

  FACE_NORMALS.forEach((normal, bit) => {
    if ((exposed & (1 << bit)) === 0) return
    // Negative depth is towards the viewer, the same convention the box projection uses.
    if (rotate(normal).z < 0) mask |= 1 << bit
  })

  return mask
}

/**
 * How bright each face is, by which way it points **in the world**.
 *
 * This was in view space to begin with, on the theory that a face keeping its brightness through a
 * drag would look calmer. It does, and it costs the one thing the shading is for: with the light
 * fixed to the camera, the top of the model is bright from one angle and dark from another, so
 * there is nothing in the picture that says which way is up. Somebody looking at a schematic from
 * underneath had no way to tell.
 *
 * Fixed to the world, the top is always the brightest face and the underside always the darkest,
 * whatever the model is turned to — which is how a real object reads, and is the difference between
 * a shape and a shape you are oriented in.
 *
 * It is also constant, so there is nothing to recompute per frame.
 */
export const FACE_SHADES: number[] = (() => {
  // Slightly off-vertical, so the two horizontal pairs separate from each other as well as from the
  // top. A straight-down light makes all four sides identical and the model reads as a cross.
  const light = { x: -0.45, y: 0.8, z: -0.28 }
  const length = Math.sqrt(light.x ** 2 + light.y ** 2 + light.z ** 2)

  return FACE_NORMALS.map((normal) => {
    const dot = (normal.x * light.x + normal.y * light.y + normal.z * light.z) / length
    // Wrapped rather than clamped at zero. Clamping puts every face turned away from the light on
    // the same ambient floor, and three sides at one grey read as a single surface — the model
    // loses its corners exactly where it needs them most.
    return 0.35 + 0.65 * ((dot + 1) / 2)
  })
})()
