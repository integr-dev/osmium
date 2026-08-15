<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Play, Power } from 'lucide-vue-next'
import AgentPicker from './AgentPicker.vue'
import { isOnline, useAgentStore } from '../stores/agents'

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

/**
 * Which agents the chosen action can act on, and which cannot. Both directions are shown rather
 * than one list filtered: an operator who selected an agent and finds it missing has learned
 * nothing, while one who sees it greyed out with a reason has.
 */
const going = ref<'connect' | 'disconnect'>('connect')

const eligible = computed(() =>
  agentStore.agents.filter((agent) => (going.value === 'connect' ? !isOnline(agent) : isOnline(agent))),
)
const blocked = computed(() =>
  agentStore.agents.filter((agent) => (going.value === 'connect' ? isOnline(agent) : !isOnline(agent))),
)

const blockedNote = computed(() =>
  going.value === 'connect' ? t('operations.offlineOnly') : t('operations.onlineOnly'),
)

async function run(action: 'connect' | 'disconnect') {
  const agents = selected.value.filter((id) => eligible.value.some((agent) => agent.id === id))
  if (!agents.length) return

  busy.value = true
  try {
    // One at a time, like the server assignment beside it. These reach real Minecraft servers, and
    // twenty simultaneous logins from one host is the shape of a thing that gets a host banned.
    for (const id of agents) {
      if (action === 'connect') await agentStore.connect(id)
      else await agentStore.disconnect(id)
    }
    emit(
      'done',
      action === 'connect'
        ? t('operations.connected', { count: agents.length })
        : t('operations.disconnected', { count: agents.length }),
    )
    selected.value = []
  } catch (failure) {
    const fallback = action === 'connect' ? t('errors.connectAgent') : t('errors.disconnectAgent')
    emit('failed', failure instanceof Error ? failure.message : fallback)
  } finally {
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
            {{
              busy
                ? t('operations.applying')
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
