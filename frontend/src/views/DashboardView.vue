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
  Layers,
  Map,
  TriangleAlert,
} from 'lucide-vue-next'
import HourlyBars from '../components/HourlyBars.vue'
import PlayerHead from '../components/PlayerHead.vue'
import TrendLine from '../components/TrendLine.vue'
import RollingNumber from '../components/RollingNumber.vue'
import type { ActivityEntryResponse } from '../api/client'
import { fetchActivityPage } from '../api/feeds'
import { useFeed, useInfiniteScroll } from '../lib/feed'
import { STATE_DOT } from '../lib/agentState'
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
 * The window stops at the oldest entry loaded rather than running a fixed twelve hours back: the
 * feed is paged, so hours before that one are not empty, they are unread — and drawing them as
 * empty bars would state something the client cannot know. Once the feed is exhausted the oldest
 * entry really is the oldest there is, and the window covers everything.
 */
const HOURS = 12

/** Says how much past there is, so an empty chart reads as ''no data yet'' rather than as a flat fleet. */
const trendCaption = computed(() =>
  history.minutes < 1
    ? t(`dashboard.trendStarting`)
    : t(`dashboard.trendSession`, { minutes: history.minutes }),
)

const incidentHours = computed(() => {
  const times = activity.value.map((entry) => Date.parse(entry.at))
  if (!times.length) return []

  const now = Date.now()
  const loaded = Math.ceil((now - Math.min(...times)) / 3_600_000)
  return bucketByHour(times, now, Math.max(1, Math.min(HOURS, loaded)))
})

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
      <div class="card border-base-300 bg-base-200 border">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <TriangleAlert class="text-warning size-4" />
            {{ t('dashboard.needsAttention') }}
            <span class="badge badge-ghost badge-sm">{{ agentStore.attention.length }}</span>
          </h2>

          <ul v-if="agentStore.attention.length" class="flex flex-col gap-1">
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

          <div v-else-if="!agentStore.loaded" class="flex flex-col gap-2 py-2">
            <div v-for="row in 2" :key="row" class="skeleton h-10 w-full"></div>
          </div>
          <p v-else class="py-8 text-center text-sm opacity-50">{{ t('dashboard.allHealthy') }}</p>
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
          <div v-if="activity.length" class="flex flex-col gap-1">
            <HourlyBars :buckets="incidentHours" :empty-label="t('dashboard.noActivity')" />
            <p class="text-xs opacity-40">
              {{ t('dashboard.incidentsPerHour', { hours: incidentHours.length }) }}
            </p>
          </div>

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
