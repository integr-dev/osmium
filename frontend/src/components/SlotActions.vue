<script setup lang="ts">
import { Hand, Trash2 } from 'lucide-vue-next'
import { t } from '../i18n'
import ActionMenu from './ActionMenu.vue'
import type { InventorySlotResponse } from '../api/client'

/**
 * What can be done with one square, floating over the square it belongs to.
 *
 * Over it rather than in a row under the grid, which is where this started: a strip at the bottom
 * of the card is a long way from the square somebody just clicked, and on a thirty-six square grid
 * it is not obvious which one it is about. Anchored to the square, the answer to "which slot?" is
 * where the panel is.
 *
 * The panel itself is {@link ActionMenu}, which the map and the 3D view also open. What is left here
 * is what is true of a square and of nothing else.
 */
defineProps<{
  /** What is in the square, or nothing — an empty hotbar square can still be put in hand. */
  item?: InventorySlotResponse
  /** Whether this square is one of the nine the agent can hold. */
  holdable?: boolean
  /** Whether the agent is already holding it, in which case there is nothing to change. */
  held?: boolean
  /** A command is in flight. */
  busy?: boolean
}>()

defineEmits<{
  hold: []
  dropOne: []
  dropStack: []
}>()
</script>

<template>
  <ActionMenu :title="item ? item.displayName : t('inventory.empty')">
    <button
      v-if="holdable && !held"
      type="button"
      class="btn btn-soft btn-warning btn-xs justify-start gap-1.5"
      :disabled="busy"
      @click="$emit('hold')"
    >
      <Hand class="size-3" />
      {{ t('inventory.hold') }}
    </button>

    <template v-if="item">
      <button
        type="button"
        class="btn btn-soft btn-xs justify-start gap-1.5"
        :disabled="busy"
        @click="$emit('dropOne')"
      >
        <Trash2 class="size-3" />
        {{ t('inventory.dropOne') }}
      </button>
      <button
        v-if="item.count > 1"
        type="button"
        class="btn btn-soft btn-error btn-xs justify-start gap-1.5"
        :disabled="busy"
        @click="$emit('dropStack')"
      >
        <Trash2 class="size-3" />
        {{ t('inventory.dropStack') }}
      </button>
    </template>

    <!--
      Said here rather than in a tooltip, because it is the one thing the panel cannot offer: moving
      is a drag, and somebody who has just clicked a square is exactly the person who does not know
      that yet.
    -->
    <template #footer>
      <span class="text-base-content/50 max-w-40 px-1 text-[0.65rem] leading-tight">
        {{ t('inventory.dragToMove') }}
      </span>
    </template>
  </ActionMenu>
</template>
