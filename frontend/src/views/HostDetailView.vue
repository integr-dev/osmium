<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  Bot as Agent,
  ArrowDownUp,
  ChevronLeft,
  Gauge,
  KeyRound,
  Server,
  SquarePen,
  Trash2,
} from 'lucide-vue-next'
import AlertNote from '../components/AlertNote.vue'
import SeriesChart, { type LegendLine } from '../components/SeriesChart.vue'
import TabBar, { type Tab } from '../components/TabBar.vue'
import HostActions from '../components/HostActions.vue'
import type { HostResponse } from '../api/client'
import PlayerHead from '../components/PlayerHead.vue'
import { agentBadge, agentStateLabel } from '../lib/agentState'
import { vFlash } from '../lib/motion'
import { useAgentStore } from '../stores/agents'
import { atShort } from '../lib/time'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toasts'
import { useHistoryStore } from '../stores/history'
import { bytes } from '../lib/bytes'
import {
  formatPercent,
  formatRate,
  hostLoad,
  LOAD_MEASURES,
  loadReading,
  RANGES,
  rangeMs,
  since,
  thin,
  type RangeKey,
} from '../lib/dashboard'

/**
 * One machine: whether it is answering, what it is running, and what it can log in with.
 *
 * The list answers "which of these is in trouble"; this answers "what is going on with *that* one",
 * which is a different set of facts — the login methods it advertised, when it was last heard from,
 * and the agents that go down with it.
 *
 * Every fact here is **observed, not configured**. Only the name is the operator's to set, which is
 * why it is the only field with an edit beside it.
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const agentStore = useAgentStore()
const auth = useAuthStore()
const toasts = useToastStore()

const actions = ref<InstanceType<typeof HostActions> | null>(null)

const host = computed(() => agentStore.hostById(Number(route.params.id)))
const agents = computed(() => agentStore.agentsOnHost(Number(route.params.id)))

onMounted(() => {
  if (!agentStore.loaded) void agentStore.refresh()
})

// ---- what this machine is doing ----------------------------------------------------------------

/**
 * The same history the dashboard draws, narrowed to this host.
 *
 * Read from the store rather than fetched: it is already loaded, already kept current from the
 * stream, and a second request for the same six hours would only be a second answer to disagree
 * with the first.
 */
const history = useHistoryStore()

const hostId = computed(() => Number(route.params.id))

const range = ref<RangeKey>('1h')
const rangeTabs = computed<Tab<RangeKey>[]>(() =>
  RANGES.map((option) => ({ id: option.key, label: t(`dashboard.ranges.${option.key}`) })),
)

/** Recomputed every ten seconds by the sample arriving, which is what moves the right-hand edge. */
const now = computed(() => Date.parse(history.samples.at(-1)?.at ?? '') || Date.now())
const from = computed(() => now.value - rangeMs(range.value))

const windowed = computed(() => since(history.samples, from.value))

/** This host's entry in each sample, and its load reading when it has reported one. */
const entries = computed(() =>
  windowed.value.map((sample) => ({
    at: Date.parse(sample.at),
    traffic: sample.hosts.find((entry) => entry.hostId === hostId.value) ?? null,
    load: hostLoad(sample, hostId.value),
  })),
)

const gameReported = computed(() => entries.value.some((entry) => entry.traffic?.gameSent != null))

/** The four traffic lines the dashboard draws, for this host alone. */
const TRAFFIC_LINES = [
  { key: 'linkSent', tone: 'text-primary' },
  { key: 'linkReceived', tone: 'text-info' },
  { key: 'gameSent', tone: 'text-secondary' },
  { key: 'gameReceived', tone: 'text-accent' },
] as const

const trafficLines = computed<LegendLine[]>(() =>
  TRAFFIC_LINES.filter((line) => gameReported.value || !line.key.startsWith('game')).map((line) => ({
    key: line.key,
    label: t(`dashboard.${line.key}`),
    tone: line.tone,
    points: thin(
      entries.value
        .filter((entry) => entry.traffic?.[line.key] != null)
        .map((entry) => ({ at: entry.at, value: entry.traffic![line.key] ?? 0 })),
      MAX_POINTS,
    ),
    latest: latestTraffic(line.key),
  })),
)

function latestTraffic(key: (typeof TRAFFIC_LINES)[number]['key']): string | null {
  const value = entries.value.at(-1)?.traffic?.[key]
  return value == null ? null : formatRate(value)
}

/**
 * Processor and memory, all four as percentages so they share one axis.
 *
 * **Two scales would need two charts.** The process is measured against a single core and the
 * machine against all of them, and memory is bytes — putting bytes and percent on one axis means
 * the scale is for one of them and lying about the other. So the lines are drawn as percentages
 * and the chips carry what each one actually is, which is the number an operator acts on.
 */

const latestLoad = computed(() => entries.value.at(-1)?.load ?? null)

const loadLines = computed<LegendLine[]>(() =>
  LOAD_MEASURES.map((line) => ({
    key: line.key,
    label: t(`hosts.load.${line.key}`),
    tone: line.tone,
    points: thin(
      entries.value
        .filter((entry) => entry.load !== null)
        .map((entry) => ({ at: entry.at, value: loadReading(entry.load!, line.key).percent })),
      MAX_POINTS,
    ),
    // Percent for the processor, bytes for memory: each read the way it is measured.
    latest:
      latestLoad.value === null
        ? null
        : line.key === 'cpu' || line.key === 'systemCpu'
          ? formatPercent(latestLoad.value[line.key])
          : bytes(latestLoad.value[line.key]),
  })),
)

/** What the machine has in total, said once under the chart rather than on every line. */
const machineMemory = computed(() =>
  latestLoad.value ? bytes(latestLoad.value.systemMemoryTotal) : null,
)

/** The same ceiling the dashboard thins to: more points than the card has pixels buys nothing. */
const MAX_POINTS = 240

/**
 * Its page cannot outlive it. The list is where there is still something to look at.
 *
 * The confirmation goes to the corner because this page is about to stop existing: the operator
 * lands on a list of hosts with one fewer row than it had, and an absence is not a receipt.
 */
function afterRemove(removed: HostResponse) {
  // A receipt, which fades: the host's absence from the list says the rest.
  toasts.notify('success', 'toast.hostRemoved', { params: { name: removed.name }, fade: true })
  void router.push({ name: 'resources' })
}
</script>

<template>
  <div class="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-6 overflow-y-auto">
    <RouterLink :to="{ name: 'resources' }" class="btn btn-ghost btn-sm w-fit gap-1 px-2">
      <ChevronLeft class="size-4" />
      {{ t('resources.title') }}
    </RouterLink>

    <AlertNote v-if="!host && agentStore.loaded" kind="error" :message="t('hosts.notFound')" />

    <template v-else-if="host">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="rounded-field bg-base-300/40 flex size-11 items-center justify-center">
            <Server class="size-5 opacity-70" />
          </div>
          <div>
            <h1 class="text-2xl font-semibold tracking-tight">{{ host.name }}</h1>
            <span
              v-flash="host.reachable"
              class="badge badge-sm mt-1"
              :class="host.reachable ? 'badge-success badge-soft' : 'badge-error badge-soft'"
            >
              {{ host.reachable ? t('hosts.reachable') : t('hosts.unreachable') }}
            </span>
          </div>
        </div>

        <div class="flex flex-wrap gap-1">
          <button
            v-if="auth.can('host.write')"
            class="btn btn-ghost btn-sm gap-1"
            @click="actions?.rename(host)"
          >
            <SquarePen class="size-4" />
            {{ t('hosts.rename') }}
          </button>
          <button
            v-if="auth.can('host.token')"
            class="btn btn-ghost btn-sm gap-1"
            @click="actions?.rotate(host)"
          >
            <KeyRound class="size-4" />
            {{ t('hosts.rotateToken') }}
          </button>
          <button
            v-if="auth.can('host.delete')"
            class="btn btn-ghost btn-sm text-error gap-1"
            @click="actions?.remove(host)"
          >
            <Trash2 class="size-4" />
            {{ t('hosts.removeAction') }}
          </button>
        </div>
      </header>

      <div class="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div class="flex min-w-0 flex-col gap-4">
          <!--
            The agents this host owns. They are listed here rather than only in the fleet list
            because they are what is lost when this machine goes: an unreachable host puts every one
            of them in a state nobody can confirm.
          -->
          <div class="card border-base-300 bg-base-200 border">
            <div class="border-base-300 flex items-center gap-2 border-b px-4 py-3">
              <Agent class="size-4 opacity-70" />
              <h2 class="text-sm font-medium">{{ t('hosts.agentsHere') }}</h2>
              <span class="badge badge-ghost badge-sm ml-auto">{{ agents.length }}</span>
            </div>

            <!-- The shape that is coming, like every other list in the application. -->
            <div v-if="!agentStore.loaded" class="flex flex-col gap-2 px-4 py-3">
              <div v-for="row in 2" :key="row" class="skeleton h-10 w-full"></div>
            </div>

            <p
              v-else-if="!agents.length"
              class="px-4 py-10 text-center text-sm opacity-50"
            >
              {{ t('hosts.noAgentsHere') }}
            </p>

            <!-- No transition: this page reads a host, it does not add agents to one. -->
            <ul class="divide-base-300 divide-y">
              <li v-for="agent in agents" :key="agent.id">
                <RouterLink
                  :to="{ name: 'agent', params: { id: agent.id } }"
                  v-flash="agent.state"
                  class="hover:bg-base-300/40 flex items-center gap-3 px-4 py-2.5"
                >
                  <PlayerHead :id="agent.mcUuid ?? agent.mcUsername" :name="agent.label" size="sm" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium">{{ agent.label }}</span>
                    <span class="block truncate text-xs opacity-50">
                      <span :class="agent.serverAddress ? 'font-mono' : 'italic'">
                        {{ agent.serverAddress ?? t('agents.noServer') }}
                      </span>
                    </span>
                  </span>
                  <span
                    class="badge badge-sm shrink-0"
                    :class="agentBadge(agent.state, agentStore.workOf(agent.id))"
                  >
                    {{ agentStateLabel(agent.state, agentStore.workOf(agent.id)) }}
                  </span>
                </RouterLink>
              </li>
            </ul>
          </div>
        </div>

        <div class="flex min-w-0 flex-col gap-4">
          <div class="stats stats-vertical border-base-300 w-full border">
            <div class="stat px-4 py-3">
              <div class="stat-title text-xs">{{ t('hosts.version') }}</div>
              <div class="stat-value font-mono text-lg">{{ host.hostVersion ?? '—' }}</div>
            </div>
            <div class="stat px-4 py-3">
              <div class="stat-title text-xs">{{ t('hosts.lastSeen') }}</div>
              <div class="stat-value text-lg">
                {{ host.lastSeenAt ? atShort(host.lastSeenAt) : t('hosts.neverSeen') }}
              </div>
            </div>
          </div>

          <!--
            What this machine says it can log in with. Its own panel because it is the one thing
            here that decides whether an agent can be set up at all — an empty list is why the setup
            dialog refuses, and this is where an operator would come to find that out.
          -->
          <div class="card border-base-300 bg-base-200 border">
            <div class="border-base-300 flex items-center gap-2 border-b px-4 py-3">
              <KeyRound class="size-4 opacity-70" />
              <h2 class="text-sm font-medium">{{ t('hosts.loginMethods') }}</h2>
            </div>

            <p v-if="!host.loginMethods.length" class="px-4 py-4 text-sm opacity-60">
              {{ t('hosts.noMethodsAdvertised') }}
            </p>

            <ul v-else class="divide-base-300 divide-y text-sm">
              <li v-for="method in host.loginMethods" :key="method.id" class="px-4 py-2.5">
                <span class="block font-medium">{{ method.label || method.id }}</span>
                <span v-if="method.description" class="block text-xs opacity-60">
                  {{ method.description }}
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!--
        What this machine is doing, over time: the two charts the dashboard draws for the fleet,
        narrowed to one host. Same components, same legend, same range strip — a host's page and
        the dashboard should read as one application looking at two scopes.
      -->
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-sm font-medium">{{ t('hosts.overTime') }}</h2>
        <TabBar v-model="range" :tabs="rangeTabs" variant="box" size="sm" />
      </div>

      <div class="grid gap-6 lg:grid-cols-2">
        <div class="card border-base-300 bg-base-200 border">
          <div class="card-body gap-3">
            <h3 class="card-title flex items-center gap-2 text-base">
              <Gauge class="text-base-content/50 size-4" />
              {{ t('hosts.loadTitle') }}
              <span v-if="machineMemory" class="text-xs font-normal opacity-50">
                {{ t('hosts.ofMemory', { total: machineMemory }) }}
              </span>
            </h3>

            <SeriesChart
              :lines="loadLines"
              :from="from"
              :to="now"
              :format="formatPercent"
              :label="t('hosts.loadTitle')"
              :empty="t('hosts.noLoad')"
            />
          </div>
        </div>

        <div class="card border-base-300 bg-base-200 border">
          <div class="card-body gap-3">
            <h3 class="card-title flex items-center gap-2 text-base">
              <ArrowDownUp class="text-base-content/50 size-4" />
              {{ t('dashboard.traffic') }}
              <span class="text-xs font-normal opacity-50">{{ t('hosts.trafficHint') }}</span>
            </h3>

            <SeriesChart
              :lines="trafficLines"
              :from="from"
              :to="now"
              :format="formatRate"
              :label="t('dashboard.traffic')"
              :empty="t('dashboard.noHistory')"
              :note="entries.length && !gameReported ? t('dashboard.gameUnreported') : undefined"
            />
          </div>
        </div>
      </div>
    </template>

    <HostActions ref="actions" @removed="afterRemove" />
  </div>
</template>
