<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  Activity,
  Beef,
  Bot as Agent,
  Clock,
  Hammer,
  Heart,
  ChevronLeft,
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
import { agentBadge, agentStateLabel } from '../lib/agentState'
import { dimensionLabel } from '../lib/vitals'
import { prefersReducedMotion, vFlash } from '../lib/motion'
import { isOnline, uptimeOf, useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'
import { useChatStore } from '../stores/chat'
import { useToastStore } from '../stores/toasts'
import { atTime } from '../lib/time'

const { t, n } = useI18n()
const route = useRoute()
const router = useRouter()
const agentStore = useAgentStore()
const auth = useAuthStore()
const chat = useChatStore()
const toasts = useToastStore()

const error = ref<string | null>(null)
const busy = ref(false)

const editDialog = ref<HTMLDialogElement | null>(null)
const removeDialog = ref<HTMLDialogElement | null>(null)
const setupDialog = ref<HTMLDialogElement | null>(null)
const draft = ref({ label: '' })
const editError = ref<string | null>(null)
const setupMethod = ref('')

const agent = computed(() => agentStore.byId(Number(route.params.id)))

/** What this agent is building, or null. Read once rather than three times in the template. */
const assignment = computed(() => (agent.value ? agentStore.assignmentOf(agent.value.id) : null))

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

/**
 * Somebody walking up to an agent, and away from it.
 *
 * A list one line long, updated every few seconds, so the arrival has to be long enough to read
 * as an event rather than a redraw — and no more than that. It travels three quarters of a line
 * on a plain ease-out: a sharper curve reads as the row being fired in, and the tint this used to
 * arrive with read as a warning about a player who is simply standing there.
 *
 * The departure is taken out of the flow first — otherwise the row holds its space until the fade
 * ends and the card jerks afterwards — and it is quicker than the arrival, so the two do not
 * overlap in the one place a one-line list has to put them.
 */
function playerIn(el: Element, done: () => void) {
  if (prefersReducedMotion()) {
    done()
    return
  }

  const arrival = el.animate(
    [
      { opacity: 0, translate: "-0.75rem 0" },
      { opacity: 1, translate: "0 0" },
    ],
    { duration: 300, easing: "ease-out" },
  )

  // Either ending has to let the row go: a hook that never calls back leaves it mid-animation.
  arrival.onfinish = done
  arrival.oncancel = done
}

function playerOut(el: Element, done: () => void) {
  const row = el as HTMLElement

  if (prefersReducedMotion()) {
    done()
    return
  }

  // Out of the flow before it fades, so the rows below close the gap while it is still going.
  const { offsetTop, offsetWidth } = row
  row.style.position = "absolute"
  row.style.top = `${offsetTop}px`
  row.style.width = `${offsetWidth}px`

  const departure = row.animate([{ opacity: 1 }, { opacity: 0, translate: "-1rem 0" }], {
    duration: 160,
    easing: "ease-in",
  })

  departure.onfinish = done
  departure.oncancel = done
}

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

/**
 * Navigating from one agent to the next is the same route with a different id, so this component
 * is kept and reused — and the feed it opened on mount goes on showing the first agent's history
 * under the second one’s name. The page has to notice the change itself.
 */
watch(agentId, async () => {
  await activityFeed.reset()
  await activityScroll.rearm()
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

/**
 * Why each action is unavailable, or null when it is not.
 *
 * Connect carried five separate disabling conditions inline and showed none of them: the button was
 * simply grey. The schematic wizard three files away does the opposite and says so out loud —
 * *"a disabled button with no reason is the interface declining to explain itself"* — and the
 * principle was right, it just had never been applied here.
 *
 * Ordered most fundamental first, so an unreachable host is named once rather than each action
 * reporting whichever of its own preconditions it happened to check first. The same shape as
 * `ChatPanel`'s `blocked`, which answers the same question for the send box.
 */
const setupBlocked = computed<string | null>(() => {
  if (!agent.value) return null
  if (!hostReachable.value) return t('agents.blockedHost', { host: agent.value.hostName })
  if (agent.value.state === 'SETUP_PENDING') return t('agents.blockedSettingUp')
  if (isOnline(agent.value)) return t('agents.blockedOnlineSetup')
  return null
})

const connectBlocked = computed<string | null>(() => {
  if (!agent.value) return null
  if (!hostReachable.value) return t('agents.blockedHost', { host: agent.value.hostName })
  if (agent.value.state === 'CONNECTING') return t('agents.blockedConnecting')
  if (isOnline(agent.value)) return t('agents.blockedAlreadyOnline')
  if (agent.value.state === 'SETUP_PENDING') return t('agents.blockedSettingUp')
  if (agent.value.state === 'UNLINKED') return t('agents.blockedUnlinked')
  if (!agent.value.serverAddress) return t('agents.blockedNoServer')
  return null
})

const disconnectBlocked = computed<string | null>(() => {
  if (!agent.value) return null
  if (!hostReachable.value) return t('agents.blockedHost', { host: agent.value.hostName })
  if (!isOnline(agent.value)) return t('agents.blockedNotOnline')
  return null
})

/**
 * The reasons worth printing under the row, without repeating one that applies to everything.
 *
 * Only for actions this operator can actually see: naming a precondition of a button that is not
 * on their screen explains nothing and reads as a fault.
 */
const blockedReasons = computed(() => {
  const shown = [
    auth.can('agent.setup') ? setupBlocked.value : null,
    auth.can('agent.run') ? connectBlocked.value : null,
    auth.can('agent.run') ? disconnectBlocked.value : null,
  ].filter((reason): reason is string => reason !== null)

  // An unreachable host blocks all three and would otherwise be printed three times.
  return [...new Set(shown)]
})

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

/**
 * Each of these guards on its own flag, and each disables its buttons for the round trip.
 *
 * They stayed live throughout, so a second press sent a second request. Harmless on a rename and
 * not on a delete, and in every case the operator had no way to tell a slow request from an
 * unresponsive button — which is exactly what invites the second press.
 */
const serverBusy = ref(false)
const editBusy = ref(false)
const removeBusy = ref(false)

async function saveServer() {
  if (!agent.value || serverBusy.value) return
  serverBusy.value = true
  serverError.value = null
  try {
    await agentStore.assignServer(agent.value.id, serverDraft.value.trim() || null)
    serverDialog.value?.close()
  } catch (failure) {
    serverError.value = failure instanceof Error ? failure.message : t('errors.assignServer')
  } finally {
    serverBusy.value = false
  }
}

async function saveEdit() {
  if (!agent.value || editBusy.value) return
  editBusy.value = true
  editError.value = null
  try {
    await agentStore.updateAgent(agent.value.id, {
      label: draft.value.label,
    })
    editDialog.value?.close()
  } catch (failure) {
    editError.value = failure instanceof Error ? failure.message : t('errors.updateAgent')
  } finally {
    editBusy.value = false
  }
}

async function confirmRemove() {
  if (!agent.value || removeBusy.value) return
  removeBusy.value = true
  try {
    const removed = agent.value.label
    await agentStore.removeAgent(agent.value.id)
    removeDialog.value?.close()
    // Same reason as a removed host: the page that would have shown this is the one being left.
    toasts.notify('success', 'toast.agentRemoved', { params: { name: removed } })
    void router.push({ name: 'dashboard' })
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.removeAgent')
    removeDialog.value?.close()
  } finally {
    removeBusy.value = false
  }
}
</script>

<template>
  <div v-if="agent" class="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-6 overflow-y-auto">
    <!-- The same way back the host page offers, from the page it is the sibling of. -->
    <RouterLink :to="{ name: 'resources' }" class="btn btn-ghost btn-sm w-fit gap-1 px-2">
      <ChevronLeft class="size-4" />
      {{ t('resources.title') }}
    </RouterLink>
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
          <span
            v-flash="agent.state"
            class="badge badge-sm"
            :class="agentBadge(agent.state, agentStore.isBuilding(agent.id))"
          >
            {{ agentStateLabel(agent.state, agentStore.isBuilding(agent.id)) }}
          </span>
          <!-- Which piece of which build, spelled out: this page has the room the fleet table did not. -->
          <RouterLink
            v-if="assignment"
            :to="{ name: 'operations', query: { tab: 'jobs' } }"
            class="link-hover mt-1 block text-xs opacity-60"
          >
            {{
              t('agents.buildingOn', {
                build: assignment?.buildName,
                ordinal: assignment?.ordinal,
              })
            }}
          </RouterLink>
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

        <p v-if="!vitals" class="py-10 text-center text-sm opacity-50">{{ t('agents.noTelemetry') }}</p>

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
              <span class="block truncate text-sm">{{ dimensionLabel(vitals.dimension) }}</span>
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
              <!--
                Its own segment, not a fleet total and not an invented one. An agent building
                nothing says so rather than showing a zero, which reads as a stalled builder.
              -->
              <span v-if="assignment" class="block truncate text-sm tabular-nums">
                {{ n(assignment.blocksPlaced) }} / {{ n(assignment.blocks) }}
              </span>
              <span v-else class="block truncate text-sm italic opacity-50">
                {{ t('agents.notBuilding') }}
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

        <!--
          Always mounted, empty or not, and **without** `appear`. A list that is drawn only once
          it has somebody in it mounts holding its first arrival, which a group does not animate —
          and telling it to animate what it was born with means the whole list plays every time
          the page is opened. Kept alive instead, the first player to walk up is an insertion like
          any other, and arriving at the page is not an event at all.
        -->
        <!--
          Animated by hand rather than by class.

          Three CSS attempts at this did nothing an operator could see, and the reason each time
          was invisible from the stylesheet: a departure drawn over the arrival, a distance too
          small to read on a one-line list, a rule that resolved to nothing at all. The Web
          Animations call cannot half-work — it either runs and calls `done`, or it throws.
        -->
        <TransitionGroup
          tag="ul"
          class="relative flex flex-col gap-1"
          :css="false"
          @enter="playerIn"
          @leave="playerOut"
        >
          <li
            v-for="player in vitals?.nearby ?? []"
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
        </TransitionGroup>

        <!-- The height of one row: the first player to walk up must not also resize the card. -->
        <p
          v-if="!vitals?.nearby.length"
          class="flex min-h-13 items-center justify-center text-sm opacity-50"
        >
          {{ t('agents.noNearby') }}
        </p>
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
              <span class="shrink-0 font-mono text-xs opacity-40">{{ atTime(line.at) }}</span>
              <span class="size-1.5 shrink-0 rounded-full" :class="SEVERITY_DOT[line.severity]"></span>
              <span class="min-w-0 flex-1">{{ line.text }}</span>
            </div>
          </TransitionGroup>

          <p v-if="activityLoading" class="py-10 text-center text-sm opacity-50">
            {{ t('common.loading') }}
          </p>
          <p v-else-if="!activity.length" class="py-10 text-center text-sm opacity-50">
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

        <!--
          The way out of a setup that is never going to finish.

          SETUP_PENDING is open-ended on purpose — the backend cannot see how far along a login is,
          so nothing can honestly time it out — and that made it a dead end: a sign-in started on the
          wrong machine, or one whose device code expired, left the agent pending forever with the
          Set-up button disabled *because a setup was in progress*.

          The copy is careful about what this does. It stops Osmium waiting; it does not reach into
          the host and cancel anything, and a login finished afterwards still links the agent.
        -->
        <div
          v-if="agent.state === 'SETUP_PENDING' && auth.can('agent.setup')"
          role="status"
          class="alert alert-info alert-soft items-start"
        >
          <KeyRound class="mt-0.5 size-4 shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="block font-medium">{{ t('agents.pendingTitle', { host: agent.hostName }) }}</span>
            <span class="block text-sm opacity-80">{{ t('agents.pendingBody') }}</span>
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            :disabled="busy"
            @click="run(() => agentStore.cancelSetup(agent!.id))"
          >
            {{ t('agents.stopWaiting') }}
          </button>
        </div>

        <div class="flex flex-wrap gap-2">
          <!--
            Each carries its reason on the title as well as in the line under the row, so hovering a
            grey button answers the question where it was asked.
          -->
          <button
            v-if="auth.can('agent.setup')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || setupBlocked !== null"
            :title="setupBlocked ?? ''"
            @click="openSetup"
          >
            <KeyRound class="size-4" />
            {{ t('agents.setUp') }}
          </button>
          <button
            v-if="auth.can('agent.run')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || connectBlocked !== null"
            :title="connectBlocked ?? ''"
            @click="run(() => agentStore.connect(agent!.id))"
          >
            <RotateCw class="size-4" :class="agent.state === 'CONNECTING' ? 'animate-spin' : ''" />
            {{ agent.state === 'CONNECTING' ? t('agents.connecting') : t('agents.connect') }}
          </button>
          <button
            v-if="auth.can('agent.run')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || disconnectBlocked !== null"
            :title="disconnectBlocked ?? ''"
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

        <!--
          Why the grey buttons are grey. Deduplicated, so an unreachable host — which blocks all
          three — is stated once rather than three times.
        -->
        <ul v-if="blockedReasons.length" class="flex flex-col gap-1">
          <li v-for="reason in blockedReasons" :key="reason" class="text-xs opacity-50">
            {{ reason }}
          </li>
        </ul>
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
            <button class="btn btn-ghost btn-sm" type="button" :disabled="editBusy" @click="editDialog?.close()">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary btn-sm" type="submit" :disabled="editBusy">
              {{ editBusy ? t('common.saving') : t('common.save') }}
            </button>
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
            <button class="btn btn-ghost btn-sm" type="button" :disabled="serverBusy" @click="serverDialog?.close()">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary btn-sm" type="submit" :disabled="isOnline(agent) || serverBusy">
              {{ serverBusy ? t('common.saving') : t('common.save') }}
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
          {{ t('agents.removeTitle', { name: agent.label }) }}
        </h3>
        <p class="mt-3 text-sm opacity-70">
          {{ t('agents.removeWarning', { host: agent.hostName }) }}
        </p>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" :disabled="removeBusy" @click="removeDialog?.close()">{{ t('common.cancel') }}</button>
          <button class="btn btn-error btn-sm gap-2" type="button" :disabled="removeBusy" @click="confirmRemove">
            <Trash2 class="size-4" />
            {{ removeBusy ? t('common.deleting') : t('common.delete') }}
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
  <div v-else-if="!agentStore.loaded" class="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-6 overflow-y-auto">
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

  <div v-else class="mx-auto w-full max-w-6xl">
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body items-center gap-2 py-20 text-center">
        <Agent class="size-8 opacity-30" />
        <p class="text-sm opacity-50">{{ t('agents.notFound') }}</p>
      </div>
    </div>
  </div>
</template>
