<script setup lang="ts">
import { computed } from 'vue'
import { areaPath, linePath, VIEW_HEIGHT, VIEW_WIDTH } from '../lib/series'

/**
 * A number's recent past, at the size of a line of text.
 *
 * One series, so there is no legend and no palette to validate — the caption above it names what it
 * is, and the mark carries no identity of its own. The line is the data; the wash under it exists to
 * give the eye a shape to read at this size, not to encode a second thing.
 *
 * Stretched to whatever width it is given (`preserveAspectRatio="none"`), with the stroke held at
 * 2px by `vector-effect` so a wide tile does not get a fat line.
 */
const props = defineProps<{ values: number[]; label: string }>()

const line = computed(() => linePath(props.values))
const area = computed(() => areaPath(props.values))

/** The shape is decorative on its own; this is what a screen reader is given instead. */
const summary = computed(() => {
  if (!props.values.length) return props.label
  return `${props.label}: ${Math.min(...props.values)}–${Math.max(...props.values)}`
})
</script>

<template>
  <svg
    v-if="line"
    class="text-primary h-8 w-full"
    :viewBox="`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`"
    preserveAspectRatio="none"
    role="img"
    :aria-label="summary"
  >
    <title>{{ summary }}</title>
    <path :d="area" fill="currentColor" opacity="0.12" />
    <path
      :d="line"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>
