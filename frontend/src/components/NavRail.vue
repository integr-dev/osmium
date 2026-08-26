<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

/**
 * A group of sidebar rows, and the one green rule that marks the active one — travelling between
 * them rather than appearing at the new row and vanishing from the old.
 *
 * **Why this is a component and not a pseudo-element.** The mark used to be a `::before` on
 * whichever row was active, which cannot move: the old row's is destroyed the instant the route
 * changes and the new row's is created somewhere else, so what an operator sees is two lines rather
 * than one. Same problem daisyUI's tab underline has, and the same answer — see `TabBar.vue`. A
 * mark that travels has to be a single element outside the rows, measured against whichever one is
 * active.
 *
 * **One of these per group, not one for the sidebar.** The fleet and the host list each scroll
 * inside their own box, so a marker pinned to the sidebar would sit still while the list it points
 * into scrolled underneath it. Sitting inside the group means it scrolls with the rows, and a group
 * that collapses takes its marker with it. Crossing from one group to another is the one move that
 * still reads as a fade, which is the honest picture: those rows are not in the same list.
 */
const route = useRoute()

const group = ref<HTMLElement | null>(null)
const marker = ref<HTMLElement | null>(null)

/**
 * Whether the mark is currently on a row in this group.
 *
 * Not reactive: nothing renders from it. It decides one thing — whether the next placement slides
 * or snaps — and a marker arriving in a group it was not in has nowhere to slide *from*, so it is
 * put where it belongs with the transition suppressed for that frame and only fades in.
 */
let here = false
let frame = 0

/**
 * Measured off the boxes rather than `offsetTop`, for the reason spelled out in `TabBar.vue`: an
 * absolutely positioned child is placed against its container's padding box while `offsetTop` is
 * measured from the border box, and the two differ by however much border the container has.
 *
 * Written straight onto the element instead of through a bound style, because the snap needs the
 * position and the suppressed transition applied in the *same* frame — a reactive style lands a
 * tick later, by which time there is nothing left to suppress.
 */
function measure(): void {
  const container = group.value
  const bar = marker.value
  if (!container || !bar) return

  const active = container.querySelector<HTMLElement>('.router-link-active, .menu-active')
  if (!active) {
    // Faded where it stands rather than moved off. Nothing here is about to be active, and a line
    // sliding away to a row it was never on says something that did not happen.
    bar.style.opacity = '0'
    here = false
    return
  }

  const strut = container.getBoundingClientRect()
  const box = active.getBoundingClientRect()

  if (!here) bar.style.transition = 'none'
  bar.style.translate = `0 ${box.top - strut.top - container.clientTop}px`
  bar.style.height = `${box.height}px`
  if (!here) {
    void bar.offsetHeight
    bar.style.transition = ''
  }

  bar.style.opacity = '1'
  here = true
}

/**
 * Every trigger lands here rather than measuring directly. A disclosure opening reports a new size
 * on every frame of its animation and a list re-rendering can report several in one, and the marker
 * only ever needs the last of them.
 */
function schedule(): void {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(measure)
}

watch(() => route.fullPath, schedule)

let sizes: ResizeObserver | null = null
let rows: MutationObserver | null = null

onMounted(() => {
  schedule()

  // A web font landing after the first paint changes the height of every row under the marker.
  void document.fonts?.ready.then(schedule)

  // The sidebar dragged wider, a disclosure opening, an agent joining the fleet: each moves the
  // rows with nothing in the route having changed.
  sizes = new ResizeObserver(schedule)
  if (group.value) sizes.observe(group.value)

  // Not everything marked here is a link. The chat toggle wears `menu-active` while its panel is
  // open, which no route reports — so the classes themselves are watched. Only `class`, which is
  // what keeps the marker's own inline styles from feeding back into this.
  rows = new MutationObserver(schedule)
  if (group.value) {
    rows.observe(group.value, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    })
  }
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  sizes?.disconnect()
  rows?.disconnect()
})
</script>

<template>
  <div ref="group" class="relative">
    <span ref="marker" aria-hidden="true" class="osmium-nav-marker"></span>
    <slot />
  </div>
</template>
