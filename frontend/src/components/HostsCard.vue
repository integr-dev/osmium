<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Server } from 'lucide-vue-next'
import type { HostTraffic } from '../api/dashboard'
import { formatRate } from '../lib/dashboard'
import { isOnline, useAgentStore } from '../stores/agents'

/**
 * Every host, whether it is connected, how many of its agents are in game, and what it is moving.
 *
 * The rates are the newest dashboard point's, so they are at most ten seconds old and agree with
 * the traffic chart beside them. A host with no point yet reads as idle rather than missing.
 */
const props = defineProps<{ traffic: HostTraffic[] }>()

const { t } = useI18n()
const agents = useAgentStore()

const rows = computed(() =>
  agents.hosts.map((host) => {
    const moving = props.traffic.find((entry) => entry.hostId === host.id)
    const own = agents.agentsOnHost(host.id)
    return {
      id: host.id,
      name: host.name,
      // The store's, which moves the moment a host drops rather than on the next point.
      reachable: host.reachable,
      online: own.filter(isOnline).length,
      total: own.length,
      link: moving ? [moving.linkSent, moving.linkReceived] : null,
      game: moving?.gameSent != null && moving.gameReceived != null ? [moving.gameSent, moving.gameReceived] : null,
    }
  }),
)
</script>

<template>
  <div class="card border-base-300 bg-base-200 flex min-h-0 flex-col border">
    <div class="card-body min-h-0 gap-2">
      <h2 class="card-title flex items-center gap-2 text-base">
        <Server class="text-primary size-4" />
        {{ t('dashboard.hosts') }}
        <span class="badge badge-ghost badge-sm">{{ rows.length }}</span>
      </h2>

      <p v-if="!rows.length" class="text-sm opacity-50">{{ t('dashboard.noHosts') }}</p>

      <ul v-else class="-mx-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2">
        <li v-for="row in rows" :key="row.id">
          <RouterLink
            :to="{ name: 'host', params: { id: row.id } }"
            class="rounded-field hover:bg-base-300/40 flex flex-col gap-1 px-2 py-1.5"
          >
            <span class="flex items-center gap-2 text-sm">
              <span
                class="size-2 shrink-0 rounded-full"
                :class="row.reachable ? 'bg-success' : 'bg-error'"
                :title="row.reachable ? t('hosts.reachable') : t('hosts.unreachable')"
              ></span>
              <span class="min-w-0 flex-1 truncate font-medium">{{ row.name }}</span>
              <span class="text-xs tabular-nums opacity-60">
                {{ t('dashboard.hostAgents', { online: row.online, total: row.total }) }}
              </span>
            </span>
            <span class="grid grid-cols-2 gap-2 pl-4 text-[0.7rem] tabular-nums" :title="t('dashboard.sentReceived')">
              <span class="flex flex-col">
                <span class="opacity-50">{{ t('dashboard.link') }}</span>
                <span>{{ row.link ? `↑ ${formatRate(row.link[0]!)} ↓ ${formatRate(row.link[1]!)}` : '—' }}</span>
              </span>
              <span class="flex flex-col">
                <span class="opacity-50">{{ t('dashboard.game') }}</span>
                <span>{{ row.game ? `↑ ${formatRate(row.game[0]!)} ↓ ${formatRate(row.game[1]!)}` : '—' }}</span>
              </span>
            </span>
          </RouterLink>
        </li>
      </ul>
    </div>
  </div>
</template>
