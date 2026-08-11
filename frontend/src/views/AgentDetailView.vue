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
  Send,
  Server,
  Signal,
  SquarePen,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-vue-next'
import FormField from '../components/FormField.vue'
import type { ActivityEntryResponse, ChatMessageResponse } from '../api/client'
import { fetchActivityPage, fetchChatPage } from '../api/feeds'
import { useFeed, useInfiniteScroll } from '../lib/feed'
import { STATE_BADGE, stateLabel } from '../lib/agentState'
import { LOGIN_METHOD_IDS } from '../lib/loginMethods'
import { isOnline, uptimeOf, useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const agentStore = useAgentStore()
const auth = useAuthStore()

const message = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

const editDialog = ref<HTMLDialogElement | null>(null)
const removeDialog = ref<HTMLDialogElement | null>(null)
const setupDialog = ref<HTMLDialogElement | null>(null)
const draft = ref({ label: '', serverAddress: '' })
const editError = ref<string | null>(null)
const setupMethod = ref(LOGIN_METHOD_IDS[0])

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
 * This agent's own feeds. Chat here is what was said **to or about this agent**; the server's global
 * chat is on the dashboard, since it is identical for every agent on the server and would bury the
 * lines that are actually about this one.
 *
 * Both are fixed-height panels rather than the whole page, so each scrolls its own older pages in.
 */
const agentId = computed(() => Number(route.params.id))

const chatBox = ref<HTMLElement | null>(null)
const chatSentinel = ref<HTMLElement | null>(null)
const activityBox = ref<HTMLElement | null>(null)
const activitySentinel = ref<HTMLElement | null>(null)

const chatFeed = useFeed<ChatMessageResponse>((cursor) =>
  fetchChatPage(cursor, { agentId: agentId.value }),
)
const activityFeed = useFeed<ActivityEntryResponse>((cursor) =>
  fetchActivityPage(cursor, agentId.value),
)
const { items: chat, loading: chatLoading, exhausted: chatExhausted } = chatFeed
const {
  items: activity,
  loading: activityLoading,
  exhausted: activityExhausted,
} = activityFeed

const chatScroll = useInfiniteScroll(chatSentinel, () => void moreChat(), chatBox)
const activityScroll = useInfiniteScroll(activitySentinel, () => void moreActivity(), activityBox)

let stopListening: (() => void) | null = null

onMounted(async () => {
  if (!agent.value) void agentStore.refresh()

  await Promise.all([chatFeed.reset(), activityFeed.reset()])
  chatScroll.start()
  activityScroll.start()

  stopListening = agentStore.onFeedEvent((name, data) => {
    if (name === 'chat') {
      const line = data as ChatMessageResponse
      // Global arrives under whichever agent forwards it, and belongs to the server, not here.
      if (line.agentId === agentId.value && line.scope !== 'GLOBAL') chatFeed.prepend(line)
      return
    }
    const entry = data as ActivityEntryResponse
    if (entry.agentId === agentId.value) activityFeed.prepend(entry)
  })
})

onBeforeUnmount(() => stopListening?.())

async function moreChat(): Promise<void> {
  await chatFeed.more()
  if (!chatExhausted.value) await chatScroll.rearm()
}

async function moreActivity(): Promise<void> {
  await activityFeed.more()
  if (!activityExhausted.value) await activityScroll.rearm()
}

/** Time only: chat is kept three days and activity ten, so the clock is what locates a line. */
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

async function send() {
  if (!agent.value) return
  const text = message.value
  await run(() => agentStore.say(agent.value!.id, text))
  if (!error.value) message.value = ''
}

/**
 * The method is chosen per setup rather than remembered: nothing on the host advertises what it can
 * perform, so the operator is the only one who knows which mechanism will work there.
 */
function openSetup() {
  setupMethod.value = LOGIN_METHOD_IDS[0]
  setupDialog.value?.showModal()
}

async function confirmSetup() {
  if (!agent.value) return
  setupDialog.value?.close()
  await run(() => agentStore.setupAgent(agent.value!.id, setupMethod.value))
}

function openEdit() {
  if (!agent.value) return
  draft.value = { label: agent.value.label, serverAddress: agent.value.serverAddress }
  editError.value = null
  editDialog.value?.showModal()
}

async function saveEdit() {
  if (!agent.value) return
  editError.value = null
  try {
    await agentStore.updateAgent(agent.value.id, {
      label: draft.value.label,
      serverAddress: draft.value.serverAddress,
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
  <div v-if="agent" class="mx-auto flex max-w-5xl flex-col gap-6">
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl leading-tight font-semibold tracking-tight">{{ agent.label }}</h1>
        <p class="flex flex-wrap items-center gap-2 text-sm opacity-60">
          <span class="flex items-center gap-1">
            <Server class="size-3.5" />
            {{ agent.serverAddress }}
          </span>
          <span>·</span>
          <span>{{ agent.hostName }}</span>
          <template v-if="agent.mcUsername">
            <span>·</span>
            <span class="font-mono">{{ agent.mcUsername }}</span>
          </template>
        </p>
      </div>

      <div class="flex items-center gap-4 text-right">
        <div>
          <div class="text-xs uppercase opacity-50">{{ t('common.status') }}</div>
          <span class="badge badge-sm" :class="STATE_BADGE[agent.state]">{{ stateLabel(agent.state) }}</span>
        </div>
        <div>
          <div class="text-xs uppercase opacity-50">{{ t('agents.uptime') }}</div>
          <div class="flex items-center gap-1 font-medium tabular-nums">
            <Clock class="size-3.5 opacity-50" />
            {{ uptimeOf(agent) }}
          </div>
        </div>
        <div v-if="auth.can('fleet.control')" class="flex gap-1">
          <button class="btn btn-ghost btn-sm gap-1" @click="openEdit">
            <SquarePen class="size-4" />
            {{ t('common.edit') }}
          </button>
          <button class="btn btn-ghost btn-sm text-error gap-1" @click="removeDialog?.showModal()">
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
                {{ Math.round(vitals.position.x) }}, {{ Math.round(vitals.position.y) }},
                {{ Math.round(vitals.position.z) }}
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
            <span class="flex-1 truncate text-sm font-medium">{{ player.name }}</span>
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
          <div
            v-for="line in activity"
            :key="line.id"
            class="rounded-field bg-base-300/30 flex items-center gap-3 px-3 py-2 text-sm"
          >
            <span class="shrink-0 font-mono text-xs opacity-40">{{ formatTime(line.at) }}</span>
            <span class="size-1.5 shrink-0 rounded-full" :class="SEVERITY_DOT[line.severity]"></span>
            <span class="min-w-0 flex-1">{{ line.text }}</span>
          </div>

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
            v-if="auth.can('fleet.login')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || !hostReachable || agent.state === 'SETUP_PENDING' || isOnline(agent)"
            @click="openSetup"
          >
            <KeyRound class="size-4" />
            {{ t('agents.setUp') }}
          </button>
          <button
            v-if="auth.can('fleet.control')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || !hostReachable || isOnline(agent) || agent.state === 'UNLINKED' || agent.state === 'SETUP_PENDING'"
            @click="run(() => agentStore.connect(agent!.id))"
          >
            <RotateCw class="size-4" />
            {{ t('agents.connect') }}
          </button>
          <button
            v-if="auth.can('fleet.control')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || !hostReachable || !isOnline(agent)"
            @click="run(() => agentStore.disconnect(agent!.id))"
          >
            <Power class="size-4" />
            {{ t('agents.disconnect') }}
          </button>
        </div>

        <div class="divider my-0"></div>

        <div class="flex items-center gap-2 text-sm font-medium opacity-70">
          <MessageSquare class="size-4" />
          {{ t('agents.chat') }}
          <span class="text-xs font-normal opacity-60">{{ t('agents.chatHint') }}</span>
        </div>

        <div
          ref="chatBox"
          class="rounded-box bg-base-300/25 flex max-h-64 flex-col gap-1 overflow-y-auto p-3"
        >
          <p v-for="line in chat" :key="line.id" class="text-sm">
            <span class="font-mono text-xs opacity-40">{{ formatTime(line.at) }}</span>
            <span class="ml-2 font-medium">{{ line.from }}:</span>
            <span class="ml-1 opacity-80">{{ line.text }}</span>
          </p>

          <p v-if="chatLoading" class="py-4 text-center text-sm opacity-50">
            {{ t('common.loading') }}
          </p>
          <p v-else-if="!chat.length" class="py-4 text-center text-sm opacity-50">
            {{ t('dashboard.noChat') }}
          </p>

          <!-- Reaching this fetches the next, older page. See src/lib/feed.ts. -->
          <div ref="chatSentinel" aria-hidden="true" class="h-px shrink-0"></div>
        </div>

        <form v-if="auth.can('fleet.chat')" class="flex gap-2" @submit.prevent="send">
          <input
            v-model="message"
            class="input w-full"
            type="text"
            :placeholder="t('agents.chatPlaceholder')"
            :disabled="busy || !hostReachable || !isOnline(agent)"
          />
          <button
            class="btn btn-primary gap-2"
            type="submit"
            :disabled="busy || !hostReachable || !isOnline(agent) || !message.trim()"
          >
            <Send class="size-4" />
            {{ t('agents.send') }}
          </button>
        </form>
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
          <FormField
            v-model="draft.serverAddress"
            :label="t('agents.server')"
            :placeholder="t('agents.serverPlaceholder')"
            :icon="Server"
            type="text"
            required
            :disabled="isOnline(agent)"
          />
          <p v-if="isOnline(agent)" class="text-xs opacity-60">
            {{ t('agents.moveOffline') }}
          </p>

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

    <dialog ref="setupDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <KeyRound class="text-primary size-5" />
          {{ t('agents.setUpTitle', { name: agent.label }) }}
        </h3>
        <p class="mt-3 text-sm opacity-70">{{ t('agents.setUpBody', { host: agent.hostName }) }}</p>

        <ul class="list bg-base-100 border-base-300 mt-4 rounded-box border">
          <li v-for="id in LOGIN_METHOD_IDS" :key="id" class="list-row items-center">
            <label class="flex w-full cursor-pointer items-center gap-3">
              <input v-model="setupMethod" type="radio" :value="id" class="radio radio-sm radio-primary" />
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium">{{ t(`loginMethod.${id}.label`) }}</span>
                <span class="block text-xs opacity-60">{{ t(`loginMethod.${id}.description`) }}</span>
              </span>
            </label>
          </li>
        </ul>

        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="setupDialog?.close()">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary btn-sm gap-2" type="button" @click="confirmSetup">
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

  <div v-else class="mx-auto max-w-5xl">
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body items-center gap-2 py-20 text-center">
        <Agent class="size-8 opacity-30" />
        <p class="text-sm opacity-50">{{ t('agents.notFound') }}</p>
      </div>
    </div>
  </div>
</template>
