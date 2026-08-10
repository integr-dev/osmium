<script setup lang="ts">
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Bot as Agent,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  RotateCw,
  ScrollText,
  Server,
  ServerOff,
  TriangleAlert,
  User,
  Users,
  WifiOff,
} from 'lucide-vue-next'
import AddAgentModal from '../components/AddAgentModal.vue'
import { backendEverReached, backendReachable } from '../api/client'
import { useAuthStore } from '../stores/auth'
import { STATE_DOT } from '../lib/agentState'
import { useAgentStore } from '../stores/agents'

const { t } = useI18n()
const auth = useAuthStore()
const agentStore = useAgentStore()
const router = useRouter()

const addAgentOpen = ref(false)
const retrying = ref(false)

/**
 * Two different failures, two different treatments.
 *
 * Never reached the backend this session: there is nothing on screen worth keeping, and a dashboard
 * of zeroes reads as "no agents configured" rather than "nothing loaded". So the app is withheld.
 *
 * Reached it and then lost it: the data on screen is real, just stale. Withholding it would throw
 * away information the operator can still use, so it stays and the sidebar says why it is frozen.
 */
const blocked = computed(() => !backendEverReached.value && !backendReachable.value)
const degraded = computed(() => backendEverReached.value && !backendReachable.value)

const backendTip = computed(() =>
  retrying.value
    ? t('connection.retrying')
    : t('connection.backendLost'),
)

async function retry() {
  retrying.value = true
  try {
    await auth.loadUser()
    if (auth.can('fleet.read')) await agentStore.refresh()
    if (backendReachable.value) agentStore.connectLiveUpdates()
  } finally {
    retrying.value = false
  }
}

// The sidebar is present on every authenticated page, so it is the natural place to load the fleet
// and to hold the live stream open: one connection for the whole session rather than one per view.
onMounted(() => {
  if (!auth.can('fleet.read')) return
  void agentStore.refresh()
  agentStore.connectLiveUpdates()
})

onUnmounted(() => agentStore.disconnectLiveUpdates())

function logout() {
  // Closed before the token is dropped, so the stream does not reconnect with a dead credential.
  agentStore.disconnectLiveUpdates()
  auth.logout()
  void router.push({ name: 'login' })
}
</script>

<template>
  <!--
    Shown instead of the app, not over it. A dashboard of zeroes behind a warning still reads as a
    fleet with nothing in it, and an operator glancing at it would draw the wrong conclusion.
  -->
  <div v-if="blocked" class="flex min-h-screen items-center justify-center px-6">
    <div class="card border-base-300 bg-base-200 w-full max-w-md border">
      <div class="card-body items-center gap-4 text-center">
        <div class="rounded-field bg-warning/10 flex size-12 items-center justify-center">
          <TriangleAlert class="text-warning size-6" />
        </div>
        <h1 class="text-lg font-semibold">{{ t('connection.blockedTitle') }}</h1>
        <p class="text-sm opacity-70">
          {{ t('connection.blockedBody') }}
        </p>
        <button class="btn btn-primary btn-sm gap-2" :disabled="retrying" @click="retry">
          <RotateCw class="size-4" :class="retrying ? 'animate-spin' : ''" />
          {{ retrying ? t('connection.retrying') : t('connection.tryAgain') }}
        </button>
        <button class="btn btn-ghost btn-xs" type="button" @click="logout">{{ t('nav.logOut') }}</button>
      </div>
    </div>
  </div>

  <div v-else class="drawer lg:drawer-open">
    <input id="app-drawer" type="checkbox" class="drawer-toggle" />

    <div class="drawer-content flex min-h-screen flex-col">
      <!-- Only reachable below lg, where the sidebar is collapsed. -->
      <div class="navbar border-base-300 bg-base-200 border-b lg:hidden">
        <label for="app-drawer" class="btn btn-square btn-ghost btn-sm" :aria-label="t('nav.openNavigation')">
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
      <label for="app-drawer" class="drawer-overlay" :aria-label="t('nav.closeNavigation')"></label>

      <aside class="border-base-300 bg-base-200 flex min-h-full w-64 flex-col border-r">
        <div class="flex items-center gap-3 px-5 py-6">
          <img src="/logo.svg" alt="" class="size-8" />
          <span class="text-lg font-semibold tracking-tight">Osmium</span>

          <!--
            Two failures, two icons, never both: the stream one is conditioned on the backend being
            reachable, because a dead backend takes the stream with it and showing both would say
            the same thing twice.

            Only shown while something is wrong. A permanent green dot is decoration nobody reads.
          -->
          <div class="ml-auto flex items-center gap-1.5">
            <!-- The more severe of the two: nothing is loading at all, so the screen is frozen. -->
            <span v-if="degraded" class="tooltip tooltip-bottom" :data-tip="backendTip">
              <button type="button" class="btn btn-ghost btn-xs px-1" :disabled="retrying" @click="retry">
                <ServerOff class="text-error size-4" :class="retrying ? 'animate-pulse' : ''" />
              </button>
            </span>

            <!-- The narrow case: the backend answers, but events are not arriving. -->
            <span
              v-else-if="auth.can('fleet.read') && !agentStore.liveUpdatesConnected"
              class="tooltip tooltip-bottom"
              :data-tip="t('connection.streamLost')"
            >
              <WifiOff class="text-warning size-4" />
            </span>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto px-3">
          <ul class="menu w-full gap-0.5 p-0">
            <li>
              <RouterLink :to="{ name: 'dashboard' }" class="gap-3">
                <LayoutDashboard class="size-4 shrink-0" />
                {{ t('nav.dashboard') }}
              </RouterLink>
            </li>
            <li>
              <RouterLink :to="{ name: 'hosts' }" class="gap-3">
                <Server class="size-4 shrink-0" />
                {{ t('nav.hosts') }}
                <span class="badge badge-xs ml-auto">
                  {{ agentStore.hosts.filter((host) => host.reachable).length }}/{{ agentStore.hosts.length }}
                </span>
              </RouterLink>
            </li>
            <li>
              <details open>
                <summary class="gap-3">
                  <Agent class="size-4 shrink-0" />
                  {{ t('nav.agents') }}
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
                  <li v-if="auth.can('fleet.control')">
                    <button type="button" class="gap-2.5 opacity-70" @click="addAgentOpen = true">
                      <Plus class="size-4 shrink-0" />
                      {{ t('nav.addAgent') }}
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
                {{ t('nav.myAccount') }}
              </RouterLink>
            </li>
            <li v-if="auth.can('user.read')">
              <RouterLink :to="{ name: 'accounts' }" class="gap-3">
                <Users class="size-4 shrink-0" />
                {{ t('nav.allAccounts') }}
              </RouterLink>
            </li>
            <li v-if="auth.can('audit.read')">
              <RouterLink :to="{ name: 'audit' }" class="gap-3">
                <ScrollText class="size-4 shrink-0" />
                {{ t('nav.auditLog') }}
              </RouterLink>
            </li>
            <li>
              <button type="button" class="text-error hover:bg-error/10 gap-3" @click="logout">
                <LogOut class="size-4 shrink-0" />
                {{ t('nav.logOut') }}
              </button>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  </div>
</template>
