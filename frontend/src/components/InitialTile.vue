<script lang="ts">
/**
 * Shared with [PlayerHead], so an image and the tile that stands in for it are never different
 * sizes. A companion block rather than `<script setup>`, which cannot export.
 */
export const TILE_SIZES = {
  xs: 'size-4 text-[0.5rem]',
  sm: 'size-6 text-[0.625rem]',
  md: 'size-8 text-xs',
  lg: 'size-14 text-lg',
} as const

export type TileSize = keyof typeof TILE_SIZES
</script>

<script setup lang="ts">
import { computed } from 'vue'

/**
 * A square tile carrying one letter, at the size of a player head.
 *
 * Extracted from [PlayerHead], where it started life as the fallback for an agent with no skin to
 * show. The sidebar draws hosts the same way — a host has no avatar and never will, a machine not
 * being a player — and two copies of a tile this fiddly would drift the first time either was
 * touched, leaving one list a pixel off the other in a place where they sit directly above.
 *
 * Decorative. The name it stands for is always beside it, so announcing the letter as well would
 * read the same thing twice.
 */
const props = withDefaults(
  defineProps<{
    /** What the letter is taken from. The visible label, not an internal identifier. */
    name?: string | null
    size?: TileSize
  }>(),
  { name: null, size: 'sm' },
)

const initial = computed(() => (props.name ?? '?').trim().charAt(0).toUpperCase() || '?')
</script>

<template>
  <span
    :class="TILE_SIZES[size]"
    class="rounded-selector bg-base-300 text-base-content/50 flex shrink-0 items-center justify-center font-semibold"
    aria-hidden="true"
  >
    {{ initial }}
  </span>
</template>
