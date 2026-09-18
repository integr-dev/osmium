<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot as Agent, Route, Server, Share2 } from 'lucide-vue-next'
import AlertNote from '../components/AlertNote.vue'
import AgentList from '../components/AgentList.vue'
import FleetGraph from '../components/FleetGraph.vue'
import HostList from '../components/HostList.vue'
import ProxyList from '../components/ProxyList.vue'
import { useQueryTab } from '../lib/queryState'
import { useSlide } from '../lib/motion'
import TabBar, { type Tab as Strip } from '../components/TabBar.vue'
import { useAgentStore } from '../stores/agents'

/**
 * What this deployment is made of, rather than what is being done with it.
 *
 * Four tabs and the same reasoning as Operations: they are four answers to one question, and an
 * operator moves between them in a sitting — which agents exist, which machines run them, where
 * those machines can route a session, and how the whole lot is wired together right now.
 *
 * Bots leads. It is the tier an operator thinks in; hosts are where those agents happen to live.
 *
 * Not node-gated per tab, unlike Operations. All three are **reads** of the same fleet a viewer can
 * already see in the sidebar; the actions inside them carry their own nodes.
 */
const { t } = useI18n()
const agentStore = useAgentStore()

type Tab = 'bots' | 'hosts' | 'proxies' | 'graph'

// Proxies before the graph, because the graph is the summary of everything before it: an operator
// reads the parts and then how they are joined, rather than the other way round.
const TABS = ['bots', 'hosts', 'proxies', 'graph'] as const

/** In the URL, like Operations beside it, so a tab can be linked to and Back returns to it. */
const tab = useQueryTab<Tab>('tab', TABS, 'bots')

const slide = useSlide(tab, TABS)

const tabs: Array<{ id: Tab; label: string; icon: typeof Agent }> = [
  { id: 'bots', label: 'resources.tabBots', icon: Agent },
  { id: 'hosts', label: 'resources.tabHosts', icon: Server },
  { id: 'proxies', label: 'resources.tabProxies', icon: Route },
  { id: 'graph', label: 'resources.tabGraph', icon: Share2 },
]

const strip = computed<Strip<Tab>[]>(() =>
  tabs.map((entry) => ({ id: entry.id, label: t(entry.label), icon: entry.icon })),
)

onMounted(() => {
  if (!agentStore.loaded) void agentStore.refresh()
})
</script>

<template>
  <div class="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">{{ t('resources.title') }}</h1>
    </header>

    <TabBar v-model="tab" :tabs="strip" />

    <AlertNote v-if="agentStore.error" kind="error" :message="agentStore.error" />

    <div class="osmium-slide min-h-0 flex-1">
      <Transition :name="slide">
      <AgentList v-if="tab === 'bots'" />
      <HostList v-else-if="tab === 'hosts'" />
      <ProxyList v-else-if="tab === 'proxies'" />
      <FleetGraph v-else />
      </Transition>
    </div>
  </div>
</template>
