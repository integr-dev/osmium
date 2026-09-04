<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Route, ShieldCheck, TriangleAlert } from 'lucide-vue-next'

import { useAgentStore } from '../stores/agents'

/**
 * What each host can route a session through, and who is routed through it.
 *
 * **A read, and only a read.** A proxy is a file on the machine that dials it — that is where the
 * password lives, and the whole reason it is not a setting — so this cannot offer to add one. What
 * it can do is the thing an operator actually needs from a screen: say which routes exist, where
 * they go, and which agents are taking them, all of which arrive in the host's handshake.
 *
 * Grouped by host rather than listed flat, because a proxy belongs to one: two machines may hold
 * proxies under the same name, and an agent can only take one its own host holds.
 */
const { t } = useI18n()
const agentStore = useAgentStore()

/** What an agent has been told to route through, or nothing. */
function routeOf(settings: Record<string, string> | undefined): string | undefined {
  return settings?.['connect.proxy']?.trim() || undefined
}

interface Routed {
  name: string
  kind: string
  address: string
  authenticated: boolean
  /** The agents on this host that name it. */
  agents: Array<{ id: number; label: string }>
}

interface Machine {
  id: number
  name: string
  reachable: boolean
  proxies: Routed[]
  /**
   * Agents naming a proxy this host does not hold.
   *
   * Worth its own line rather than left to be noticed: the host refuses to connect them at all, on
   * purpose — going direct is the one outcome a proxy exists to prevent — so an agent in here is
   * one that will not join anything until somebody fixes the name.
   */
  stranded: Array<{ id: number; label: string; wanted: string }>
}

const machines = computed<Machine[]>(() =>
  agentStore.hosts.map((host) => {
    const owned = agentStore.agents.filter((agent) => agent.hostId === host.id)
    const held = host.proxies ?? []
    const names = new Set(held.map((proxy) => proxy.name))

    return {
      id: host.id,
      name: host.name,
      reachable: host.reachable,
      // Every field of the response is optional in the generated schema, so each is given the
      // reading that a host leaving it out would deserve: no name is a proxy nothing can choose.
      proxies: held.map((proxy) => ({
        name: proxy.name ?? '',
        kind: proxy.kind ?? 'socks5',
        address: `${proxy.host ?? '?'}:${proxy.port ?? 0}`,
        authenticated: proxy.authenticated === true,
        agents: owned
          .filter((agent) => routeOf(agent.settings) === proxy.name)
          .map((agent) => ({ id: agent.id, label: agent.label })),
      })),
      stranded: owned.flatMap((agent) => {
        const wanted = routeOf(agent.settings)
        return wanted && !names.has(wanted) ? [{ id: agent.id, label: agent.label, wanted }] : []
      }),
    }
  }),
)

/** Whether anything at all is being offered, which decides between the list and the empty state. */
const any = computed(() => machines.value.some((machine) => machine.proxies.length > 0))

const direct = computed(
  () => agentStore.agents.filter((agent) => !routeOf(agent.settings)).length,
)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4">
    <p class="text-sm opacity-60">{{ t('proxies.subtitle', { count: direct }) }}</p>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="!any && !machines.some((m) => m.stranded.length)" class="flex flex-col items-center gap-3 py-16 text-center">
        <Route class="size-8 opacity-20" />
        <p class="max-w-md text-sm opacity-50">{{ t('proxies.empty') }}</p>
      </div>

      <div v-else class="flex flex-col gap-4">
        <div
          v-for="machine in machines"
          v-show="machine.proxies.length || machine.stranded.length"
          :key="machine.id"
          class="card border-base-300 bg-base-200 border"
        >
          <div class="card-body gap-3 p-4">
            <div class="flex items-center gap-2">
              <RouterLink
                :to="{ name: 'host', params: { id: machine.id } }"
                class="link-hover link text-sm font-medium"
              >
                {{ machine.name }}
              </RouterLink>
              <!-- The list goes with the connection that claimed it, so a machine that is gone is
                   not holding nothing — it is not saying. -->
              <span v-if="!machine.reachable" class="badge badge-warning badge-sm badge-soft">
                {{ t('proxies.unheard') }}
              </span>
            </div>

            <table v-if="machine.proxies.length" class="table-sm table">
              <thead>
                <tr>
                  <th>{{ t('proxies.name') }}</th>
                  <th>{{ t('proxies.kind') }}</th>
                  <th>{{ t('proxies.address') }}</th>
                  <th>{{ t('proxies.routed') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="proxy in machine.proxies" :key="proxy.name">
                  <td class="font-mono">
                    <span class="flex items-center gap-1.5">
                      {{ proxy.name }}
                      <!-- Said, never shown: what it authenticates with stays on the host. -->
                      <ShieldCheck
                        v-if="proxy.authenticated"
                        class="size-3.5 opacity-50"
                        :aria-label="t('proxies.authenticated')"
                      />
                    </span>
                  </td>
                  <td><span class="badge badge-ghost badge-sm">{{ proxy.kind }}</span></td>
                  <td class="font-mono text-xs opacity-70 tabular-nums">{{ proxy.address }}</td>
                  <td>
                    <span v-if="!proxy.agents.length" class="text-xs italic opacity-50">
                      {{ t('proxies.nobody') }}
                    </span>
                    <span v-else class="flex flex-wrap gap-1">
                      <RouterLink
                        v-for="agent in proxy.agents"
                        :key="agent.id"
                        :to="{ name: 'agent', params: { id: agent.id } }"
                        class="badge badge-sm badge-ghost hover:badge-primary"
                      >
                        {{ agent.label }}
                      </RouterLink>
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>

            <div
              v-for="agent in machine.stranded"
              :key="agent.id"
              role="alert"
              class="alert alert-warning alert-soft py-2 text-sm"
            >
              <TriangleAlert class="size-4 shrink-0" />
              <span>
                <RouterLink :to="{ name: 'agent', params: { id: agent.id } }" class="link-hover link">
                  {{ agent.label }}
                </RouterLink>
                {{ ' ' }}{{ t('proxies.stranded', { name: agent.wanted }) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
