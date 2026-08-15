<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Box, Power, Server, TriangleAlert, Workflow } from 'lucide-vue-next'
import FleetConnections from '../components/FleetConnections.vue'
import SchematicLibrary from '../components/SchematicLibrary.vue'
import ServerAssignment from '../components/ServerAssignment.vue'
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

type Tab = 'schematics' | 'servers' | 'power'

const tab = ref<Tab>('schematics')
const error = ref<string | null>(null)
const done = ref<string | null>(null)

const tabs: Array<{ id: Tab; label: string; icon: typeof Box; node: string }> = [
  { id: 'schematics', label: 'operations.tabSchematics', icon: Box, node: 'schematic.read' },
  { id: 'servers', label: 'operations.tabServers', icon: Server, node: 'agent.write' },
  { id: 'power', label: 'operations.tabPower', icon: Power, node: 'agent.run' },
]

onMounted(() => {
  if (!agentStore.agents.length) void agentStore.refresh()
})

/** One banner for all three tabs: the outcome belongs to the page, not to whichever panel spoke. */
function report(message: string, failed: boolean) {
  error.value = failed ? message : null
  done.value = failed ? null : message
}
</script>

<template>
  <!--
    Wider than the other pages. Every tab here is a picker beside a panel, and the Schematics one is
    a picker beside two — at 6xl the box viewer ends up narrower than the list of segments beside it.
  -->
  <div class="mx-auto flex max-w-7xl flex-col gap-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">{{ t('operations.title') }}</h1>
      <p class="text-sm opacity-60">{{ t('operations.subtitle') }}</p>
    </header>

    <!--
      Node-gated per tab. A viewer reaches this page for the schematic library and should not be
      shown two tabs that answer 403 — an interface that offers what it will refuse reads as broken
      rather than as restricted.
    -->
    <div role="tablist" class="tabs tabs-border">
      <template v-for="entry in tabs" :key="entry.id">
        <button
          v-if="auth.can(entry.node)"
          type="button"
          role="tab"
          class="tab gap-2"
          :class="tab === entry.id ? 'tab-active' : ''"
          @click="tab = entry.id"
        >
          <component :is="entry.icon" class="size-4" />
          {{ t(entry.label) }}
        </button>
      </template>
    </div>

    <div v-if="error" role="alert" class="alert alert-error alert-soft">
      <TriangleAlert class="size-4" />
      <span>{{ error }}</span>
    </div>
    <div v-if="done" role="alert" class="alert alert-success alert-soft">
      <Workflow class="size-4" />
      <span>{{ done }}</span>
    </div>

    <SchematicLibrary
      v-if="tab === 'schematics' && auth.can('schematic.read')"
      @failed="report($event, true)"
    />
    <ServerAssignment
      v-else-if="tab === 'servers' && auth.can('agent.write')"
      @done="report($event, false)"
      @failed="report($event, true)"
    />
    <FleetConnections
      v-else-if="tab === 'power' && auth.can('agent.run')"
      @done="report($event, false)"
      @failed="report($event, true)"
    />
  </div>
</template>
