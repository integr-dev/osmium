<script setup lang="ts">
import { schematicField } from '../lib/schematic'

/**
 * The sign-in screen's backdrop: a disc of blocks placing itself, block by block, forever.
 *
 * Decorative and marked so — it carries no information, and nothing on the page depends on it. It
 * is here because the login screen is the one page with nothing to show, and what Osmium does is
 * place blocks; a field that assembles itself says that without a line of copy.
 *
 * Drawn once and animated in CSS. The alternative is a canvas and a frame loop, which would keep a
 * timer running behind a page whose whole purpose is to be left as soon as possible.
 */

/**
 * One pass of build-and-clear. Long enough that a glance never catches the field mid-change, which
 * is what keeps it a texture rather than something the eye tracks while somebody is typing a
 * password.
 */
const LOOP_SECONDS = 42

/**
 * The disc is sized to overrun the page rather than to sit on it, so `radius` is a block count as
 * much as a length: it and `size` together set how many blocks land across the screen. Twelve
 * blocks to the edge is the balance — fewer and they are slabs, more and there are enough
 * separately animated elements to be worth thinking about.
 */
const field = schematicField({ radius: 264, size: 22, stagger: LOOP_SECONDS / 4 })

/** The three faces, unshaded. A light source implied rather than drawn, which is enough here. */
const FACE = { top: 0.15, left: 0.1, right: 0.055 }
</script>

<template>
  <!--
    A square of 120vmax, centred and overflowing the page on every side. The disc has to be wider
    than the screen's *diagonal* to leave no bare corner, which is about 115% of the longer edge —
    so `size-full` cannot do this however it is fitted, and neither can `slice`, which would crop
    the field to the viewport and leave the corners empty anyway.

    `meet` inside that square, so the disc stays circular rather than being stretched to whatever
    aspect the window happens to have.
  -->
  <svg
    class="text-primary pointer-events-none absolute top-1/2 left-1/2 size-[120vmax] -translate-x-1/2 -translate-y-1/2"
    :viewBox="field.viewBox"
    :style="{ '--osmium-place-loop': `${LOOP_SECONDS}s` }"
    preserveAspectRatio="xMidYMid meet"
    aria-hidden="true"
  >
    <g
      v-for="(block, index) in field.blocks"
      :key="index"
      class="osmium-place"
      :style="{ '--osmium-place-delay': `${block.delay}s` }"
      fill="currentColor"
    >
      <polygon :points="block.top" :opacity="FACE.top * block.fade" />
      <polygon :points="block.left" :opacity="FACE.left * block.fade" />
      <polygon :points="block.right" :opacity="FACE.right * block.fade" />
    </g>
  </svg>
</template>
