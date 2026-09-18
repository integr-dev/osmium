<script setup lang="ts">
import { computed } from 'vue'
import { CheckCheck, Info, TriangleAlert } from 'lucide-vue-next'

/**
 * Something said back to the operator in place: a failure, a warning, a confirmation.
 *
 * **One shape, because they were fifty.** Every screen wrote its own — and they had drifted: an
 * error with a triangle here and a circle there, one with no icon at all, half of them with a
 * shrinking icon that squeezed against wrapping text.
 *
 * `kind` decides the icon and the ARIA role together, which is the part that was quietly wrong in
 * several places. `alert` interrupts a screen reader and is right for a failure or a warning;
 * something that merely went well is `status`, which waits its turn.
 *
 * The message can be a prop or the slot. The slot is for the few that carry a control — the
 * dashboard's dismissible notice — and everything else passes the string.
 *
 * `title` is the second shape these come in: a line naming what happened over a line explaining it,
 * which the layout's two banners and the agent page's pending notice each wrote out by hand. A
 * titled note aligns to the top, because two lines beside a centred icon look like a mistake.
 */
const props = defineProps<{
  kind: 'error' | 'warning' | 'info' | 'success'
  message?: string | null
  /** A line above the message, for a notice that has to name itself before it explains. */
  title?: string
  /** An icon of the note's own, where the default says less than the subject does. */
  icon?: unknown
}>()

const TONE = {
  error: 'alert-error',
  warning: 'alert-warning',
  info: 'alert-info',
  success: 'alert-success',
} as const

const ICON = { error: TriangleAlert, warning: TriangleAlert, info: Info, success: CheckCheck }

const mark = computed(() => props.icon ?? ICON[props.kind])
</script>

<template>
  <div
    :role="kind === 'error' || kind === 'warning' ? 'alert' : 'status'"
    class="alert alert-soft"
    :class="[TONE[kind], title ? 'items-start' : '']"
  >
    <component :is="mark" class="size-4 shrink-0" :class="title ? 'mt-0.5' : ''" />
    <span class="min-w-0 flex-1">
      <span v-if="title" class="block font-medium">{{ title }}</span>
      <span :class="title ? 'block text-sm opacity-80' : ''"><slot>{{ message }}</slot></span>
    </span>
    <slot name="action" />
  </div>
</template>
