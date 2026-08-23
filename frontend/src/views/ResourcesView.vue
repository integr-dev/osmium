<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot as Agent, Server, Share2, TriangleAlert } from 'lucide-vue-next'
import AgentList from '../components/AgentList.vue'
import FleetGraph from '../components/FleetGraph.vue'
import HostList from '../components/HostList.vue'
import { useAgentStore } from '../stores/agents'

/**
 * What this deployment is made of, rather than what is being done with it.
 *
 * Three tabs and the same reasoning as Operations: they are three answers to one question, and an
 * operator moves between them in a sitting — which agents exist, which machines run them, and how
 * the two are wired together right now.
 *
 * Bots leads. It is the tier an operator thinks in; hosts are where those agents happen to live.
 *
 * Not node-gated per tab, unlike Operations. All three are **reads** of the same fleet a viewer can
 * already see in the sidebar; the actions inside them carry their own nodes.
 */
const { t } = useI18n()
const agentStore = useAgentStore()

type Tab = 'bots' | 'hosts' | 'graph'

const tab = ref<Tab>('bots')

const tabs: Array<{ id: Tab; label: string; icon: typeof Agent }> = [
  { id: 'bots', label: 'resources.tabBots', icon: Agent },
  { id: 'hosts', label: 'resources.tabHosts', icon: Server },
  { id: 'graph', label: 'resources.tabGraph', icon: Share2 },
]

onMounted(() => {
  if (!agentStore.loaded) void agentStore.refresh()
})
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">{{ t('resources.title') }}</h1>
      <p class="text-sm opacity-60">{{ t('resources.subtitle') }}</p>
    </header>

    <div role="tablist" class="tabs tabs-border">
      <button
        v-for="entry in tabs"
        :key="entry.id"
        type="button"
        role="tab"
        class="tab gap-2"
        :class="tab === entry.id ? 'tab-active' : ''"
        @click="tab = entry.id"
      >
        <component :is="entry.icon" class="size-4" />
        {{ t(entry.label) }}
      </button>
    </div>

    <div v-if="agentStore.error" role="alert" class="alert alert-error alert-soft">
      <TriangleAlert class="size-4" />
      <span>{{ agentStore.error }}</span>
    </div>

    <AgentList v-if="tab === 'bots'" />
    <HostList v-else-if="tab === 'hosts'" />
    <FleetGraph v-else />
  </div>
</template>
