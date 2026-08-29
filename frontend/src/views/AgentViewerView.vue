<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

import AgentViewer from '../components/AgentViewer.vue'

/**
 * One agent's world, full height.
 *
 * The canvas is keyed on the agent so that navigating between two of them tears the first stream
 * down rather than pointing a live renderer at a different world - the backend counts watchers, and
 * a socket left open keeps a host following a world nobody is looking at.
 */
const route = useRoute()
const { t } = useI18n()

const agentId = computed(() => Number(route.params['id']))
</script>

<template>
  <div class="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-4">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">{{ t('viewer.title') }}</h1>
      <p class="text-sm opacity-60">{{ t('viewer.subtitle') }}</p>
    </header>

    <AgentViewer :key="agentId" :agent-id="agentId" />
  </div>
</template>
