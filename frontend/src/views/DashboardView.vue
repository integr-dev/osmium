<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import {
  Activity,
  Bot as Agent,
  CircleAlert,
  Clock,
  Gauge,
  Hammer,
  Heart,
  Layers,
  Map,
  TriangleAlert,
} from 'lucide-vue-next'
import HourlyBars from '../components/HourlyBars.vue'
import TrendLine from '../components/TrendLine.vue'
import RollingNumber from '../components/RollingNumber.vue'
import type { ActivityEntryResponse } from '../api/client'
import { fetchActivityPage } from '../api/feeds'
import { useFeed, useInfiniteScroll } from '../lib/feed'
import { summariseVitals } from '../lib/vitals'
import type { Sector } from '../stores/agents'
import { bucketByHour } from '../lib/series'
import { useAgentStore } from '../stores/agents'
import { useHistoryStore } from '../stores/history'

const { t } = useI18n()
const agentStore = useAgentStore()
const history = useHistoryStore()

const activityBox = ref<HTMLElement | null>(null)
const activitySentinel = ref<HTMLElement | null>(null)

const activityFeed = useFeed<ActivityEntryResponse>((cursor) => fetchActivityPage(cursor))
const {
  items: activity,
  loading: activityLoading,
  error: activityError,
  exhausted: activityExhausted,
} = activityFeed
const activityScroll = useInfiniteScroll(activitySentinel, () => void moreActivity(), activityBox)

let stopListening: (() => void) | null = null

onMounted(async () => {
  void agentStore.refresh()
  await activityFeed.reset()
  activityScroll.start()

  // An incident arriving live belongs at the top, where the newest already is.
  stopListening = agentStore.onFeedEvent((name, data) => {
    if (name === 'activity') activityFeed.prepend(data as ActivityEntryResponse)
  })
})

onBeforeUnmount(() => stopListening?.())

async function moreActivity(): Promise<void> {
  await activityFeed.more()
  if (!activityExhausted.value) await activityScroll.rearm()
}

/** Time only: the feed is a working day's worth, and the date is noise inside one. */
function formatTime(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

const SECTOR_BADGE: Record<Sector['status'], string> = {
  done: 'badge-success badge-soft',
  active: 'badge-primary badge-soft',
  blocked: 'badge-error badge-soft',
  queued: 'badge-ghost',
}

const SEVERITY_DOT: Record<ActivityEntryResponse['severity'], string> = {
  INFO: 'bg-base-content/30',
  WARNING: 'bg-warning',
  ERROR: 'bg-error',
}

const SECTOR_PROGRESS: Record<Sector['status'], string> = {
  done: 'progress-success',
  active: 'progress-primary',
  blocked: 'progress-error',
  queued: '',
}

const eta = computed(() => {
  const minutes = agentStore.etaMinutes
  if (minutes === null) return 'stalled'
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
})

/** Still mock — see the store. */
const blocksRemaining = computed(() => agentStore.schematic.totalBlocks - agentStore.blocksPlaced)

/**
 * Incidents per hour, from the page of activity already on screen.
 *
 * A **fixed** twelve hours, always. Sizing the window to what happened to be loaded meant a busy
 * last hour produced a one-bucket chart, and one bar is a number rather than a comparison.
 *
 * What varies is how much of it is known. The feed is paged, so hours before the oldest entry
 * loaded are not empty, they are unread; `knownSince` marks that line and those hours are drawn as
 * unknown rather than as zero. Once the feed is exhausted the oldest entry really is the oldest
 * there is, and nothing is unknown.
 */
const HOURS = 12

/** Says how much past there is, so an empty chart reads as "no data yet" rather than a flat fleet. */
const trendCaption = computed(() =>
  history.minutes < 1
    ? t('dashboard.trendStarting')
    : t('dashboard.trendSession', { minutes: history.minutes }),
)

const incidentTimes = computed(() => activity.value.map((entry) => Date.parse(entry.at)))

const incidentHours = computed(() =>
  incidentTimes.value.length ? bucketByHour(incidentTimes.value, Date.now(), HOURS) : [],
)

const knownSince = computed(() =>
  activityExhausted.value || !incidentTimes.value.length ? 0 : Math.min(...incidentTimes.value),
)

/**
 * The worst reading of each kind and whose it is — an average would hide the one agent about to die
 * in a fleet that is otherwise fine. See `summariseVitals`.
 */
const vitals = computed(() => summariseVitals(agentStore.agents))

/**
 * The three readings as rows, so the template loops once instead of repeating the same markup with
 * different fields. Ping is a duration rather than a proportion, so its bar is scaled against a
 * ceiling past which the number is simply "bad" — 300ms and 3000ms are the same problem.
 */
const vitalRows = computed(() =>
  [
    { key: 'health', extreme: vitals.value.lowestHealth, bar: 'progress-success', of: 20 },
    { key: 'food', extreme: vitals.value.lowestFood, bar: 'progress-warning', of: 20 },
    { key: 'ping', extreme: vitals.value.worstPing, bar: 'progress-info', of: 300 },
  ]
    .filter((row) => row.extreme !== null)
    .map((row) => ({
      key: row.key,
      bar: row.bar,
      agent: row.extreme!.agent,
      label: t('dashboard.vital.' + row.key),
      reading: row.key === 'ping' ? '' + row.extreme!.value + ' ms' : row.extreme!.value + '/20',
      percent: Math.min(100, (row.extreme!.value / row.of) * 100),
    })),
)

function percent(part: number, whole: number): number {
  return Math.min(100, (part / whole) * 100)
}
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{{ t('dashboard.title') }}</h1>
        <!--
          Component interpolation rather than a bare key plus a span: the name sits mid-sentence,
          and word order around it is not the same in every language.
        -->
        <i18n-t keypath="dashboard.buildingName" tag="p" class="text-sm opacity-60" scope="global">
          <template #name>
            <span class="font-medium opacity-100">{{ agentStore.schematic.name }}</span>
          </template>
        </i18n-t>
      </div>
      <span
        class="badge badge-sm gap-1"
        :class="agentStore.blocksPerMinute > 0 ? 'badge-success badge-soft' : 'badge-error badge-soft'"
      >
        {{ agentStore.blocksPerMinute > 0 ? t('dashboard.building') : t('dashboard.stalled') }}
      </span>
    </header>

    <!--
      These four move on their own, from the live stream, with nobody having asked for it — so the
      three that are counts travel to their new value rather than swapping it. The remaining figure
      is a formatted duration, and there is nothing to count through between "12m" and "2h 4m".
    -->
    <div class="stats stats-vertical sm:stats-horizontal border-base-300 bg-base-200 w-full border">
      <div class="stat">
        <div class="stat-figure text-primary"><Agent class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.agentsOnline') }}</div>
        <div v-if="!agentStore.loaded" class="skeleton my-1.5 h-8 w-20"></div>
        <div v-else class="stat-value text-3xl">
          <RollingNumber :value="agentStore.online.length" /><span class="text-lg opacity-40">/{{ agentStore.agents.length }}</span>
        </div>
        <!--
          The number is instantaneous; this is the only thing on the tile that says whether it has
          been moving. Sampled in the browser, so it starts empty on a reload — the caption says so
          rather than letting an empty chart read as an idle fleet.
        -->
        <div class="stat-desc mt-1 flex flex-col gap-0.5">
          <TrendLine :values="history.online" :label="t('dashboard.agentsOnline')" />
          <span>{{ trendCaption }}</span>
        </div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Hammer class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.blocksPlaced') }}</div>
        <div v-if="!agentStore.loaded" class="skeleton my-1.5 h-8 w-28"></div>
        <div v-else class="stat-value text-3xl"><RollingNumber :value="agentStore.blocksPlaced" /></div>
        <div class="stat-desc">of {{ agentStore.schematic.totalBlocks.toLocaleString() }}</div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Gauge class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.throughput') }}</div>
        <div v-if="!agentStore.loaded" class="skeleton my-1.5 h-8 w-16"></div>
        <div v-else class="stat-value text-3xl"><RollingNumber :value="agentStore.blocksPerMinute" /></div>
        <div class="stat-desc mt-1 flex flex-col gap-0.5">
          <TrendLine :values="history.blocksPerMinute" :label="t('dashboard.throughput')" />
          <span>{{ t('dashboard.perMinute') }}</span>
        </div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Clock class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.remaining') }}</div>
        <div v-if="!agentStore.loaded" class="skeleton my-1.5 h-8 w-24"></div>
        <div v-else class="stat-value text-3xl">{{ eta }}</div>
        <div class="stat-desc">{{ t('dashboard.atCurrentRate') }}</div>
      </div>
    </div>

    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-3">
        <div class="flex items-center justify-between">
          <h2 class="card-title flex items-center gap-2 text-base">
            <Layers class="text-primary size-4" />
            {{ t('dashboard.progress') }}
          </h2>
          <span class="text-sm opacity-60">
            Layer {{ agentStore.schematic.currentLayer }} of {{ agentStore.schematic.layers }}
          </span>
        </div>
        <progress
          class="progress progress-primary w-full"
          :value="agentStore.progressPercent"
          max="100"
        ></progress>
        <div class="flex justify-between text-xs opacity-60">
          <span>{{ t('dashboard.percentComplete', { percent: agentStore.progressPercent.toFixed(1) }) }}</span>
          <span class="tabular-nums">
            {{
              t(
                'dashboard.blocksRemaining',
                { count: blocksRemaining.toLocaleString() },
                blocksRemaining,
              )
            }}
          </span>
        </div>
      </div>
    </div>

    <div class="grid gap-6 lg:grid-cols-2">
      <div class="flex h-full flex-col gap-6">
        <div class="card border-base-300 bg-base-200 flex min-h-0 flex-1 flex-col border">
          <div class="card-body min-h-0 flex-1 gap-3">
            <h2 class="card-title flex items-center gap-2 text-base">
              <TriangleAlert class="text-warning size-4" />
              {{ t('dashboard.needsAttention') }}
              <span class="badge badge-ghost badge-sm">{{ agentStore.attention.length }}</span>
            </h2>

            <ul v-if="agentStore.attention.length" class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
              <RouterLink
                v-for="(item, index) in agentStore.attention"
                :key="`${item.agent.id}-${index}`"
                :to="{ name: 'agent', params: { id: item.agent.id } }"
                class="rounded-field hover:bg-base-300/50 flex items-center gap-3 px-3 py-2"
              >
                <CircleAlert
                  class="size-4 shrink-0"
                  :class="item.severity === 'error' ? 'text-error' : 'text-warning'"
                />
                <span class="flex-1 truncate text-sm font-medium">{{ item.agent.label }}</span>
                <span
                  class="badge badge-xs"
                  :class="item.severity === 'error' ? 'badge-error badge-soft' : 'badge-warning badge-soft'"
                >
                  {{ item.reason }}
                </span>
              </RouterLink>
            </ul>

            <div v-else-if="!agentStore.loaded" class="flex min-h-0 flex-1 flex-col gap-2">
              <div v-for="row in 2" :key="row" class="skeleton h-9 w-full"></div>
            </div>
            <p v-else class="flex-1 text-sm opacity-50">{{ t('dashboard.allHealthy') }}</p>
          </div>
        </div>

        <!--
          The worst of each reading rather than an average, and whose it is: a fleet averaging 18
          health with one agent on 2 is a fleet with a problem, and the average hides exactly that.
          Every row links to the agent you would open next.
        -->
        <div class="card border-base-300 bg-base-200 shrink-0 border">
          <div class="card-body gap-3">
            <h2 class="card-title flex items-center gap-2 text-base">
              <Heart class="text-primary size-4" />
              {{ t('dashboard.vitals') }}
              <span class="badge badge-ghost badge-sm">
                {{ t('dashboard.reporting', { reporting: vitals.reporting, online: vitals.online }) }}
              </span>
            </h2>

            <div v-if="!agentStore.loaded" class="flex h-36 flex-col gap-3">
              <div v-for="row in 4" :key="row" class="skeleton h-7 w-full"></div>
            </div>

            <!--
              Absent rather than zeroed when nobody is reporting. A zero here reads as an agent on no
              health standing at the origin, which is the one lie the vitals panel exists to avoid.
              Same height either way, so an arriving reading moves nothing.
            -->
            <p v-else-if="!vitals.reporting" class="flex h-36 items-center text-sm opacity-50">
              {{ t('dashboard.noVitals') }}
            </p>

            <div v-else class="flex h-36 flex-col justify-between">
              <RouterLink
                v-for="row in vitalRows"
                :key="row.key"
                :to="{ name: 'agent', params: { id: row.agent.id } }"
                class="flex flex-col gap-1"
              >
                <span class="flex items-center gap-2 text-xs">
                  <span class="flex-1 truncate opacity-60">{{ row.label }}</span>
                  <span class="max-w-32 truncate font-medium">{{ row.agent.label }}</span>
                  <span class="tabular-nums opacity-60">{{ row.reading }}</span>
                </span>
                <progress class="progress w-full" :class="row.bar" :value="row.percent" max="100"></progress>
              </RouterLink>

              <span
                v-if="vitals.spread"
                class="flex items-center gap-2 text-xs"
                :title="vitals.spread.dimension"
              >
                <span class="flex-1 truncate opacity-60">{{ t('dashboard.vital.spread') }}</span>
                <span class="max-w-40 truncate font-medium">
                  {{ vitals.spread.from.label }} ↔ {{ vitals.spread.to.label }}
                </span>
                <span class="tabular-nums opacity-60">
                  {{ t('dashboard.blocksApart', { blocks: vitals.spread.blocks }) }}
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="card border-base-300 bg-base-200 border">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <Activity class="text-primary size-4" />
            {{ t('dashboard.activity') }}
          </h2>
          <p class="text-xs opacity-50">{{ t('dashboard.activityHint') }}</p>

          <!--
            Counts in discrete buckets, so bars: a line between them would suggest a value at 14:30
            that nothing measured. Above the feed rather than beside it, because it is the same data
            at a different resolution.
          -->
          <HourlyBars
            v-if="activity.length"
            :buckets="incidentHours"
            :known-since="knownSince"
            :empty-label="t('dashboard.noActivity')"
          />

          <div v-if="activityError" role="alert" class="alert alert-error alert-soft">
            <TriangleAlert class="size-4" />
            <span>{{ activityError }}</span>
          </div>

          <div ref="activityBox" class="flex max-h-96 flex-col gap-1 overflow-y-auto">
            <!--
              A TransitionGroup animates insertions but not the first render, which is exactly the
              distinction that matters: an incident arriving live slides in, and a page full of
              history simply appears. Only the list is wrapped — the sentinel below must stay put or
              the infinite scroll would be observing something that moves.
            -->
            <TransitionGroup name="feed" tag="div" class="flex flex-col gap-1">
              <component
                :is="line.agentId ? RouterLink : 'div'"
                v-for="line in activity"
                :key="line.id"
                :to="line.agentId ? { name: 'agent', params: { id: line.agentId } } : undefined"
                class="rounded-field hover:bg-base-300/50 flex items-center gap-2 px-2 py-1.5 text-sm"
              >
                <span class="shrink-0 font-mono text-xs opacity-40">{{ formatTime(line.at) }}</span>
                <span class="size-1.5 shrink-0 rounded-full" :class="SEVERITY_DOT[line.severity]"></span>
                <span class="shrink-0 font-medium">{{ line.agentLabel }}</span>
                <span class="min-w-0 flex-1 truncate opacity-70">{{ line.text }}</span>
              </component>
            </TransitionGroup>

            <p v-if="activityLoading" class="py-6 text-center text-sm opacity-50">
              {{ t('common.loading') }}
            </p>
            <p v-else-if="!activity.length" class="py-8 text-center text-sm opacity-50">
              {{ t('dashboard.noActivity') }}
            </p>

            <!-- Reaching this fetches the next, older page. See src/lib/feed.ts. -->
            <div ref="activitySentinel" aria-hidden="true" class="h-px shrink-0"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-3">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Map class="text-primary size-4" />
          {{ t('dashboard.sectors') }}
          <span class="badge badge-ghost badge-sm">
            {{ agentStore.sectors.filter((sector) => sector.status === 'done').length }}/{{
              agentStore.sectors.length
            }}
          </span>
        </h2>

        <ul class="flex flex-col gap-3">
          <li v-for="sector in agentStore.sectors" :key="sector.id">
            <div class="flex items-center justify-between gap-2">
              <span class="truncate text-sm">{{ sector.name }}</span>
              <span class="badge badge-xs shrink-0" :class="SECTOR_BADGE[sector.status]">
                {{ sector.status }}
              </span>
            </div>
            <progress
              class="progress mt-1 w-full"
              :class="SECTOR_PROGRESS[sector.status]"
              :value="percent(sector.blocksPlaced, sector.totalBlocks)"
              max="100"
            ></progress>
            <div class="mt-1 flex items-center justify-between gap-2 text-xs opacity-60">
              <span class="truncate">
                {{ sector.assigned.length ? sector.assigned.join(', ') : 'unassigned' }}
              </span>
              <span class="shrink-0 tabular-nums">
                {{ sector.blocksPlaced.toLocaleString() }} /
                {{ sector.totalBlocks.toLocaleString() }}
              </span>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
