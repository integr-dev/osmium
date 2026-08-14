<script setup lang="ts">
import { computed } from 'vue'
import type { HourBucket } from '../lib/series'

/**
 * Incidents per hour, from the activity already loaded.
 *
 * Bars rather than a line: these are counts in discrete buckets, and a line between them would
 * suggest a value at 14:30 that nothing measured. Rounded data-ends, anchored to the baseline, with
 * a real gap between bars rather than a stroke — the gap is the surface showing through.
 *
 * One series, so no legend: the heading names it. Each bar carries its own `<title>`, which is the
 * hover layer a chart this small can afford.
 */
const props = defineProps<{ buckets: HourBucket[]; emptyLabel: string }>()

const BAR = 8
const GAP = 2
const HEIGHT = 40

const width = computed(() => Math.max(1, props.buckets.length) * (BAR + GAP) - GAP)
const peak = computed(() => Math.max(1, ...props.buckets.map((bucket) => bucket.count)))

const bars = computed(() =>
  props.buckets.map((bucket, index) => {
    // A bucket with something in it never renders as nothing: a 2px stub says "one" where a
    // proportional height would round it away to an empty slot.
    const height = bucket.count === 0 ? 0 : Math.max(2, (bucket.count / peak.value) * HEIGHT)
    return {
      ...bucket,
      x: index * (BAR + GAP),
      y: HEIGHT - height,
      height,
      hour: new Date(bucket.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    }
  }),
)
</script>

<template>
  <svg
    v-if="bars.length"
    class="h-14 w-full"
    :viewBox="`0 0 ${width} ${HEIGHT}`"
    preserveAspectRatio="none"
    role="img"
  >
    <g v-for="bar in bars" :key="bar.at">
      <!-- The empty hours are drawn too, faintly: a gap in the row is a fact, not a missing bar. -->
      <rect
        :x="bar.x"
        :y="HEIGHT - 2"
        :width="BAR"
        height="2"
        rx="1"
        class="fill-base-content"
        opacity="0.12"
      />
      <rect
        v-if="bar.height"
        :x="bar.x"
        :y="bar.y"
        :width="BAR"
        :height="bar.height"
        rx="2"
        class="fill-primary"
      >
        <title>{{ bar.hour }} · {{ bar.count }}</title>
      </rect>
    </g>
  </svg>

  <p v-else class="py-4 text-center text-sm opacity-50">{{ emptyLabel }}</p>
</template>
