<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Activity,
  Beef,
  Bot,
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
import { STATE_BADGE, STATE_LABEL } from '../lib/botState'
import { formatUptime, isOnline, useBotStore } from '../stores/bots'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const router = useRouter()
const botStore = useBotStore()
const auth = useAuthStore()

const message = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

const editDialog = ref<HTMLDialogElement | null>(null)
const removeDialog = ref<HTMLDialogElement | null>(null)
const draft = ref({ label: '', serverAddress: '' })
const editError = ref<string | null>(null)

const bot = computed(() => botStore.byId(Number(route.params.id)))

/**
 * Commands travel to the bot's host, so nothing is deliverable while its agent is disconnected.
 * Checked here so the UI does not offer an action the API will refuse.
 */
const host = computed(() => (bot.value ? botStore.hostById(bot.value.hostId) : undefined))
const hostReachable = computed(() => host.value?.reachable === true)

const healthPercent = computed(() => ((bot.value?.telemetry.health ?? 0) / 20) * 100)
const foodPercent = computed(() => ((bot.value?.telemetry.food ?? 0) / 20) * 100)

const SEVERITY_DOT: Record<'info' | 'warning' | 'error', string> = {
  info: 'bg-base-content/30',
  warning: 'bg-warning',
  error: 'bg-error',
}

onMounted(() => {
  if (!bot.value) void botStore.refresh()
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
  if (!bot.value) return
  const text = message.value
  await run(() => botStore.say(bot.value!.id, text))
  if (!error.value) message.value = ''
}

function openEdit() {
  if (!bot.value) return
  draft.value = { label: bot.value.label, serverAddress: bot.value.serverAddress }
  editError.value = null
  editDialog.value?.showModal()
}

async function saveEdit() {
  if (!bot.value) return
  editError.value = null
  try {
    await botStore.updateBot(bot.value.id, {
      label: draft.value.label,
      serverAddress: draft.value.serverAddress,
    })
    editDialog.value?.close()
  } catch (failure) {
    editError.value = failure instanceof Error ? failure.message : 'Could not update the bot'
  }
}

async function confirmRemove() {
  if (!bot.value) return
  try {
    await botStore.removeBot(bot.value.id)
    removeDialog.value?.close()
    void router.push({ name: 'dashboard' })
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Could not delete the bot'
    removeDialog.value?.close()
  }
}
</script>

<template>
  <div v-if="bot" class="mx-auto flex max-w-5xl flex-col gap-6">
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl leading-tight font-semibold tracking-tight">{{ bot.label }}</h1>
        <p class="flex flex-wrap items-center gap-2 text-sm opacity-60">
          <span class="flex items-center gap-1">
            <Server class="size-3.5" />
            {{ bot.serverAddress }}
          </span>
          <span>·</span>
          <span>{{ bot.hostName }}</span>
          <template v-if="bot.mcUsername">
            <span>·</span>
            <span class="font-mono">{{ bot.mcUsername }}</span>
          </template>
        </p>
      </div>

      <div class="flex items-center gap-4 text-right">
        <div>
          <div class="text-xs uppercase opacity-50">Status</div>
          <span class="badge badge-sm" :class="STATE_BADGE[bot.state]">{{ STATE_LABEL[bot.state] }}</span>
        </div>
        <div>
          <div class="text-xs uppercase opacity-50">Uptime</div>
          <div class="flex items-center gap-1 font-medium tabular-nums">
            <Clock class="size-3.5 opacity-50" />
            {{ formatUptime(bot.telemetry.uptimeSeconds) }}
          </div>
        </div>
        <div v-if="auth.can('agent.control')" class="flex gap-1">
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
        <span class="font-medium">{{ bot.hostName }}</span> is not connected, so commands cannot be
        delivered. Enrolling a host only issues its token — the host has to connect to Osmium using
        that token before this bot can be set up or connected.
      </span>
    </div>

    <div
      v-else-if="bot.state === 'UNLINKED' || bot.state === 'NEEDS_RELINK'"
      role="alert"
      class="alert alert-info alert-soft"
    >
      <KeyRound class="size-4 shrink-0" />
      <span>
        This bot has no credentials on its host yet. Setting it up prompts the host to log in — the
        login happens there, not here.
      </span>
    </div>

    <!-- Stats: mock until an agent reports telemetry -->
    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-4">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Bot class="text-primary size-4" />
          Stats
        </h2>

        <div class="grid gap-4 sm:grid-cols-2">
          <div class="flex items-center gap-3">
            <Heart class="text-error size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="flex justify-between text-xs opacity-60">
                <span>Health</span>
                <span class="tabular-nums">{{ bot.telemetry.health }} / 20</span>
              </div>
              <progress class="progress progress-error mt-1 w-full" :value="healthPercent" max="100"></progress>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <Beef class="text-warning size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="flex justify-between text-xs opacity-60">
                <span>Food</span>
                <span class="tabular-nums">{{ bot.telemetry.food }} / 20</span>
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
                {{ bot.telemetry.position.x }}, {{ bot.telemetry.position.y }},
                {{ bot.telemetry.position.z }}
              </span>
            </span>
          </div>
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <Target class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">Task</span>
              <span class="block truncate text-sm">{{ bot.telemetry.task }}</span>
            </span>
          </div>
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <Signal class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">Ping</span>
              <span class="block truncate text-sm tabular-nums">{{ bot.telemetry.pingMs }} ms</span>
            </span>
          </div>
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <Hammer class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">Blocks placed</span>
              <span class="block truncate text-sm tabular-nums">
                {{ bot.telemetry.blocksPlaced.toLocaleString() }}
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
          <span class="badge badge-ghost badge-sm">{{ bot.telemetry.nearby.length }}</span>
        </h2>

        <ul v-if="bot.telemetry.nearby.length" class="flex flex-col gap-1">
          <li
            v-for="player in bot.telemetry.nearby"
            :key="player.name"
            class="rounded-field bg-base-300/30 flex items-center gap-3 px-3 py-2"
          >
            <span class="flex-1 truncate text-sm font-medium">{{ player.name }}</span>
            <span v-if="player.isBot" class="badge badge-primary badge-soft badge-xs">bot</span>
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

        <ul v-if="bot.telemetry.activity.length" class="flex flex-col gap-1">
          <li
            v-for="(line, index) in bot.telemetry.activity"
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
            v-if="auth.can('agent.login')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || !hostReachable || bot.state === 'SETUP_PENDING' || isOnline(bot)"
            @click="run(() => botStore.setupBot(bot!.id, 'device_code'))"
          >
            <KeyRound class="size-4" />
            Set up on host
          </button>
          <button
            v-if="auth.can('agent.control')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || !hostReachable || isOnline(bot) || bot.state === 'UNLINKED' || bot.state === 'SETUP_PENDING'"
            @click="run(() => botStore.connect(bot!.id))"
          >
            <RotateCw class="size-4" />
            Connect
          </button>
          <button
            v-if="auth.can('agent.control')"
            class="btn btn-soft btn-sm gap-2"
            :disabled="busy || !hostReachable || !isOnline(bot)"
            @click="run(() => botStore.disconnect(bot!.id))"
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
            — messages to or from this bot. Server chat is on the dashboard.
          </span>
        </div>

        <div
          v-if="bot.telemetry.chat.length"
          class="rounded-box bg-base-300/25 flex max-h-48 flex-col gap-1 overflow-y-auto p-3"
        >
          <p v-for="(line, index) in bot.telemetry.chat" :key="index" class="text-sm">
            <span class="font-mono text-xs opacity-40">{{ line.at }}</span>
            <span class="ml-2 font-medium">{{ line.from }}:</span>
            <span class="ml-1 opacity-80">{{ line.text }}</span>
          </p>
        </div>

        <form v-if="auth.can('agent.chat')" class="flex gap-2" @submit.prevent="send">
          <input
            v-model="message"
            class="input w-full"
            type="text"
            placeholder="Send a message as this bot"
            :disabled="busy || !hostReachable || !isOnline(bot)"
          />
          <button
            class="btn btn-primary gap-2"
            type="submit"
            :disabled="busy || !hostReachable || !isOnline(bot) || !message.trim()"
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
          Edit {{ bot.label }}
        </h3>
        <p class="mt-1 text-sm opacity-60">
          Moving to another server keeps the bot's credentials — the account is the same wherever it
          joins — but it has to be offline first.
        </p>
        <form class="mt-5 flex flex-col gap-4" @submit.prevent="saveEdit">
          <FormField
            v-model="draft.label"
            label="Name"
            :icon="Bot"
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
            :disabled="isOnline(bot)"
          />
          <p v-if="isOnline(bot)" class="text-xs opacity-60">
            Disconnect the bot to move it to another server.
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

    <dialog ref="removeDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <TriangleAlert class="text-error size-5" />
          Delete {{ bot.label }}?
        </h3>
        <p class="mt-3 text-sm opacity-70">
          The bot record is removed from Osmium. Credentials cached on
          <span class="font-medium">{{ bot.hostName }}</span> are not cleaned up by this, so revoke
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
        <Bot class="size-8 opacity-30" />
        <p class="text-sm opacity-50">No bot with that id.</p>
      </div>
    </div>
  </div>
</template>
