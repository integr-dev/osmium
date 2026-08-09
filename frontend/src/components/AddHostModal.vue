<script setup lang="ts">
import { ref, watch } from 'vue'
import { Copy, KeyRound, Server, TriangleAlert } from 'lucide-vue-next'
import FormField from './FormField.vue'
import { useBotStore } from '../stores/bots'

const open = defineModel<boolean>('open', { required: true })

const botStore = useBotStore()

const dialogEl = ref<HTMLDialogElement | null>(null)
const name = ref('')
const token = ref<string | null>(null)
const copied = ref(false)
const error = ref<string | null>(null)
const busy = ref(false)

watch(open, (isOpen) => {
  if (isOpen) {
    name.value = ''
    token.value = null
    copied.value = false
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
    token.value = await botStore.enrolHost(name.value)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Could not enrol the host'
  } finally {
    busy.value = false
  }
}

async function copy() {
  if (!token.value) return
  await navigator.clipboard.writeText(token.value)
  copied.value = true
}
</script>

<template>
  <dialog ref="dialogEl" class="modal" @close="open = false">
    <div class="modal-box">
      <h3 class="flex items-center gap-2 text-lg font-semibold">
        <Server class="text-primary size-5" />
        Enrol host
      </h3>

      <form v-if="!token" class="mt-5 flex flex-col gap-4" @submit.prevent="enrol">
        <p class="text-sm opacity-60">
          Name the host and give it the token below. The host connects to Osmium, so there is no
          address to enter — its location is recorded when it connects.
        </p>
        <FormField
          v-model="name"
          label="Host name"
          placeholder="e.g. agent-eu-3"
          :icon="Server"
          type="text"
          maxlength="64"
          required
        />
        <div v-if="error" role="alert" class="alert alert-error alert-soft">
          <TriangleAlert class="size-4" />
          <span>{{ error }}</span>
        </div>

        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="open = false">Cancel</button>
          <button class="btn btn-primary btn-sm" type="submit" :disabled="busy">Enrol</button>
        </div>
      </form>

      <div v-else class="mt-5 flex flex-col gap-4">
        <div role="alert" class="alert alert-warning alert-soft">
          <TriangleAlert class="size-4" />
          <span>Copy this token now — it is shown once and cannot be recovered.</span>
        </div>
        <label class="input w-full">
          <KeyRound class="size-4 opacity-60" />
          <input class="font-mono text-sm" :value="token" readonly />
          <button type="button" class="btn btn-ghost btn-xs gap-1" @click="copy">
            <Copy class="size-3.5" />
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
        </label>
        <p class="text-xs opacity-60">
          Set it as <span class="font-mono">OSMIUM_AGENT_TOKEN</span> on that machine. The host stays
          unreachable here until it connects.
        </p>
        <div class="modal-action">
          <button class="btn btn-primary btn-sm" type="button" @click="open = false">Done</button>
        </div>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button>close</button></form>
  </dialog>
</template>
