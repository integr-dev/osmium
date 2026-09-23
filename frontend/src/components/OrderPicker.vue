<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRightLeft } from 'lucide-vue-next'
import { AXES, reorder, reverse, type Axis, type PlacementOrder } from '../lib/placementOrder'

/**
 * The six controls that say what order a piece is worked in.
 *
 * **Three sweeps rather than a list of named orders.** The names multiply — bottom-up,
 * north-to-south, snaking — and the operator still cannot say the one the fourth name would have
 * been. Six controls say all of them.
 *
 * Its own component because it is asked in two places now: a build's order and an excavation's are
 * the same question with the axes pointing opposite ways, and a second copy of this would be a
 * second place for the snake toggles to disagree about what they mean.
 *
 * What it does *not* carry is which piece the order is for. A build can give one piece its own
 * order and an excavation gives one to all of them; that list belongs to whoever knows the
 * division, and this control edits whatever it is handed.
 */
const order = defineModel<PlacementOrder>({ required: true })

const { t } = useI18n()

/** The three sweeps as rows: which axis is outermost, then the next, then the innermost. */
const sweepRows = computed(() =>
  order.value.sweeps.map((sweep, place) => ({
    place,
    axis: sweep.axis,
    towards: sweep.towards,
    direction: `order.axis.${sweep.axis}${sweep.towards === 1 ? 'up' : 'down'}`,
  })),
)

function chooseAxis(place: number, axis: Axis): void {
  order.value = reorder(order.value, axis, place)
}

function turnAround(axis: Axis): void {
  order.value = reverse(order.value, axis)
}

function snake(on: boolean): void {
  // Snaking the layers only means anything while the rows snake, so turning the rows off takes it
  // with them rather than leaving a token nobody chose to be stored.
  order.value = { ...order.value, serpentine: on, snakeLayers: on && order.value.snakeLayers }
}

function snakeLayers(on: boolean): void {
  order.value = { ...order.value, snakeLayers: on }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <ol class="flex flex-col gap-2">
      <li v-for="row in sweepRows" :key="row.place" class="flex items-center gap-2">
        <span class="w-4 shrink-0 text-xs tabular-nums opacity-50">{{ row.place + 1 }}</span>
        <select
          class="select select-sm w-16 shrink-0"
          :value="row.axis"
          :aria-label="t('order.sweepAxis', { place: row.place + 1 })"
          @change="chooseAxis(row.place, ($event.target as HTMLSelectElement).value as Axis)"
        >
          <option v-for="axis in AXES" :key="axis" :value="axis">
            {{ t(`order.axisShort.${axis}`) }}
          </option>
        </select>
        <button
          type="button"
          class="btn btn-ghost btn-sm min-w-0 flex-1 justify-start font-normal"
          :title="t('order.turnAround')"
          @click="turnAround(row.axis)"
        >
          <ArrowRightLeft class="size-3.5 shrink-0 opacity-50" />
          <span class="truncate">{{ t(row.direction) }}</span>
        </button>
      </li>
    </ol>

    <label class="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        class="toggle toggle-sm"
        :checked="order.serpentine"
        @change="snake(($event.target as HTMLInputElement).checked)"
      />
      <span class="flex flex-col gap-0.5">
        <span class="text-sm">{{ t('order.snake') }}</span>
        <span class="text-xs opacity-60">{{ t('order.snakeHint') }}</span>
      </span>
    </label>

    <!--
      Snaking the layers is the same idea one axis out, and it is only a choice once the rows
      snake: a layer that reverses while its rows restart at the same end saves nothing and reads
      as a mistake in the preview. So it follows the toggle above rather than standing beside it.
    -->
    <label
      class="flex items-start gap-3 pl-6"
      :class="order.serpentine ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'"
    >
      <input
        type="checkbox"
        class="toggle toggle-sm"
        :checked="order.snakeLayers"
        :disabled="!order.serpentine"
        @change="snakeLayers(($event.target as HTMLInputElement).checked)"
      />
      <span class="flex flex-col gap-0.5">
        <span class="text-sm">{{ t('order.snakeLayers') }}</span>
        <span class="text-xs opacity-60">{{ t('order.snakeLayersHint') }}</span>
      </span>
    </label>
  </div>
</template>
