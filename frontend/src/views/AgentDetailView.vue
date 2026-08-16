<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  Activity,
  Beef,
  Bot as Agent,
  Clock,
  Hammer,
  Heart,
  KeyRound,
  Layers,
  MapPin,
  MessageSquare,
  Power,
  RotateCw,
  Server,
  Signal,
  SquarePen,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-vue-next'
import FormField from '../components/FormField.vue'
import PlayerHead from '../components/PlayerHead.vue'
import type { ActivityEntryResponse } from '../api/client'
import { fetchActivityPage } from '../api/feeds'
import { useFeed, useInfiniteScroll } from '../lib/feed'
import { STATE_BADGE, stateLabel } from '../lib/agentState'
import { vFlash } from '../lib/motion'
import { isOnline, uptimeOf, useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'
import { useChatStore } from '../stores/chat'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const agentStore = useAgentStore()
const auth = useAuthStore()
const chat = useChatStore()

const error = ref<string | null>(null)
const busy = ref(false)

const editDialog = ref<HTMLDialogElement | null>(null)
const removeDialog = ref<HTMLDialogElement | null>(null)
const setupDialog = ref<HTMLDialogElement | null>(null)
const draft = ref({ label: '' })
const editError = ref<string | null>(null)
const setupMethod = ref('')

const agent = computed(() => agentStore.byId(Number(route.params.id)))

/**
 * Commands travel to the agent's host, so nothing is deliverable while its agent is disconnected.
 * Checked here so the UI does not offer an action the API will refuse.
 */
const host = computed(() => (agent.value ? agentStore.hostById(agent.value.hostId) : undefined))
const hostReachable = computed(() => host.value?.reachable === true)

/**
 * Null until the agent reports, and after it stops. The whole panel is hidden in that case rather
 * than shown as zeroes, which would read as an agent on no health standing at the world origin.
 */
const vitals = computed(() => agent.value?.telemetry ?? null)

const healthPercent = computed(() => ((vitals.value?.health ?? 0) / 20) * 100)
const foodPercent = computed(() => ((vitals.value?.food ?? 0) / 20) * 100)

const SEVERITY_DOT: Record<ActivityEntryResponse['severity'], string> = {
  INFO: 'bg-base-content/30',
  WARNING: 'bg-warning',
  ERROR: 'bg-error',
}

/**
 * This agent's incidents. Its chat is a scope of the rail rather than a panel here — one
 * conversation shown in one place, pointed at whatever is being looked at.
 *
 * A fixed-height panel rather than the whole page, so it scrolls its own older pages in.
 */
const agentId = computed(() => Number(route.params.id))

const activityBox = ref<HTMLElement | null>(null)
const activitySentinel = ref<HTMLElement | null>(null)

const activityFeed = useFeed<ActivityEntryResponse>((cursor) =>
  fetchActivityPage(cursor, agentId.value),
)
const {
  items: activity,
  loading: activityLoading,
  exhausted: activityExhausted,
} = activityFeed

const activityScroll = useInfiniteScroll(activitySentinel, () => void moreActivity(), activityBox)

let stopListening: (() => void) | null = null

onMounted(async () => {
  if (!agent.value) void agentStore.refresh()

  await activityFeed.reset()
  activityScroll.start()

  // Chat is the panel's own business; this is only activity. See ChatPanel.
  stopListening = agentStore.onFeedEvent((name, data) => {
    if (name !== 'activity') return
    const entry = data as ActivityEntryResponse
    if (entry.agentId === agentId.value) activityFeed.prepend(entry)
  })
})

onBeforeUnmount(() => stopListening?.())

async function moreActivity(): Promise<void> {
  await activityFeed.more()
  if (!activityExhausted.value) await activityScroll.rearm()
}

/** Time only: chat is kept three days and activity ten, so the clock is what locates a line. */
/**
 * Whole blocks. A Minecraft coordinate carries more decimals than anyone reads at a glance, and the
 * fractional part is never what an operator is looking for.
 */
function formatPosition(at: { x: number; y: number; z: number }): string {
  return `${Math.round(at.x)}, ${Math.round(at.y)}, ${Math.round(at.z)}`
}

function formatTime(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Every command can legitimately fail with 503 while no agent is connected to the host. */
async function run(action: () => Promise<void>) {
  busy.value = true
  error.value = null
  try {
    await action()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.commandFailed')
  } finally {
    busy.value = false
  }
}

/**
 * What this agent's host says it can log in with, from its handshake.
 *
 * The host is the only party that knows: the mechanisms are implemented there, and a fixed list in
 * the frontend offered every host the same four whether or not any of them would work. Empty while
 * the host is disconnected, and empty for one that advertises nothing — which can then set nothing
 * up, and says so rather than failing on the way back from the attempt.
 */
const loginMethods = computed(() => host.value?.loginMethods ?? [])

/** Chosen per setup rather than remembered: the list belongs to the host and can change under it. */
function openSetup() {
  setupMethod.value = loginMethods.value[0]?.id ?? ''
  setupDialog.value?.showModal()
}

async function confirmSetup() {
  if (!agent.value || !setupMethod.value) return
  setupDialog.value?.close()
  await run(() => agentStore.setupAgent(agent.value!.id, setupMethod.value))
}

function openEdit() {
  if (!agent.value) return
  draft.value = { label: agent.value.label }
  editError.value = null
  editDialog.value?.showModal()
}

/**
 * Where the agent plays, as its own dialog.
 *
 * Separate from the rename because it is a different kind of change: it decides what the next
 * connection targets, so the backend refuses it while the agent is online, where a rename is always
 * allowed. Clearing the field unassigns, which leaves the agent set up and idle.
 */
const serverDialog = ref<HTMLDialogElement | null>(null)
const serverDraft = ref('')
const serverError = ref<string | null>(null)

function openServer() {
  if (!agent.value) return
  serverDraft.value = agent.value.serverAddress ?? ''
  serverError.value = null
  serverDialog.value?.showModal()
}

async function saveServer() {
  if (!agent.value) return
  serverError.value = null
  try {
    await agentStore.assignServer(agent.value.id, serverDraft.value.trim() || null)
    serverDialog.value?.close()
  } catch (failure) {
    serverError.value = failure instanceof Error ? failure.message : t('errors.assignServer')
  }
}

async function saveEdit() {
  if (!agent.value) return
  editError.value = null
  try {
    await agentStore.updateAgent(agent.value.id, {
      label: draft.value.label,
    })
    editDialog.value?.close()
  } catch (failure) {
    editError.value = failure instanceof Error ? failure.message : t('errors.updateAgent')
  }
}

async function confirmRemove() {
  if (!agent.value) return
  try {
    await agentStore.removeAgent(agent.value.id)
    removeDialog.value?.close()
    void router.push({ name: 'dashboard' })
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.removeAgent')
    removeDialog.value?.close()
  }
}
</script>

<template>
  <div v-if="agent" class="mx-auto flex max-w-6xl flex-col gap-6">
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div class="flex items-center gap-4">
        <PlayerHead :id="agent.mcUuid ?? agent.mcUsername" :name="agent.label" size="lg" />
        <div>
        <h1 class="text-2xl leading-tight font-semibold tracking-tight">{{ agent.label }}</h1>
        <!--
          One line: the Minecraft account, where it plays, and the host running it. Each is named
          when absent rather than dropped — before setup there is no account and an agent assigned
          nowhere has no server, and both are answers somebody is looking for rather than gaps.
        -->
        <p class="flex flex-wrap items-center gap-2 text-sm opacity-60">
          <span v-if="agent.mcUsername" class="font-mono">{{ agent.mcUsername }}</span>
          <span v-else class="italic">{{ t('agents.notLinked') }}</span>
          <span>·</span>
          <span :class="agent.serverAddress ? '' : 'italic'">
            {{ agent.serverAddress ?? t('agents.noServer') }}
          </span>
          <span>·</span>
          <span>{{ agent.hostName }}</span>
        </p>
        </div>
      </div>

      <div class="flex items-center gap-4 text-right">
        <div>
          <div class="text-xs uppercase opacity-50">{{ t('common.status') }}</div>
          <!--
            The state is the one thing on this page that changes without the operator doing it —
            a host reporting a disconnect, a relink coming through. The vitals beside it change
            every second, which is why nothing there flashes: constant motion carries no news.
          -->
          <span v-flash="agent.state" class="badge badge-sm" :class="STATE_BADGE[agent.state]">
            {{ stateLabel(agent.state) }}
          </span>
        </div>
        <div>
          <div class="text-xs uppercase opacity-50">{{ t('agents.uptime') }}</div>
          <div class="flex items-center gap-1 font-medium tabular-nums">
            <Clock class="size-3.5 opacity-50" />
            {{ uptimeOf(agent) }}
          </div>
        </div>
        <!-- Reshaping and destroying are separate authorities, so they are separate checks. -->
        <div
          v-if="auth.can('agent.write') || auth.can('agent.delete')"
          class="flex gap-1"
        >
          <template v-if="auth.can('agent.write')">
            <button class="btn btn-ghost btn-sm gap-1" @click="openServer">
              <Server class="size-4" />
              {{ t('agents.setServer') }}
            </button>
            <button class="btn btn-ghost btn-sm gap-1" @click="openEdit">
              <SquarePen class="size-4" />
              {{ t('common.edit') }}
            </button>
          </template>
          <button
            v-if="auth.can('agent.delete')"
            class="btn btn-ghost btn-sm text-error gap-1"
            @click="removeDialog?.showModal()"
          >
            <Trash2 class="size-4" />
            {{ t('common.delete') }}
          </button>
        </div>
      </div>
    </header>

    <div v-if="error" role="alert" class="alert alert-error alert-soft">
      <TriangleAlert class="size-4" />
      <span>{{ error }}</span>
    </div>

    <div v-if="!hostReachable" role="alert" class="alert alert-warning alert-soft">
      <TriangleAlert class="size-4 shrink-0" />
      <span>{{ t('agents.hostOffline', { host: agent.hostName }) }}</span>
    </div>

    <div
      v-else-if="agent.state === 'UNLINKED' || agent.state === 'NEEDS_RELINK'"
      role="alert"
      class="alert alert-info alert-soft"
    >
      <KeyRound class="size-4 shrink-0" />
      <span>
        {{ t('agents.notSetUp') }}
      </span>
    </div>

    <!--
      Vitals are the host's, and absent until it reports. Nothing is invented in their place: an
      agent showing 0/20 health at 0,0,0 is a much more convincing lie than an empty panel.
    -->
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-4">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Agent class="text-primary size-4" />
          {{ t('agents.stats') }}
        </h2>

        <p v-if="!vitals" class="py-6 text-center text-sm opacity-50">{{ t('agents.noTelemetry') }}</p>

        <template v-else>
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="flex items-center gap-3">
            <Heart class="text-error size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="flex justify-between text-xs opacity-60">
                <span>{{ t('agents.health') }}</span>
                <span class="tabular-nums">{{ vitals.health }} / 20</span>
              </div>
              <progress class="progress progress-error mt-1 w-full" :value="healthPercent" max="100"></progress>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <Beef class="text-warning size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="flex justify-between text-xs opacity-60">
                <span>{{ t('agents.food') }}</span>
                <span class="tabular-nums">{{ vitals.food }} / 20</span>
              </div>
              <progress class="progress progress-warning mt-1 w-full" :value="foodPercent" max="100"></progress>
            </div>
          </div>
        </div>

        <div class="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <MapPin class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">{{ t('agents.position') }}</span>
              <span class="block truncate font-mono text-sm tabular-nums">
                {{ formatPosition(vitals.position) }}
              </span>
            </span>
          </div>
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <Layers class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">{{ t('agents.dimension') }}</span>
              <span class="block truncate text-sm">{{ vitals.dimension }}</span>
            </span>
          </div>
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <Signal class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">{{ t('agents.ping') }}</span>
              <span class="block truncate text-sm tabular-nums">{{ vitals.pingMs }} ms</span>
            </span>
          </div>
          <!-- Still mock: nothing reports build progress until the schematic pipeline lands. -->
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <Hammer class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">{{ t('agents.blocksPlaced') }}</span>
              <span class="block truncate text-sm tabular-nums">
                {{ agent.build.blocksPlaced.toLocaleString() }}
              </span>
            </span>
          </div>
        </div>
        </template>
      </div>
    </div>

    <!-- Nearby players -->
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-3">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Users class="text-primary size-4" />
          {{ t('agents.nearbyPlayers') }}
          <span class="badge badge-ghost badge-sm">{{ vitals?.nearby.length ?? 0 }}</span>
        </h2>

        <ul v-if="vitals?.nearby.length" class="flex flex-col gap-1">
          <li
            v-for="player in vitals.nearby"
            :key="player.name"
            class="rounded-field bg-base-300/30 flex items-center gap-3 px-3 py-2"
          >
            <!-- A name is what the host reports for a nearby player; there is no UUID to key on. -->
            <PlayerHead :id="player.name" :name="player.name" size="sm" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ player.name }}</span>
              <!--
                Only when the host sent one. A player without coordinates is still worth listing —
                that somebody is there is the point — so the line simply loses its second row.
              -->
              <span v-if="player.position" class="block font-mono text-xs tabular-nums opacity-40">
                {{ formatPosition(player.position) }}
              </span>
            </span>
            <span v-if="player.isAgent" class="badge badge-primary badge-soft badge-xs">{{ t('agents.agentTag') }}</span>
            <span class="text-xs tabular-nums opacity-50">{{ player.distance.toFixed(1) }} m</span>
          </li>
        </ul>

        <p v-else class="py-6 text-center text-sm opacity-50">{{ t('agents.noNearby') }}</p>
      </div>
    </div>

    <!-- Activity: incidents, kept out of chat so they are not buried -->
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-3">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Activity class="text-primary size-4" />
          {{ t('agents.activity') }}
        </h2>

        <div ref="activityBox" class="flex max-h-72 flex-col gap-1 overflow-y-auto">
          <!-- Insertions animate, the first render does not. See the dashboard for the full note. -->
          <TransitionGroup name="feed" tag="div" class="flex flex-col gap-1">
            <div
              v-for="line in activity"
              :key="line.id"
              class="rounded-field bg-base-300/30 flex items-center gap-3 px-3 py-2 text-sm"
            >
              <span class="shrink-0 font-mono text-xs opacity-40">{{ formatTime(line.at) }}</span>
              <span class="size-1.5 shrink-0 rounded-full" :class="SEVERITY_DOT[line.severity]"></span>
              <span class="min-w-0 flex-1">{{ line.text }}</span>
            </div>
          </TransitionGroup>

          <p v-if="activityLoading" class="py-6 text-center text-sm opacity-50">
            {{ t('common.loading') }}
          </p>
          <p v-else-if="!activity.length" class="py-6 text-center text-sm opacity-50">
            {{ t('agents.noActivity') }}
          </p>

          <!-- Reaching this fetches the next, older page. See src/lib/feed.ts. -->
          <div ref="activitySentinel" aria-hidden="true" class="h-px shrink-0"></div>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-4">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Power class="text-primary size-4" />
          {{ t('common.actions') }}
        </h2>

        <div class="flex flex-wrap gap-2">
          <button
            v-if="auth.can('agent.setup')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || !hostReachable || agent.state === 'SETUP_PENDING' || isOnline(agent)"
            @click="openSetup"
          >
            <KeyRound class="size-4" />
            {{ t('agents.setUp') }}
          </button>
          <!-- No server is nowhere to connect to, and the backend refuses it with a 409. -->
          <button
            v-if="auth.can('agent.run')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || !hostReachable || !agent.serverAddress || isOnline(agent) || agent.state === 'UNLINKED' || agent.state === 'SETUP_PENDING'"
            @click="run(() => agentStore.connect(agent!.id))"
          >
            <RotateCw class="size-4" />
            {{ t('agents.connect') }}
          </button>
          <button
            v-if="auth.can('agent.run')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || !hostReachable || !isOnline(agent)"
            @click="run(() => agentStore.disconnect(agent!.id))"
          >
            <Power class="size-4" />
            {{ t('agents.disconnect') }}
          </button>

          <!--
            The conversation itself is the rail's, not this page's — one panel, wherever it is
            pointed. This aims it here, so the page still leads to the chat without carrying a
            second copy of it.
          -->
          <button
            v-if="auth.can('chat.read')"
            class="btn btn-soft btn-sm gap-2"
            @click="chat.show({ kind: 'agent', id: agent.id })"
          >
            <MessageSquare class="size-4" />
            {{ t('agents.chat') }}
          </button>
        </div>
      </div>
    </div>

    <dialog ref="editDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <SquarePen class="text-primary size-5" />
          {{ t('agents.editTitle', { name: agent.label }) }}
        </h3>
        <p class="mt-1 text-sm opacity-60">{{ t('agents.editHint') }}</p>
        <form class="mt-5 flex flex-col gap-4" @submit.prevent="saveEdit">
          <FormField
            v-model="draft.label"
            :label="t('agents.label')"
            :icon="Agent"
            type="text"
            maxlength="64"
            required
          />
          <div v-if="editError" role="alert" class="alert alert-error alert-soft">
            <TriangleAlert class="size-4" />
            <span>{{ editError }}</span>
          </div>

          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="editDialog?.close()">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary btn-sm" type="submit">{{ t('common.save') }}</button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>

    <dialog ref="serverDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <Server class="text-primary size-5" />
          {{ t('agents.setServerTitle', { name: agent.label }) }}
        </h3>
        <p class="mt-1 text-sm opacity-60">{{ t('agents.setServerHint') }}</p>
        <form class="mt-5 flex flex-col gap-4" @submit.prevent="saveServer">
          <FormField
            v-model="serverDraft"
            :label="t('agents.server')"
            :placeholder="t('agents.serverPlaceholder')"
            :icon="Server"
            type="text"
            :disabled="isOnline(agent)"
          />
          <!-- Emptying the field is how an agent is taken off a server, so it is said out loud. -->
          <p class="text-xs opacity-60">
            {{ isOnline(agent) ? t('agents.moveOffline') : t('agents.unassignHint') }}
          </p>

          <div v-if="serverError" role="alert" class="alert alert-error alert-soft">
            <TriangleAlert class="size-4" />
            <span>{{ serverError }}</span>
          </div>

          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="serverDialog?.close()">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary btn-sm" type="submit" :disabled="isOnline(agent)">
              {{ t('common.save') }}
            </button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>

    <dialog ref="setupDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <KeyRound class="text-primary size-5" />
          {{ t('agents.setUpTitle', { name: agent.label }) }}
        </h3>
        <p class="mt-3 text-sm opacity-70">{{ t('agents.setUpBody', { host: agent.hostName }) }}</p>

        <!--
          The host's list, not ours. Its copy comes from the host too: it is the only party that
          knows what its mechanisms are, so it is the only one that can describe them. The id is
          shown when it sends none, which is at least the string it will be asked to act on.
        -->
        <ul v-if="loginMethods.length" class="list bg-base-100 border-base-300 mt-4 rounded-box border">
          <li v-for="method in loginMethods" :key="method.id" class="list-row items-center">
            <label class="flex w-full cursor-pointer items-center gap-3">
              <input
                v-model="setupMethod"
                type="radio"
                :value="method.id"
                class="radio radio-sm radio-primary"
              />
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium">{{ method.label || method.id }}</span>
                <span v-if="method.description" class="block text-xs opacity-60">
                  {{ method.description }}
                </span>
              </span>
            </label>
          </li>
        </ul>

        <div v-else role="alert" class="alert alert-warning alert-soft mt-4 text-sm">
          <TriangleAlert class="size-4 shrink-0" />
          <span>{{ t('agents.noLoginMethods', { host: agent.hostName }) }}</span>
        </div>

        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="setupDialog?.close()">{{ t('common.cancel') }}</button>
          <button
            class="btn btn-primary btn-sm gap-2"
            type="button"
            :disabled="!setupMethod"
            @click="confirmSetup"
          >
            <KeyRound class="size-4" />
            {{ t('agents.setUpStart') }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>

    <dialog ref="removeDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <TriangleAlert class="text-error size-5" />
          Delete {{ agent.label }}?
        </h3>
        <p class="mt-3 text-sm opacity-70">
          {{ t('agents.removeWarning', { host: agent.hostName }) }}
        </p>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="removeDialog?.close()">{{ t('common.cancel') }}</button>
          <button class="btn btn-error btn-sm gap-2" type="button" @click="confirmRemove">
            <Trash2 class="size-4" />
            {{ t('common.delete') }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>
  </div>

  <!--
    Loading before missing. On a reload or a deep link the fleet has not arrived yet, and "not
    found" is a claim this page is in no position to make until it has.
  -->
  <div v-else-if="!agentStore.loaded" class="mx-auto flex max-w-6xl flex-col gap-6">
    <div class="flex flex-col gap-2">
      <div class="skeleton h-8 w-64"></div>
      <div class="skeleton h-4 w-40"></div>
    </div>
    <div class="skeleton h-32 w-full"></div>
    <div class="grid gap-6 lg:grid-cols-2">
      <div class="skeleton h-64 w-full"></div>
      <div class="skeleton h-64 w-full"></div>
    </div>
  </div>

  <div v-else class="mx-auto max-w-6xl">
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body items-center gap-2 py-20 text-center">
        <Agent class="size-8 opacity-30" />
        <p class="text-sm opacity-50">{{ t('agents.notFound') }}</p>
      </div>
    </div>
  </div>
</template>
