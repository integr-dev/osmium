<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { prefersReducedMotion } from '../lib/motion'

/**
 * A number that travels to its new value instead of jumping to it.
 *
 * Only for headline figures that move on their own — the ones a live stream changes while nobody is
 * looking. A number that only ever changes because the operator did something does not need this;
 * they already know.
 *
 * The first value is never animated. Counting up from zero on page load would be an animation about
 * nothing, and it would make an already-loaded figure look like it was still loading.
 */
const props = withDefaults(defineProps<{ value: number; duration?: number }>(), { duration: 500 })

const shown = ref(props.value)
let frame = 0

watch(
  () => props.value,
  (to, from) => {
    cancelAnimationFrame(frame)
    if (prefersReducedMotion()) {
      shown.value = to
      return
    }

    const start = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / props.duration)
      // Ease out: most of the distance early, so the figure reads as settling rather than sliding.
      shown.value = Math.round(from + (to - from) * (1 - (1 - progress) ** 3))
      if (progress < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
  },
)

onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>

<template>
  <!-- Tabular figures: without them the whole line jitters as the digits change width. -->
  <span class="tabular-nums">{{ shown.toLocaleString() }}</span>
</template>
