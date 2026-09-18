<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Server } from 'lucide-vue-next'
import ModalShell from './ModalShell.vue'
import TokenReveal from './TokenReveal.vue'
import AlertNote from './AlertNote.vue'
import FormField from './FormField.vue'
import { useAgentStore } from '../stores/agents'

const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const agentStore = useAgentStore()

const dialogEl = ref<InstanceType<typeof ModalShell> | null>(null)
const name = ref('')
const token = ref<string | null>(null)
const error = ref<string | null>(null)
const busy = ref(false)

watch(open, (isOpen) => {
  if (isOpen) {
    name.value = ''
    token.value = null
    error.value = null
    dialogEl.value?.showModal()
  } else {
    dialogEl.value?.close()
  }
})

async function enrol() {
  busy.value = true
  error.value = null
  try {
    // Reveal the one-time token in place rather than closing, mirroring Phase 0 in the design.
    token.value = await agentStore.enrolHost(name.value)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.enrolHost')
  } finally {
    busy.value = false
  }
}

</script>

<template>
  <!--
    Escape is refused while the token is on screen. It is shown once and never again, and `cancel`
    is the event a <dialog> fires for that key, so preventing it is the only way to stop an idle
    keystroke taking the credential with it. Done still closes; only the accidental exit is blocked.
  -->
  <ModalShell
    ref="dialogEl"
    :title="t('hosts.enrolTitle')"
    :icon="Server"
    :dismissible="!token"
    @close="open = false"
  >
    <form v-if="!token" class="mt-5 flex flex-col gap-4" @submit.prevent="enrol">
      <p class="text-sm opacity-60">{{ t('hosts.enrolIntro') }}</p>
      <FormField
        v-model="name"
        :label="t('hosts.name')"
        :placeholder="t('hosts.namePlaceholder')"
        :icon="Server"
        type="text"
        maxlength="64"
        required
      />
      <AlertNote v-if="error" kind="error" :message="error" />

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" type="button" @click="open = false">
          {{ t('common.cancel') }}
        </button>
        <button class="btn btn-primary btn-sm" type="submit" :disabled="busy">
          {{ t('hosts.enrol') }}
        </button>
      </div>
    </form>

    <div v-else class="mt-5 flex flex-col gap-4">
      <TokenReveal :token="token" />
      <div class="modal-action">
        <button class="btn btn-primary btn-sm" type="button" @click="open = false">
          {{ t('common.done') }}
        </button>
      </div>
    </div>
  </ModalShell>
</template>
