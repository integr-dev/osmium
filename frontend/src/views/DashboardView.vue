<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  Activity,
  Bot as Agent,
  CircleAlert,
  Clock,
  Gauge,
  Hammer,
  Heart,
  Layers,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-vue-next'
import HourlyBars from '../components/HourlyBars.vue'
import TrendLine from '../components/TrendLine.vue'
import RollingNumber from '../components/RollingNumber.vue'
import type { ActivityEntryResponse } from '../api/client'
import { fetchActivityPage } from '../api/feeds'
import { useFeed, useInfiniteScroll } from '../lib/feed'
import { jobFigures } from '../lib/jobs'
import { dimensionLabel, summariseVitals } from '../lib/vitals'
import { bucketByHour } from '../lib/series'
import { isOnline, useAgentStore } from '../stores/agents'
import { nodeLabel } from '../lib/nodeLabel'
import { useHistoryStore } from '../stores/history'
import { atTime } from '../lib/time'

const { t, n } = useI18n()
const route = useRoute()
const router = useRouter()
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
const SEVERITY_DOT: Record<ActivityEntryResponse['severity'], string> = {
  INFO: 'bg-base-content/30',
  WARNING: 'bg-warning',
  ERROR: 'bg-error',
}


const eta = computed(() => {
  const minutes = build.value.etaMinutes
  if (minutes === null) return t('dashboard.noEta')
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
})

/**
 * The node the guard turned an operator away for, or null when they arrived here on purpose.
 *
 * Read once rather than watched: it describes the navigation that landed here, and re-reading it on
 * every route change would resurrect the notice when the query is cleared.
 */
const denied = ref<string | null>((route.query.denied as string) ?? null)

function dismissDenied() {
  denied.value = null
  // Out of the URL as well, so a reload does not bring it back.
  void router.replace({ query: { ...route.query, denied: undefined } })
}

const blocksRemaining = computed(() => Math.max(0, build.value.total - build.value.placed))

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

/**
 * Which server the page is about, or null for the whole fleet.
 *
 * **Everything is scoped now.** Agents, their vitals, what needs attention and what happened are
 * per-agent facts and an agent is on exactly one server; a job *is* per-server. What used to be
 * left fleet-wide and labelled as mock is neither any more.
 */
const server = ref<string | null>(null)

const scoped = computed(() =>
  server.value === null
    ? agentStore.agents
    : agentStore.agents.filter((agent) => agent.serverAddress === server.value),
)

const scopedOnline = computed(() => scoped.value.filter(isOnline).length)

/**
 * What is being built here, from what hosts have reported.
 *
 * A fleet-wide figure is a sum across separate builds, which is meaningful as a total and not as
 * a percentage of anything — so the picker matters more than it did when this was invented.
 */
const jobs = computed(() => agentStore.jobsOn(server.value))

const build = computed(() => jobFigures(jobs.value))

/** The builds under way here, named. Empty when the fleet is idle, which it usually is. */
const buildingNames = computed(() =>
  [...new Set(jobs.value.map((job) => job.buildName))].join(", "),
)

/**
 * Every segment being worked here, newest job first.
 *
 * Replaces five hardcoded sectors named after parts of a cathedral. A segment has no name — it is
 * a box and an ordinal — so the job it belongs to is what identifies it, which is also the fact an
 * operator needs when two builds are running on one server.
 */
const segments = computed(() =>
  jobs.value.flatMap((job) =>
    job.segments.map((segment) => ({ job, segment })),
  ),
)

/** The sparklines follow the picker too, which is what the per-server sampling is for. */
const onlineSeries = computed(() => history.seriesFor(server.value, 'online'))
const throughputSeries = computed(() => history.seriesFor(server.value, 'perMinute'))

const scopedAttention = computed(() =>
  server.value === null
    ? agentStore.attention
    : agentStore.attention.filter((item) => item.agent.serverAddress === server.value),
)

/**
 * Activity is filtered here rather than in the request: the endpoint takes an agent, not a server.
 * The feed pages regardless, so scoping thins each page rather than truncating the history — the
 * same way the hourly chart already reports only what it has actually loaded.
 */
const scopedActivity = computed(() =>
  server.value === null
    ? activity.value
    : activity.value.filter(
        (entry) => entry.agentId !== null && agentStore.byId(entry.agentId)?.serverAddress === server.value,
      ),
)

const incidentTimes = computed(() => scopedActivity.value.map((entry) => Date.parse(entry.at)))

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
const vitals = computed(() => summariseVitals(scoped.value))

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


</script>

<template>
  <div class="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-6 overflow-y-auto">
    <!--
      Why this page rather than the one that was asked for. The guard sends anyone without a route's
      node here, and doing that silently made a bookmarked link look broken instead of restricted.
      Dismissible, because it is about one navigation and not about the fleet.
    -->
    <div v-if="denied" role="alert" class="alert alert-warning alert-soft">
      <ShieldAlert class="size-4" />
      <span>{{ t('errors.deniedRoute', { node: nodeLabel(denied) }) }}</span>
      <button type="button" class="btn btn-ghost btn-xs" @click="dismissDenied">
        {{ t('common.dismiss') }}
      </button>
    </div>

    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{{ t('dashboard.title') }}</h1>
        <!--
          Component interpolation rather than a bare key plus a span: the name sits mid-sentence,
          and word order around it is not the same in every language.
        -->
        <!--
          What is actually being built here, which can be nothing. A dashboard that names a
          schematic whatever the fleet is doing was the most confident part of the mock.
        -->
        <i18n-t
          v-if="buildingNames"
          keypath="dashboard.buildingName"
          tag="p"
          class="text-sm opacity-60"
          scope="global"
        >
          <template #name>
            <span class="font-medium opacity-100">{{ buildingNames }}</span>
          </template>
        </i18n-t>
        <p v-else class="text-sm opacity-60">{{ t('dashboard.buildingNothing') }}</p>
      </div>
      <div class="flex items-center gap-3">
        <!--
          Only shown once there is a choice to make: a one-server fleet has nothing to switch
          between, and a picker with a single option is a control that does nothing.
        -->
        <select
          v-if="agentStore.serverSummaries.length > 1"
          v-model="server"
          class="select select-sm max-w-56 font-mono text-xs"
          :aria-label="t('dashboard.serverScope')"
        >
          <option :value="null">{{ t('dashboard.allServers') }}</option>
          <option v-for="entry in agentStore.serverSummaries" :key="entry.address" :value="entry.address">
            {{ entry.address }}
          </option>
        </select>

        <span
          class="badge badge-sm gap-1"
          :class="build.perMinute > 0 ? 'osmium-badge-building' : 'badge-error badge-soft'"
        >
          {{ build.perMinute > 0 ? t('dashboard.building') : t('dashboard.stalled') }}
        </span>
      </div>
    </header>


    <!--
      These four move on their own, from the live stream, with nobody having asked for it — so the
      three that are counts travel to their new value rather than swapping it. The remaining figure
      is a formatted duration, and there is nothing to count through between "12m" and "2h 4m".
    -->
    <!--
      `auto-cols-fr` is what stops the row re-flowing. daisyUI sizes stat columns to their content,
      so a caption swapping between "building a trend…" and "last 12 min this session", or a count
      crossing from 999 to 1000, resized that tile and pushed the other three sideways. Equal
      fractions make every tile immune to what is inside it.
    -->
    <div
      class="stats stats-vertical sm:stats-horizontal border-base-300 bg-base-200 w-full auto-cols-fr border"
    >
      <div class="stat">
        <div class="stat-figure text-primary"><Agent class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.agentsOnline') }}</div>
        <div v-if="!agentStore.loaded" class="skeleton my-1.5 h-8 w-20"></div>
        <div v-else class="stat-value text-3xl">
          <RollingNumber :value="scopedOnline" /><span class="text-lg opacity-40">/{{ scoped.length }}</span>
        </div>
        <!--
          The number is instantaneous; this is the only thing on the tile that says whether it has
          been moving. Sampled in the browser, so it starts empty on a reload — the caption says so
          rather than letting an empty chart read as an idle fleet.
        -->
        <div class="stat-desc mt-1 flex flex-col gap-0.5">
          <TrendLine :values="onlineSeries" :label="t('dashboard.agentsOnline')" />
          <span class="truncate">{{ trendCaption }}</span>
        </div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Hammer class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.blocksPlaced') }}</div>
        <div v-if="!agentStore.loaded" class="skeleton my-1.5 h-8 w-28"></div>
        <div v-else class="stat-value text-3xl"><RollingNumber :value="build.placed" /></div>
        <div class="stat-desc">{{ t('dashboard.ofTarget', { total: n(build.total) }) }}</div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Gauge class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.throughput') }}</div>
        <div v-if="!agentStore.loaded" class="skeleton my-1.5 h-8 w-16"></div>
        <div v-else class="stat-value text-3xl"><RollingNumber :value="build.perMinute" /></div>
        <div class="stat-desc mt-1 flex flex-col gap-0.5">
          <TrendLine :values="throughputSeries" :label="t('dashboard.throughput')" />
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
          <!--
            Segments finished, where a layer count used to be. Layers were invented and have no real
            analogue: a build is divided into boxes, and only one of the three split modes cuts
            anything that could be called a layer.
          -->
          <span class="text-sm opacity-60">
            {{
              t('dashboard.segmentsDone', {
                done: segments.filter(({ segment }) => segment.state === 'DONE').length,
                total: segments.length,
              })
            }}
          </span>
        </div>
        <progress
          class="progress osmium-progress-building w-full"
          :value="build.percent"
          max="100"
        ></progress>
        <div class="flex justify-between text-xs opacity-60">
          <span>{{ t('dashboard.percentComplete', { percent: build.percent.toFixed(1) }) }}</span>
          <span class="tabular-nums">
            {{
              t(
                'dashboard.blocksRemaining',
                { count: n(blocksRemaining) },
                blocksRemaining,
              )
            }}
          </span>
        </div>
      </div>
    </div>

    <div class="grid gap-6 lg:h-[30rem] lg:grid-cols-2">
      <div class="flex min-h-0 flex-col gap-6">
        <div class="card border-base-300 bg-base-200 flex min-h-0 flex-1 flex-col border">
          <div class="card-body min-h-0 flex-1 gap-3">
            <h2 class="card-title flex items-center gap-2 text-base">
              <TriangleAlert class="text-warning size-4" />
              {{ t('dashboard.needsAttention') }}
              <span class="badge badge-ghost badge-sm">{{ scopedAttention.length }}</span>
            </h2>

            <!--
              `max-h` below lg only: there the column is a single grid track with no height to flex
              against, so `flex-1` resolves to the content and the card grows instead of scrolling.
              At lg the row sets the height and a cap would put back the gap it was sized to fill.
            -->
            <!-- Always mounted so the first thing to go wrong is an insertion rather than the
                 birth of the list, which a group does not animate. -->
            <TransitionGroup
              name="rows"
              tag="ul"
              class="flex max-h-64 min-h-0 flex-1 flex-col gap-1 overflow-y-auto lg:max-h-none"
            >
              <RouterLink
                v-for="(item, index) in scopedAttention"
                :key="`${item.agent.id}-${index}`"
                :to="{ name: 'agent', params: { id: item.agent.id } }"
                class="rounded-field hover:bg-base-300/40 flex items-center gap-3 px-3 py-2"
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
            </TransitionGroup>

            <div v-if="!agentStore.loaded" class="flex min-h-0 flex-1 flex-col gap-2">
              <div v-for="row in 2" :key="row" class="skeleton h-9 w-full"></div>
            </div>
            <p v-else-if="!scopedAttention.length" class="flex-1 text-sm opacity-50">
              {{ t('dashboard.allHealthy') }}
            </p>
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
                :title="[vitals.spread.server, dimensionLabel(vitals.spread.dimension)].filter(Boolean).join(' · ')"
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

      <div class="card border-base-300 bg-base-200 flex min-h-0 flex-col border">
        <div class="card-body min-h-0 flex-1 justify-start gap-4">
          <!--
            Heading, hint and chart are one block that never grows, so every spare pixel in the card
            goes to the feed rather than opening a gap above the bars.

            Counts in discrete buckets, so bars: a line between them would suggest a value at 14:30
            that nothing measured. Above the feed rather than beside it, because it is the same data
            at a different resolution.
          -->
          <div class="flex shrink-0 flex-col gap-3">
            <h2 class="card-title flex items-center gap-2 text-base">
              <Activity class="text-primary size-4" />
              {{ t('dashboard.activity') }}
              <span class="text-xs font-normal opacity-50">{{ t('dashboard.activityHint') }}</span>
            </h2>

            <HourlyBars
              v-if="scopedActivity.length"
              :buckets="incidentHours"
              :known-since="knownSince"
              :empty-label="t('dashboard.noActivity')"
            />
          </div>

          <div v-if="activityError" role="alert" class="alert alert-error alert-soft">
            <TriangleAlert class="size-4" />
            <span>{{ activityError }}</span>
          </div>

          <div ref="activityBox" class="flex max-h-96 min-h-0 flex-1 flex-col gap-1 overflow-y-auto lg:max-h-none">
            <!--
              A TransitionGroup animates insertions but not the first render, which is exactly the
              distinction that matters: an incident arriving live slides in, and a page full of
              history simply appears. Only the list is wrapped — the sentinel below must stay put or
              the infinite scroll would be observing something that moves.
            -->
            <TransitionGroup name="feed" tag="div" class="flex flex-col gap-1">
              <component
                :is="line.agentId ? RouterLink : 'div'"
                v-for="line in scopedActivity"
                :key="line.id"
                :to="line.agentId ? { name: 'agent', params: { id: line.agentId } } : undefined"
                class="rounded-field hover:bg-base-300/40 flex items-center gap-2 px-2 py-1.5 text-sm"
              >
                <span class="shrink-0 font-mono text-xs opacity-40">{{ atTime(line.at) }}</span>
                <span class="size-1.5 shrink-0 rounded-full" :class="SEVERITY_DOT[line.severity]"></span>
                <span class="shrink-0 font-medium">{{ line.agentLabel }}</span>
                <span class="min-w-0 flex-1 truncate opacity-70">{{ line.text }}</span>
              </component>
            </TransitionGroup>

            <p v-if="activityLoading" class="py-10 text-center text-sm opacity-50">
              {{ t('common.loading') }}
            </p>
            <p v-else-if="!scopedActivity.length" class="py-10 text-center text-sm opacity-50">
              {{ t('dashboard.noActivity') }}
            </p>

            <!-- Reaching this fetches the next, older page. See src/lib/feed.ts. -->
            <div ref="activitySentinel" aria-hidden="true" class="h-px shrink-0"></div>
          </div>
        </div>
      </div>
    </div>
</div>
</template>
