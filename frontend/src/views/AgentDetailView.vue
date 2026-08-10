<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Activity,
  Beef,
  Bot as Agent,
  Clock,
  Hammer,
  Heart,
  KeyRound,
  MapPin,
  MessageSquare,
  Power,
  RotateCw,
  Send,
  Server,
  Signal,
  SquarePen,
  Target,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-vue-next'
import FormField from '../components/FormField.vue'
import { STATE_BADGE, STATE_LABEL } from '../lib/agentState'
import { LOGIN_METHODS } from '../lib/loginMethods'
import { formatUptime, isOnline, useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'

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
const setupMethod = ref(LOGIN_METHODS[0]!.id)

const agent = computed(() => agentStore.byId(Number(route.params.id)))

/**
 * Commands travel to the agent's host, so nothing is deliverable while its agent is disconnected.
 * Checked here so the UI does not offer an action the API will refuse.
 */
const host = computed(() => (agent.value ? agentStore.hostById(agent.value.hostId) : undefined))
const hostReachable = computed(() => host.value?.reachable === true)

const healthPercent = computed(() => ((agent.value?.telemetry.health ?? 0) / 20) * 100)
const foodPercent = computed(() => ((agent.value?.telemetry.food ?? 0) / 20) * 100)

const SEVERITY_DOT: Record<'info' | 'warning' | 'error', string> = {
  info: 'bg-base-content/30',
  warning: 'bg-warning',
  error: 'bg-error',
}

onMounted(() => {
  if (!agent.value) void agentStore.refresh()
})

/** Every command can legitimately fail with 503 while no agent is connected to the host. */
async function run(action: () => Promise<void>) {
  busy.value = true
  error.value = null
  try {
    await action()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Command failed'
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
  setupMethod.value = LOGIN_METHODS[0]!.id
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
    editError.value = failure instanceof Error ? failure.message : 'Could not update the agent'
  }
}

async function confirmRemove() {
  if (!agent.value) return
  try {
    await agentStore.removeAgent(agent.value.id)
    removeDialog.value?.close()
    void router.push({ name: 'dashboard' })
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Could not delete the agent'
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
          <div class="text-xs uppercase opacity-50">Status</div>
          <span class="badge badge-sm" :class="STATE_BADGE[agent.state]">{{ STATE_LABEL[agent.state] }}</span>
        </div>
        <div>
          <div class="text-xs uppercase opacity-50">Uptime</div>
          <div class="flex items-center gap-1 font-medium tabular-nums">
            <Clock class="size-3.5 opacity-50" />
            {{ formatUptime(agent.telemetry.uptimeSeconds) }}
          </div>
        </div>
        <div v-if="auth.can('fleet.control')" class="flex gap-1">
          <button class="btn btn-ghost btn-sm gap-1" @click="openEdit">
            <SquarePen class="size-4" />
            Edit
          </button>
          <button class="btn btn-ghost btn-sm text-error gap-1" @click="removeDialog?.showModal()">
            <Trash2 class="size-4" />
            Delete
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
      <span>
        <span class="font-medium">{{ agent.hostName }}</span> is not connected, so commands cannot be
        delivered. Enrolling a host only issues its token — the host has to connect to Osmium using
        that token before this agent can be set up or connected.
      </span>
    </div>

    <div
      v-else-if="agent.state === 'UNLINKED' || agent.state === 'NEEDS_RELINK'"
      role="alert"
      class="alert alert-info alert-soft"
    >
      <KeyRound class="size-4 shrink-0" />
      <span>
        This agent has no credentials on its host yet. Setting it up prompts the host to log in — the
        login happens there, not here.
      </span>
    </div>

    <!-- Stats: mock until an agent reports telemetry -->
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-4">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Agent class="text-primary size-4" />
          Stats
        </h2>

        <div class="grid gap-4 sm:grid-cols-2">
          <div class="flex items-center gap-3">
            <Heart class="text-error size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="flex justify-between text-xs opacity-60">
                <span>Health</span>
                <span class="tabular-nums">{{ agent.telemetry.health }} / 20</span>
              </div>
              <progress class="progress progress-error mt-1 w-full" :value="healthPercent" max="100"></progress>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <Beef class="text-warning size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="flex justify-between text-xs opacity-60">
                <span>Food</span>
                <span class="tabular-nums">{{ agent.telemetry.food }} / 20</span>
              </div>
              <progress class="progress progress-warning mt-1 w-full" :value="foodPercent" max="100"></progress>
            </div>
          </div>
        </div>

        <div class="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <MapPin class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">Position</span>
              <span class="block truncate font-mono text-sm tabular-nums">
                {{ agent.telemetry.position.x }}, {{ agent.telemetry.position.y }},
                {{ agent.telemetry.position.z }}
              </span>
            </span>
          </div>
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <Target class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">Task</span>
              <span class="block truncate text-sm">{{ agent.telemetry.task }}</span>
            </span>
          </div>
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <Signal class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">Ping</span>
              <span class="block truncate text-sm tabular-nums">{{ agent.telemetry.pingMs }} ms</span>
            </span>
          </div>
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <Hammer class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">Blocks placed</span>
              <span class="block truncate text-sm tabular-nums">
                {{ agent.telemetry.blocksPlaced.toLocaleString() }}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Nearby players -->
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-3">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Users class="text-primary size-4" />
          Nearby players
          <span class="badge badge-ghost badge-sm">{{ agent.telemetry.nearby.length }}</span>
        </h2>

        <ul v-if="agent.telemetry.nearby.length" class="flex flex-col gap-1">
          <li
            v-for="player in agent.telemetry.nearby"
            :key="player.name"
            class="rounded-field bg-base-300/30 flex items-center gap-3 px-3 py-2"
          >
            <span class="flex-1 truncate text-sm font-medium">{{ player.name }}</span>
            <span v-if="player.isBot" class="badge badge-primary badge-soft badge-xs">agent</span>
            <span class="text-xs tabular-nums opacity-50">{{ player.distance.toFixed(1) }} m</span>
          </li>
        </ul>

        <p v-else class="py-6 text-center text-sm opacity-50">No players in range.</p>
      </div>
    </div>

    <!-- Activity: incidents, kept out of chat so they are not buried -->
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-3">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Activity class="text-primary size-4" />
          Activity
        </h2>

        <ul v-if="agent.telemetry.activity.length" class="flex flex-col gap-1">
          <li
            v-for="(line, index) in agent.telemetry.activity"
            :key="index"
            class="rounded-field bg-base-300/30 flex items-center gap-3 px-3 py-2 text-sm"
          >
            <span class="font-mono text-xs opacity-40">{{ line.at }}</span>
            <span class="size-1.5 shrink-0 rounded-full" :class="SEVERITY_DOT[line.severity]"></span>
            <span class="min-w-0 flex-1">{{ line.text }}</span>
          </li>
        </ul>

        <p v-else class="py-6 text-center text-sm opacity-50">No incidents recorded.</p>
      </div>
    </div>

    <!-- Actions -->
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-4">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Power class="text-primary size-4" />
          Actions
        </h2>

        <div class="flex flex-wrap gap-2">
          <button
            v-if="auth.can('fleet.login')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || !hostReachable || agent.state === 'SETUP_PENDING' || isOnline(agent)"
            @click="openSetup"
          >
            <KeyRound class="size-4" />
            Set up on host
          </button>
          <button
            v-if="auth.can('fleet.control')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || !hostReachable || isOnline(agent) || agent.state === 'UNLINKED' || agent.state === 'SETUP_PENDING'"
            @click="run(() => agentStore.connect(agent!.id))"
          >
            <RotateCw class="size-4" />
            Connect
          </button>
          <button
            v-if="auth.can('fleet.control')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || !hostReachable || !isOnline(agent)"
            @click="run(() => agentStore.disconnect(agent!.id))"
          >
            <Power class="size-4" />
            Disconnect
          </button>
        </div>

        <div class="divider my-0"></div>

        <div class="flex items-center gap-2 text-sm font-medium opacity-70">
          <MessageSquare class="size-4" />
          Chat
          <span class="text-xs font-normal opacity-60">
            — messages to or from this agent. Server chat is on the dashboard.
          </span>
        </div>

        <div
          v-if="agent.telemetry.chat.length"
          class="rounded-box bg-base-300/25 flex max-h-48 flex-col gap-1 overflow-y-auto p-3"
        >
          <p v-for="(line, index) in agent.telemetry.chat" :key="index" class="text-sm">
            <span class="font-mono text-xs opacity-40">{{ line.at }}</span>
            <span class="ml-2 font-medium">{{ line.from }}:</span>
            <span class="ml-1 opacity-80">{{ line.text }}</span>
          </p>
        </div>

        <form v-if="auth.can('fleet.chat')" class="flex gap-2" @submit.prevent="send">
          <input
            v-model="message"
            class="input w-full"
            type="text"
            placeholder="Send a message as this agent"
            :disabled="busy || !hostReachable || !isOnline(agent)"
          />
          <button
            class="btn btn-primary gap-2"
            type="submit"
            :disabled="busy || !hostReachable || !isOnline(agent) || !message.trim()"
          >
            <Send class="size-4" />
            Send
          </button>
        </form>
      </div>
    </div>

    <dialog ref="editDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <SquarePen class="text-primary size-5" />
          Edit {{ agent.label }}
        </h3>
        <p class="mt-1 text-sm opacity-60">
          Moving to another server keeps the agent's credentials — the account is the same wherever it
          joins — but it has to be offline first.
        </p>
        <form class="mt-5 flex flex-col gap-4" @submit.prevent="saveEdit">
          <FormField
            v-model="draft.label"
            label="Name"
            :icon="Agent"
            type="text"
            maxlength="64"
            required
          />
          <FormField
            v-model="draft.serverAddress"
            label="Server"
            placeholder="mc.example.com:25565"
            :icon="Server"
            type="text"
            required
            :disabled="isOnline(agent)"
          />
          <p v-if="isOnline(agent)" class="text-xs opacity-60">
            Disconnect the agent to move it to another server.
          </p>

          <div v-if="editError" role="alert" class="alert alert-error alert-soft">
            <TriangleAlert class="size-4" />
            <span>{{ editError }}</span>
          </div>

          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="editDialog?.close()">Cancel</button>
            <button class="btn btn-primary btn-sm" type="submit">Save</button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>

    <dialog ref="setupDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <KeyRound class="text-primary size-5" />
          Set up {{ agent.label }}
        </h3>
        <p class="mt-3 text-sm opacity-70">
          The login runs on <span class="font-medium">{{ agent.hostName }}</span>, not here. Osmium
          relays your choice and never sees the credentials — finish the sign-in on the host, then
          the agent reports back as ready.
        </p>

        <ul class="list bg-base-100 border-base-300 mt-4 rounded-box border">
          <li v-for="method in LOGIN_METHODS" :key="method.id" class="list-row items-center">
            <label class="flex w-full cursor-pointer items-center gap-3">
              <input v-model="setupMethod" type="radio" :value="method.id" class="radio radio-sm radio-primary" />
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium">{{ method.label }}</span>
                <span class="block text-xs opacity-60">{{ method.description }}</span>
              </span>
            </label>
          </li>
        </ul>

        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="setupDialog?.close()">Cancel</button>
          <button class="btn btn-primary btn-sm gap-2" type="button" @click="confirmSetup">
            <KeyRound class="size-4" />
            Start setup
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>

    <dialog ref="removeDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <TriangleAlert class="text-error size-5" />
          Delete {{ agent.label }}?
        </h3>
        <p class="mt-3 text-sm opacity-70">
          The agent record is removed from Osmium. Credentials cached on
          <span class="font-medium">{{ agent.hostName }}</span> are not cleaned up by this, so revoke
          the account there if it should stop being usable.
        </p>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="removeDialog?.close()">Cancel</button>
          <button class="btn btn-error btn-sm gap-2" type="button" @click="confirmRemove">
            <Trash2 class="size-4" />
            Delete
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>
  </div>

  <div v-else class="mx-auto max-w-5xl">
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body items-center gap-2 py-20 text-center">
        <Agent class="size-8 opacity-30" />
        <p class="text-sm opacity-50">No agent with that id.</p>
      </div>
    </div>
  </div>
</template>
