<script setup lang="ts">
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Bot as Agent,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  // Aliased: `Map` is a JavaScript built-in, and shadowing it in a template is a trap for the next
  // person who reaches for one.
  Map as MapIcon,
  Menu,
  MessagesSquare,
  Plus,
  RotateCw,
  HardDrive,
  ScrollText,
  Search,
  Network,
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
import AlertNote from '../components/AlertNote.vue'
import AddAgentModal from '../components/AddAgentModal.vue'
import AddHostModal from '../components/AddHostModal.vue'
import ChatRail from '../components/ChatRail.vue'
import CommandPalette from '../components/CommandPalette.vue'
import LanguagePicker from '../components/LanguagePicker.vue'
import ThemePicker from '../components/ThemePicker.vue'
import NavRail from '../components/NavRail.vue'
import InitialTile from '../components/InitialTile.vue'
import PlayerHead from '../components/PlayerHead.vue'
import ToastStack from '../components/ToastStack.vue'
import { backendEverReached, backendReachable } from '../api/client'
import { useAuthStore } from '../stores/auth'
import { agentDot, agentStateLabel } from '../lib/agentState'
import { prefersReducedMotion, vFlash } from '../lib/motion'
import { atShort } from '../lib/time'
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
const route = useRoute()

const addAgentOpen = ref(false)
const addHostOpen = ref(false)

/** The fleet section, open by default: it is the reason most operators open the sidebar. */
const agentsOpen = ref(true)

/**
 * The hosts section, **shut** by default. There are far fewer hosts than agents and they change far
 * less often, so it is the fleet that earns the open state and the vertical room it costs.
 */
const hostsOpen = ref(false)
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

/**
 * Whether the live stream has been down long enough to be worth a banner.
 *
 * Nearly every list in the application is stream-fed and none of them poll, deliberately. So a
 * dropped stream freezes upload bars, agent states and arriving rows while every page goes on
 * looking entirely normal — and the only thing that said so was a 16px glyph in the corner of the
 * sidebar behind a hover tooltip.
 *
 * Delayed rather than immediate. The stream is not connected for the first moment of every page
 * load and reconnects with backoff after any blip, and a banner that flashed on each of those would
 * be noise that teaches an operator to ignore it.
 */
const streamDown = ref(false)
let streamTimer: ReturnType<typeof setTimeout> | undefined

const STREAM_GRACE_MS = 6_000

watch(
  () => auth.can('agent.read') && !agentStore.liveUpdatesConnected,
  (lost) => {
    clearTimeout(streamTimer)
    if (!lost) {
      streamDown.value = false
      return
    }
    streamTimer = setTimeout(() => {
      streamDown.value = true
    }, STREAM_GRACE_MS)
  },
  { immediate: true },
)

onUnmounted(() => clearTimeout(streamTimer))

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

/**
 * The chat rail opening and shutting, animated in JavaScript rather than in CSS.
 *
 * It is a width that has to move — the rail is a column beside the page, so anything else would
 * have the page jump to its new width while the rail slid into it — and the width it moves to is
 * the operator's own, dragged and remembered. A keyframe cannot know that number; this reads it
 * off the element the moment before it is animated from nothing.
 *
 * `:css="false"` on the transition, so Vue waits for `done()` rather than for classes it will not
 * find.
 */
const RAIL_MS = 280

function slideRail(el: Element, to: string, done: () => void) {
  const rail = el as HTMLElement

  if (prefersReducedMotion()) {
    done()
    return
  }

  const from = to === '0px' ? `${rail.offsetWidth}px` : '0px'

  rail.style.overflow = 'hidden'
  rail.style.width = from

  // Read back, so the browser has the starting width as a computed value before it is changed.
  void rail.offsetWidth

  rail.style.transition = `width ${RAIL_MS}ms var(--osmium-ease)`
  rail.style.width = to

  rail.addEventListener(
    'transitionend',
    () => {
      rail.style.transition = ''
      rail.style.overflow = ''
      done()
    },
    { once: true },
  )
}

function railEnter(el: Element, done: () => void) {
  // Its own width, which the component has already put on the element as an inline style.
  slideRail(el, (el as HTMLElement).style.width || '0px', done)
}

function railLeave(el: Element, done: () => void) {
  slideRail(el, '0px', done)
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
        <!--
          **The page itself does not scroll.** Every view is given the height of this frame and puts
          its own scrollbar on the part that is long — the table, the list of jobs, the column of
          cards — so a title, a set of tabs and a row of filters stay where they were put while the
          rows move under them. Scrolling a whole page to reach the bottom of a list, and losing the
          controls for that list on the way, is the thing this is instead of.

          No scrollbar gutter here any more: nothing on this element scrolls, so there is none to
          reserve room for.
        -->
        <!--
          Padding is the layout's, except where a screen has asked to own the whole frame, and there
          are two ways of asking.

          `full` is a window onto somewhere — the map, the viewer — where a margin is world nobody
          can see. `scrolls` is a page that is simply taller than the frame: it keeps the margin,
          but applies it *inside* its own scroller, so the scrollbar runs down the frame's right
          edge instead of six units in from it with page either side of it.
        -->
        <main
          class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          :class="route.meta.full || route.meta.scrolls ? '' : 'px-6 py-8'"
        >
          <!--
            The two notices below are the layout's own, not the page's, so they keep the layout's
            margin whoever owns the rest of it — a warning hard against the window edge reads as
            broken. Wrapped rather than padded one by one so either alone gets the same gap, and
            absent entirely when neither is up, since a padded empty box is a stripe of nothing.
          -->
          <div
            v-if="auth.sessionAlertAt || streamDown"
            class="shrink-0"
            :class="route.meta.scrolls ? 'px-6 pt-8' : ''"
          >
            <!--
              On every page rather than tucked into My account. It is the only way the person it
              happened to hears about it at all — the audit trail needs `audit.read`, which reaches an
              administrator and not them — and somebody who has just been signed out with no
              explanation should not have to go looking.
            -->
            <AlertNote
              v-if="auth.sessionAlertAt"
              kind="warning"
              :icon="ShieldAlert"
              class="mx-auto mb-6 max-w-6xl"
              :title="t('sessions.alertTitle')"
              :message="t('sessions.alertBody', { when: atShort(auth.sessionAlertAt) })"
            >
              <template #action>
                <button type="button" class="btn btn-ghost btn-xs" @click="auth.dismissSessionAlert()">
                  {{ t('sessions.alertDismiss') }}
                </button>
              </template>
            </AlertNote>

            <!--
              The one thing nothing on a page can say for itself: what is on screen is real but has
              stopped moving. Every list here is fed by the stream and none of them poll, so without
              this a frozen page and a quiet one are the same picture.

              Not dismissible, unlike the notice above it. That one is about something that already
              happened; this one is about the state of the screen right now, and it goes away by
              being fixed.
            -->
            <AlertNote
              v-if="streamDown"
              kind="warning"
              :icon="WifiOff"
              class="mx-auto mb-6 max-w-6xl"
              :title="t('connection.streamLost')"
              :message="t('connection.streamLostBody')"
            />
          </div>

          <!--
            No mode: the outgoing view is dropped rather than faded, so a lazily loaded page is
            never waited for behind a blank screen. See the note in `style.css`.
          -->
          <RouterView v-slot="{ Component }">
            <Transition name="page">
              <component :is="Component" />
            </Transition>
          </RouterView>

          <!--
            Inside the page rather than pinned to the window, so the stack is never over the chat
            rail — which is a column on this same row, and whose composer is in exactly the corner
            a fixed stack would want. It follows the rail opening and closing for free.
          -->
          <ToastStack />
        </main>

        <Transition :css="false" @enter="railEnter" @leave="railLeave">
          <ChatRail v-if="chat.open" />
        </Transition>
      </div>
    </div>

    <AddAgentModal v-model:open="addAgentOpen" />
    <AddHostModal v-model:open="addHostOpen" />
    <!-- Listens on the window, so it opens from anywhere inside the app. -->
    <CommandPalette ref="palette" @add-agent="addAgentOpen = true" />

    <div class="drawer-side">
      <label for="app-drawer" class="drawer-overlay" :aria-label="t('nav.closeNavigation')"></label>

      <!--
        Wider than the default drawer: agent rows now carry an account name and a server address.

        `h-full`, not `min-h-full`. daisyUI gives `.drawer-side` a height of 100dvh and its own
        `overflow-y: auto`, so an aside that is merely *at least* full height grows past the
        viewport with the fleet and the drawer scrolls the whole sidebar — links included. Fixing
        it to the viewport is what gives the list below something to be bounded by.
      -->
      <aside
        class="border-base-300 bg-base-200 relative flex h-full max-w-[85vw] flex-col overflow-hidden border-r lg:max-w-none"
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
                <ServerOff class="text-error size-3.5" :class="retrying ? 'animate-pulse' : ''" />
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

        <!--
          The pages stay put and the fleet scrolls under them.

          The scroll used to sit here, on everything: a fleet of forty pushed Dashboard, Map and
          Hosts off the top of the sidebar, so reaching a page meant scrolling back up a list of
          agents to find the links. Only the agents grow without bound, so only the agents scroll.

          Two menus rather than one, with the scroll on a plain div between them. Bounding the
          agents *inside* the menu does not work: daisyUI sets `flex-shrink: 0` on every `.menu li`
          and `flex-flow: column wrap` on both the menu and its items, so a bounded list refuses to
          shrink and wraps into a second column beside the pages instead of scrolling. Keeping the
          scroller out of the menu's way avoids arguing with all of that.
        -->
        <!-- Natural height. Given `flex-1` it splits the spare space with the scroller below and
             the fleet starts halfway down the sidebar with a gap above it. -->
        <div class="px-3">
          <NavRail>
            <ul class="menu w-full flex-nowrap gap-0.5 p-0">
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
                <RouterLink :to="{ name: 'resources' }" class="gap-3">
                  <Network class="size-4 shrink-0" />
                  {{ t('nav.resources') }}
                </RouterLink>
              </li>
            </ul>
          </NavRail>
        </div>

        <!--
          The machines, on the same disclosure as the fleet below and for the same reason: this is
          the one place all of them are on screen at once, and a host going unreachable takes its
          agents with it without anybody having pressed anything.

          Capped rather than flexible, unlike the fleet. Two lists both claiming the leftover height
          would leave neither with enough of it, and hosts are the shorter list by an order of
          magnitude — so this one takes what it needs and the fleet keeps the rest.
        -->
        <div class="px-3">
          <ul class="menu w-full flex-nowrap gap-0.5 p-0">
            <li>
              <button
                type="button"
                class="gap-3"
                :aria-expanded="hostsOpen"
                aria-controls="sidebar-hosts"
                @click="hostsOpen = !hostsOpen"
              >
                <Server class="size-4 shrink-0" />
                {{ t('nav.hosts') }}
                <span class="badge badge-xs ml-auto">
                  {{ agentStore.hosts.filter((host) => host.reachable).length }}/{{ agentStore.hosts.length }}
                </span>
                <ChevronDown
                  class="size-4 shrink-0 opacity-60 transition-transform"
                  :class="hostsOpen ? '' : '-rotate-90'"
                />
              </button>
            </li>
          </ul>
        </div>

        <!--
          Opened and shut on a grid row rather than with `v-show`, which is the one way a height
          of `auto` can be animated: the track goes from `0fr` to `1fr` and the row inside keeps
          its own measured height. `v-show` blinked, which read as the section not being part of
          the same interface as everything else that moves.
        -->
        <div
          id="sidebar-hosts"
          class="osmium-reveal grid px-3"
          :class="hostsOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
        >
          <div class="osmium-reveal-clip">
            <div class="max-h-56 overflow-y-auto">
              <!-- The shape that is coming, like every other list in the application. -->
              <div v-if="!agentStore.loaded" class="ms-4 flex flex-col gap-1 ps-2 py-1">
                <div v-for="row in 2" :key="row" class="skeleton h-9 w-full"></div>
              </div>
          <!-- The indent and hairline daisyUI would have drawn for a nested menu, by hand. -->
          <div class="border-base-content/10 ms-4 border-s ps-2">
            <NavRail>
            <TransitionGroup name="rows" tag="ul" class="menu w-full flex-nowrap gap-0.5 p-0">
              <!--
                The same row as an agent, deliberately: a lettered tile with the status on its
                corner, then the name over a line of detail. The two lists sit directly above one
                another in one column, and reading as two different kinds of thing made the
                sidebar look like two sidebars.

                A tile rather than a head. A host has no avatar and never will — it is a machine,
                not a player — so it lands on the same fallback an agent uses before it is set up.
              -->
              <li v-for="host in agentStore.hosts" :key="host.id">
                <RouterLink
                  v-flash="host.reachable"
                  :to="{ name: 'host', params: { id: host.id } }"
                  class="gap-2.5"
                >
                  <span
                    class="relative shrink-0"
                    :title="host.reachable ? t('hosts.reachable') : t('hosts.unreachable')"
                  >
                    <InitialTile :name="host.name" size="sm" />
                    <span
                      class="ring-base-200 absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
                      :class="host.reachable ? 'bg-success' : 'bg-error'"
                    ></span>
                  </span>
                  <!--
                    The agent count moves here from a badge on the right. It is detail about the
                    host rather than a count of anything on screen, and it read as a notification
                    sitting where one would be — the chat rail puts a real one in that position.
                  -->
                  <span class="min-w-0 flex-1">
                    <span class="block truncate">{{ host.name }}</span>
                    <span class="block truncate text-xs opacity-50">
                      {{ host.reachable ? t('hosts.reachable') : t('hosts.unreachable') }}
                      <span class="opacity-60"> · </span>
                      {{ t('hosts.agentCount', { count: host.agentCount }, host.agentCount) }}
                    </span>
                  </span>
                </RouterLink>
              </li>
              <li v-if="!agentStore.hosts.length" key="no-hosts">
                <span class="text-xs opacity-50">{{ t('hosts.none') }}</span>
              </li>
              <li v-if="auth.can('host.write')" key="enrol-host">
                <button type="button" class="gap-2.5 opacity-70" @click="addHostOpen = true">
                  <Plus class="size-4 shrink-0" />
                  {{ t('hosts.enrol') }}
                </button>
              </li>
            </TransitionGroup>
            </NavRail>
            </div>
          </div>
          </div>
        </div>

        <!--
          A button rather than a `<summary>`, and the reason is the scrolling.

          A summary has to be a child of its `<details>`, which means it scrolls with the list it
          opens — so the heading and the online count leave the screen as soon as the fleet is long
          enough to need scrolling, which is exactly when they are worth reading. Splitting the two
          costs the native disclosure and buys a header that stays.
        -->
        <div class="px-3">
          <ul class="menu w-full flex-nowrap gap-0.5 p-0">
            <li>
              <button
                type="button"
                class="gap-3"
                :aria-expanded="agentsOpen"
                aria-controls="sidebar-agents"
                @click="agentsOpen = !agentsOpen"
              >
                <Agent class="size-4 shrink-0" />
                {{ t('nav.agents') }}
                <span class="badge badge-xs ml-auto">{{ agentStore.online.length }}/{{ agentStore.agents.length }}</span>
                <ChevronDown
                  class="size-4 shrink-0 opacity-60 transition-transform"
                  :class="agentsOpen ? '' : '-rotate-90'"
                />
              </button>
            </li>
          </ul>
        </div>

        <!-- The fleet, and only the fleet. Everything above stays where it was put. -->
        <div
          id="sidebar-agents"
          class="osmium-reveal grid min-h-0 px-3"
          :class="agentsOpen ? 'flex-1 grid-rows-[1fr]' : 'grid-rows-[0fr]'"
        >
          <div class="osmium-reveal-clip">
            <div class="h-full overflow-y-auto">
              <div v-if="!agentStore.loaded" class="ms-4 flex flex-col gap-1 ps-2 py-1">
                <div v-for="row in 4" :key="row" class="skeleton h-9 w-full"></div>
              </div>
          <!-- The indent and hairline daisyUI would have drawn for a nested menu, kept by hand now
               that the list is no longer nested inside one. -->
          <div class="border-base-content/10 ms-4 border-s ps-2">
            <NavRail>
            <TransitionGroup name="rows" tag="ul" class="menu w-full flex-nowrap gap-0.5 p-0">
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
                      <span class="relative shrink-0" :title="agentStateLabel(agent.state, agentStore.workOf(agent.id))">
                        <PlayerHead :id="agent.mcUuid ?? agent.mcUsername" :name="agent.label" size="sm" />
                        <span
                          class="ring-base-200 absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
                          :class="agentDot(agent.state, agentStore.workOf(agent.id))"
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
                  <li v-if="auth.can('agent.write')" key="add-agent">
                    <button type="button" class="gap-2.5 opacity-70" @click="addAgentOpen = true">
                      <Plus class="size-4 shrink-0" />
                      {{ t('nav.addAgent') }}
                    </button>
                  </li>
            </TransitionGroup>
            </NavRail>
            </div>
          </div>
          </div>
        </div>

        <!--
          Not a nav item — it opens a panel beside the page rather than going anywhere — so it sits
          on the separator between the pages and the account menu instead of among the links. The
          badge is the only place the fleet's chatter is visible while the rail is shut, which is
          also why it takes the corner the keys otherwise occupy.
        -->
        <!--
          The padding moves off the list and onto a wrapper: the rule is placed against the box it
          is inside, so a list that holds its own padding would put the mark at the sidebar's edge
          rather than at the row's.
        -->
        <!--
          **The foot of the sidebar, kept at the foot of it.**

          Everything above is either a fixed height or the fleet, and the fleet only claims the
          leftover space while it is open. Folded shut nothing claimed it at all, so the chat row and
          the account menu rode up the middle of an otherwise empty sidebar and sat under the Agents
          header as though they belonged to it. `mt-auto` takes whatever is spare and puts it above
          this group, which is nothing at all when the fleet is open and the whole of it when it is
          not - so the foot is at the bottom either way.

          `shrink-0` for the other half of the same bug: with the window short enough there is
          nothing spare to take, and flex answers that by squeezing whatever will squeeze. That was
          this group, which has a definite size and cannot afford to lose any of it, rather than the
          one thing here built to be bounded and scrolled. The fleet gives way instead.
        -->
        <div class="mt-auto shrink-0">
          <!--
            `mt-2` rather than the gap the fleet happens to leave. With the agents open, the list ends
            somewhere above this and the space between reads as a break between two kinds of thing;
            folded shut, the reveal collapses to nothing and the chat row landed against the Agents
            header as though it were the next item in that list.
          -->
          <div v-if="auth.can('chat.read')" class="mt-2 px-3 pb-3">
            <NavRail>
              <ul class="menu w-full gap-0.5 p-0">
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
            </NavRail>
          </div>

          <div class="border-base-300 border-t p-3">
            <NavRail>
              <ul class="menu w-full gap-0.5 p-0">
                <ThemePicker />
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
                <li v-if="auth.can('storage.read')">
                  <RouterLink :to="{ name: 'storage' }" class="gap-3">
                    <HardDrive class="size-4 shrink-0" />
                    {{ t('nav.storage') }}
                  </RouterLink>
                </li>
                <li>
                  <button type="button" class="text-error hover:bg-error/10 gap-3" @click="logout">
                    <LogOut class="size-4 shrink-0" />
                    {{ t('nav.logOut') }}
                  </button>
                </li>
              </ul>
            </NavRail>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>
