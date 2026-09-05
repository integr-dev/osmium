<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Search } from 'lucide-vue-next'
import PlayerHead from './PlayerHead.vue'
import { agentDot, agentStateLabel } from '../lib/agentState'
import { useAgentStore, type FleetAgent } from '../stores/agents'

/**
 * Who to send somewhere, inside a panel that opened where somebody clicked.
 *
 * **Not {@link AgentPicker}, and it was for a while.** That component is a page's worth of list: a
 * heading, a count badge, a search box and a select-all, all of which earn their space in a column
 * beside the thing being acted on. Floating over a map with one agent in it, they were four rows of
 * chrome around one row of content, and the panel read as a form rather than as an answer to a
 * click.
 *
 * So this is the same list with everything that only pays off at scale made conditional on there
 * being any scale. What is left for a fleet of one is the agent.
 */
const selected = defineModel<number[]>({ required: true })

const props = defineProps<{ agents: FleetAgent[] }>()

const { t } = useI18n()
const agentStore = useAgentStore()

/**
 * Past this many, a list is scanned rather than read.
 *
 * Under it, a search box costs more than it saves: it is one more thing between a click and the
 * agent, and the agent is already on screen.
 */
const SEARCHABLE = 6

const query = ref('')
const needle = computed(() => query.value.trim().toLowerCase())

const searchable = computed(() => props.agents.length > SEARCHABLE)

/** Matched against the label and the account, which is what somebody is looking down the list for. */
const visible = computed(() =>
  needle.value
    ? props.agents.filter(
        (agent) =>
          agent.label.toLowerCase().includes(needle.value) ||
          (agent.mcUsername?.toLowerCase().includes(needle.value) ?? false),
      )
    : props.agents,
)

/** Only worth offering for more than one. With one agent it is a second way to tick one box. */
const selectable = computed(() => props.agents.length > 1)

const allSelected = computed(
  () => visible.value.length > 0 && visible.value.every((agent) => selected.value.includes(agent.id)),
)

/** Takes what is shown rather than everything, so a search narrows what it means - like the picker. */
function toggleAll(): void {
  const shown = visible.value.map((agent) => agent.id)

  selected.value = allSelected.value
    ? selected.value.filter((id) => !shown.includes(id))
    : [...new Set([...selected.value, ...shown])]
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label v-if="searchable" class="input input-xs w-full">
      <Search class="size-3.5 opacity-60" />
      <input v-model="query" type="search" :placeholder="t('configuration.filterAgents')" />
    </label>

    <label
      v-if="selectable"
      class="rounded-field hover:bg-base-300/40 flex cursor-pointer items-center gap-2 px-1 py-1 text-xs"
    >
      <input type="checkbox" class="checkbox checkbox-xs" :checked="allSelected" @change="toggleAll" />
      <span class="opacity-70">
        {{ needle ? t('configuration.selectAllShown') : t('configuration.selectAll') }}
      </span>
    </label>

    <!-- Scrolls, so a fleet of forty does not push the panel off the bottom of the window. -->
    <ul class="-mx-1 flex max-h-48 flex-col gap-0.5 overflow-y-auto">
      <li v-for="agent in visible" :key="agent.id">
        <label
          class="rounded-field hover:bg-base-300/40 flex cursor-pointer items-center gap-2 px-1 py-1 transition-colors"
        >
          <input v-model="selected" type="checkbox" :value="agent.id" class="checkbox checkbox-xs" />
          <span class="relative shrink-0" :title="agentStateLabel(agent.state, agentStore.isBuilding(agent.id))">
            <PlayerHead :id="agent.mcUuid ?? agent.mcUsername" :name="agent.label" size="sm" />
            <span
              class="ring-base-100 absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
              :class="agentDot(agent.state, agentStore.isBuilding(agent.id))"
            ></span>
          </span>
          <!--
            The label only. The account and the server are what tell two agents apart on a screen
            listing the whole fleet; every agent in this list is already in the same world, standing
            where the click landed, so the name is the whole of what distinguishes them.
          -->
          <span class="min-w-0 flex-1 truncate text-sm">{{ agent.label }}</span>
        </label>
      </li>
    </ul>

    <p v-if="!visible.length" class="px-1 py-1 text-xs opacity-50">{{ t('configuration.noMatches') }}</p>
  </div>
</template>
