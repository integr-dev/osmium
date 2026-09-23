<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot as Agent, Search } from 'lucide-vue-next'
import PlayerHead from './PlayerHead.vue'
import { agentDot, agentStateLabel } from '../lib/agentState'
import { useAgentStore, type FleetAgent } from '../stores/agents'

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
    /**
     * Drops the card around it, for where it is already inside one.
     *
     * In a dialog the card was a second surface inside the first, with its own border, its own
     * padding and its own heading directly under the dialog’s — the list ended up inset from
     * everything around it and titled twice. The dialog's own box is the card there.
     */
    bare?: boolean
  }>(),
  { unavailable: () => [], unavailableNote: '', title: '', bare: false },
)

const { t } = useI18n()
const agentStore = useAgentStore()

const query = ref('')
const needle = computed(() => query.value.trim().toLowerCase())

/**
 * Matched against everything the row shows: the label, the Minecraft account and the server.
 *
 * All three, because all three are what an operator is looking down the list for — "which of
 * these is on the build server" is as ordinary a question as "where is Mason_14", and a search
 * that only read the label would answer neither.
 */
function matches(agent: FleetAgent): boolean {
  return (
    agent.label.toLowerCase().includes(needle.value) ||
    (agent.mcUsername?.toLowerCase().includes(needle.value) ?? false) ||
    (agent.serverAddress?.toLowerCase().includes(needle.value) ?? false)
  )
}

/**
 * **Filtering hides, it does not deselect.** A search is a way to find the next agent to tick, so
 * an agent already ticked stays ticked while the search looks past it — which is the opposite of
 * what the watch below does, and deliberately: that one fires when an agent stops being *eligible*,
 * and this one only changes what is on screen.
 */
const visible = computed(() => (needle.value ? props.agents.filter(matches) : props.agents))

const visibleUnavailable = computed(() =>
  needle.value ? props.unavailable.filter(matches) : props.unavailable,
)

/**
 * Select-all is about what is shown, so a search narrows what it takes.
 *
 * It adds to the selection rather than replacing it, and clearing takes only the rows on screen:
 * otherwise ticking all of one search would silently drop everything picked under the last one.
 * With no search this is exactly what it was, because everything is shown.
 */
const allSelected = computed(
  () =>
    visible.value.length > 0 &&
    visible.value.every((agent) => selected.value.includes(agent.id)),
)

function toggleAll() {
  const shown = visible.value.map((agent) => agent.id)

  selected.value = allSelected.value
    ? selected.value.filter((id) => !shown.includes(id))
    : [...new Set([...selected.value, ...shown])]
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
  <div :class="bare ? '' : 'card border-base-300 bg-base-200 h-fit border'">
    <div :class="bare ? 'flex flex-col gap-3' : 'card-body gap-3'">
      <div v-if="!bare || selected.length" class="flex items-center justify-between">
        <h2 v-if="!bare" class="card-title flex items-center gap-2 text-base">
          <Agent class="text-base-content/50 size-4" />
          {{ title || t('configuration.agents') }}
        </h2>
        <span v-if="selected.length" class="badge badge-sm ml-auto">
          {{ t('configuration.selected', { count: selected.length }) }}
        </span>
      </div>

      <!-- Always, like every other list with a search: a control that comes and goes is one an
           operator has to look for rather than reach for. -->
      <label class="input input-sm w-full">
        <Search class="size-4 opacity-60" />
        <input v-model="query" type="search" :placeholder="t('configuration.filterAgents')" />
      </label>

      <label
        v-if="visible.length"
        class="rounded-field hover:bg-base-300/40 -mx-2 flex cursor-pointer items-center gap-3 px-2 py-1.5 text-sm"
      >
        <input type="checkbox" class="checkbox checkbox-sm" :checked="allSelected" @change="toggleAll" />
        <!--
          Named for what it actually takes. Under a search that is the rows on screen, and a
          control saying "all" while taking four of twenty is the interface misreporting itself.
        -->
        <span class="opacity-70">
          {{ needle ? t('configuration.selectAllShown') : t('configuration.selectAll') }}
        </span>
      </label>

      <!--
        The agents scroll, the heading and the select-all do not.

        A fleet of forty makes this card taller than the panel it sits beside, and then the page
        scrolls instead of the list: reaching the last agent pushes the thing being acted on off the
        screen, and the select-all is somewhere above the top of the window by the time it is
        wanted. Both lists are inside the same scroller, since the unavailable ones grow the card
        just as well as the available ones.
      -->
      <div class="-mx-2 flex max-h-[26rem] flex-col gap-0.5 overflow-y-auto">
      <!--
        No transition on either list. Nothing is ever added to these: they are re-listed, by a
        search or by a change of what the operator intends to do, and animating a re-list means
        forty rows playing at once every time a letter is typed.
      -->
      <ul class="flex flex-col gap-0.5">
        <li v-for="agent in visible" :key="agent.id">
          <label
            class="rounded-field hover:bg-base-300/40 flex cursor-pointer items-center gap-3 px-2 py-1.5 transition-colors"
          >
            <input v-model="selected" type="checkbox" :value="agent.id" class="checkbox checkbox-sm" />
            <span class="relative shrink-0" :title="agentStateLabel(agent.state, agentStore.workOf(agent.id))">
              <PlayerHead :id="agent.mcUuid ?? agent.mcUsername" :name="agent.label" size="sm" />
              <span
                class="ring-base-200 absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
                :class="agentDot(agent.state, agentStore.workOf(agent.id))"
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

      <template v-if="visibleUnavailable.length">
        <p class="px-2 pt-2 text-xs opacity-50">{{ unavailableNote }}</p>
        <ul class="flex flex-col gap-0.5 opacity-40">
          <li
            v-for="agent in visibleUnavailable"
            :key="agent.id"
            class="flex items-center gap-3 px-2 py-1.5"
            :title="agentStateLabel(agent.state, agentStore.workOf(agent.id))"
          >
            <!--
              Disabled rather than absent. Without it these rows start a whole checkbox to the left
              of the ones above them, and one list reads as two different kinds of thing.
            -->
            <input type="checkbox" class="checkbox checkbox-sm" disabled />
            <span class="relative shrink-0">
              <PlayerHead :id="agent.mcUuid ?? agent.mcUsername" :name="agent.label" size="sm" />
              <span
                class="ring-base-200 absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
                :class="agentDot(agent.state, agentStore.workOf(agent.id))"
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

      <p v-if="!agents.length && !unavailable.length" class="px-2 py-10 text-center text-sm opacity-50">
        {{ t('configuration.noAgents') }}
      </p>
      <!-- A search that matches nothing is not an empty fleet, and must not read as one. -->
      <p
        v-else-if="!visible.length && !visibleUnavailable.length"
        class="px-2 py-10 text-center text-sm opacity-50"
      >
        {{ t('configuration.noMatches') }}
      </p>
    </div>
  </div>
</template>
