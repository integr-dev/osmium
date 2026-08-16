<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Minus, Plus, RotateCcw } from 'lucide-vue-next'
import { clampPitch, clampZoom, DEFAULT_PITCH, DEFAULT_YAW, rotation, type Vec3 } from '../lib/box3d'
import { drawOrder, FACE_SHADES, visibleFaces, type DrawOrder } from '../lib/voxels'
import { palette } from '../lib/blockColours'
import type { ShapeResponse } from '../api/schematics'

/**
 * The schematic itself, as a voxel model that can be turned.
 *
 * **Canvas rather than SVG**, unlike the box view beside it. Tens of thousands of cubes is hundreds
 * of thousands of polygons, and the DOM will not hold that many nodes, let alone re-lay them out
 * during a drag. What that costs is the geometry being testable — so the geometry is not here: the
 * rotation lives in `box3d.ts` and the ordering and face selection in `voxels.ts`, both with specs.
 * This file is the paint call.
 *
 * Three reductions make it affordable, and only the last is done here:
 *
 * - the backend drops every voxel enclosed on all six sides, which at any interesting size is most
 *   of them;
 * - it also sends which sides are exposed, so a face buried in the solid is never considered;
 * - and of those, only the three that can face a camera are drawn, in an order that needs no sort.
 */
const props = defineProps<{ shape: ShapeResponse | null }>()

const { t } = useI18n()

const canvas = ref<HTMLCanvasElement | null>(null)

const START_YAW = DEFAULT_YAW
const START_PITCH = DEFAULT_PITCH

const yaw = ref(START_YAW)
const pitch = ref(START_PITCH)
const zoom = ref(1)

/**
 * The palette, as colours, resolved once per shape rather than per voxel. The draw loop then
 * indexes an array: at tens of thousands of cubes a lookup by name would be most of the frame.
 */
const colours = computed(() => palette(props.shape?.palette ?? []))

/** The model's own dimensions, for the description and the fit. */
const size = computed<Vec3>(() => ({
  x: props.shape?.sizeX ?? 0,
  y: props.shape?.sizeY ?? 0,
  z: props.shape?.sizeZ ?? 0,
}))

/**
 * A cube's eight corners as offsets, and its six faces as corner indices. The same winding the box
 * projection uses, so the two views of one schematic cannot disagree about which way it faces.
 */
const CORNERS: Array<[number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
  [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1],
]

const FACE_CORNERS = [
  [3, 7, 4, 0], // -X
  [1, 5, 6, 2], // +X
  [0, 1, 2, 3], // -Y
  [7, 6, 5, 4], // +Y
  [0, 4, 5, 1], // -Z
  [2, 6, 7, 3], // +Z
]

/**
 * The voxels as a typed array.
 *
 * They arrive as JSON, which is a plain array of boxed numbers; reading a quarter of a million of
 * those in a loop that runs every frame is measurably slower than reading the same values out of
 * contiguous memory.
 */
const data = computed(() => Int32Array.from(props.shape?.voxels ?? []))

/**
 * The eight walk orders, one per side of the model the camera can be on.
 *
 * `shallowRef` on purpose. These are the hottest reads in the frame and none of them ever changes
 * in place, so there is nothing to gain from Vue watching inside them and a proxy on the path
 * would be felt.
 */
const orders = shallowRef<Array<Int32Array | undefined>>(new Array(8))

/** Which of the eight, as an index rather than a key — a frame should allocate no strings. */
function octantOf(order: DrawOrder): number {
  return (order.x > 0 ? 1 : 0) | (order.y > 0 ? 2 : 0) | (order.z > 0 ? 4 : 0)
}

function build(octant: number): Int32Array {
  const voxels = data.value
  const count = props.shape?.count ?? 0

  const x = octant & 1 ? 1 : -1
  const y = octant & 2 ? 1 : -1
  const z = octant & 4 ? 1 : -1

  const indices = new Array<number>(count)
  for (let index = 0; index < count; index += 1) indices[index] = index * 5

  indices.sort((a, b) => {
    const dy = (voxels[a + 1]! - voxels[b + 1]!) * y
    if (dy !== 0) return dy
    const dz = (voxels[a + 2]! - voxels[b + 2]!) * z
    if (dz !== 0) return dz
    return (voxels[a]! - voxels[b]!) * x
  })

  const built = Int32Array.from(indices)
  orders.value[octant] = built
  return built
}

let warming = 0

/**
 * Fills in the seven orders the camera is not currently using, while nothing is happening.
 *
 * Building all eight the moment a model arrives stalls the first frame instead of a later one,
 * which for a large model is a visible pause on something that has just appeared. Building them
 * lazily is what made dragging stutter every quarter turn. So: the one needed now is built on
 * demand, and the rest are filled in one at a time whenever the browser is idle — by the time a
 * drag reaches another side of the model, its order is already there.
 */
function warm() {
  if (warming) return

  const next = orders.value.findIndex((order) => order === undefined)
  if (next === -1) return

  const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 200))
  warming = idle(() => {
    warming = 0
    if (props.shape && props.shape.count > 0) build(next)
    warm()
  }) as number
}

watch(
  data,
  () => {
    orders.value = new Array(8)
    warm()
  },
  { immediate: true },
)

/**
 * A colour darkened to a face's shade, so brightness never touches `globalAlpha`.
 *
 * Transparency was the expensive part: every face set an alpha, and every alpha change is a canvas
 * state change that also forces the compositor to blend rather than overwrite. Baking the shade in
 * makes each face an opaque fill, which draws faster *and* groups — two faces of one material and
 * one direction now share a colour, so they share a path.
 *
 * Cached, because there are only as many combinations as materials times six.
 */
const shadedCache = new Map<string, string>()

function shaded(colour: string, shade: number): string {
  const key = `${colour}|${shade.toFixed(3)}`
  const known = shadedCache.get(key)
  if (known !== undefined) return known

  const result = darken(colour, shade)
  shadedCache.set(key, result)
  return result
}

function darken(colour: string, shade: number): string {
  if (colour.startsWith('#') && colour.length >= 7) {
    const red = Math.round(parseInt(colour.slice(1, 3), 16) * shade)
    const green = Math.round(parseInt(colour.slice(3, 5), 16) * shade)
    const blue = Math.round(parseInt(colour.slice(5, 7), 16) * shade)
    return `rgb(${red} ${green} ${blue})`
  }

  // The derived colours are `hsl(h s% l%)`. Scaling the lightness is the same idea as scaling the
  // channels and avoids converting the space to do it.
  const parts = colour.match(/hsl\((\d+) (\d+)% (\d+)%\)/)
  if (parts) return `hsl(${parts[1]} ${parts[2]}% ${Math.round(Number(parts[3]) * shade)}%)`

  return colour
}

/**
 * A grid on the plane the model sits on, extending past its footprint.
 *
 * Deliberately not centred on the model's own base: it runs a little wider, because a grid that
 * stopped exactly at the walls would read as part of the building rather than as the ground under
 * it.
 */
function drawGround(
  context: CanvasRenderingContext2D,
  project: (x: number, y: number, z: number) => [number, number],
) {
  const { x, z } = size.value
  if (x === 0 || z === 0) return

  const margin = Math.max(1, Math.round(Math.max(x, z) * 0.15))
  const from = -margin
  const toX = x + margin
  const toZ = z + margin

  // Enough lines to read as a plane, few enough to stay quiet behind the model.
  const lines = 6
  const stepX = (toX - from) / lines
  const stepZ = (toZ - from) / lines

  context.strokeStyle = getComputedStyle(context.canvas).color
  context.globalAlpha = 0.16
  context.lineWidth = 1
  context.beginPath()

  for (let index = 0; index <= lines; index += 1) {
    const alongX = from + index * stepX
    const alongZ = from + index * stepZ

    const [ax, ay] = project(alongX, 0, from)
    const [bx, by] = project(alongX, 0, toZ)
    context.moveTo(ax, ay)
    context.lineTo(bx, by)

    const [cx, cy] = project(from, 0, alongZ)
    const [dx, dy] = project(toX, 0, alongZ)
    context.moveTo(cx, cy)
    context.lineTo(dx, dy)
  }

  context.stroke()
  context.globalAlpha = 1
}

function draw() {
  const element = canvas.value
  const shape = props.shape
  if (!element) return

  const context = element.getContext('2d')
  if (!context) return

  // Backed by the device's pixels rather than CSS ones, or the cubes come out soft on any screen
  // that is not exactly 1x.
  const ratio = window.devicePixelRatio || 1
  const width = element.clientWidth
  const height = element.clientHeight
  if (element.width !== width * ratio || element.height !== height * ratio) {
    element.width = width * ratio
    element.height = height * ratio
  }

  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)
  if (!shape || shape.count === 0) return

  const rotate = rotation(yaw.value, clampPitch(pitch.value))
  const order = drawOrder(rotate)

  // Fitted from the model's own corners, so turning it never crops it. Computed here rather than
  // per voxel: the extent of the whole grid is what the scale has to satisfy.
  const corners = CORNERS.map(([fx, fy, fz]) =>
    rotate({ x: fx * size.value.x, y: fy * size.value.y, z: fz * size.value.z }),
  )
  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => -corner.y)
  const spanX = Math.max(...xs) - Math.min(...xs) || 1
  const spanY = Math.max(...ys) - Math.min(...ys) || 1

  const padding = 16
  const scale =
    Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY) * clampZoom(zoom.value)
  const offsetX = (width - (Math.max(...xs) + Math.min(...xs)) * scale) / 2
  const offsetY = (height - (Math.max(...ys) + Math.min(...ys)) * scale) / 2

  const voxels = data.value

  // Which of the six directions can face a camera at all. Constant for the frame, so it is one
  // calculation rather than fifty thousand: the old loop asked per voxel, and each ask rotated six
  // normals into six fresh objects — three hundred thousand allocations a frame, for one number.
  const facing = visibleFaces(0b111111, rotate)

  // The corner offsets, projected and scaled once. Every cube is the same shape in view space and
  // differs only in where it sits, so this is the whole of the per-cube geometry — and as plain
  // numbers, because a pair of arrays costs nothing to read and an array of objects costs a chase.
  const cornerX = new Float64Array(8)
  const cornerY = new Float64Array(8)
  CORNERS.forEach(([fx, fy, fz], index) => {
    const point = rotate({ x: fx, y: fy, z: fz })
    cornerX[index] = point.x * scale
    cornerY[index] = -point.y * scale
  })

  // The rotation as six scalars, so the inner loop multiplies numbers instead of allocating a
  // vector per voxel.
  const pitched = clampPitch(pitch.value)
  const cosYaw = Math.cos(yaw.value)
  const sinYaw = Math.sin(yaw.value)
  const cosPitch = Math.cos(pitched)
  const sinPitch = Math.sin(pitched)

  /** One point of the model's own grid, on screen. */
  const project = (x: number, y: number, z: number): [number, number] => {
    const rx = x * cosYaw + z * sinYaw
    const rz = -x * sinYaw + z * cosYaw
    const ry = y * cosPitch - rz * sinPitch
    return [rx * scale + offsetX, -ry * scale + offsetY]
  }

  context.lineWidth = 0
  context.globalAlpha = 1

  // One fill per *run* of faces that share a colour, not one per face.
  //
  // A canvas state change is expensive and a path submission more so; the old loop did both for
  // every face, which on a real model is a few hundred thousand of each. Faces of one colour cannot
  // obscure each other in a way anybody can see, so they are accumulated into a single path and
  // filled together — and the run is flushed the moment the colour changes, which is what keeps the
  // painter's order between *different* colours exact.
  //
  // Safe under the nonzero fill rule because every face here is turned towards the camera, and
  // consistently wound faces seen from the front project with consistent winding — so overlapping
  // subpaths reinforce rather than cancel.
  const swatches = colours.value
  let openFill = ''
  let open = false

  const flush = () => {
    if (!open) return
    context.fill()
    open = false
  }

  // The ground the model stands on, drawn before it and therefore behind it.
  //
  // Shading alone says which face is the top; it does not say where the *bottom* is, and a model
  // floating in an empty frame gives an operator nothing to be oriented against. A grid at the
  // model's base is the cheapest thing that does: five lines each way, and suddenly the picture has
  // a floor and a horizon.
  drawGround(context, project)

  const octant = octantOf(order)
  const walk = orders.value[octant] ?? build(octant)

  for (const at of walk) {
    const exposed = voxels[at + 3]!
    const faces = exposed & facing
    if (faces === 0) continue

    const x = voxels[at]!
    const y = voxels[at + 1]!
    const z = voxels[at + 2]!

    // The projection, inlined. Yaw about the vertical axis, then pitch about the horizontal one —
    // the same arithmetic `box3d.rotation` does, written out so it allocates nothing.
    const rx = x * cosYaw + z * sinYaw
    const rz = -x * sinYaw + z * cosYaw
    const ry = y * cosPitch - rz * sinPitch

    const baseX = rx * scale + offsetX
    const baseY = -ry * scale + offsetY

    const colour = swatches[voxels[at + 4]!] ?? swatches[0]!

    for (let bit = 0; bit < 6; bit += 1) {
      if ((faces & (1 << bit)) === 0) continue

      // Shade rides on the colour rather than on globalAlpha, so a run of one material and one
      // face direction is a single fill with no state change inside it at all.
      const fill = shaded(colour, FACE_SHADES[bit]!)
      if (fill !== openFill) {
        flush()
        context.fillStyle = fill
        context.beginPath()
        openFill = fill
        open = true
      }

      const face = FACE_CORNERS[bit]!
      context.moveTo(baseX + cornerX[face[0]!]!, baseY + cornerY[face[0]!]!)
      context.lineTo(baseX + cornerX[face[1]!]!, baseY + cornerY[face[1]!]!)
      context.lineTo(baseX + cornerX[face[2]!]!, baseY + cornerY[face[2]!]!)
      context.lineTo(baseX + cornerX[face[3]!]!, baseY + cornerY[face[3]!]!)
      context.closePath()
    }
  }

  flush()
}

let frame = 0

/** Coalesced to one paint per frame: a drag fires far more pointer events than the screen refreshes. */
function schedule() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    draw()
  })
}

watch([() => props.shape, yaw, pitch, zoom], schedule)

let observer: ResizeObserver | null = null

onMounted(() => {
  draw()
  observer = new ResizeObserver(schedule)
  if (canvas.value) observer.observe(canvas.value)
})

onUnmounted(() => {
  observer?.disconnect()
  if (frame) cancelAnimationFrame(frame)
})

const SENSITIVITY = 0.009
const STEP = 0.12

let dragging: number | null = null
let lastX = 0
let lastY = 0

function onPointerDown(event: PointerEvent) {
  dragging = event.pointerId
  lastX = event.clientX
  lastY = event.clientY
  ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  if (dragging !== event.pointerId) return

  yaw.value += (event.clientX - lastX) * SENSITIVITY
  // Dragging down raises the camera rather than lowering it, so the gesture reads as taking hold
  // of the model and rolling its top towards you. This used to be the other way round while the
  // arrow keys did it this way, which is why the control felt inverted on and off.
  pitch.value = clampPitch(pitch.value - (event.clientY - lastY) * SENSITIVITY)
  lastX = event.clientX
  lastY = event.clientY
}

function onPointerUp(event: PointerEvent) {
  if (dragging !== event.pointerId) return
  dragging = null
  ;(event.currentTarget as Element).releasePointerCapture(event.pointerId)
}

function onKeydown(event: KeyboardEvent) {
  const turn: Record<string, () => void> = {
    ArrowLeft: () => (yaw.value -= STEP),
    ArrowRight: () => (yaw.value += STEP),
    ArrowUp: () => (pitch.value = clampPitch(pitch.value - STEP)),
    ArrowDown: () => (pitch.value = clampPitch(pitch.value + STEP)),
  }
  const move = turn[event.key]
  if (!move) return

  event.preventDefault()
  move()
}

function onWheel(event: WheelEvent) {
  event.preventDefault()
  zoom.value = clampZoom(zoom.value * (event.deltaY < 0 ? 1.12 : 1 / 1.12))
}

function reset() {
  yaw.value = START_YAW
  pitch.value = START_PITCH
  zoom.value = 1
}

/** What the picture says for anyone not looking at it: the size, not the angle. */
const described = computed(() =>
  props.shape
    ? t('schematics.shapeOf', {
        x: props.shape.sizeX * props.shape.voxelSize,
        y: props.shape.sizeY * props.shape.voxelSize,
        z: props.shape.sizeZ * props.shape.voxelSize,
      })
    : '',
)
</script>

<template>
  <div class="border-base-300 bg-base-100 relative overflow-hidden rounded-lg border">
    <div class="absolute top-2 right-2 z-10 flex gap-1">
      <button
        type="button"
        class="btn btn-xs btn-ghost"
        :aria-label="t('operations.zoomOut')"
        @click="zoom = clampZoom(zoom / 1.3)"
      >
        <Minus class="size-3.5" />
      </button>
      <button
        type="button"
        class="btn btn-xs btn-ghost"
        :aria-label="t('operations.zoomIn')"
        @click="zoom = clampZoom(zoom * 1.3)"
      >
        <Plus class="size-3.5" />
      </button>
      <button
        type="button"
        class="btn btn-xs btn-ghost"
        :aria-label="t('operations.resetView')"
        @click="reset"
      >
        <RotateCcw class="size-3.5" />
      </button>
    </div>

    <canvas
      ref="canvas"
      class="text-primary h-[26rem] w-full touch-none select-none"
      :class="shape?.count ? 'cursor-grab active:cursor-grabbing' : ''"
      role="img"
      tabindex="0"
      :aria-label="described"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onKeydown"
      @wheel="onWheel"
    ></canvas>
  </div>
</template>
