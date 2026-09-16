<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TimePoint } from '../lib/dashboard'
import { niceCeiling, timePath } from '../lib/series'
import { atTime } from '../lib/time'

/**
 * Lines over a fixed stretch of time, with a scale and a readout under the pointer.
 *
 * The time axis is **given**, not taken from the data: a chart showing the last hour spans the last
 * hour whether the backend has been up for six hours or six minutes, so a short history reads as
 * short rather than being stretched to fill the card.
 *
 * Drawn the way the sparklines are — a stretched viewBox with strokes held at their width by
 * `vector-effect` — and labelled in HTML over the top, where text is not stretched with it.
 */
export interface ChartSeries {
  key: string
  label: string
  /** A text colour class. The line and its wash take `currentColor`. */
  tone: string
  points: TimePoint[]
  /** A projection rather than a measurement, drawn dashed and without a wash. */
  dashed?: boolean
}

const props = defineProps<{
  series: ChartSeries[]
  from: number
  to: number
  format: (value: number) => string
  label: string
  /** Counts: the scale's top is even, so its middle label is a whole number too. */
  whole?: boolean
  /** A shorter plot, for a chart that sits above a list rather than on its own. */
  compact?: boolean
}>()

const WIDTH = 1000
const HEIGHT = 200

const ceiling = computed(() => {
  const top = niceCeiling(Math.max(0, ...props.series.flatMap((line) => line.points.map((point) => point.value))))
  return props.whole ? Math.max(2, Math.ceil(top / 2) * 2) : top
})

const lines = computed(() =>
  props.series.map((line) => ({
    ...line,
    ...timePath(line.points, props.from, props.to, ceiling.value, WIDTH, HEIGHT),
  })),
)

/** Where "now" sits, when the axis reaches past it for a projection. */
const nowAt = computed(() => {
  const now = Date.now()
  if (now >= props.to) return null
  return ((now - props.from) / (props.to - props.from)) * 100
})

const pointer = ref<number | null>(null)

function track(event: PointerEvent): void {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  pointer.value = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
}

/** Each line's value nearest the pointer, and when that was. */
const readout = computed(() => {
  if (pointer.value === null) return null
  const at = props.from + pointer.value * (props.to - props.from)
  const rows = props.series
    .map((line) => {
      const nearest = nearestTo(line.points, at)
      return nearest ? { key: line.key, label: line.label, tone: line.tone, at: nearest.at, value: nearest.value } : null
    })
    .filter((row) => row !== null)
  if (!rows.length) return null
  return { left: pointer.value * 100, time: atTime(rows[0]!.at), rows }
})

function nearestTo(points: TimePoint[], at: number): TimePoint | undefined {
  let best: TimePoint | undefined
  for (const point of points) {
    if (!best || Math.abs(point.at - at) < Math.abs(best.at - at)) best = point
  }
  // Nothing within a tenth of the axis is not a reading at that moment, only the nearest one.
  if (best && Math.abs(best.at - at) > (props.to - props.from) / 10) return undefined
  return best
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="relative" :class="compact ? 'h-24' : 'h-40'">
      <!-- Scale: the top and the middle, labelled on the left, ruled faintly across. -->
      <div class="pointer-events-none absolute inset-0">
        <div
          v-for="step in [0, 0.5, 1]"
          :key="step"
          class="absolute inset-x-0 border-t"
          :class="step === 1 ? 'border-base-content/20' : 'border-base-content/10 border-dashed'"
          :style="{ top: `${step * 100}%` }"
        ></div>
        <span class="bg-base-200 absolute top-0 left-0 -translate-y-1/2 pr-1 text-[0.65rem] tabular-nums opacity-50">
          {{ format(ceiling) }}
        </span>
        <span class="bg-base-200 absolute top-1/2 left-0 -translate-y-1/2 pr-1 text-[0.65rem] tabular-nums opacity-50">
          {{ format(ceiling / 2) }}
        </span>
        <div v-if="nowAt !== null" class="border-base-content/25 absolute inset-y-0 border-l" :style="{ left: `${nowAt}%` }"></div>
      </div>

      <svg
        class="absolute inset-0 h-full w-full overflow-visible"
        :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
        preserveAspectRatio="none"
        role="img"
        :aria-label="label"
      >
        <g v-for="line in lines" :key="line.key" :class="line.tone">
          <path v-if="!line.dashed && line.area" :d="line.area" fill="currentColor" opacity="0.1" />
          <path
            v-if="line.line"
            :d="line.line"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
            :stroke-dasharray="line.dashed ? '6 5' : undefined"
            vector-effect="non-scaling-stroke"
          />
        </g>
      </svg>

      <div
        class="absolute inset-0 cursor-crosshair"
        @pointermove="track"
        @pointerleave="pointer = null"
      >
        <template v-if="readout">
          <div class="bg-base-content/30 pointer-events-none absolute inset-y-0 w-px" :style="{ left: `${readout.left}%` }"></div>
          <div
            class="bg-base-100 border-base-300 rounded-box pointer-events-none absolute top-1 z-10 flex flex-col gap-0.5 border px-2 py-1 text-xs shadow"
            :class="readout.left > 60 ? '-translate-x-full -ml-2' : 'ml-2'"
            :style="{ left: `${readout.left}%` }"
          >
            <span class="opacity-50">{{ readout.time }}</span>
            <span v-for="row in readout.rows" :key="row.key" class="flex items-center gap-2 whitespace-nowrap">
              <span class="size-2 rounded-full bg-current" :class="row.tone"></span>
              <span class="opacity-70">{{ row.label }}</span>
              <span class="ml-auto font-medium tabular-nums">{{ format(row.value) }}</span>
            </span>
          </div>
        </template>
      </div>
    </div>

    <div class="flex justify-between text-[0.65rem] tabular-nums opacity-50">
      <span>{{ atTime(from) }}</span>
      <span>{{ atTime(to) }}</span>
    </div>
  </div>
</template>
