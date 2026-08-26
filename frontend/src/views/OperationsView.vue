<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Box, Hammer, Server, TriangleAlert, Workflow } from 'lucide-vue-next'
import BuildJobs from '../components/BuildJobs.vue'
import SchematicLibrary from '../components/SchematicLibrary.vue'
import FleetControls from '../components/FleetControls.vue'
import { useQueryTab } from '../lib/queryState'
import { useSlide } from '../lib/motion'
import TabBar, { type Tab as Strip } from '../components/TabBar.vue'
import { useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'

/**
 * Work done to the fleet as a group, rather than settings held on one agent.
 *
 * Three things, and they are tabs rather than three pages because they are the same act with a
 * different verb — pick a group, then do one thing to all of it — and because an operator moves
 * between them in one sitting: choose what to build, point the agents at the server, bring them in.
 *
 * Schematics leads. It is the only one of the three that is about the work rather than about the
 * fleet, and it is what an operation starts from.
 */
const { t } = useI18n()
const agentStore = useAgentStore()
const auth = useAuthStore()

type Tab = 'schematics' | 'jobs' | 'fleet'

const TABS = ['schematics', 'jobs', 'fleet'] as const

/** In the URL, so this page can be linked to and Back means the previous tab. See lib/queryState.ts. */
const tab = useQueryTab<Tab>('tab', TABS, 'schematics')
/** Which way the strip was moved through, so the panel arrives from the side its tab is on. */
const slide = useSlide(tab, TABS)
const error = ref<string | null>(null)
const done = ref<string | null>(null)

const tabs: Array<{ id: Tab; label: string; icon: typeof Box; node: string }> = [
  { id: 'schematics', label: 'operations.tabSchematics', icon: Box, node: 'schematic.read' },
  // Beside the wizard rather than on the dashboard: this is where a job is started, so it is where
  // an operator looks for the one they just started.
  { id: 'jobs', label: 'operations.tabJobs', icon: Hammer, node: 'agent.read' },
  // One tab, because pointing agents at a server and bringing them into it is one sitting.
  { id: 'fleet', label: 'operations.tabFleet', icon: Server, node: 'agent.write' },
]

onMounted(() => {
  if (!agentStore.agents.length) void agentStore.refresh()
})

/**
 * What the strip shows: the tabs this account may actually open, with their labels resolved.
 *
 * The gating is done here rather than inside the strip. A viewer reaches this page for the
 * schematic library and should not be shown three tabs that answer 403 — an interface that offers
 * what it will refuse reads as broken rather than as restricted.
 */
const strip = computed<Strip<Tab>[]>(() =>
  tabs
    .filter((entry) => auth.can(entry.node))
    .map((entry) => ({ id: entry.id, label: t(entry.label), icon: entry.icon })),
)

/** One banner for all three tabs: the outcome belongs to the page, not to whichever panel spoke. */
function report(message: string, failed: boolean) {
  error.value = failed ? message : null
  done.value = failed ? null : message
}

function clearReport() {
  error.value = null
  done.value = null
}

/**
 * The banner is about one act on one tab, so it does not follow the operator to the next.
 *
 * Nothing cleared it before — not a tab change, not a new selection, not time — so "12 agents
 * connected" stayed pinned above the Schematics tab for the rest of the session, describing
 * something that had happened somewhere the operator was no longer looking.
 */
watch(tab, clearReport)
</script>

<template>
  <!--
    Wider than the other pages. Every tab here is a picker beside a panel, and the Schematics one is
    a picker beside two — at 6xl the box viewer ends up narrower than the list of segments beside it.
  -->
  <div class="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">{{ t('operations.title') }}</h1>
      <p class="text-sm opacity-60">{{ t('operations.subtitle') }}</p>
    </header>

    <TabBar v-model="tab" :tabs="strip" />

    <!--
      Dismissible, both of them. A tab change clears the banner on its own, but an operator who has
      read the outcome and wants the room back should not have to leave the tab to get it.
    -->
    <div v-if="error" role="alert" class="alert alert-error alert-soft">
      <TriangleAlert class="size-4" />
      <span class="min-w-0 flex-1">{{ error }}</span>
      <button type="button" class="btn btn-ghost btn-xs" @click="clearReport">
        {{ t('common.dismiss') }}
      </button>
    </div>
    <div v-if="done" role="alert" class="alert alert-success alert-soft">
      <Workflow class="size-4" />
      <span class="min-w-0 flex-1">{{ done }}</span>
      <button type="button" class="btn btn-ghost btn-xs" @click="clearReport">
        {{ t('common.dismiss') }}
      </button>
    </div>

    <!-- One transition over the whole chain: only one panel is ever mounted. -->
    <div class="osmium-slide min-h-0 flex-1">
      <Transition :name="slide">
      <SchematicLibrary
        v-if="tab === 'schematics' && auth.can('schematic.read')"
        @done="report($event, false)"
        @failed="report($event, true)"
        @started="tab = 'jobs'"
      />
      <!--
        Moving the operator to what they just made. A run started from the wizard leaves the last
        step looking exactly as it did, and "did that work" is not a question the banner alone
        answers.
      -->
      <BuildJobs
        v-else-if="tab === 'jobs' && auth.can('agent.read')"
        @done="report($event, false)"
        @failed="report($event, true)"
      />
      <FleetControls
        v-else-if="tab === 'fleet' && auth.can('agent.write')"
        @done="report($event, false)"
        @failed="report($event, true)"
      />
      </Transition>
    </div>
  </div>
</template>
