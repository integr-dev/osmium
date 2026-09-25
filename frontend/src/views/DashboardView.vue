<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  Activity,
  ArrowDownUp,
  Bot as Agent,
  CircleCheck,
  Clock,
  Gauge,
  Hammer,
  Layers,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-vue-next'
import AlertNote from '../components/AlertNote.vue'
import FilterChip from '../components/FilterChip.vue'
import ActivityRow from '../components/ActivityRow.vue'
import TabBar, { type Tab } from '../components/TabBar.vue'
import SeriesChart, { type LegendLine } from '../components/SeriesChart.vue'
import TimeChart, { type ChartSeries } from '../components/TimeChart.vue'
import TrendLine from '../components/TrendLine.vue'
import RollingNumber from '../components/RollingNumber.vue'
import type { ActivityEntryResponse } from '../api/client'
import { fetchActivityPage } from '../api/feeds'
import { useFeed, useInfiniteScroll } from '../lib/feed'
import { JOB_ICON, jobBadge, jobStyle, oneKind } from '../lib/jobKinds'
import { jobFigures } from '../lib/jobs'
import {
  ACTIVITY_BUCKET_MS,
  activitySeries,
  fleetLoad,
  LOAD_MEASURES,
  type LoadKey,
  fleetTraffic,
  formatCount,
  formatPercent,
  formatRate,
  groupAttention,
  projection,
  RANGES,
  rangeMs,
  readingOf,
  seriesOf,
  since,
  thin,
  type RangeKey,
} from '../lib/dashboard'
import { SEVERITIES, SEVERITY_TONE, type Severity } from '../lib/activity'
import { isOnline, useAgentStore } from '../stores/agents'
import { nodeLabel } from '../lib/nodeLabel'
import { useHistoryStore } from '../stores/history'
import { atTime } from '../lib/time'
import { bytes } from '../lib/bytes'

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

/**
 * The right-hand end of every chart. Moved on a timer rather than read inside each computed, which
 * would never re-run: `Date.now()` is not reactive.
 */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined

onMounted(async () => {
  void agentStore.refresh()
  clock = setInterval(() => (now.value = Date.now()), 10_000)
  await activityFeed.reset()
  activityScroll.start()

  // An incident arriving live belongs at the top, where the newest already is.
  stopListening = agentStore.onFeedEvent((name, data) => {
    if (name === 'activity') activityFeed.prepend(data as ActivityEntryResponse)
    if (name === 'dashboard-sample') now.value = Date.now()
  })
})

onBeforeUnmount(() => {
  stopListening?.()
  clearInterval(clock)
})

/**
 * Only while the feed is unfiltered. A filter leaves the list short, so the sentinel stays in view
 * and every page it fetched fetched the next — the whole history, back to back, rendered and
 * animated in one go, which froze the page. Filters narrow what is loaded; scrolling loads more.
 */
async function moreActivity(): Promise<void> {
  if (filtering.value) return
  await activityFeed.more()
  if (!activityExhausted.value) await activityScroll.rearm()
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
 * Which server the page is about, or null for the whole fleet.
 *
 * Everything is scoped: agents, what needs attention and what happened are per-agent facts and an
 * agent is on exactly one server; a job *is* per-server. The one exception is traffic, which is
 * counted per host, and a host is not on a server.
 */
const server = ref<string | null>(null)

/** The strip's ids are strings, so the fleet is the empty one. */
const ALL = ''

const serverTab = computed({
  get: () => server.value ?? ALL,
  set: (id: string) => (server.value = id === ALL ? null : id),
})

const serverTabs = computed<Tab[]>(() => [
  { id: ALL, label: t('dashboard.allServers') },
  ...agentStore.serverSummaries.map((entry) => ({ id: entry.address, label: entry.address })),
])

/**
 * Tabs while the servers fit on one line, a menu once they do not. A one-server fleet has nothing
 * to switch between, and a picker with a single option is a control that does nothing.
 */
const MAX_TABS = 4

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
 * a percentage of anything — so the picker matters.
 */
const jobs = computed(() => agentStore.jobsOn(server.value))

const build = computed(() => jobFigures(jobs.value))

/** The jobs under way here, named. Empty when the fleet is idle, which it usually is. */
const buildingNames = computed(() => [...new Set(jobs.value.map((job) => job.name))].join(', '))

/**
 * What kind of work the fleet is doing, when it is all one kind.
 *
 * **Null is not an absence of jobs, it is a mix of them** — a crew raising a tower while another
 * charts a valley. Every figure on this page is a sum across jobs, so in that case the total is
 * blocks *and* columns and only neutral words are true of it. See `oneKind`.
 */
const kind = computed(() => oneKind(jobs.value.map((job) => job.type)))

/** The words for that kind, or the neutral ones. One lookup, used by every caption here. */
const word = (which: 'count' | 'doing' | 'doingName' | 'unit' | 'left' | 'pieces') =>
  `dashboard.work.${kind.value ?? 'MIXED'}.${which}`

const segments = computed(() => jobs.value.flatMap((job) => job.segments))
const segmentsDone = computed(() => segments.value.filter((segment) => segment.state === 'DONE').length)

// ---- history ---------------------------------------------------------------------------------

const range = ref<RangeKey>('1h')

const rangeTabs = computed<Tab<RangeKey>[]>(() =>
  RANGES.map((option) => ({ id: option.key, label: t(`dashboard.ranges.${option.key}`) })),
)

const from = computed(() => now.value - rangeMs(range.value))

const windowed = computed(() => since(history.samples, from.value))

/** Wider than any card is in pixels is only work for the browser. */
const MAX_POINTS = 360

const onlineSeries = computed(() => windowed.value.map((sample) => readingOf(sample, server.value).online))
const throughputSeries = computed(() =>
  windowed.value.map((sample) => readingOf(sample, server.value).perMinute),
)

/**
 * Says how much past there is, so a short chart reads as a backend that has only just started
 * rather than as a fleet that was idle before.
 */
const trendCaption = computed(() =>
  history.minutes < 1
    ? t('dashboard.trendStarting')
    : t('dashboard.trendKept', { minutes: Math.min(history.minutes, rangeMs(range.value) / 60_000) }),
)

/**
 * Blocks left over time, and where they reach zero at the current rate.
 *
 * The axis runs a third past now while there is something to project, so the dashed line has
 * somewhere to go; it stops at now otherwise, where the measurements do.
 */
const projected = computed(() =>
  projection(blocksRemaining.value, build.value.perMinute, now.value, now.value + rangeMs(range.value) / 3),
)

const burndownTo = computed(() => (projected.value ? now.value + rangeMs(range.value) / 3 : now.value))

const burndownPoints = computed(() =>
  thin(
    seriesOf(windowed.value, (sample) => {
      const reading = readingOf(sample, server.value)
      return Math.max(0, reading.total - reading.placed)
    }),
    MAX_POINTS,
  ),
)

const burndown = computed<ChartSeries[]>(() => {
  const lines: ChartSeries[] = [
    { key: 'remaining', label: t('dashboard.remainingLine'), tone: 'text-primary', points: burndownPoints.value },
  ]
  if (projected.value) {
    lines.push({
      key: 'projected',
      label: t('dashboard.projectedLine'),
      tone: 'text-primary',
      points: projected.value.line,
      dashed: true,
    })
  }
  return lines
})

const hasBurndown = computed(
  () => blocksRemaining.value > 0 || burndownPoints.value.some((point) => point.value > 0),
)

/** Bytes a second across every host, four ways. The game lines only when some host reports them. */
const TRAFFIC_LINES = [
  { key: 'linkSent', tone: 'text-primary' },
  { key: 'linkReceived', tone: 'text-info' },
  { key: 'gameSent', tone: 'text-secondary' },
  { key: 'gameReceived', tone: 'text-accent' },
] as const

const trafficSamples = computed(() => windowed.value.map((sample) => ({ at: sample.at, traffic: fleetTraffic(sample) })))

const gameReported = computed(() => trafficSamples.value.some((sample) => sample.traffic.gameSent !== null))

/**
 * The four traffic lines, ready for the legend to draw and switch off.
 *
 * A line whose value is null at a point is left out of that point rather than drawn at zero: a
 * host too old to report its game traffic has not reported nothing, and a line along the floor
 * says the agents are idle.
 */
const trafficLines = computed<LegendLine[]>(() =>
  TRAFFIC_LINES.filter((line) => gameReported.value || !line.key.startsWith('game')).map((line) => ({
    key: line.key,
    label: t(`dashboard.${line.key}`),
    tone: line.tone,
    points: thin(
      trafficSamples.value
        .filter((sample) => sample.traffic[line.key] !== null)
        .map((sample) => ({ at: Date.parse(sample.at), value: sample.traffic[line.key] ?? 0 })),
      MAX_POINTS,
    ),
    latest: latestOf(trafficSamples.value.at(-1)?.traffic[line.key] ?? null, formatRate),
  })),
)

// ---- host load -------------------------------------------------------------------------------

/**
 * What the fleet's machines are costing, moment by moment.
 *
 * **The same four lines a host's own page draws**, so the fleet view and one machine's view are
 * the same picture at two scopes and a chip means the same thing on both. What differs is the
 * scope: every reporting host added together — see `fleetLoad`, which also says which of the four
 * cannot honestly be added and is averaged instead.
 *
 * All four as percentages so they share one axis; the chips carry what memory actually is in
 * bytes, since a percentage of machines nobody can see is not a number anybody can act on.
 */
const loadSamples = computed(() =>
  windowed.value.map((sample) => ({ at: sample.at, load: fleetLoad(sample) })),
)

const latestLoad = computed(() => loadSamples.value.at(-1)?.load ?? null)

const loadLines = computed<LegendLine[]>(() =>
  LOAD_MEASURES.map((measure) => ({
    key: measure.key,
    // The host is part of the label rather than a note under it: four lines can be four machines.
    label: t(`hosts.load.${measure.key}`),
    tone: measure.tone,
    points: thin(
      loadSamples.value
        .filter((sample) => sample.load !== null)
        .map((sample) => ({ at: Date.parse(sample.at), value: sample.load![measure.key].percent })),
      MAX_POINTS,
    ),
    latest: readingOfLoad(measure.key),
  })),
)

/** Percent for the processor, bytes for memory: each read the way it is measured. */
function readingOfLoad(key: LoadKey): string | null {
  const worst = latestLoad.value?.[key]
  if (!worst) return null
  return key === 'cpu' || key === 'systemCpu' ? formatPercent(worst.percent) : bytes(worst.bytes)
}


/** A reading for a chip: formatted when there is one, and absent rather than zero when there is not. */
function latestOf(value: number | null, format: (value: number) => string): string | null {
  return value === null ? null : format(value)
}

// ---- attention -------------------------------------------------------------------------------

const scopedAttention = computed(() =>
  server.value === null
    ? agentStore.attention
    : agentStore.attention.filter((item) => item.agent.serverAddress === server.value),
)

/**
 * One row per agent, grouped by cause: every agent with the same trouble together, worst cause
 * first. Not filterable — by the time anything is wrong with only a handful of agents the list is
 * short, and a control over five rows hides more than it finds.
 */
const attentionRows = computed(() =>
  groupAttention(scopedAttention.value).flatMap((group) =>
    group.entries.map((entry, index) => ({
      key: `${group.kind}-${entry.agent.id}`,
      kind: group.kind,
      severity: group.severity,
      /** Only the first of a run carries the cause, so a column of "Low food" is written once. */
      heads: index === 0,
      ...entry,
    })),
  ),
)

// ---- activity --------------------------------------------------------------------------------

/**
 * Activity is filtered here rather than in the request: the endpoint takes an agent, not a server.
 * The feed pages regardless, so scoping thins each page rather than truncating the history — the
 * same way the hourly chart reports only what it has actually loaded.
 */
const scopedActivity = computed(() =>
  server.value === null
    ? activity.value
    : activity.value.filter(
        (entry) => entry.agentId !== null && agentStore.byId(entry.agentId)?.serverAddress === server.value,
      ),
)

const shownSeverities = ref(new Set<Severity>(SEVERITIES))

function toggleSeverity(severity: Severity): void {
  const next = new Set(shownSeverities.value)
  if (next.has(severity)) next.delete(severity)
  else next.add(severity)
  shownSeverities.value = next
}

const severityActivity = computed(() =>
  scopedActivity.value.filter((entry) => shownSeverities.value.has(entry.severity)),
)

const filtering = computed(() => shownSeverities.value.size < SEVERITIES.length)

/**
 * Changes whenever the filter does, and keys the list with it: a new list is drawn rather than the
 * old one animated into it, which for a few hundred rows is hundreds of leave and move transitions.
 */
const filterKey = computed(() => [...shownSeverities.value].join(','))

// Paging was held while filtered; the sentinel may have been in view the whole time, and an
// observer only reports a change, so it is asked again.
watch(filtering, (active) => {
  if (!active && !activityExhausted.value) void activityScroll.rearm()
})

const shownActivity = severityActivity

/**
 * The feed is paged, so time before the oldest entry loaded is not quiet, it is unread. Once the
 * feed is exhausted the oldest entry really is the oldest there is, and nothing is unknown.
 */
const knownSince = computed(() => {
  // Newest first, so the last entry is the oldest loaded.
  const oldest = scopedActivity.value.at(-1)
  return activityExhausted.value || !oldest ? 0 : Date.parse(oldest.at)
})

const ACTIVITY_LINES = SEVERITIES.map((key) => ({ key, tone: SEVERITY_TONE[key] }))

/**
 * Incidents over the same range as the charts above, one line per severity. Counts per bucket, the
 * bucket named under the chart, and only for what is loaded — see `activitySeries`.
 */
const activityChart = computed<ChartSeries[]>(() => {
  const series = activitySeries(
    scopedActivity.value,
    from.value,
    now.value,
    ACTIVITY_BUCKET_MS[range.value],
    knownSince.value,
  )
  return ACTIVITY_LINES.filter((line) => shownSeverities.value.has(line.key)).map((line) => ({
    key: line.key,
    label: t(`dashboard.severity.${line.key}`),
    tone: line.tone,
    points: series[line.key],
  }))
})

/** Set when the loaded feed does not reach back to the start of the chart. */
const loadedSince = computed(() => (knownSince.value > from.value ? knownSince.value : null))

function wholeNumber(value: number): string {
  return String(Math.round(value))
}
</script>

<template>
  <div class="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-6 overflow-y-auto">
    <!--
      Why this page rather than the one that was asked for. The guard sends anyone without a route's
      node here, and doing that silently made a bookmarked link look broken instead of restricted.
    -->
    <AlertNote v-if="denied" kind="warning" :icon="ShieldAlert" :message="t('errors.deniedRoute', { node: nodeLabel(denied) })">
      <template #action>
        <button type="button" class="btn btn-ghost btn-xs" @click="dismissDenied">
          {{ t('common.dismiss') }}
        </button>
      </template>
    </AlertNote>

    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{{ t('dashboard.title') }}</h1>
        <!-- Component interpolation: the name sits mid-sentence, and word order is not universal. -->
        <i18n-t
          v-if="buildingNames"
          :keypath="word('doingName')"
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
      <div class="flex flex-wrap items-center gap-3">
        <template v-if="agentStore.serverSummaries.length > 1">
          <TabBar
            v-if="agentStore.serverSummaries.length <= MAX_TABS"
            v-model="serverTab"
            :tabs="serverTabs"
            variant="box"
            size="sm"
          />
          <select
            v-else
            v-model="server"
            class="select select-sm max-w-56 font-mono text-xs"
            :aria-label="t('dashboard.serverScope')"
          >
            <option :value="null">{{ t('dashboard.allServers') }}</option>
            <option v-for="entry in agentStore.serverSummaries" :key="entry.address" :value="entry.address">
              {{ entry.address }}
            </option>
          </select>
        </template>

        <TabBar v-model="range" :tabs="rangeTabs" variant="box" size="sm" />

        <span
          class="badge badge-sm gap-1"
          :class="build.perMinute > 0 ? jobBadge(kind ?? 'BUILD') : 'badge-error badge-soft'"
        >
          {{ build.perMinute > 0 ? t(word('doing')) : t('dashboard.stalled') }}
        </span>
      </div>
    </header>

    <!--
      `shrink-0` because daisyUI gives `.stats` an overflow, which lets this column squash it below its
      content once the page is taller than the screen - and the row then scrolls on its own.
      `auto-cols-fr` stops the row re-flowing: daisyUI sizes stat columns to their content, so a
      changing caption or a count crossing 999 would push the other tiles sideways.
    -->
    <div
      class="stats stats-vertical sm:stats-horizontal border-base-300 bg-base-200 w-full shrink-0 auto-cols-fr border"
    >
      <div class="stat">
        <div class="stat-figure text-primary"><Agent class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.agentsOnline') }}</div>
        <div v-if="!agentStore.loaded" class="skeleton my-1.5 h-8 w-20"></div>
        <div v-else class="stat-value text-3xl">
          <RollingNumber :value="scopedOnline" /><span class="text-lg opacity-50">/{{ scoped.length }}</span>
        </div>
        <div class="stat-desc mt-1 flex flex-col gap-0.5">
          <TrendLine :values="onlineSeries" :label="t('dashboard.agentsOnline')" />
          <span class="truncate">{{ trendCaption }}</span>
        </div>
      </div>
      <div class="stat">
        <div class="stat-figure" :style="kind ? jobStyle(kind) : undefined">
          <component :is="kind ? JOB_ICON[kind] : Hammer" class="size-7" :class="kind ? '' : 'text-primary'" />
        </div>
        <div class="stat-title">{{ t(word('count')) }}</div>
        <div v-if="!agentStore.loaded" class="skeleton my-1.5 h-8 w-28"></div>
        <div v-else class="stat-value text-3xl"><RollingNumber :value="build.placed" /></div>
        <div class="stat-desc">
          {{ t('dashboard.ofTarget', { total: n(build.total) }) }} ·
          {{ t('dashboard.percentComplete', { percent: build.percent }) }}
        </div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Gauge class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.throughput') }}</div>
        <div v-if="!agentStore.loaded" class="skeleton my-1.5 h-8 w-16"></div>
        <div v-else class="stat-value text-3xl"><RollingNumber :value="build.perMinute" /></div>
        <div class="stat-desc mt-1 flex flex-col gap-0.5">
          <TrendLine :values="throughputSeries" :label="t('dashboard.throughput')" />
          <span>{{ t(word('unit')) }}</span>
        </div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Clock class="size-7" /></div>
        <div class="stat-title">{{ t('dashboard.remaining') }}</div>
        <div v-if="!agentStore.loaded" class="skeleton my-1.5 h-8 w-24"></div>
        <div v-else class="stat-value text-3xl">{{ eta }}</div>
        <div class="stat-desc">
          {{ projected ? t('dashboard.finishAt', { time: atTime(projected.finishAt) }) : t('dashboard.atCurrentRate') }}
        </div>
      </div>
    </div>

    <AlertNote v-if="history.error" kind="error" :message="history.error" />

    <div class="grid gap-6 lg:grid-cols-2">
      <!-- Burndown: what is left, falling. Replaces a progress bar that said only how far along. -->
      <div class="card border-base-300 bg-base-200 border">
        <div class="card-body gap-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="card-title flex items-center gap-2 text-base">
              <Layers class="text-base-content/50 size-4" />
              {{ t(word('left')) }}
            </h2>
            <span class="text-sm tabular-nums opacity-60">
              {{ t(word('pieces'), { count: n(blocksRemaining) }, blocksRemaining) }}
            </span>
          </div>

          <TimeChart
            v-if="hasBurndown"
            :series="burndown"
            :from="from"
            :to="burndownTo"
            :format="formatCount"
            :label="t('dashboard.progress')"
          />
          <p v-else class="flex h-40 items-center justify-center text-sm opacity-50">
            {{ history.samples.length ? t('dashboard.noBurndown') : t('dashboard.noHistory') }}
          </p>

          <div class="flex flex-wrap justify-between gap-2 text-xs opacity-60">
            <span>{{ t('dashboard.segmentsDone', { done: segmentsDone, total: segments.length }) }}</span>
            <span v-if="projected" class="flex items-center gap-1.5">
              <span class="border-primary w-4 border-t-2 border-dashed"></span>
              {{ t('dashboard.projectedLine') }}
            </span>
          </div>
        </div>
      </div>

      <div class="card border-base-300 bg-base-200 border">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <ArrowDownUp class="text-base-content/50 size-4" />
            {{ t('dashboard.traffic') }}
            <span class="text-xs font-normal opacity-50">{{ t('dashboard.trafficHint') }}</span>
          </h2>

          <SeriesChart
            :lines="trafficLines"
            :from="from"
            :to="now"
            :format="formatRate"
            :label="t('dashboard.traffic')"
            :empty="t('dashboard.noHistory')"
            :note="history.samples.length && !gameReported ? t('dashboard.gameUnreported') : undefined"
          />
        </div>
      </div>
</div>

    <!--
      One card: what is wrong now, and what has happened. They were two, and an operator reads them
      together - a warning in the feed is usually why a row appears above it.
    -->
    <div class="grid gap-6 lg:grid-cols-3">
      <div class="card border-base-300 bg-base-200 border lg:col-span-2">
        <div class="card-body gap-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="card-title flex items-center gap-2 text-base">
              <Activity class="text-base-content/50 size-4" />
              {{ t('dashboard.activity') }}
            </h2>
            <div class="flex flex-wrap gap-1.5">
              <FilterChip
                v-for="severity in SEVERITIES"
                :key="severity"
                :label="t(`dashboard.severity.${severity}`)"
                :active="shownSeverities.has(severity)"
                :tone="SEVERITY_TONE[severity]"
                @toggle="toggleSeverity(severity)"
              />
            </div>
          </div>

          <!--
            Chart and feed side by side on a wide screen, in one fixed-height row, so the card is no
            taller than the chart and the feed scrolls inside it rather than stretching the page.
          -->
          <div class="grid gap-4 lg:h-72 lg:grid-cols-2">
            <!-- The same range as the charts above, so a spike here lines up with one there. -->
            <div class="flex min-w-0 flex-col gap-1">
              <TimeChart
                :series="activityChart"
                :from="from"
                :to="now"
                :format="wholeNumber"
                :label="t('dashboard.activity')"
                whole
                compact
              />
              <p class="text-xs opacity-50">
                {{ t('dashboard.perBucket', { minutes: ACTIVITY_BUCKET_MS[range] / 60_000 }) }}
                <template v-if="loadedSince !== null">
                  · {{ t('dashboard.loadedSince', { time: atTime(loadedSince) }) }}
                </template>
              </p>

              <!--
                Under the chart rather than in a card of its own: an operator reads the two together,
                since a warning in the feed beside it is usually why a row appears here.
              -->
              <div class="border-base-300 flex min-h-0 flex-1 flex-col gap-1.5 border-t pt-2">
                <span class="flex items-center gap-2 text-xs font-medium tracking-wide uppercase opacity-60">
                  <TriangleAlert class="text-warning size-3.5" />
                  {{ t('dashboard.needsAttention') }}
                  <span v-if="attentionRows.length" class="tabular-nums">{{ attentionRows.length }}</span>
                </span>

                <div v-if="!agentStore.loaded" class="flex flex-col gap-1">
                  <div v-for="row in 3" :key="row" class="skeleton h-6 w-full"></div>
                </div>

                <p
                  v-else-if="!attentionRows.length"
                  class="flex flex-1 items-center justify-center gap-2 text-sm opacity-60"
                >
                  <CircleCheck class="text-success size-4" />
                  {{ t('dashboard.allHealthy') }}
                </p>

                <TransitionGroup
                  v-else
                  name="rows"
                  tag="ul"
                  class="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto"
                >
                  <li v-for="row in attentionRows" :key="row.key">
                    <RouterLink
                      :to="{ name: 'agent', params: { id: row.agent.id } }"
                      class="rounded-field hover:bg-base-300/40 flex items-center gap-3 px-2 py-1.5 text-sm"
                    >
                      <span
                        class="h-4 w-0.5 shrink-0 rounded-full"
                        :class="row.severity === 'error' ? 'bg-error' : 'bg-warning'"
                      ></span>
                      <span class="min-w-0 flex-1 truncate font-medium">{{ row.agent.label }}</span>
                      <span class="shrink-0 text-xs opacity-60" :class="row.heads ? '' : 'invisible'">
                        {{ t(`attention.${row.kind}`) }}
                      </span>
                      <span class="w-14 shrink-0 text-right text-xs tabular-nums opacity-80">
                        {{ row.detail ?? '' }}
                      </span>
                    </RouterLink>
                  </li>
                </TransitionGroup>
              </div>
            </div>

          <div class="flex min-h-0 min-w-0 flex-col gap-2">
              <AlertNote v-if="activityError" kind="error" :message="activityError" />

              <div
                ref="activityBox"
                class="border-base-300 flex max-h-72 min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto border-t pt-2 lg:max-h-none lg:border-t-0 lg:border-l lg:pt-0 lg:pl-2"
              >
                <!--
                  A TransitionGroup animates insertions but not the first render: an incident arriving
                  live slides in, and a page full of history simply appears. Only the list is wrapped —
                  the sentinel below must stay put or the infinite scroll would observe something moving.
                -->
                <TransitionGroup :key="filterKey" name="feed" tag="div" class="flex flex-col gap-0.5">
                  <ActivityRow v-for="line in shownActivity" :key="line.id" :line="line" agent />
                </TransitionGroup>

                <p v-if="activityLoading" class="py-10 text-center text-sm opacity-50">
                  {{ t('common.loading') }}
                </p>
                <p v-else-if="!shownActivity.length" class="py-10 text-center text-sm opacity-50">
                  {{ t('dashboard.noActivity') }}
                </p>

                <!-- Reaching this fetches the next, older page. See src/lib/feed.ts. -->
                <div ref="activitySentinel" aria-hidden="true" class="h-px shrink-0"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!--
        What the fleet is costing the machines under it: every reporting host added together, the
        way the traffic card beside it adds their bytes. The one figure that is averaged instead is
        a machine's own processor use — three machines at half are not one machine at 150%.
      -->
      <div class="card border-base-300 bg-base-200 border lg:h-full">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <Gauge class="text-base-content/50 size-4" />
            {{ t('dashboard.load') }}
            <span class="text-xs font-normal opacity-50">{{ t('dashboard.loadHint') }}</span>
          </h2>

          <SeriesChart
            :lines="loadLines"
            :from="from"
            :to="now"
            :format="formatPercent"
            :label="t('dashboard.load')"
            :empty="history.samples.length ? t('dashboard.noLoad') : t('dashboard.noHistory')"
          />
        </div>
      </div>
    </div>
  </div>
</template>
