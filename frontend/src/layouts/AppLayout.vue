<script setup lang="ts">
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Bot as Agent,
  LayoutDashboard,
  LogOut,
  // Aliased: `Map` is a JavaScript built-in, and shadowing it in a template is a trap for the next
  // person who reaches for one.
  Map as MapIcon,
  Menu,
  MessagesSquare,
  Plus,
  RotateCw,
  ScrollText,
  Search,
  Server,
  ServerOff,
  ShieldAlert,
  SlidersHorizontal,
  TriangleAlert,
  User,
  Users,
  WifiOff,
  Workflow,
} from 'lucide-vue-next'
import AddAgentModal from '../components/AddAgentModal.vue'
import ChatRail from '../components/ChatRail.vue'
import CommandPalette from '../components/CommandPalette.vue'
import LanguagePicker from '../components/LanguagePicker.vue'
import PlayerHead from '../components/PlayerHead.vue'
import { backendEverReached, backendReachable } from '../api/client'
import { useAuthStore } from '../stores/auth'
import { STATE_DOT, stateLabel } from '../lib/agentState'
import { vFlash } from '../lib/motion'
import { useResizable } from '../lib/resizable'
import { isShortcut, shortcutLabel } from '../lib/shortcuts'
import { useAgentStore } from '../stores/agents'
import { useChatStore } from '../stores/chat'
import { useHistoryStore } from '../stores/history'

const { t } = useI18n()
const auth = useAuthStore()
const agentStore = useAgentStore()
const chat = useChatStore()
// Started here rather than on the dashboard, so the series covers the session instead of only the
// stretches somebody happened to be looking at it.
useHistoryStore()
const router = useRouter()

const addAgentOpen = ref(false)
const retrying = ref(false)

const palette = ref<InstanceType<typeof CommandPalette> | null>(null)

function openPalette() {
  palette.value?.open()
}

const paletteKeys = shortcutLabel('K')
const chatKeys = shortcutLabel('J')

/**
 * Agent rows carry a label, an account name and a server address, and how much of that fits is a
 * judgement only the person reading it can make. The floor keeps the nav legible; the ceiling stops
 * the sidebar from eating the page it is navigating.
 */
const {
  width: sidebarWidth,
  start: startSidebarResize,
  nudge: nudgeSidebar,
} = useResizable({ key: 'osmium.layout.sidebar', initial: 288, min: 224, max: 440, edge: 'right' })

/**
 * Ctrl/⌘-J opens the rail. Prevented because Chrome binds it to its own downloads panel, and this is
 * the more specific claim while the app has focus. Ctrl/⌘-K is the palette's own, in that component.
 */
function onKeydown(event: KeyboardEvent) {
  if (!isShortcut(event, 'J') || !auth.can('chat.read')) return
  event.preventDefault()
  chat.toggle()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

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

/**
 * Whether either status icon is showing. They share the right edge with the palette hint, and the
 * hint gives it up: something is wrong is worth more of the operator's attention than a shortcut
 * they will learn on any other day.
 */
const statusShown = computed(
  () => degraded.value || (auth.can('agent.read') && !agentStore.liveUpdatesConnected),
)

const backendTip = computed(() =>
  retrying.value
    ? t('connection.retrying')
    : t('connection.backendLost'),
)

async function retry() {
  retrying.value = true
  try {
    await auth.loadUser()
    if (auth.can('agent.read')) await agentStore.refresh()
    if (backendReachable.value) agentStore.connectLiveUpdates()
  } finally {
    retrying.value = false
  }
}

// The sidebar is present on every authenticated page, so it is the natural place to load the fleet
// and to hold the live stream open: one connection for the whole session rather than one per view.
onMounted(() => {
  if (!auth.can('agent.read')) return
  void agentStore.refresh()
  agentStore.connectLiveUpdates()
})

onUnmounted(() => agentStore.disconnectLiveUpdates())

/** Date and time both: this is a security notice, and "which day" is the first thing asked of it. */
function formatAlert(at: string): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function logout() {
  // Closed before the token is dropped, so the stream does not reconnect with a dead credential.
  agentStore.disconnectLiveUpdates()
  // Awaited: this revokes the refresh token at the backend, and leaving before it lands would let
  // the cookie outlive the logout.
  await auth.logout()
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

    <div class="drawer-content flex h-screen flex-col overflow-hidden">
      <!-- Only reachable below lg, where the sidebar is collapsed. -->
      <div class="navbar border-base-300 bg-base-200 border-b lg:hidden">
        <label for="app-drawer" class="btn btn-square btn-ghost btn-sm" :aria-label="t('nav.openNavigation')">
          <Menu class="size-5" />
        </label>
        <img src="/logo.svg" alt="" class="ml-2 size-6" />
        <span class="ml-2 font-semibold">Osmium</span>
      </div>

      <!--
        The page and the chat rail share the width, and **each scrolls itself**. The document used to
        scroll instead, which put the scrollbar on the viewport edge — to the right of the rail,
        past the content it was actually scrolling.

        `min-w-0` on the page, or a wide table inside it pushes the rail off the screen rather than
        scrolling itself. `min-h-0` on the row, or neither pane may shrink below its content and both
        overflow the frame instead of scrolling inside it.
      -->
      <div class="flex min-h-0 flex-1">
        <main class="min-w-0 flex-1 overflow-y-auto px-6 py-8">
          <!--
            On every page rather than tucked into My account. It is the only way the person it
            happened to hears about it at all — the audit trail needs `audit.read`, which reaches an
            administrator and not them — and somebody who has just been signed out with no
            explanation should not have to go looking.
          -->
          <div
            v-if="auth.sessionAlertAt"
            role="alert"
            class="alert alert-warning alert-soft mx-auto mb-6 flex max-w-6xl items-start gap-3"
          >
            <ShieldAlert class="mt-0.5 size-5 shrink-0" />
            <span class="min-w-0 flex-1">
              <span class="block font-medium">{{ t('sessions.alertTitle') }}</span>
              <span class="block text-sm opacity-80">
                {{ t('sessions.alertBody', { when: formatAlert(auth.sessionAlertAt) }) }}
              </span>
            </span>
            <button type="button" class="btn btn-ghost btn-xs" @click="auth.dismissSessionAlert()">
              {{ t('sessions.alertDismiss') }}
            </button>
          </div>

          <RouterView />
        </main>

        <ChatRail v-if="chat.open" />
      </div>
    </div>

    <AddAgentModal v-model:open="addAgentOpen" />
    <!-- Listens on the window, so it opens from anywhere inside the app. -->
    <CommandPalette ref="palette" @add-agent="addAgentOpen = true" />

    <div class="drawer-side">
      <label for="app-drawer" class="drawer-overlay" :aria-label="t('nav.closeNavigation')"></label>

      <!-- Wider than the default drawer: agent rows now carry an account name and a server address. -->
      <aside
        class="border-base-300 bg-base-200 relative flex min-h-full max-w-[85vw] flex-col border-r lg:max-w-none"
        :style="{ width: `${sidebarWidth}px` }"
      >
        <!--
          Pointer only, and hidden where the sidebar is a drawer: a 4px target is not something to
          hand somebody on a touchscreen, and a panel that slides over the page has no edge to drag.
          Focusable with arrow keys anyway, so the width is not a mouse-only setting.
        -->
        <div
          class="hover:bg-primary/40 focus-visible:bg-primary/40 absolute inset-y-0 right-0 z-10 hidden w-1 cursor-col-resize outline-none lg:block"
          role="separator"
          aria-orientation="vertical"
          :aria-label="t('nav.resizeSidebar')"
          tabindex="0"
          @pointerdown="startSidebarResize"
          @keydown.left.prevent="nudgeSidebar(-16)"
          @keydown.right.prevent="nudgeSidebar(16)"
        ></div>

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
            <!--
              Opens leftward and wraps: these sit at the right edge of a fixed-width sidebar that
              clips its own overflow, so a centred one-line bubble loses its second half.
            -->
            <!-- The more severe of the two: nothing is loading at all, so the screen is frozen. -->
            <span
              v-if="degraded"
              class="tooltip tooltip-left before:w-44 before:whitespace-normal"
              :data-tip="backendTip"
            >
              <button type="button" class="btn btn-ghost btn-xs px-1" :disabled="retrying" @click="retry">
                <ServerOff class="text-error size-4" :class="retrying ? 'animate-pulse' : ''" />
              </button>
            </span>

            <!-- The narrow case: the backend answers, but events are not arriving. -->
            <span
              v-else-if="auth.can('agent.read') && !agentStore.liveUpdatesConnected"
              class="tooltip tooltip-left before:w-44 before:whitespace-normal"
              :data-tip="t('connection.streamLost')"
            >
              <WifiOff class="text-warning size-4" />
            </span>
          </div>

          <!--
            Says the palette exists and opens it, so the shortcut is discoverable without being the
            only way in. Gives up the right edge the moment a status icon needs it, so the two never
            compete for the same corner.

            `-mr-2` cancels the button's own padding: without it the label sits inset from the edge
            everything else in the sidebar lines up against.

            The icon carries the meaning and the keys carry the instruction, so the sentence lives
            in the title: an icon on its own says nothing to a screen reader.
          -->
          <button
            v-if="!statusShown"
            type="button"
            class="btn btn-ghost btn-xs -mr-2 gap-1.5 px-2 font-normal opacity-50 hover:opacity-100"
            :title="t('palette.hint', { keys: paletteKeys })"
            @click="openPalette"
          >
            <Search class="size-3.5 shrink-0" />
            {{ paletteKeys }}
          </button>
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
              <RouterLink :to="{ name: 'map' }" class="gap-3">
                <MapIcon class="size-4 shrink-0" />
                {{ t('nav.map') }}
              </RouterLink>
            </li>
            <li v-if="auth.can('agent.run')">
              <RouterLink :to="{ name: 'operations' }" class="gap-3">
                <Workflow class="size-4 shrink-0" />
                {{ t('nav.operations') }}
              </RouterLink>
            </li>
            <li v-if="auth.can('agent.write')">
              <RouterLink :to="{ name: 'configuration' }" class="gap-3">
                <SlidersHorizontal class="size-4 shrink-0" />
                {{ t('nav.configuration') }}
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
                  <!--
                    The fleet is a list of people as much as a list of rows, and this is the one
                    place every one of them is on screen at once. `v-flash` is on the state rather
                    than the agent: a relink or a disconnect that happened while the operator was
                    on another page is exactly what they would otherwise miss.
                  -->
                  <li v-for="agent in agentStore.agents" :key="agent.id">
                    <RouterLink
                      v-flash="agent.state"
                      :to="{ name: 'agent', params: { id: agent.id } }"
                      class="gap-2.5"
                    >
                      <span class="relative shrink-0" :title="stateLabel(agent.state)">
                        <PlayerHead :id="agent.mcUuid ?? agent.mcUsername" :name="agent.label" size="sm" />
                        <span
                          class="ring-base-200 absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
                          :class="STATE_DOT[agent.state] ?? 'bg-base-content/30'"
                        ></span>
                      </span>
                      <!--
                        The same second line the agent picker carries: the Minecraft account, then
                        where it plays. Each is named when absent rather than left blank — before
                        setup there is no account, and an agent assigned nowhere has no server, and
                        both are things an operator is looking for when they scan this list.
                      -->
                      <span class="min-w-0 flex-1">
                        <span class="block truncate">{{ agent.label }}</span>
                        <span class="block truncate text-xs opacity-50">
                          <span v-if="agent.mcUsername" class="font-mono">{{ agent.mcUsername }}</span>
                          <span v-else class="italic">{{ t('agents.notLinked') }}</span>
                          <span class="opacity-60"> · </span>
                          <span :class="agent.serverAddress ? 'font-mono' : 'italic'">
                            {{ agent.serverAddress ?? t('agents.noServer') }}
                          </span>
                        </span>
                      </span>
                    </RouterLink>
                  </li>
                  <li v-if="auth.can('agent.write')">
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

        <!--
          Not a nav item — it opens a panel beside the page rather than going anywhere — so it sits
          on the separator between the pages and the account menu instead of among the links. The
          badge is the only place the fleet's chatter is visible while the rail is shut, which is
          also why it takes the corner the keys otherwise occupy.
        -->
        <ul v-if="auth.can('chat.read')" class="menu w-full gap-0.5 px-3 pb-3">
          <li>
            <button type="button" class="gap-3" :class="chat.open ? 'menu-active' : ''" @click="chat.toggle()">
              <MessagesSquare class="size-4 shrink-0" />
              {{ t('chat.title') }}
              <span v-if="chat.unread" class="badge badge-primary badge-xs ml-auto">
                {{ chat.unread > 99 ? '99+' : chat.unread }}
              </span>
              <kbd v-else class="kbd kbd-xs ml-auto">{{ chatKeys }}</kbd>
            </button>
          </li>
        </ul>

        <div class="border-base-300 border-t p-3">
          <ul class="menu w-full gap-0.5 p-0">
            <LanguagePicker />
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
