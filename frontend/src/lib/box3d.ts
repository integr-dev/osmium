/**
 * Projecting axis-aligned boxes for the operations preview.
 *
 * A schematic is placed as one box and split into several, and both are looked at the same way:
 * turned around to understand which corner is which. That needs three dimensions and almost
 * nothing else — no meshes, no lighting model, no scene graph — so it is a rotation matrix and a
 * fit, kept here as a plain function rather than behind a renderer.
 *
 * Deliberately not a 3D library. Three things fall out of doing it this way that would each be work
 * to get back: labels stay screen-aligned instead of rotating with the geometry, depth order is
 * exact rather than approximate because the boxes are disjoint and axis-aligned, and the whole
 * thing is testable, which nothing drawn to a canvas is.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** A box in schematic space. `max` is exclusive, as a size added to `min`. */
export interface Box {
  id: string
  min: Vec3
  max: Vec3
  label?: string
  /** Blocks inside it, when this is a segment of a split rather than the whole schematic. */
  blocks?: number
}

export interface Point {
  x: number
  y: number
}

export interface Face {
  /** Four corners, wound so the polygon is closed in order. */
  points: Point[]
  /** 0 to 1. A stand-in for lighting: enough to read as a solid, cheaper than one. */
  shade: number
}

export interface Corner {
  at: Point
  world: Vec3
}

/** One edge of the box with its length in blocks, for the measurement labels. */
export interface Dimension {
  axis: 'x' | 'y' | 'z'
  length: number
  /** Midpoint of the edge being measured, where the label goes. */
  at: Point
}

export interface ProjectedBox {
  id: string
  label?: string
  blocks?: number
  /** Only the faces turned towards the viewer, so the box reads as solid without depth sorting. */
  faces: Face[]
  edges: Array<{ a: Point; b: Point }>
  corners: Corner[]
  dimensions: Dimension[]
  /** Larger is further away. Boxes are drawn in descending order. */
  depth: number
}

export interface Scene {
  boxes: ProjectedBox[]
  width: number
  height: number
}

export interface View {
  /** Radians. Rotation about the vertical axis — what dragging left and right changes. */
  yaw: number
  /** Radians, clamped. Rotation about the horizontal axis — dragging up and down. */
  pitch: number
  width: number
  height: number
  padding?: number
  /** 1 fits the whole thing. Above that it overflows, which is the point of zooming in. */
  zoom?: number
}

export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 6

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/**
 * Looking straight down the axis is a degenerate view: the box collapses to a rectangle and every
 * face but one disappears. Stopping short of it keeps a sense of three dimensions at every angle a
 * drag can reach.
 */
export const MAX_PITCH = 1.4

export function clampPitch(pitch: number): number {
  return Math.min(MAX_PITCH, Math.max(-MAX_PITCH, pitch))
}

/**
 * The eight corners of a box, in a fixed order, as (x, y, z) flags. Fixed because the faces below
 * index into it, and a different order would silently rewind them into bowties.
 */
const CORNERS: Array<[number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 0, 1],
  [0, 0, 1],
  [0, 1, 0],
  [1, 1, 0],
  [1, 1, 1],
  [0, 1, 1],
]

/** Each face as four corner indices, wound counter-clockwise seen from outside, plus its normal. */
const FACES: Array<{ corners: number[]; normal: Vec3 }> = [
  { corners: [0, 1, 2, 3], normal: { x: 0, y: -1, z: 0 } },
  { corners: [7, 6, 5, 4], normal: { x: 0, y: 1, z: 0 } },
  { corners: [0, 4, 5, 1], normal: { x: 0, y: 0, z: -1 } },
  { corners: [2, 6, 7, 3], normal: { x: 0, y: 0, z: 1 } },
  { corners: [3, 7, 4, 0], normal: { x: -1, y: 0, z: 0 } },
  { corners: [1, 5, 6, 2], normal: { x: 1, y: 0, z: 0 } },
]

/** The twelve edges, as pairs of corner indices. */
const EDGES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
]

/**
 * Where the light comes from. Fixed in view space rather than in the world, so a face keeps its
 * brightness as the box turns — the alternative makes the whole thing flicker while dragging.
 */
const LIGHT: Vec3 = { x: -0.4, y: 0.82, z: -0.4 }

/**
 * Projects every box into one scene, scaled so all of them fit.
 *
 * Fitted together rather than each to itself: a split preview is several boxes that have to stay in
 * proportion to each other, and scaling them individually would draw the smallest segment the same
 * size as the largest.
 */
export function project(boxes: Box[], view: View): Scene {
  const padding = view.padding ?? 24
  const rotate = rotation(view.yaw, clampPitch(view.pitch))

  // Everything is projected once into view space, then measured, then scaled. Doing it in that
  // order is what lets the fit account for rotation — the extent of a turned box is not the extent
  // of its sides.
  const turned = boxes.map((box) => ({
    box,
    corners: CORNERS.map(([fx, fy, fz]) =>
      rotate({
        x: fx ? box.max.x : box.min.x,
        y: fy ? box.max.y : box.min.y,
        z: fz ? box.max.z : box.min.z,
      }),
    ),
  }))

  const points = turned.flatMap((entry) => entry.corners)
  const fit = fitting(points, view.width, view.height, padding, clampZoom(view.zoom ?? 1))
  const light = normalise(LIGHT)

  const projected = turned.map(({ box, corners }) => {
    const flat = corners.map(fit)

    const faces = FACES.flatMap((face) => {
      const normal = rotate(face.normal)
      // Backface culling rather than depth sorting. A box is convex, so a face turned away is
      // always hidden — exact, and it means no face of a box can ever draw over another.
      if (normal.z >= 0) return []

      return [{
        points: face.corners.map((index) => flat[index]),
        // Half ambient, half directional: unlit faces stay legible rather than going black.
        shade: 0.45 + 0.55 * Math.max(0, dot(normal, light)),
      }]
    })

    return {
      id: box.id,
      label: box.label,
      blocks: box.blocks,
      faces,
      edges: EDGES.map(([a, b]) => ({ a: flat[a], b: flat[b] })),
      corners: CORNERS.map(([fx, fy, fz], index) => ({
        at: flat[index],
        world: {
          x: fx ? box.max.x : box.min.x,
          y: fy ? box.max.y : box.min.y,
          z: fz ? box.max.z : box.min.z,
        },
      })),
      dimensions: dimensionsOf(box, flat),
      depth: average(corners.map((corner) => corner.z)),
    }
  })

  // Furthest first. Painter's order is exact here because the boxes of a split never overlap.
  projected.sort((a, b) => b.depth - a.depth)

  return { boxes: projected, width: view.width, height: view.height }
}

/**
 * The three measurements, each on one edge meeting the near-bottom corner.
 *
 * Always the same three edges rather than whichever face happens to point at the viewer: a label
 * that jumps to another edge mid-drag reads as the number having changed.
 */
function dimensionsOf(box: Box, flat: Point[]): Dimension[] {
  return [
    { axis: 'x' as const, length: box.max.x - box.min.x, edge: [0, 1] as const },
    { axis: 'y' as const, length: box.max.y - box.min.y, edge: [0, 4] as const },
    { axis: 'z' as const, length: box.max.z - box.min.z, edge: [0, 3] as const },
  ].map(({ axis, length, edge }) => ({
    axis,
    length,
    at: midpoint(flat[edge[0]], flat[edge[1]]),
  }))
}

/** Yaw about the vertical axis, then pitch about the horizontal one. */
function rotation(yaw: number, pitch: number): (point: Vec3) => Vec3 {
  const cosYaw = Math.cos(yaw)
  const sinYaw = Math.sin(yaw)
  const cosPitch = Math.cos(pitch)
  const sinPitch = Math.sin(pitch)

  return (point) => {
    const x = point.x * cosYaw + point.z * sinYaw
    const z = -point.x * sinYaw + point.z * cosYaw

    return {
      x,
      y: point.y * cosPitch - z * sinPitch,
      z: point.y * sinPitch + z * cosPitch,
    }
  }
}

/**
 * Scale and offset that put every point inside the viewport.
 *
 * One scale for both axes: separate ones would fit more tightly and turn every cube into a box of
 * whatever shape the window is.
 */
function fitting(
  points: Vec3[],
  width: number,
  height: number,
  padding: number,
  zoom: number,
): (point: Vec3) => Point {
  const xs = points.map((point) => point.x)
  // Screen y grows downwards, so the world's vertical axis is negated on the way out.
  const ys = points.map((point) => -point.y)

  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  // A flat schematic — one block tall, or a single column — has no extent on one axis, and
  // dividing by it would put every corner at infinity.
  const spanX = Math.max(maxX - minX, 1e-6)
  const spanY = Math.max(maxY - minY, 1e-6)

  // Zoom multiplies the fit rather than replacing it, so the picture stays centred on the same
  // point as it grows and 1 always means "all of it, just inside the frame".
  const scale = Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY) * zoom
  const offsetX = (width - (maxX + minX) * scale) / 2
  const offsetY = (height - (maxY + minY) * scale) / 2

  return (point) => ({
    x: round(point.x * scale + offsetX),
    y: round(-point.y * scale + offsetY),
  })
}

function midpoint(a: Point, b: Point): Point {
  return { x: round((a.x + b.x) / 2), y: round((a.y + b.y) / 2) }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function normalise(vector: Vec3): Vec3 {
  const length = Math.sqrt(dot(vector, vector)) || 1
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length }
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

/** Two decimals is a fifth of a pixel and keeps the markup a third shorter. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}
