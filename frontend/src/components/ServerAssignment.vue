<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Server } from 'lucide-vue-next'
import AgentPicker from './AgentPicker.vue'
import FormField from './FormField.vue'
import { isOnline, useAgentStore } from '../stores/agents'

/**
 * Pointing a group of agents at one Minecraft server.
 *
 * A tab of Operations rather than a screen of its own: it is one of three things done to the fleet
 * as a group, and the three share a shape — pick agents, then act on them.
 */
const { t } = useI18n()
const agentStore = useAgentStore()

const emit = defineEmits<{ done: [string]; failed: [string] }>()

const selected = ref<number[]>([])
const target = ref('')
const busy = ref(false)

/**
 * An online agent cannot be moved — the backend refuses it, because the address decides what the
 * next connection targets. Rather than letting the operator select one and meet a 409 per agent,
 * they are shown as unavailable with the reason attached.
 */
const eligible = computed(() => agentStore.agents.filter((agent) => !isOnline(agent)))
const blocked = computed(() => agentStore.agents.filter(isOnline))

async function apply(clear: boolean) {
  const agents = selected.value
  const address = clear ? null : target.value.trim()
  if (!clear && !address) return

  busy.value = true
  try {
    // Sequential rather than parallel: these are writes against the same fleet, and a failure part
    // way through should stop rather than leave an unpredictable subset applied.
    for (const id of agents) await agentStore.assignServer(id, address)
    emit(
      'done',
      clear
        ? t('operations.cleared', { count: agents.length })
        : t('operations.assigned', { count: agents.length, server: address }),
    )
    selected.value = []
  } catch (failure) {
    emit('failed', failure instanceof Error ? failure.message : t('errors.assignServer'))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="grid gap-6 lg:grid-cols-[20rem_1fr]">
    <!-- The same picker Configuration uses, so the two screens cannot drift apart. -->
    <AgentPicker
      v-model="selected"
      :agents="eligible"
      :unavailable="blocked"
      :unavailable-note="t('operations.onlineExcluded')"
      :title="t('operations.agents')"
    />

    <div class="card border-base-300 bg-base-200 h-fit border">
      <div class="card-body gap-4">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Server class="text-primary size-4" />
          {{ t('operations.assignTitle') }}
        </h2>
        <p class="text-sm opacity-60">{{ t('operations.assignHint') }}</p>

        <FormField
          v-model="target"
          :label="t('agents.server')"
          :icon="Server"
          :placeholder="t('agents.serverPlaceholder')"
          type="text"
        />

        <div class="border-base-300 flex flex-wrap items-center gap-3 border-t pt-4">
          <span v-if="!selected.length" class="text-xs opacity-50">
            {{ t('operations.pickAgents') }}
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-sm ml-auto"
            :disabled="busy || !selected.length"
            @click="apply(true)"
          >
            {{ t('operations.clearServer') }}
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm gap-2"
            :disabled="busy || !selected.length || !target.trim()"
            @click="apply(false)"
          >
            <Server class="size-4" />
            {{ busy ? t('operations.applying') : t('operations.assign') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
