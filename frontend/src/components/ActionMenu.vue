<script setup lang="ts">
import { ref } from 'vue'

/**
 * A small panel of what can be done to whatever was just clicked.
 *
 * **Grown out of the inventory rather than invented beside it.** This started as the panel that
 * floats under an inventory square, and the map and the 3D view turned out to ask the same question
 * about a different subject: this thing here, then what? Three shapes of that answer would be three
 * things to learn, so the chrome is here and each caller brings its own buttons.
 *
 * Two placements, because there are two kinds of subject. A square in a grid is an element, and a
 * panel about it belongs under it; a point on a map is not an element at all, and a panel about it
 * belongs where the pointer was.
 */
withDefaults(
  defineProps<{
    /** What the panel is about, on its first line. */
    title: string
    /** A second line, smaller: the detail that makes the title unambiguous. */
    note?: string
    /**
     * `under` hangs it below the element it is rendered inside, which is what an inventory square
     * wants. `at` puts its point at {@link x}, {@link y} in the nearest positioned ancestor.
     */
    placement?: 'under' | 'at'
    x?: number
    y?: number
  }>(),
  { placement: 'under' },
)

/**
 * The panel itself, for whoever has to know whether a click landed inside it.
 *
 * **Exposed rather than guarded here with `stopPropagation`.** A panel is dismissed by a listener on
 * the document, in the capture phase - which is the only way to see the clicks that never reach this
 * component at all. Capture runs top-down *before* anything here, so stopping propagation on the way
 * back up is too late to matter, and a click on a button in this panel closed it before the button
 * did anything. Asking `composedPath` is what the inventory grid already does, and for the same
 * reason: it survives a click on something the click itself removes.
 */
const root = ref<HTMLElement | null>(null)

defineExpose({ root })
</script>

<template>
  <!--
    `w-max` because the labels decide the width. Neither an inventory square nor a pixel on a map is
    anywhere near wide enough to lay them out in.
  -->
  <div
    ref="root"
    class="border-base-300 bg-base-100 absolute z-20 flex w-max -translate-x-1/2 flex-col gap-1 rounded-box border p-1.5 shadow-lg"
    :class="placement === 'under' ? 'top-full left-1/2 mt-1.5' : ''"
    :style="placement === 'at' ? { left: `${x ?? 0}px`, top: `${y ?? 0}px` } : undefined"
    role="group"
    :aria-label="title"
  >
    <span class="truncate px-1 text-xs font-medium">{{ title }}</span>
    <span v-if="note" class="text-base-content/60 px-1 font-mono text-[0.65rem] tabular-nums">{{ note }}</span>

    <slot />

    <!-- For whatever a caller has to say that is not a button. The inventory says how to move. -->
    <slot name="footer" />
  </div>
</template>
