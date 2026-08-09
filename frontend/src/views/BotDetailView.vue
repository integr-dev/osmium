<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  Beef,
  Bot,
  Clock,
  Hammer,
  Heart,
  MapPin,
  MessageSquare,
  Power,
  RotateCw,
  Send,
  Signal,
  Target,
  Users,
} from 'lucide-vue-next'
import { formatUptime, useBotStore } from '../stores/bots'

const route = useRoute()
const botStore = useBotStore()

const message = ref('')

const bot = computed(() => botStore.byId(String(route.params.id)))

const healthPercent = computed(() => ((bot.value?.health ?? 0) / 20) * 100)
const foodPercent = computed(() => ((bot.value?.food ?? 0) / 20) * 100)

function send() {
  if (!bot.value) return
  botStore.say(bot.value.id, message.value)
  message.value = ''
}
</script>

<template>
  <div v-if="bot" class="mx-auto flex max-w-5xl flex-col gap-6">
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div class="flex items-center gap-3">
        <span
          class="size-2.5 shrink-0 rounded-full"
          :class="bot.online ? 'bg-success' : 'bg-error'"
        ></span>
        <div>
          <h1 class="text-2xl leading-tight font-semibold tracking-tight">{{ bot.name }}</h1>
          <p class="text-sm opacity-60">{{ bot.task }}</p>
        </div>
      </div>

      <div class="flex items-center gap-4 text-right">
        <div>
          <div class="text-xs uppercase opacity-50">Status</div>
          <span
            class="badge badge-sm gap-1"
            :class="bot.online ? 'badge-success badge-soft' : 'badge-error badge-soft'"
          >
            {{ bot.online ? 'Online' : 'Offline' }}
          </span>
        </div>
        <div>
          <div class="text-xs uppercase opacity-50">Uptime</div>
          <div class="flex items-center gap-1 font-medium tabular-nums">
            <Clock class="size-3.5 opacity-50" />
            {{ formatUptime(bot.uptimeSeconds) }}
          </div>
        </div>
      </div>
    </header>

    <!-- Stats -->
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
                <span class="tabular-nums">{{ bot.health }} / 20</span>
              </div>
              <progress class="progress progress-error mt-1 w-full" :value="healthPercent" max="100"></progress>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <Beef class="text-warning size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="flex justify-between text-xs opacity-60">
                <span>Food</span>
                <span class="tabular-nums">{{ bot.food }} / 20</span>
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
                {{ bot.position.x }}, {{ bot.position.y }}, {{ bot.position.z }}
              </span>
            </span>
          </div>
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <Target class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">Dimension</span>
              <span class="block truncate text-sm capitalize">{{ bot.dimension }}</span>
            </span>
          </div>
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <Signal class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">Ping</span>
              <span class="block truncate text-sm tabular-nums">{{ bot.pingMs }} ms</span>
            </span>
          </div>
          <div class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2">
            <Hammer class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block text-xs opacity-50">Blocks placed</span>
              <span class="block truncate text-sm tabular-nums">
                {{ bot.blocksPlaced.toLocaleString() }}
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
          <span class="badge badge-ghost badge-sm">{{ bot.nearby.length }}</span>
        </h2>

        <ul v-if="bot.nearby.length" class="flex flex-col gap-1">
          <li
            v-for="player in bot.nearby"
            :key="player.name"
            class="rounded-field bg-base-300/30 flex items-center gap-3 px-3 py-2"
          >
            <div class="avatar avatar-placeholder">
              <div class="bg-neutral text-neutral-content w-7 rounded">
                <span class="text-xs">{{ player.name.charAt(0).toUpperCase() }}</span>
              </div>
            </div>
            <span class="flex-1 truncate text-sm font-medium">{{ player.name }}</span>
            <span v-if="player.isBot" class="badge badge-primary badge-soft badge-xs">bot</span>
            <span class="text-xs tabular-nums opacity-50">{{ player.distance.toFixed(1) }} m</span>
          </li>
        </ul>

        <p v-else class="py-6 text-center text-sm opacity-50">No players in range.</p>
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
            class="btn btn-soft btn-sm gap-2"
            :disabled="!bot.online"
            @click="botStore.disconnect(bot.id)"
          >
            <Power class="size-4" />
            Disconnect
          </button>
          <button
            class="btn btn-soft btn-sm gap-2"
            :disabled="bot.online"
            @click="botStore.reconnect(bot.id)"
          >
            <RotateCw class="size-4" />
            Reconnect
          </button>
        </div>

        <div class="divider my-0"></div>

        <div class="flex items-center gap-2 text-sm font-medium opacity-70">
          <MessageSquare class="size-4" />
          Chat
        </div>

        <div
          v-if="bot.chat.length"
          class="rounded-box bg-base-300/25 flex max-h-48 flex-col gap-1 overflow-y-auto p-3"
        >
          <p v-for="(line, index) in bot.chat" :key="index" class="text-sm">
            <span class="font-mono text-xs opacity-40">{{ line.at }}</span>
            <span class="ml-2 font-medium" :class="line.from === 'system' ? 'opacity-50' : ''">
              {{ line.from }}:
            </span>
            <span class="ml-1 opacity-80">{{ line.text }}</span>
          </p>
        </div>

        <form class="flex gap-2" @submit.prevent="send">
          <input
            v-model="message"
            class="input w-full"
            type="text"
            placeholder="Send a message as this bot"
            :disabled="!bot.online"
          />
          <button class="btn btn-primary gap-2" type="submit" :disabled="!bot.online || !message.trim()">
            <Send class="size-4" />
            Send
          </button>
        </form>
      </div>
    </div>
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
