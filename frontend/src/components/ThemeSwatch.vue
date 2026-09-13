<script setup lang="ts">
import { computed } from 'vue'
import { SYSTEM_THEMES, type ThemeChoice, type ThemeId } from '../lib/theme'

/**
 * A theme drawn small: its sidebar, its page, its fleet colour and its text.
 *
 * **Drawn by the theme itself, not from a copy of its colours.** Each half carries `data-theme`, so
 * daisyUI resolves every class inside it against that theme's block - the preview is the real
 * palette at thumbnail size and cannot drift from the stylesheet. System is the pair it switches
 * between, light beside dark.
 */
const props = defineProps<{ choice: ThemeChoice }>()

const halves = computed<ThemeId[]>(() =>
  props.choice === 'system' ? [SYSTEM_THEMES.light, SYSTEM_THEMES.dark] : [props.choice],
)
</script>

<template>
  <span class="border-base-content/20 flex h-6 w-11 shrink-0 overflow-hidden rounded-sm border" aria-hidden="true">
    <span v-for="id in halves" :key="id" :data-theme="id" class="bg-base-100 flex flex-1">
      <span class="bg-base-200 w-1/3" />
      <span class="flex flex-1 flex-col justify-center gap-0.5 px-1">
        <span class="flex gap-0.5">
          <span class="bg-primary size-1.5 rounded-full" />
          <span v-if="halves.length === 1" class="bg-accent size-1.5 rounded-full" />
          <span v-if="halves.length === 1" class="bg-error size-1.5 rounded-full" />
        </span>
        <span class="bg-base-content/70 h-0.5 w-full rounded-full" />
      </span>
    </span>
  </span>
</template>
