<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { DEFAULT_PITCH, DEFAULT_YAW, project, type Box, type Point } from '../lib/box3d'
import { sequence, type Cell, type PlacementOrder } from '../lib/placementOrder'

/**
 * What an order does, shown rather than described.
 *
 * Three nested sweeps is a paragraph to write down and a glance to watch: a small cube fills in the
 * order chosen, a numbered arrow on each axis says which way that axis runs and which sweep it is,
 * and the line through the cells shows the route — which is what makes a snaking order obvious.
 *
 * **The same projection as the box viewer** (`lib/box3d.ts`), so this reads as the same picture as
 * the split it is about, and the geometry stays testable — see `BoxViewer.vue` for the argument
 * against a 3D renderer here.
 *
 * Twenty-seven cells: the smallest cube in which three axes are visibly different, and short enough
 * that the loop is over before an operator loses interest.
 */
const props = defineProps<{ order: PlacementOrder }>()

const { t } = useI18n()

const SIDE = 3
const WIDTH = 320
const HEIGHT = 250
/** Quick enough to be over in a few seconds, slow enough to read the turns. */
const STEP_MS = 120
/** Held frames at the end, so the last cell is seen before the sweep starts again. */
const PAUSE_STEPS = 8

const cells = computed<Cell[]>(() => sequence({ x: SIDE, y: SIDE, z: SIDE }, props.order))

const head = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

/**
 * Still for an operator who has asked for less motion, with the whole sweep drawn at once: the
 * route through the cells carries the same information the animation does, so nothing is lost.
 */
const still = ref(false)

onMounted(() => {
  still.value = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  if (still.value) return

  timer = setInterval(() => {
    head.value = head.value >= cells.value.length + PAUSE_STEPS ? 0 : head.value + 1
  }, STEP_MS)
})

onBeforeUnmount(() => clearInterval(timer))

// A changed order is a different sweep; carrying on from halfway through the old one reads as a fault.
watch(
  () => props.order,
  () => (head.value = 0),
  { deep: true },
)

/**
 * The cube and the arrows in one projection.
 *
 * One call rather than two because `project` fits what it is given: projected apart, the arrows
 * would be scaled to themselves and land across the cube rather than beside it. The arrow ends are
 * degenerate boxes — a point is a box with no volume, and all this needs of them is where they land.
 */
const scene = computed(() => {
  const boxes: Box[] = cells.value.map((cell, index) => ({
    id: `c${index}`,
    min: { x: cell.x + 0.08, y: cell.y + 0.08, z: cell.z + 0.08 },
    max: { x: cell.x + 0.92, y: cell.y + 0.92, z: cell.z + 0.92 },
  }))

  const corner = -0.55
  const beyond = SIDE + 0.55
  for (const sweep of props.order.sweeps) {
    const low = { x: corner, y: corner, z: corner }
    const high = { ...low, [sweep.axis]: beyond }
    const [from, to] = sweep.towards === 1 ? [low, high] : [high, low]
    boxes.push({ id: `${sweep.axis}-from`, min: from, max: from }, { id: `${sweep.axis}-to`, min: to, max: to })
  }

  return project(boxes, { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, zoom: 1, width: WIDTH, height: HEIGHT })
})

/** Where each box landed, by id — `project` returns them furthest first, not in the order given. */
const placed = computed(() => new Map(scene.value.boxes.map((box) => [box.id, box])))

/** The middle of a cell on screen, for the route line. */
function centre(id: string): Point {
  const box = placed.value.get(id)!
  const sum = box.corners.reduce((total, corner) => ({ x: total.x + corner.at.x, y: total.y + corner.at.y }), {
    x: 0,
    y: 0,
  })
  return { x: sum.x / box.corners.length, y: sum.y / box.corners.length }
}

const reached = computed(() => (still.value ? cells.value.length : Math.min(head.value, cells.value.length)))

/**
 * Every cell in painting order, with how far back it was placed.
 *
 * The newest carries the accent and the rest settle into a quiet fill, which is what makes the
 * direction of travel readable in a single frame.
 */
const drawn = computed(() =>
  scene.value.boxes
    .filter((box) => box.id.startsWith('c'))
    .map((box) => {
      const index = Number(box.id.slice(1))
      const age = reached.value - index
      return { box, index, filled: age > 0, head: age === 1, fresh: age > 0 && age <= 3 }
    }),
)

/** The route so far, as one line through the middles of the cells. */
const route = computed(() => {
  const upTo = Math.max(reached.value, 1)
  return cells.value
    .slice(0, upTo)
    .map((_, index) => {
      const point = centre(`c${index}`)
      return `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`
    })
    .join(' ')
})

/** One numbered arrow per axis, along the edge it describes. */
const arrows = computed(() =>
  props.order.sweeps.map((sweep, place) => ({
    axis: sweep.axis,
    place: place + 1,
    from: centre(`${sweep.axis}-from`),
    to: centre(`${sweep.axis}-to`),
  })),
)

/** The arrowhead, as a triangle pointing the way the line runs. */
function tip(from: Point, to: Point): string {
  const [dx, dy] = [to.x - from.x, to.y - from.y]
  const length = Math.hypot(dx, dy) || 1
  const [ux, uy] = [dx / length, dy / length]
  const [px, py] = [-uy, ux]
  const size = 8

  const left = { x: to.x - ux * size + px * size * 0.45, y: to.y - uy * size + py * size * 0.45 }
  const right = { x: to.x - ux * size - px * size * 0.45, y: to.y - uy * size - py * size * 0.45 }
  return `${to.x},${to.y} ${left.x},${left.y} ${right.x},${right.y}`
}

/** Where the label sits: just past the head of the arrow, out of the cube's way. */
function label(from: Point, to: Point): Point {
  const [dx, dy] = [to.x - from.x, to.y - from.y]
  const length = Math.hypot(dx, dy) || 1
  return { x: to.x + (dx / length) * 12, y: to.y + (dy / length) * 12 }
}

/** Said for a screen reader, which has nothing to watch. */
const spoken = computed(() =>
  t('order.spoken', {
    sweeps: props.order.sweeps
      .map((sweep) => t(`order.axis.${sweep.axis}${sweep.towards === 1 ? 'up' : 'down'}`))
      .join(', '),
  }),
)
</script>

<template>
  <svg
    class="w-full"
    :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
    role="img"
    :aria-label="spoken"
    preserveAspectRatio="xMidYMid meet"
  >
    <title>{{ spoken }}</title>

    <!-- Cells: unplaced ones are an outline, so the cube keeps its shape while it fills. -->
    <g v-for="cell in drawn" :key="cell.box.id">
      <polygon
        v-for="(face, index) in cell.box.faces"
        :key="index"
        :points="face.points.map((point) => `${point.x},${point.y}`).join(' ')"
        :class="cell.head ? 'fill-primary' : cell.filled ? 'fill-primary/45' : 'fill-base-content/5'"
        :style="{ opacity: cell.filled ? (cell.fresh ? 1 : 0.85) * face.shade : 0.5 * face.shade }"
      />
      <polygon
        v-for="(face, index) in cell.box.faces"
        :key="`edge-${index}`"
        :points="face.points.map((point) => `${point.x},${point.y}`).join(' ')"
        fill="none"
        class="stroke-base-content/20"
        stroke-width="0.7"
      />
    </g>

    <!-- The route: the part a filled cube cannot say, and what makes a snake a snake. -->
    <path
      :d="route"
      fill="none"
      class="stroke-primary"
      stroke-width="1.6"
      stroke-linejoin="round"
      stroke-linecap="round"
      opacity="0.75"
    />

    <!-- One arrow per axis, numbered by its place in the sweep: 1 is the outermost. -->
    <g v-for="arrow in arrows" :key="arrow.axis" class="text-base-content/60">
      <line
        :x1="arrow.from.x"
        :y1="arrow.from.y"
        :x2="arrow.to.x"
        :y2="arrow.to.y"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-dasharray="4 3"
      />
      <polygon :points="tip(arrow.from, arrow.to)" fill="currentColor" />
      <text
        :x="label(arrow.from, arrow.to).x"
        :y="label(arrow.from, arrow.to).y"
        text-anchor="middle"
        dominant-baseline="middle"
        class="fill-base-content text-[10px] font-medium"
      >
        {{ arrow.place }}{{ t(`order.axisShort.${arrow.axis}`) }}
      </text>
    </g>
  </svg>
</template>
