<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot as Agent } from 'lucide-vue-next'
import PlayerHead from './PlayerHead.vue'
import { STATE_DOT, stateLabel } from '../lib/agentState'
import type { FleetAgent } from '../stores/agents'

/**
 * Checkboxed list of agents, for the screens that act on several at once.
 *
 * One component rather than one per screen: Configuration and Operations both need it, and two
 * copies of a list this fiddly drift the first time either is touched.
 *
 * [unavailable] renders agents that cannot be picked, greyed and without a checkbox, above the
 * reason. Hiding them instead would leave an operator hunting for an agent that is right there —
 * being told why it cannot be chosen is the useful answer.
 */
const selected = defineModel<number[]>({ required: true })

const props = withDefaults(
  defineProps<{
    agents: FleetAgent[]
    unavailable?: FleetAgent[]
    unavailableNote?: string
    title?: string
  }>(),
  { unavailable: () => [], unavailableNote: '', title: '' },
)

const { t } = useI18n()

const allSelected = computed(
  () => props.agents.length > 0 && selected.value.length === props.agents.length,
)

function toggleAll() {
  selected.value = allSelected.value ? [] : props.agents.map((agent) => agent.id)
}

/**
 * Nothing stays selected once it leaves the list.
 *
 * On screens where the choices *depend on the choice* — picking a builder locks the fleet to that
 * agent's server — selecting all takes every agent shown, and the list then shrinks around the
 * decision that made. Without this the ones that dropped out stay selected while invisible: the
 * count says nine, the list shows four, and the action goes out to agents on a server the operator
 * did not pick.
 *
 * It settles in one pass, because what is kept is exactly what the narrowed list contains. The
 * guard is what stops it looping: assigning an unchanged array would retrigger the watch forever.
 */
watch(
  () => props.agents,
  (agents) => {
    const available = new Set(agents.map((agent) => agent.id))
    const kept = selected.value.filter((id) => available.has(id))

    if (kept.length !== selected.value.length) selected.value = kept
  },
)
</script>

<template>
  <div class="card border-base-300 bg-base-200 h-fit border">
    <div class="card-body gap-3">
      <div class="flex items-center justify-between">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Agent class="text-primary size-4" />
          {{ title || t('configuration.agents') }}
        </h2>
        <span v-if="selected.length" class="badge badge-sm">
          {{ t('configuration.selected', { count: selected.length }) }}
        </span>
      </div>

      <label
        v-if="agents.length"
        class="rounded-field hover:bg-base-content/5 flex cursor-pointer items-center gap-3 px-2 py-1.5 text-sm"
      >
        <input type="checkbox" class="checkbox checkbox-sm" :checked="allSelected" @change="toggleAll" />
        <span class="opacity-70">{{ t('configuration.selectAll') }}</span>
      </label>

      <!--
        The agents scroll, the heading and the select-all do not.

        A fleet of forty makes this card taller than the panel it sits beside, and then the page
        scrolls instead of the list: reaching the last agent pushes the thing being acted on off the
        screen, and the select-all is somewhere above the top of the window by the time it is
        wanted. Both lists are inside the same scroller, since the unavailable ones grow the card
        just as well as the available ones.
      -->
      <div class="-mr-1 flex max-h-[26rem] flex-col gap-0.5 overflow-y-auto pr-1">
      <ul class="flex flex-col gap-0.5">
        <li v-for="agent in agents" :key="agent.id">
          <label
            class="rounded-field hover:bg-base-content/5 flex cursor-pointer items-center gap-3 px-2 py-1.5"
          >
            <input v-model="selected" type="checkbox" :value="agent.id" class="checkbox checkbox-sm" />
            <span class="relative shrink-0" :title="stateLabel(agent.state)">
              <PlayerHead :id="agent.mcUuid ?? agent.mcUsername" :name="agent.label" size="sm" />
              <span
                class="ring-base-200 absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
                :class="STATE_DOT[agent.state] ?? 'bg-base-content/30'"
              ></span>
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{{ agent.label }}</span>
              <!--
                Where it plays, under the name. It is the thing most of these screens act on, and an
                agent assigned nowhere says so rather than showing a blank line.
              -->
              <!--
                The Minecraft account and where it plays, in that order: the account is what the
                agent *is*, the server is where it happens to be. Either can be absent — an agent
                before setup has no account, one assigned nowhere has no server — so each is named
                rather than left blank.
              -->
              <span class="block truncate text-xs opacity-50">
                <span v-if="agent.mcUsername" class="font-mono">{{ agent.mcUsername }}</span>
                <span v-else class="italic">{{ t('agents.notLinked') }}</span>
                <span class="opacity-60"> · </span>
                <span :class="agent.serverAddress ? 'font-mono' : 'italic'">
                  {{ agent.serverAddress ?? t('agents.noServer') }}
                </span>
              </span>
            </span>
          </label>
        </li>
      </ul>

      <template v-if="unavailable.length">
        <p class="px-2 pt-2 text-xs opacity-50">{{ unavailableNote }}</p>
        <ul class="flex flex-col gap-0.5 opacity-40">
          <li
            v-for="agent in unavailable"
            :key="agent.id"
            class="flex items-center gap-3 px-2 py-1.5"
            :title="stateLabel(agent.state)"
          >
            <span class="relative shrink-0">
              <PlayerHead :id="agent.mcUuid ?? agent.mcUsername" :name="agent.label" size="sm" />
              <span
                class="ring-base-200 absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
                :class="STATE_DOT[agent.state] ?? 'bg-base-content/30'"
              ></span>
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{{ agent.label }}</span>
              <!--
                The Minecraft account and where it plays, in that order: the account is what the
                agent *is*, the server is where it happens to be. Either can be absent — an agent
                before setup has no account, one assigned nowhere has no server — so each is named
                rather than left blank.
              -->
              <span class="block truncate text-xs opacity-50">
                <span v-if="agent.mcUsername" class="font-mono">{{ agent.mcUsername }}</span>
                <span v-else class="italic">{{ t('agents.notLinked') }}</span>
                <span class="opacity-60"> · </span>
                <span :class="agent.serverAddress ? 'font-mono' : 'italic'">
                  {{ agent.serverAddress ?? t('agents.noServer') }}
                </span>
              </span>
            </span>
          </li>
        </ul>
      </template>
      </div>

      <p v-if="!agents.length && !unavailable.length" class="px-2 py-4 text-center text-sm opacity-50">
        {{ t('configuration.noAgents') }}
      </p>
    </div>
  </div>
</template>
