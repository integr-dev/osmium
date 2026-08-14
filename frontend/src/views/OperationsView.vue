<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Server, TriangleAlert, Workflow } from 'lucide-vue-next'
import AgentPicker from '../components/AgentPicker.vue'
import { isOnline, useAgentStore } from '../stores/agents'

/**
 * Work run across the fleet, rather than settings held on one agent.
 *
 * The first real thing here is **assigning a server**. It lives on this screen rather than on
 * Configuration for two reasons: Configuration is mock end to end and putting one real field in
 * among invented ones is how a mock stops being obvious, and pointing a group of agents at a server
 * is an operation performed on the fleet rather than a property configured per agent.
 */
const { t } = useI18n()
const agentStore = useAgentStore()

const selected = ref<number[]>([])
const target = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const done = ref<string | null>(null)

onMounted(() => {
  if (!agentStore.agents.length) void agentStore.refresh()
})

/**
 * An online agent cannot be moved — the backend refuses it, because the address decides what the
 * next connection targets. Rather than letting the operator select one and meet a 409 per agent,
 * they are shown as unavailable with the reason attached.
 */
const eligible = computed(() => agentStore.agents.filter((agent) => !isOnline(agent)))
const blocked = computed(() => agentStore.agents.filter(isOnline))

async function apply(clear: boolean) {
  const agents = selected.value
  if (!agents.length) return

  busy.value = true
  error.value = null
  done.value = null
  try {
    const address = clear ? null : target.value.trim()
    if (!clear && !address) return
    // Sequential rather than parallel: these are writes against the same fleet, and a failure part
    // way through should stop rather than leave an unpredictable subset applied.
    for (const id of agents) await agentStore.assignServer(id, address)
    done.value = clear
      ? t('operations.cleared', { count: agents.length })
      : t('operations.assigned', { count: agents.length, server: address })
    selected.value = []
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.assignServer')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">{{ t('operations.title') }}</h1>
      <p class="text-sm opacity-60">{{ t('operations.subtitle') }}</p>
    </header>

    <div v-if="error" role="alert" class="alert alert-error alert-soft">
      <TriangleAlert class="size-4" />
      <span>{{ error }}</span>
    </div>
    <div v-if="done" role="alert" class="alert alert-success alert-soft">
      <Workflow class="size-4" />
      <span>{{ done }}</span>
    </div>

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

          <label class="input w-full">
            <Server class="size-4 opacity-60" />
            <input v-model="target" type="text" :placeholder="t('agents.serverPlaceholder')" />
          </label>

          <div class="border-base-300 flex flex-wrap items-center gap-3 border-t pt-4">
            <span v-if="!selected.length" class="text-xs opacity-50">{{ t('operations.pickAgents') }}</span>
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
  </div>
</template>
