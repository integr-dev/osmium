<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * The frame a panel is swapped inside, which eases to the height of whatever arrives.
 *
 * A panel on its way out is taken out of the flow so the one arriving can set the height — see the
 * `panel-*` keyframes — and that height therefore lands on the frame the new panel appears in,
 * while the panel itself is still sliding. Anything below the swap, a wizard's Back and Next among
 * it, jumps to meet it. The movement was right and the room it moved in was not.
 *
 * **A height of `auto` cannot be transitioned by content changing under it**, even with
 * `interpolate-size`: a transition fires on a computed value changing, and `auto` stays `auto` no
 * matter what is inside. The height has to be a number, which means measuring — so the content is
 * measured as it changes and the frame is told, in pixels, what to ease to.
 */
const inner = ref<HTMLElement | null>(null)
const height = ref<number | null>(null)

/**
 * Clipped only while the height is moving.
 *
 * A panel taller than the frame it is growing into would otherwise reach over whatever is below for
 * the length of the transition. Clipping it permanently is not an option: the panels hold pickers
 * and menus that open past their own edges.
 */
const busy = ref(false)

let observer: ResizeObserver | null = null

onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    const measured = entry?.borderBoxSize?.[0]?.blockSize ?? inner.value?.offsetHeight
    if (measured === undefined) return

    // The first measurement is the frame's starting size, not a change to animate towards.
    busy.value = height.value !== null && Math.round(measured) !== Math.round(height.value)
    height.value = measured
  })

  if (inner.value) observer.observe(inner.value)
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div
    class="osmium-swap"
    :class="busy ? 'osmium-swap-busy' : ''"
    :style="height === null ? undefined : { height: `${height}px` }"
    @transitionend="busy = false"
  >
    <!--
      Positioned, because this is what a leaving panel is taken out of the flow against — and
      clipped across, because a step arriving from the side is briefly past the edge of the page.
    -->
    <div ref="inner" class="osmium-slide">
      <slot />
    </div>
  </div>
</template>
