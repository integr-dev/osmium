<script lang="ts">
import type { Component } from 'vue'

/**
 * One tab. `count` is shown after the label, for a strip whose tabs are lists — the one that is not
 * open still says how much is in it.
 */
export type Tab<T extends string = string> = {
  id: T
  label: string
  icon?: Component
  count?: number
}
</script>

<script setup lang="ts" generic="T extends string">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * A tab strip whose marker travels between the tabs rather than appearing under the new one.
 *
 * **The travel is the reason this is a component.** daisyUI draws the underline as a pseudo-element
 * on each tab and fades its colour, so the line vanishes here and reappears there — two lines, never
 * one moving. A marker that slides has to be a single element outside the tabs, measured against
 * whichever one is active, and that measurement is not something five screens should each be doing.
 *
 * It stayed hand-written in those five places for as long as it was a `v-for` and a class. It is not
 * that any more.
 */
const props = withDefaults(
  defineProps<{
    tabs: Tab<T>[]
    /** `border` underlines, `box` fills. daisyUI's two, and the only two this needs. */
    variant?: 'border' | 'box'
    size?: 'xs' | 'sm' | 'md'
  }>(),
  { variant: 'border', size: 'md' },
)

const current = defineModel<T>({ required: true })

const strip = ref<HTMLElement | null>(null)
const marker = ref({ x: 0, y: 0, width: 0, height: 0 })

/**
 * Off until it has been measured once.
 *
 * A marker sitting at zero and then moved would slide in from the left edge on every mount, which is
 * an animation about nothing: the tabs did not change, the screen simply arrived.
 */
const placed = ref(false)

/**
 * `data-tab` rather than a ref per button. The ids come from this application's own tab constants,
 * never from anything a user or a server names, and reading one attribute is less machinery than
 * keeping a map of elements in step with a list that permission can filter.
 *
 * **Measured off the boxes, not off `offsetLeft`.** An absolutely positioned child is placed
 * against its container's *padding* box, while `offsetLeft` is measured from the *border* box —
 * and a boxed strip has both a border and padding, so the marker sat a few pixels up and to the
 * left of the tab it was supposed to be under. `clientLeft` and `clientTop` are exactly that
 * border, so taking them off puts the two measurements in the same coordinates.
 *
 * The height and the vertical offset are read the same way rather than assumed: a filled marker
 * has to be the size of the tab it fills, whatever padding the strip's own class happens to use.
 */
function measure() {
  const container = strip.value
  const active = container?.querySelector<HTMLElement>(`[data-tab="${current.value}"]`)
  if (!container || !active) return

  const strut = container.getBoundingClientRect()
  const box = active.getBoundingClientRect()

  marker.value = {
    x: box.left - strut.left - container.clientLeft,
    y: box.top - strut.top - container.clientTop,
    width: box.width,
    height: box.height,
  }
  placed.value = true
}

/** After the DOM has the change: every number here comes off the laid-out buttons. */
async function remeasure() {
  await nextTick()
  measure()
}

watch(current, remeasure)

// Labels are translated, so their widths change when the language does — with the same tab active,
// and often within the same strip width, which an observer on the strip would not see.
watch(() => props.tabs.map((tab) => `${tab.id}:${tab.label}:${tab.count}`).join('|'), remeasure)

let observer: ResizeObserver | null = null

onMounted(() => {
  void remeasure()

  // A web font landing after the first paint changes every label width under the marker.
  void document.fonts?.ready.then(measure)

  // Wrapping, a sidebar dragged, a window resized: each moves the buttons with nothing here changing.
  observer = new ResizeObserver(() => measure())
  if (strip.value) observer.observe(strip.value)
})

onBeforeUnmount(() => observer?.disconnect())

/**
 * The underline spans the tab and sits on the bottom of the strip; the pill covers the tab
 * outright. Only the boxed one needs the vertical numbers, and it needs them exact.
 */
const style = computed(() =>
  props.variant === 'box'
    ? {
        translate: `${marker.value.x}px ${marker.value.y}px`,
        width: `${marker.value.width}px`,
        height: `${marker.value.height}px`,
      }
    : {
        translate: `${marker.value.x}px 0`,
        width: `${marker.value.width}px`,
      },
)
</script>

<template>
  <div
    ref="strip"
    role="tablist"
    class="osmium-tabs tabs relative"
    :class="[
      variant === 'box' ? 'tabs-box w-fit' : 'tabs-border',
      size === 'xs' ? 'tabs-xs' : size === 'sm' ? 'tabs-sm' : '',
    ]"
  >
    <!--
      Ahead of the tabs in the DOM so the buttons paint over it. Both are positioned and neither
      carries a stacking order, which leaves document order to decide.
    -->
    <span
      aria-hidden="true"
      class="osmium-tab-marker"
      :class="[
        variant === 'box' ? 'osmium-tab-marker-pill' : 'osmium-tab-marker-line',
        placed ? '' : 'osmium-tab-marker-idle',
      ]"
      :style="style"
    ></span>

    <button
      v-for="tab in tabs"
      :key="tab.id"
      :data-tab="tab.id"
      type="button"
      role="tab"
      :aria-selected="current === tab.id"
      class="tab gap-2"
      :class="current === tab.id ? 'tab-active' : ''"
      @click="current = tab.id"
    >
      <component :is="tab.icon" v-if="tab.icon" class="size-4" />
      {{ tab.label }}
      <span v-if="tab.count !== undefined" class="badge badge-xs tabular-nums">{{ tab.count }}</span>
    </button>
  </div>
</template>
