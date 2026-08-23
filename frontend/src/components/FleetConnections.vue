<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Play, Power } from 'lucide-vue-next'
import AgentPicker from './AgentPicker.vue'
import { isOnline, useAgentStore, type FleetAgent } from '../stores/agents'

/**
 * Bringing a group of agents in or out of game at once.
 *
 * The same act as the button on an agent's own page, done to several — which is why it belongs
 * here rather than there: connecting twenty agents one at a time is not a different feature, it is
 * the same feature with the tedium removed.
 */
const { t } = useI18n()
const agentStore = useAgentStore()

const emit = defineEmits<{ done: [string]; failed: [string] }>()

const selected = ref<number[]>([])
const busy = ref(false)
/** How far through the run it is, so a long sequential loop is not one motionless word. */
const progress = ref<{ done: number; total: number } | null>(null)

/**
 * Which agents the chosen action can act on, and which cannot. Both directions are shown rather
 * than one list filtered: an operator who selected an agent and finds it missing has learned
 * nothing, while one who sees it greyed out with a reason has.
 */
const going = ref<'connect' | 'disconnect'>('connect')

/**
 * An agent already on its way in cannot be connected again — the backend answers 409 — so it is
 * unavailable here rather than selectable. Disconnect is unaffected: only a live session can end.
 */
function connectable(agent: FleetAgent): boolean {
  return !isOnline(agent) && agent.state !== 'CONNECTING'
}

const eligible = computed(() =>
  agentStore.agents.filter((agent) => (going.value === 'connect' ? connectable(agent) : isOnline(agent))),
)
const blocked = computed(() =>
  agentStore.agents.filter((agent) => (going.value === 'connect' ? !connectable(agent) : !isOnline(agent))),
)

const blockedNote = computed(() =>
  going.value === 'connect' ? t('operations.offlineOnly') : t('operations.onlineOnly'),
)

async function run(action: 'connect' | 'disconnect') {
  const agents = selected.value.filter((id) => eligible.value.some((agent) => agent.id === id))
  if (!agents.length) return

  busy.value = true
  progress.value = { done: 0, total: agents.length }

  // What actually happened, rather than what was asked for. A run that stops halfway is the normal
  // case here — one banned agent, one full server — and reporting only the failure left the
  // operator not knowing whether the ones before it went in.
  const succeeded: number[] = []

  try {
    // One at a time, like the server assignment beside it. These reach real Minecraft servers, and
    // twenty simultaneous logins from one host is the shape of a thing that gets a host banned.
    for (const id of agents) {
      if (action === 'connect') await agentStore.connect(id)
      else await agentStore.disconnect(id)
      succeeded.push(id)
      progress.value = { done: succeeded.length, total: agents.length }
    }
    emit(
      'done',
      action === 'connect'
        ? t('operations.connected', { count: agents.length })
        : t('operations.disconnected', { count: agents.length }),
    )
  } catch (failure) {
    const fallback = action === 'connect' ? t('errors.connectAgent') : t('errors.disconnectAgent')
    const reason = failure instanceof Error ? failure.message : fallback
    const stopped = agentStore.byId(agents[succeeded.length])

    emit(
      'failed',
      succeeded.length
        ? t('operations.stoppedAfter', {
            count: succeeded.length,
            name: stopped?.label ?? '',
            reason,
          })
        : reason,
    )
  } finally {
    // Only what went through. Left in place, pressing the button again would re-run every agent
    // that already succeeded — and a second connect for one already in game is a refusal per agent.
    selected.value = selected.value.filter((id) => !succeeded.includes(id))
    progress.value = null
    busy.value = false
  }
}
</script>

<template>
  <div class="grid gap-6 lg:grid-cols-[20rem_1fr]">
    <AgentPicker
      v-model="selected"
      :agents="eligible"
      :unavailable="blocked"
      :unavailable-note="blockedNote"
      :title="t('operations.agents')"
    />

    <div class="card border-base-300 bg-base-200 h-fit border">
      <div class="card-body gap-4">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Power class="text-primary size-4" />
          {{ t('operations.powerTitle') }}
        </h2>
        <p class="text-sm opacity-60">{{ t('operations.powerHint') }}</p>

        <!--
          Which direction is chosen changes which agents are selectable, so it is a control rather
          than two buttons at the end: picking agents and then finding half of them ineligible is
          the version of this that wastes the operator's time.
        -->
        <div role="tablist" class="tabs tabs-box w-fit">
          <button
            type="button"
            role="tab"
            class="tab gap-2"
            :class="going === 'connect' ? 'tab-active' : ''"
            @click="going = 'connect'"
          >
            <Play class="size-3.5" />
            {{ t('operations.connect') }}
          </button>
          <button
            type="button"
            role="tab"
            class="tab gap-2"
            :class="going === 'disconnect' ? 'tab-active' : ''"
            @click="going = 'disconnect'"
          >
            <Power class="size-3.5" />
            {{ t('operations.disconnect') }}
          </button>
        </div>

        <div class="border-base-300 flex flex-wrap items-center gap-3 border-t pt-4">
          <span v-if="!selected.length" class="text-xs opacity-50">
            {{ t('operations.pickAgents') }}
          </span>
          <button
            type="button"
            class="btn btn-primary btn-sm ml-auto gap-2"
            :disabled="busy || !selected.length"
            @click="run(going)"
          >
            <component :is="going === 'connect' ? Play : Power" class="size-4" />
            <!--
              Which one of twenty, not just "applying". These run sequentially and reach real
              Minecraft servers, so the wait is long enough that a motionless label reads as a stall.
            -->
            {{
              busy && progress
                ? t('operations.applyingOne', { done: progress.done + 1, total: progress.total })
                : going === 'connect'
                  ? t('operations.connect')
                  : t('operations.disconnect')
            }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
