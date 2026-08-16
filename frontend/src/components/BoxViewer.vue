<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Minus, Plus, RotateCcw } from 'lucide-vue-next'
import { clampPitch, clampZoom, DEFAULT_PITCH, DEFAULT_YAW, project, type Box } from '../lib/box3d'

/**
 * An axis-aligned box, or several, that the operator can turn around.
 *
 * Used twice: once for the schematic as placed, and once for the segments a split produced. They
 * are the same picture with a different number of boxes, so they are the same component — a split
 * that looked unlike the thing it divided would be harder to read, not easier.
 *
 * SVG rather than a 3D renderer. See `src/lib/box3d.ts` for why; the short version is that labels
 * stay screen-aligned for free, depth order is exact for disjoint boxes, and the geometry stays
 * testable.
 */
const props = withDefaults(
  defineProps<{
    boxes: Box[]
    /** The eight corner coordinates. On for one box, off for a split — 8 per segment is noise. */
    corners?: boolean
  }>(),
  { corners: false },
)

const { t, n } = useI18n()

/**
 * A logical viewport the SVG scales from, rather than measuring the element.
 *
 * The alternative is a ResizeObserver feeding a reactive width into the projection, which
 * reprojects every box on every pixel of a window drag. Nothing here needs to know its own size in
 * pixels: the geometry is fitted to this box, and the browser scales the result.
 */
const WIDTH = 640
const HEIGHT = 440

/** Turned a little off-axis to start, so the first look already reads as three dimensions. */
const START_YAW = DEFAULT_YAW
const START_PITCH = DEFAULT_PITCH

const yaw = ref(START_YAW)
const pitch = ref(START_PITCH)
const zoom = ref(1)

const scene = computed(() =>
  project(props.boxes, {
    yaw: yaw.value,
    pitch: pitch.value,
    zoom: zoom.value,
    width: WIDTH,
    height: HEIGHT,
  }),
)

/**
 * Only the two extreme corners are labelled, not all eight.
 *
 * Eight coordinates on a box that can be turned edge-on is a pile of overlapping text, and it is
 * text nobody reads: the numbers an operator wants are the corner they place from and the corner
 * it reaches to. The other six are derivable from those two and the axis lengths already shown.
 */
const labelled = computed(() => {
  if (!props.corners || scene.value.boxes.length !== 1) return []

  const corners = scene.value.boxes[0].corners
  const extent = (corner: (typeof corners)[number]) =>
    corner.world.x + corner.world.y + corner.world.z

  const sorted = [...corners].sort((a, b) => extent(a) - extent(b))
  return [sorted[0], sorted[sorted.length - 1]]
})

function reset() {
  yaw.value = START_YAW
  pitch.value = START_PITCH
  zoom.value = 1
}

function onWheel(event: WheelEvent) {
  // Only once it has focus or is being pointed at deliberately — a page scrolled past a viewer
  // that swallowed the wheel would be stuck on it.
  event.preventDefault()
  zoom.value = clampZoom(zoom.value * (event.deltaY < 0 ? 1.12 : 1 / 1.12))
}

/** Radians per pixel dragged. A full turn in about the width of the picture. */
const SENSITIVITY = 0.009
const STEP = 0.12

let dragging: number | null = null
let lastX = 0
let lastY = 0

function onPointerDown(event: PointerEvent) {
  dragging = event.pointerId
  lastX = event.clientX
  lastY = event.clientY
  // Capture, so a drag that leaves the picture keeps turning it rather than stopping dead at the
  // edge — which reads as the control having broken.
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

/** The same rotation from the keyboard: a drag-only control is one some operators cannot use. */
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

/**
 * What the picture says, for anyone not looking at it. The dimensions rather than the rotation:
 * the angle is a way of looking, the size is the information.
 */
const described = computed(() =>
  props.boxes
    .map((box) =>
      t('operations.boxSize', {
        name: box.label ?? '',
        x: box.max.x - box.min.x,
        y: box.max.y - box.min.y,
        z: box.max.z - box.min.z,
      }),
    )
    .join('. '),
)

const axisLabel: Record<string, string> = { x: 'X', y: 'Y', z: 'Z' }
</script>

<template>
  <div class="border-base-300 bg-base-100 relative overflow-hidden rounded-lg border">
    <!--
      Controls sit over the picture rather than beside it: the picture is the thing, and a row of
      buttons under it pushes everything below further from the shape they describe.
    -->
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
      <!-- Turning a box to an angle that shows nothing is easy, and finding the way back is not. -->
      <button
        type="button"
        class="btn btn-xs btn-ghost"
        :aria-label="t('operations.resetView')"
        @click="reset"
      >
        <RotateCcw class="size-3.5" />
      </button>
    </div>

    <!--
      Height capped. An SVG given a width takes whatever height its aspect asks for, and in a wide
      column that is six hundred pixels of picture with everything else on the step below the fold.
      The viewBox letterboxes inside whatever it is given, so the shape is unharmed by the clamp.
    -->
    <svg
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      class="max-h-[26rem] w-full touch-none select-none"
      :class="boxes.length ? 'cursor-grab active:cursor-grabbing' : ''"
      role="img"
      tabindex="0"
      :aria-label="described"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onKeydown"
      @wheel="onWheel"
    >
    <g v-for="box in scene.boxes" :key="box.id" class="text-primary">
      <!--
        Only the faces turned towards the viewer are here at all — a box is convex, so the rest are
        hidden with certainty rather than by drawing order.
      -->
      <polygon
        v-for="(face, index) in box.faces"
        :key="index"
        :points="face.points.map((point) => `${point.x},${point.y}`).join(' ')"
        fill="currentColor"
        :fill-opacity="face.shade * 0.34"
      />

      <!-- Every edge, including the three hidden ones: a wireframe back is what makes a box read
           as a volume rather than as three shaded panels. -->
      <line
        v-for="(edge, index) in box.edges"
        :key="`edge-${index}`"
        :x1="edge.a.x"
        :y1="edge.a.y"
        :x2="edge.b.x"
        :y2="edge.b.y"
        stroke="currentColor"
        stroke-opacity="0.55"
        stroke-width="1.2"
      />

      <text
        v-for="dimension in box.dimensions"
        :key="`${box.id}-${dimension.axis}`"
        :x="dimension.at.x"
        :y="dimension.at.y"
        class="fill-base-content text-[13px] font-medium"
        text-anchor="middle"
        dominant-baseline="middle"
        fill-opacity="0.75"
      >
        {{ axisLabel[dimension.axis] }} {{ n(dimension.length) }}
      </text>

      <text
        v-if="box.label"
        :x="box.corners[6].at.x"
        :y="box.corners[6].at.y - 8"
        class="fill-base-content text-[13px] font-semibold"
        text-anchor="middle"
      >
        {{ box.label }}
      </text>
    </g>

    <!--
      Two coordinates rather than eight. The pair an operator needs is the corner they place from
      and the corner it reaches to; the rest follow from those and the axis lengths already drawn.
      Backed, because a coordinate over an edge is unreadable against the wireframe.
    -->
    <g v-for="(corner, index) in labelled" :key="`corner-${index}`">
      <rect
        :x="corner.at.x - 46"
        :y="corner.at.y - 9"
        width="92"
        height="18"
        rx="4"
        class="fill-base-100"
        fill-opacity="0.85"
      />
      <text
        :x="corner.at.x"
        :y="corner.at.y"
        class="fill-base-content text-[11px] tabular-nums"
        text-anchor="middle"
        dominant-baseline="middle"
        fill-opacity="0.7"
      >
        {{ corner.world.x }}, {{ corner.world.y }}, {{ corner.world.z }}
      </text>
    </g>
    </svg>
  </div>
</template>
