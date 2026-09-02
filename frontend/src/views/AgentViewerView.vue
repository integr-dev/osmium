<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ChevronLeft } from 'lucide-vue-next'

import AgentViewer from '../components/AgentViewer.vue'
import { useAgentStore } from '../stores/agents'

/**
 * One agent's world, given the whole frame.
 *
 * Not a card in a column like the rest of the fleet screens: this is a window into somewhere, and
 * every pixel spent on a margin around it is a pixel of world nobody can see. The route asks the
 * layout to drop its padding, and the only two controls float over the scene rather than taking a
 * band of it - the way back here, and the camera in the viewer itself.
 *
 * The canvas is keyed on the agent so that navigating between two of them tears the first stream
 * down rather than pointing a live renderer at a different world - the backend counts watchers, and
 * a socket left open keeps a host following a world nobody is looking at.
 */
const route = useRoute()
const { t } = useI18n()
const agentStore = useAgentStore()

const agentId = computed(() => Number(route.params['id']))

/** Named if the fleet is already loaded; otherwise just the way back. */
const agent = computed(() => agentStore.byId(agentId.value))
</script>

<template>
  <div class="relative flex min-h-0 w-full flex-1 flex-col">
    <AgentViewer :key="agentId" :agent-id="agentId" />

    <!--
      Over the scene, not above it. Solid rather than ghost: a transparent control on a world is
      whatever colour the world happens to be behind it, which is not readable.
    -->
    <RouterLink
      :to="{ name: 'agent', params: { id: agentId } }"
      class="btn btn-sm absolute top-3 left-3 z-10 gap-1 shadow-md"
    >
      <ChevronLeft class="size-4" />
      {{ agent?.label ?? t('agents.back') }}
    </RouterLink>
  </div>
</template>
