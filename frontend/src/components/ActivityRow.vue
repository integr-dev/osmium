<script setup lang="ts">
import { RouterLink } from 'vue-router'
import type { ActivityEntryResponse } from '../api/client'
import { SEVERITY_DOT } from '../lib/activity'
import { atTime } from '../lib/time'

/**
 * One line of the activity feed: when, how bad, and what happened.
 *
 * Shared by the dashboard and an agent's own page, which show the same entries at different scopes.
 * They had a row each, and the two had drifted into different paddings and different backgrounds for
 * the same fact.
 *
 * `agent` is what differs between the two: the fleet's feed names the agent and links to it, while
 * an agent's own page is already about one agent, so naming it on every line says nothing.
 *
 * Time only, never a date: the feed is a working day's worth, and the date is noise inside one.
 */
defineProps<{ line: ActivityEntryResponse; agent?: boolean }>()
</script>

<template>
  <component
    :is="agent && line.agentId ? RouterLink : 'div'"
    :to="agent && line.agentId ? { name: 'agent', params: { id: line.agentId } } : undefined"
    class="rounded-field flex items-center gap-2 px-2 py-1 text-sm"
    :class="agent && line.agentId ? 'hover:bg-base-300/40' : ''"
  >
    <span class="shrink-0 font-mono text-xs opacity-50">{{ atTime(line.at) }}</span>
    <span class="size-1.5 shrink-0 rounded-full" :class="SEVERITY_DOT[line.severity]"></span>
    <span v-if="agent" class="shrink-0 font-medium">{{ line.agentLabel }}</span>
    <span class="min-w-0 flex-1 truncate opacity-70">{{ line.text }}</span>
  </component>
</template>
