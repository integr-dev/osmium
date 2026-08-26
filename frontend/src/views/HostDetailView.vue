<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  Bot as Agent,
  ChevronLeft,
  KeyRound,
  Server,
  SquarePen,
  Trash2,
  TriangleAlert,
} from 'lucide-vue-next'
import HostActions from '../components/HostActions.vue'
import PlayerHead from '../components/PlayerHead.vue'
import { agentBadge, agentStateLabel } from '../lib/agentState'
import { vFlash } from '../lib/motion'
import { useAgentStore } from '../stores/agents'
import { atShort } from '../lib/time'
import { useAuthStore } from '../stores/auth'

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

const actions = ref<InstanceType<typeof HostActions> | null>(null)

const host = computed(() => agentStore.hostById(Number(route.params.id)))
const agents = computed(() => agentStore.agentsOnHost(Number(route.params.id)))

onMounted(() => {
  if (!agentStore.loaded) void agentStore.refresh()
})

/** Its page cannot outlive it. The list is where there is still something to look at. */
function afterRemove() {
  void router.push({ name: 'resources' })
}
</script>

<template>
  <div class="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-6 overflow-y-auto">
    <RouterLink :to="{ name: 'resources' }" class="btn btn-ghost btn-sm w-fit gap-1 px-2">
      <ChevronLeft class="size-4" />
      {{ t('resources.title') }}
    </RouterLink>

    <div v-if="!host && agentStore.loaded" role="alert" class="alert alert-error alert-soft">
      <TriangleAlert class="size-4" />
      <span>{{ t('hosts.notFound') }}</span>
    </div>

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
                    :class="agentBadge(agent.state, agentStore.isBuilding(agent.id))"
                  >
                    {{ agentStateLabel(agent.state, agentStore.isBuilding(agent.id)) }}
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
    </template>

    <HostActions ref="actions" @removed="afterRemove" />
  </div>
</template>
