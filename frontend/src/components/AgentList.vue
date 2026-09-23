<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot as Agent, Plus, Server } from 'lucide-vue-next'
import AddAgentModal from './AddAgentModal.vue'
import PlayerHead from './PlayerHead.vue'
import TableSkeleton from './TableSkeleton.vue'
import { agentBadge, agentDot, agentStateLabel } from '../lib/agentState'
import { vFlash } from '../lib/motion'
import { useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'

/**
 * The fleet as a table, alongside the hosts table it mirrors.
 *
 * The sidebar already lists every agent, and this is not that list. The sidebar answers "take me to
 * one"; this answers "what have I got" — which account, on which host, pointed at which server, in
 * what state — four facts the sidebar has no room for and which are exactly what an operator
 * compares across the fleet.
 *
 * No actions column. Everything that can be done to an agent is done on its own page or, for a
 * group, on Operations; a per-row menu here would be a third place to keep in step with both.
 */
const { t } = useI18n()
const agentStore = useAgentStore()
const auth = useAuthStore()

const addOpen = ref(false)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm opacity-60">
        {{ t('agents.onlineCount', { online: agentStore.online.length, total: agentStore.agents.length }) }}
      </p>
      <button v-if="auth.can('agent.write')" class="btn btn-primary btn-sm gap-2" @click="addOpen = true">
        <Plus class="size-4" />
        {{ t('nav.addAgent') }}
      </button>
    </div>

    <!--
      Not `flex-1`. A card given the whole column drew a table of two hosts with an empty half
      screen under it — the frame reporting its own size rather than the fleet's. It shrinks
      instead: as tall as its rows, and no taller than what is left, which is the point at which
      the rows start scrolling inside it.
    -->
    <div class="card border-base-300 bg-base-200 min-h-0 overflow-hidden border">
      <div class="h-full overflow-auto">
        <table class="table-pin-rows table">
          <thead>
            <tr>
              <th>{{ t('agents.label') }}</th>
              <th>{{ t('common.status') }}</th>
              <th>{{ t('agents.account') }}</th>
              <th>{{ t('agents.host') }}</th>
              <th>{{ t('agents.server') }}</th>
            </tr>
          </thead>
          <TableSkeleton v-if="!agentStore.loaded" :columns="5" />

          <TransitionGroup v-else name="rows" tag="tbody">
            <!--
              The state is what flashes, not the row. A relink or a disconnect that happened while
              the operator was on another page is exactly what they would otherwise miss.
            -->
            <tr
              v-for="agent in agentStore.agents"
              :key="agent.id"
              v-flash="agent.state"
              class="hover:bg-base-300/40 transition-colors"
            >
              <td>
                <RouterLink
                  :to="{ name: 'agent', params: { id: agent.id } }"
                  class="flex items-center gap-3"
                >
                  <!-- The same chip as the sidebar and the picker: an avatar with its state on it. -->
                  <span class="relative shrink-0">
                    <PlayerHead :id="agent.mcUuid ?? agent.mcUsername" :name="agent.label" size="sm" />
                    <span
                      class="ring-base-100 absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
                      :class="agentDot(agent.state, agentStore.workOf(agent.id))"
                    ></span>
                  </span>
                  <span class="link-hover font-medium">{{ agent.label }}</span>
                </RouterLink>
              </td>
              <!--
                Building replaces the state rather than sitting beside it: it already says the agent
                is in game, and the more specific of two true things is the one worth the column.
                Which piece of which build is the tooltip — a table scanned across twenty rows has
                room for the fact, not for the detail.
              -->
              <td>
                <span
                  class="badge badge-sm"
                  :class="agentBadge(agent.state, agentStore.workOf(agent.id))"
                  :title="
                    agentStore.assignmentOf(agent.id)
                      ? t('agents.buildingOn', {
                          build: agentStore.assignmentOf(agent.id)?.name,
                          ordinal: agentStore.assignmentOf(agent.id)?.ordinal,
                        })
                      : undefined
                  "
                >
                  {{ agentStateLabel(agent.state, agentStore.workOf(agent.id)) }}
                </span>
              </td>
              <!--
                Each absent value is named rather than left blank. Before setup there is no account
                and an agent assigned nowhere has no server, and both are things being looked for
                when somebody scans this column.
              -->
              <td class="text-sm">
                <span v-if="agent.mcUsername" class="font-mono opacity-80">{{ agent.mcUsername }}</span>
                <span v-else class="italic opacity-50">{{ t('agents.notLinked') }}</span>
              </td>
              <td>
                <RouterLink
                  :to="{ name: 'host', params: { id: agent.hostId } }"
                  class="link-hover flex items-center gap-2 text-sm opacity-80"
                >
                  <Server class="size-3.5 shrink-0 opacity-60" />
                  {{ agent.hostName }}
                </RouterLink>
              </td>
              <td class="text-sm">
                <span v-if="agent.serverAddress" class="font-mono opacity-80">{{ agent.serverAddress }}</span>
                <span v-else class="italic opacity-50">{{ t('agents.noServer') }}</span>
              </td>
            </tr>
            <tr v-if="agentStore.agents.length === 0" key="no-agents">
              <td colspan="5">
                <div class="flex flex-col items-center gap-2 py-10 opacity-60">
                  <Agent class="size-6" />
                  <span class="text-sm">{{ t('agents.none') }}</span>
                </div>
              </td>
            </tr>
          </TransitionGroup>
        </table>
      </div>
    </div>

    <AddAgentModal v-model:open="addOpen" />
  </div>
</template>
