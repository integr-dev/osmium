<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import {
  Activity,
  Blocks,
  Bot as Agent,
  CircleAlert,
  Clock,
  Gauge,
  Hammer,
  Layers,
  Map,
  MessagesSquare,
  Server,
  TriangleAlert,
} from 'lucide-vue-next'
import ServerChatModal from '../components/ServerChatModal.vue'
import type { ActivityEntryResponse } from '../api/client'
import { fetchActivityPage } from '../api/feeds'
import { useFeed, useInfiniteScroll } from '../lib/feed'
import { STATE_DOT } from '../lib/agentState'
import type { Sector, ServerSummary } from '../stores/agents'
import { useAgentStore } from '../stores/agents'

const { t } = useI18n()
const agentStore = useAgentStore()

/** Which server's chat is open. Null closes the modal. */
const openServer = ref<ServerSummary | null>(null)

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

/** Builders only, ranked by contribution, for the leaderboard bars. Still mock — see the store. */
const contributors = computed(() =>
  [...agentStore.agents]
    .filter((agent) => agent.build.blocksPlaced > 0)
    .sort((a, b) => b.build.blocksPlaced - a.build.blocksPlaced),
)

const topContribution = computed(() =>
  Math.max(1, ...contributors.value.map((agent) => agent.build.blocksPlaced)),
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
        <p class="text-sm opacity-60">
          Building <span class="font-medium opacity-100">{{ agentStore.schematic.name }}</span>
        </p>
      </div>
      <span
        class="badge badge-sm gap-1"
        :class="agentStore.blocksPerMinute > 0 ? 'badge-success badge-soft' : 'badge-error badge-soft'"
      >
        {{ agentStore.blocksPerMinute > 0 ? 'Building' : 'Stalled' }}
      </span>
    </header>

    <div class="stats stats-vertical sm:stats-horizontal border-base-300 bg-base-200 w-full border">
      <div class="stat">
        <div class="stat-figure text-primary"><Agent class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.agentsOnline') }}</div>
        <div class="stat-value text-3xl">
          {{ agentStore.online.length }}<span class="text-lg opacity-40">/{{ agentStore.agents.length }}</span>
        </div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Hammer class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.blocksPlaced') }}</div>
        <div class="stat-value text-3xl">{{ agentStore.blocksPlaced.toLocaleString() }}</div>
        <div class="stat-desc">of {{ agentStore.schematic.totalBlocks.toLocaleString() }}</div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Gauge class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.throughput') }}</div>
        <div class="stat-value text-3xl">{{ agentStore.blocksPerMinute }}</div>
        <div class="stat-desc">{{ t('dashboard.perMinute') }}</div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Clock class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.remaining') }}</div>
        <div class="stat-value text-3xl">{{ eta }}</div>
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
          <span>{{ agentStore.progressPercent.toFixed(1) }}% complete</span>
          <span class="tabular-nums">
            {{ (agentStore.schematic.totalBlocks - agentStore.blocksPlaced).toLocaleString() }} blocks
            remaining
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

          <p v-else class="py-8 text-center text-sm opacity-50">{{ t('dashboard.allHealthy') }}</p>
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

    <div class="grid gap-6 lg:grid-cols-2">
      <div class="card border-base-300 bg-base-200 border">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <Blocks class="text-primary size-4" />
            {{ t('dashboard.contribution') }}
          </h2>

          <ul class="flex flex-col gap-3">
            <li v-for="agent in contributors" :key="agent.id">
              <div class="flex items-center justify-between text-xs">
                <RouterLink
                  :to="{ name: 'agent', params: { id: agent.id } }"
                  class="flex items-center gap-2 hover:underline"
                >
                  <span
                    class="size-1.5 rounded-full"
                    :class="STATE_DOT[agent.state] ?? 'bg-base-content/30'"
                  ></span>
                  {{ agent.label }}
                </RouterLink>
                <span class="tabular-nums opacity-60">{{ agent.build.blocksPlaced.toLocaleString() }}</span>
              </div>
              <progress
                class="progress progress-primary mt-1 w-full"
                :value="percent(agent.build.blocksPlaced, topContribution)"
                max="100"
              ></progress>
            </li>
          </ul>
        </div>
      </div>

      <div class="card border-base-300 bg-base-200 border">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <Server class="text-primary size-4" />
            {{ t('servers.title') }}
            <span class="badge badge-ghost badge-sm">{{ agentStore.serverSummaries.length }}</span>
          </h2>
          <p class="text-xs opacity-50">{{ t('servers.hint') }}</p>

          <!--
            One row per server rather than every server's chat stacked. A fleet can span servers and
            each feed is long, so the card lists them and the conversation opens on demand.
          -->
          <ul v-if="agentStore.serverSummaries.length" class="flex flex-col gap-1">
            <li v-for="server in agentStore.serverSummaries" :key="server.address">
              <!-- Tailwind 4's preflight gives buttons cursor: default, so the row asks for it back. -->
              <button
                class="rounded-field hover:bg-base-300/50 flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left"
                @click="openServer = server"
              >
                <MessagesSquare class="size-4 shrink-0 opacity-50" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ server.address }}</span>

                <span class="shrink-0 text-xs tabular-nums opacity-60">
                  {{ t('servers.online', { online: server.online, total: server.total }) }}
                </span>

                <span
                  v-if="server.listener"
                  class="badge badge-success badge-soft badge-xs shrink-0"
                >
                  {{ t('servers.listening') }}
                </span>
                <span v-else class="badge badge-warning badge-soft badge-xs shrink-0 gap-1">
                  <TriangleAlert class="size-3" />
                  {{ t('servers.noListenerShort') }}
                </span>
              </button>
            </li>
          </ul>

          <p v-else class="py-8 text-center text-sm opacity-50">{{ t('servers.none') }}</p>
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

        <div v-if="activityError" role="alert" class="alert alert-error alert-soft">
          <TriangleAlert class="size-4" />
          <span>{{ activityError }}</span>
        </div>

        <div ref="activityBox" class="flex max-h-96 flex-col gap-1 overflow-y-auto">
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

    <ServerChatModal :server="openServer" @close="openServer = null" />
  </div>
</template>
