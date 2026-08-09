<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import {
  Blocks,
  Bot,
  CircleAlert,
  Clock,
  Gauge,
  Hammer,
  Layers,
  Map,
  TriangleAlert,
} from 'lucide-vue-next'
import type { Sector } from '../stores/bots'
import { useBotStore } from '../stores/bots'

const botStore = useBotStore()

const SECTOR_BADGE: Record<Sector['status'], string> = {
  done: 'badge-success badge-soft',
  active: 'badge-primary badge-soft',
  blocked: 'badge-error badge-soft',
  queued: 'badge-ghost',
}

const SECTOR_PROGRESS: Record<Sector['status'], string> = {
  done: 'progress-success',
  active: 'progress-primary',
  blocked: 'progress-error',
  queued: '',
}

const eta = computed(() => {
  const minutes = botStore.etaMinutes
  if (minutes === null) return 'stalled'
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
})

/** Builders only, ranked by contribution, for the leaderboard bars. */
const contributors = computed(() =>
  [...botStore.bots].filter((bot) => bot.blocksPlaced > 0).sort((a, b) => b.blocksPlaced - a.blocksPlaced),
)

const topContribution = computed(() =>
  Math.max(1, ...contributors.value.map((bot) => bot.blocksPlaced)),
)

function percent(part: number, whole: number): number {
  return Math.min(100, (part / whole) * 100)
}
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p class="text-sm opacity-60">
          Building <span class="font-medium opacity-100">{{ botStore.schematic.name }}</span>
        </p>
      </div>
      <span
        class="badge badge-sm gap-1"
        :class="botStore.blocksPerMinute > 0 ? 'badge-success badge-soft' : 'badge-error badge-soft'"
      >
        {{ botStore.blocksPerMinute > 0 ? 'Building' : 'Stalled' }}
      </span>
    </header>

    <div class="stats stats-vertical sm:stats-horizontal border-base-300 bg-base-200 w-full border">
      <div class="stat">
        <div class="stat-figure text-primary"><Bot class="size-7" /></div>
        <div class="stat-title">Bots online</div>
        <div class="stat-value text-3xl">
          {{ botStore.online.length }}<span class="text-lg opacity-40">/{{ botStore.bots.length }}</span>
        </div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Hammer class="size-7" /></div>
        <div class="stat-title">Blocks placed</div>
        <div class="stat-value text-3xl">{{ botStore.blocksPlaced.toLocaleString() }}</div>
        <div class="stat-desc">of {{ botStore.schematic.totalBlocks.toLocaleString() }}</div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Gauge class="size-7" /></div>
        <div class="stat-title">Throughput</div>
        <div class="stat-value text-3xl">{{ botStore.blocksPerMinute }}</div>
        <div class="stat-desc">blocks / minute</div>
      </div>
      <div class="stat">
        <div class="stat-figure text-primary"><Clock class="size-7" /></div>
        <div class="stat-title">Est. remaining</div>
        <div class="stat-value text-3xl">{{ eta }}</div>
        <div class="stat-desc">at the current rate</div>
      </div>
    </div>

    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-3">
        <div class="flex items-center justify-between">
          <h2 class="card-title flex items-center gap-2 text-base">
            <Layers class="text-primary size-4" />
            Schematic progress
          </h2>
          <span class="text-sm opacity-60">
            Layer {{ botStore.schematic.currentLayer }} of {{ botStore.schematic.layers }}
          </span>
        </div>
        <progress
          class="progress progress-primary w-full"
          :value="botStore.progressPercent"
          max="100"
        ></progress>
        <div class="flex justify-between text-xs opacity-60">
          <span>{{ botStore.progressPercent.toFixed(1) }}% complete</span>
          <span class="tabular-nums">
            {{ (botStore.schematic.totalBlocks - botStore.blocksPlaced).toLocaleString() }} blocks
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
            Needs attention
            <span class="badge badge-ghost badge-sm">{{ botStore.attention.length }}</span>
          </h2>

          <ul v-if="botStore.attention.length" class="flex flex-col gap-1">
            <RouterLink
              v-for="(item, index) in botStore.attention"
              :key="`${item.bot.id}-${index}`"
              :to="{ name: 'bot', params: { id: item.bot.id } }"
              class="rounded-field hover:bg-base-300/50 flex items-center gap-3 px-3 py-2"
            >
              <CircleAlert
                class="size-4 shrink-0"
                :class="item.severity === 'error' ? 'text-error' : 'text-warning'"
              />
              <span class="flex-1 truncate text-sm font-medium">{{ item.bot.name }}</span>
              <span
                class="badge badge-xs"
                :class="item.severity === 'error' ? 'badge-error badge-soft' : 'badge-warning badge-soft'"
              >
                {{ item.reason }}
              </span>
            </RouterLink>
          </ul>

          <p v-else class="py-8 text-center text-sm opacity-50">Every bot is healthy.</p>
        </div>
      </div>

      <div class="card border-base-300 bg-base-200 border">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <Map class="text-primary size-4" />
            Sectors
            <span class="badge badge-ghost badge-sm">
              {{ botStore.sectors.filter((sector) => sector.status === 'done').length }}/{{
                botStore.sectors.length
              }}
            </span>
          </h2>

          <ul class="flex flex-col gap-3">
            <li v-for="sector in botStore.sectors" :key="sector.id">
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
            Contribution
          </h2>

          <ul class="flex flex-col gap-3">
            <li v-for="bot in contributors" :key="bot.id">
              <div class="flex items-center justify-between text-xs">
                <RouterLink
                  :to="{ name: 'bot', params: { id: bot.id } }"
                  class="flex items-center gap-2 hover:underline"
                >
                  <span
                    class="size-1.5 rounded-full"
                    :class="bot.online ? 'bg-success' : 'bg-error'"
                  ></span>
                  {{ bot.name }}
                </RouterLink>
                <span class="tabular-nums opacity-60">{{ bot.blocksPlaced.toLocaleString() }}</span>
              </div>
              <progress
                class="progress progress-primary mt-1 w-full"
                :value="percent(bot.blocksPlaced, topContribution)"
                max="100"
              ></progress>
            </li>
          </ul>
        </div>
      </div>

      <div class="card border-base-300 bg-base-200 border">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <Clock class="text-primary size-4" />
            Recent activity
          </h2>

          <div v-if="botStore.activity.length" class="flex max-h-72 flex-col gap-1 overflow-y-auto">
            <RouterLink
              v-for="(line, index) in botStore.activity"
              :key="index"
              :to="{ name: 'bot', params: { id: line.bot.id } }"
              class="rounded-field hover:bg-base-300/50 flex gap-2 px-2 py-1.5 text-sm"
            >
              <span class="font-mono text-xs opacity-40">{{ line.at }}</span>
              <span class="font-medium" :class="line.from === 'system' ? 'opacity-50' : ''">
                {{ line.from }}
              </span>
              <span class="min-w-0 flex-1 truncate opacity-70">{{ line.text }}</span>
            </RouterLink>
          </div>

          <p v-else class="py-8 text-center text-sm opacity-50">Nothing yet.</p>
        </div>
      </div>
    </div>
  </div>
</template>
