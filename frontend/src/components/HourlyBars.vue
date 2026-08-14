<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HourBucket } from '../lib/series'

/**
 * Incidents per hour.
 *
 * Bars rather than a line: these are counts in discrete buckets, and a line between them would
 * suggest a value at 14:30 that nothing measured.
 *
 * **Laid out with CSS, not a stretched viewBox.** An SVG with `preserveAspectRatio="none"` is fine
 * for a sparkline — a stretched line is still a line — and wrong for bars: with one bucket the
 * single bar was scaled across the whole card and rendered as a lozenge. Flex children keep their
 * proportions at any count.
 *
 * Three states, and the third is the point: a bar with a count, a **thin rule** for an hour that
 * was quiet, and a **faint column** for an hour older than anything loaded. The feed is paged, so
 * those hours are not empty, they are unread — drawing them as zero would state something the
 * client cannot know.
 */
const props = defineProps<{
  buckets: HourBucket[]
  /**
   * Epoch milliseconds before which nothing has been loaded, or 0 when the feed is exhausted and
   * the oldest entry really is the oldest there is.
   */
  knownSince: number
  emptyLabel: string
}>()

const { t } = useI18n()

const HOUR = 3_600_000

const peak = computed(() => Math.max(1, ...props.buckets.map((bucket) => bucket.count)))

const bars = computed(() =>
  props.buckets.map((bucket) => {
    const unknown = bucket.at + HOUR <= props.knownSince
    return {
      ...bucket,
      unknown,
      // Never rounded away to nothing: a bucket with something in it always shows above the rule.
      percent: bucket.count === 0 ? 0 : Math.max(6, (bucket.count / peak.value) * 100),
      hour: new Date(bucket.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    }
  }),
)

const hasUnknown = computed(() => bars.value.some((bar) => bar.unknown))
</script>

<template>
  <div v-if="bars.length" class="flex flex-col gap-1">
    <div class="flex h-14 items-end gap-0.5" role="img" :aria-label="t('dashboard.activity')">
      <div
        v-for="bar in bars"
        :key="bar.at"
        class="flex h-full flex-1 items-end"
        :title="bar.unknown ? `${bar.hour} · ${t('dashboard.incidentsUnloaded')}` : `${bar.hour} · ${bar.count}`"
      >
        <!-- Unread: the slot exists, its height does not. Faint over the full height rather than
             flat on the floor, which is what a quiet hour looks like. -->
        <div v-if="bar.unknown" class="bg-base-content/5 h-full w-full rounded-sm"></div>
        <div
          v-else
          class="bg-primary w-full rounded-t-sm"
          :class="bar.percent === 0 ? 'bg-base-content/15' : ''"
          :style="{ height: bar.percent === 0 ? '2px' : `${bar.percent}%` }"
        ></div>
      </div>
    </div>

    <p class="text-xs opacity-40">
      {{ hasUnknown ? t('dashboard.incidentsPartial') : t('dashboard.incidentsPerHour', { hours: bars.length }) }}
    </p>
  </div>

  <p v-else class="py-4 text-center text-sm opacity-50">{{ emptyLabel }}</p>
</template>
