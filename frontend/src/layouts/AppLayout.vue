<script setup lang="ts">
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { onMounted, onUnmounted, ref } from 'vue'
import { Bot as Agent, LayoutDashboard, LogOut, Menu, Plus, ScrollText, Server, User, Users } from 'lucide-vue-next'
import AddAgentModal from '../components/AddAgentModal.vue'
import { useAuthStore } from '../stores/auth'
import { STATE_DOT } from '../lib/agentState'
import { useAgentStore } from '../stores/agents'

const auth = useAuthStore()
const agentStore = useAgentStore()
const router = useRouter()

const addAgentOpen = ref(false)

// The sidebar is present on every authenticated page, so it is the natural place to load the fleet
// and to hold the live stream open: one connection for the whole session rather than one per view.
onMounted(() => {
  if (!auth.can('fleet.read')) return
  void agentStore.refresh()
  agentStore.connectStream()
})

onUnmounted(() => agentStore.disconnectStream())

function logout() {
  // Closed before the token is dropped, so the stream does not reconnect with a dead credential.
  agentStore.disconnectStream()
  auth.logout()
  void router.push({ name: 'login' })
}
</script>

<template>
  <div class="drawer lg:drawer-open">
    <input id="app-drawer" type="checkbox" class="drawer-toggle" />

    <div class="drawer-content flex min-h-screen flex-col">
      <!-- Only reachable below lg, where the sidebar is collapsed. -->
      <div class="navbar border-base-300 bg-base-200 border-b lg:hidden">
        <label for="app-drawer" class="btn btn-square btn-ghost btn-sm" aria-label="Open navigation">
          <Menu class="size-5" />
        </label>
        <img src="/logo.svg" alt="" class="ml-2 size-6" />
        <span class="ml-2 font-semibold">Osmium</span>
      </div>

      <main class="flex-1 px-6 py-8">
        <RouterView />
      </main>
    </div>

    <AddAgentModal v-model:open="addAgentOpen" />

    <div class="drawer-side">
      <label for="app-drawer" class="drawer-overlay" aria-label="Close navigation"></label>

      <aside class="border-base-300 bg-base-200 flex min-h-full w-64 flex-col border-r">
        <div class="flex items-center gap-3 px-5 py-6">
          <img src="/logo.svg" alt="" class="size-8" />
          <span class="text-lg font-semibold tracking-tight">Osmium</span>
        </div>

        <div class="flex-1 overflow-y-auto px-3">
          <ul class="menu w-full gap-0.5 p-0">
            <li>
              <RouterLink :to="{ name: 'dashboard' }" class="gap-3">
                <LayoutDashboard class="size-4 shrink-0" />
                Dashboard
              </RouterLink>
            </li>
            <li>
              <RouterLink :to="{ name: 'hosts' }" class="gap-3">
                <Server class="size-4 shrink-0" />
                Hosts
                <span class="badge badge-xs ml-auto">
                  {{ agentStore.hosts.filter((host) => host.reachable).length }}/{{ agentStore.hosts.length }}
                </span>
              </RouterLink>
            </li>
            <li>
              <details open>
                <summary class="gap-3">
                  <Agent class="size-4 shrink-0" />
                  Agents
                  <span class="badge badge-xs ml-auto">{{ agentStore.online.length }}/{{ agentStore.agents.length }}</span>
                </summary>
                <ul class="gap-0.5">
                  <li v-for="agent in agentStore.agents" :key="agent.id">
                    <RouterLink :to="{ name: 'agent', params: { id: agent.id } }" class="gap-2.5">
                      <span
                        class="size-2 shrink-0 rounded-full"
                        :class="STATE_DOT[agent.state] ?? 'bg-base-content/30'"
                        :title="agent.state"
                      ></span>
                      <span class="truncate">{{ agent.label }}</span>
                    </RouterLink>
                  </li>
                  <li>
                    <button type="button" class="gap-2.5 opacity-70" @click="addAgentOpen = true">
                      <Plus class="size-4 shrink-0" />
                      Add agent
                    </button>
                  </li>
                </ul>
              </details>
            </li>
          </ul>
        </div>

        <div class="border-base-300 border-t p-3">
          <ul class="menu w-full gap-0.5 p-0">
            <li>
              <RouterLink :to="{ name: 'account' }" class="gap-3">
                <User class="size-4 shrink-0" />
                My account
              </RouterLink>
            </li>
            <li v-if="auth.can('user.read')">
              <RouterLink :to="{ name: 'accounts' }" class="gap-3">
                <Users class="size-4 shrink-0" />
                All accounts
              </RouterLink>
            </li>
            <li v-if="auth.can('audit.read')">
              <RouterLink :to="{ name: 'audit' }" class="gap-3">
                <ScrollText class="size-4 shrink-0" />
                Audit log
              </RouterLink>
            </li>
            <li>
              <button type="button" class="text-error hover:bg-error/10 gap-3" @click="logout">
                <LogOut class="size-4 shrink-0" />
                Log out
              </button>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  </div>
</template>
