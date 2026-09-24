<script lang="ts">
/**
 * One line, as the legend beside the chart describes it.
 *
 * `latest` is the reading as a *string* rather than a number, because what a line is measured in
 * and what it is drawn against are not always the same thing: memory is plotted as a percentage of
 * the machine so it shares an axis with the processor, and read as gigabytes so it means something.
 * The caller formats it; this only shows it.
 */
export interface LegendLine {
  key: string
  label: string
  /** A text colour class, as `TimeChart` takes one. */
  tone: string
  points: TimePoint[]
  latest: string | null
}
</script>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import FilterChip from './FilterChip.vue'
import TimeChart, { type ChartSeries } from './TimeChart.vue'
import type { TimePoint } from '../lib/series'

/**
 * A chart with a legend that is also its switch.
 *
 * **One component, because four places draw this and they must not drift.** The dashboard's
 * traffic, the dashboard's host load, and both of the same on a host's own page are the same
 * picture over different numbers: lines against time, a row of chips under it naming each line and
 * carrying its current reading, and a chip that turns its line off so a quiet one can be read
 * beside a loud one. Written out four times, the first change to any of it would make two of them
 * look like a different application.
 *
 * Hiding is held here rather than by the caller: it is about what somebody is looking at right
 * now, it does not survive the card being rebuilt, and no caller has ever wanted to know.
 */
const props = defineProps<{
  lines: LegendLine[]
  from: number
  to: number
  format: (value: number) => string
  label: string
  /** Said in place of the chart when there is nothing to draw yet. */
  empty: string
  /** An extra note after the chips, for what a line's absence means. */
  note?: string
}>()

const { t } = useI18n()

const hidden = ref(new Set<string>())

function toggle(key: string): void {
  const next = new Set(hidden.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  hidden.value = next
}

const shown = computed<ChartSeries[]>(() =>
  props.lines
    .filter((line) => !hidden.value.has(line.key))
    .map((line) => ({ key: line.key, label: line.label, tone: line.tone, points: line.points })),
)

/** Something to draw: a line nobody has hidden, with at least one point on it. */
const drawable = computed(() => shown.value.some((line) => line.points.length > 0))

/**
 * Every line hidden is not the same as no data, and saying "nothing yet" would be wrong — the
 * operator turned them off and can turn them back on from the chips that are still there.
 */
const allHidden = computed(
  () => props.lines.length > 0 && props.lines.every((line) => hidden.value.has(line.key)),
)
</script>

<template>
  <div class="flex flex-col gap-3">
    <TimeChart
      v-if="drawable"
      :series="shown"
      :from="from"
      :to="to"
      :format="format"
      :label="label"
    />
    <p v-else class="flex h-40 items-center justify-center text-sm opacity-50">
      {{ allHidden ? t('dashboard.allHidden') : empty }}
    </p>

    <!-- The legend is also the switch: a quiet line can be hidden to see the others' scale. -->
    <div class="flex flex-wrap items-center gap-1.5 text-xs">
      <FilterChip
        v-for="line in lines"
        :key="line.key"
        :label="line.label"
        :active="!hidden.has(line.key)"
        :tone="line.tone"
        :value="line.latest"
        @toggle="toggle(line.key)"
      />
      <span v-if="note" class="opacity-50">{{ note }}</span>
    </div>
  </div>
</template>
