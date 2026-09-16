<script setup lang="ts">
import { Check } from 'lucide-vue-next'

/**
 * A chip that switches something on a card: a severity in a feed, a cause in a list, a line on a
 * chart. One look for all of them, so a filter reads as a filter wherever it is.
 *
 * `active` is what the chip is doing *now* — shown, picked. `tone` is the colour of the thing it
 * stands for, as a text colour class, and it is drawn in one place that carries the state too: a
 * filled mark with a check when on, an empty ring when off. The mark is the same size either way,
 * so a chip never changes width when it is switched, and an off chip still says what colour its
 * line or its rows are.
 *
 * Off is a quiet outline rather than a faded copy of on: a faded chip reads as disabled, and these
 * are all one click from being on again.
 */
defineProps<{
  label: string
  active: boolean
  tone: string
  /** A count or a reading after the label. */
  value?: string | number | null
}>()

defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    type="button"
    class="focus-visible:outline-primary inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full border pr-2.5 pl-1 text-xs whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1"
    :class="
      active
        ? 'border-base-content/15 bg-base-300 text-base-content'
        : 'border-base-300 text-base-content/60 hover:bg-base-300/50 hover:text-base-content bg-transparent'
    "
    :aria-pressed="active"
    @click="$emit('toggle')"
  >
    <span
      class="grid size-4 shrink-0 place-items-center rounded-full border-2 border-current"
      :class="[tone, active ? 'bg-current' : '']"
      aria-hidden="true"
    >
      <Check v-if="active" class="text-base-100 size-2.5" :stroke-width="4" />
    </span>
    <span>{{ label }}</span>
    <span v-if="value !== undefined && value !== null" class="tabular-nums opacity-70">{{ value }}</span>
  </button>
</template>
