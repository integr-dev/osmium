<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft, ChevronRight, Server, UserPlus } from 'lucide-vue-next'
import FormField from './FormField.vue'
import { useAgentStore } from '../stores/agents'
import { useRouter } from 'vue-router'

const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const agentStore = useAgentStore()
const router = useRouter()

const dialogEl = ref<HTMLDialogElement | null>(null)
const step = ref<1 | 2>(1)
const draft = ref({ label: '', serverAddress: '', hostId: null as number | null })
const error = ref<string | null>(null)
const busy = ref(false)

watch(open, (isOpen) => {
  if (isOpen) {
    draft.value = { label: '', serverAddress: '', hostId: agentStore.hosts[0]?.id ?? null }
    step.value = 1
    error.value = null
    dialogEl.value?.showModal()
  } else {
    dialogEl.value?.close()
  }
})

async function submit() {
  if (step.value === 1) {
    step.value = 2
    return
  }
  if (draft.value.hostId === null) {
    error.value = t('errors.pickHost')
    return
  }

  busy.value = true
  error.value = null
  try {
    const agent = await agentStore.addAgent({
      label: draft.value.label,
      // Optional now. Left blank the agent is created assigned nowhere, which is a real state and
      // often the right one: where it plays can be decided once its credential is known to work.
      serverAddress: draft.value.serverAddress.trim() || null,
      hostId: draft.value.hostId,
    })
    open.value = false
    void router.push({ name: 'agent', params: { id: agent.id } })
  } catch (failure) {
    // Conflicts and validation errors are all step 1 fields, so send the operator back.
    step.value = 1
    error.value = failure instanceof Error ? failure.message : t('errors.createAgent')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <dialog ref="dialogEl" class="modal" @close="open = false">
    <div class="modal-box">
      <h3 class="flex items-center gap-2 text-lg font-semibold">
        <UserPlus class="text-primary size-5" />
        {{ t('agents.addTitle') }}
      </h3>

      <ul class="steps mt-4 w-full">
        <li class="step step-primary text-xs">{{ t('agents.identity') }}</li>
        <li class="step text-xs" :class="step === 2 ? 'step-primary' : ''">{{ t('agents.host') }}</li>
      </ul>

      <form class="mt-5 flex flex-col gap-4" @submit.prevent="submit">
        <template v-if="step === 1">
          <FormField
            v-model="draft.label"
            :label="t('agents.label')"
            :placeholder="t('agents.labelPlaceholder')"
            :icon="UserPlus"
            type="text"
            maxlength="64"
            required
          />
          <!--
            No longer required. Deciding where an agent plays before it has been set up means
            deciding before anyone knows the credential works, so it can be left for later.
          -->
          <FormField
            v-model="draft.serverAddress"
            :label="t('agents.serverOptional')"
            :placeholder="t('agents.serverPlaceholder')"
            :icon="Server"
            type="text"
          />
          <p class="text-xs opacity-60">{{ t('agents.serverLaterHint') }}</p>
        </template>

        <template v-else>
          <p class="text-sm opacity-60">{{ t('agents.hostStepHint') }}</p>
          <ul v-if="agentStore.hosts.length" class="flex flex-col gap-1">
            <li v-for="host in agentStore.hosts" :key="host.id">
              <label class="rounded-field hover:bg-base-300/50 flex cursor-pointer items-center gap-3 p-3">
                <input
                  v-model="draft.hostId"
                  type="radio"
                  name="agent-host"
                  class="radio radio-sm radio-primary shrink-0"
                  :value="host.id"
                />
                <span
                  class="size-2 shrink-0 rounded-full"
                  :class="host.reachable ? 'bg-success' : 'bg-error'"
                ></span>
                <span class="min-w-0 flex-1">
                  <span class="block font-medium">{{ host.name }}</span>
                  <span class="block font-mono text-xs opacity-50">
                    {{ host.address ?? t('hosts.notConnected') }}
                  </span>
                </span>
                <span class="text-xs opacity-50">
                  {{ t('hosts.agentCount', { count: host.agentCount }, host.agentCount) }}
                </span>
              </label>
            </li>
          </ul>
          <p v-else class="rounded-field bg-base-300/30 px-3 py-4 text-center text-sm opacity-60">
            {{ t('agents.noHosts') }}
          </p>
        </template>

        <div v-if="error" role="alert" class="alert alert-error alert-soft">
          <span>{{ error }}</span>
        </div>

        <div class="modal-action">
          <button v-if="step === 2" class="btn btn-ghost btn-sm gap-1" type="button" @click="step = 1">
            <ChevronLeft class="size-4" />
            {{ t('agents.back') }}
          </button>
          <button v-else class="btn btn-ghost btn-sm" type="button" @click="open = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary btn-sm gap-1" type="submit" :disabled="busy || (step === 2 && !agentStore.hosts.length)">
            {{ step === 1 ? t('agents.next') : t('agents.create') }}
            <ChevronRight v-if="step === 1" class="size-4" />
          </button>
        </div>
      </form>
    </div>
    <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
  </dialog>
</template>
