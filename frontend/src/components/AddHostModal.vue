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

watch(open, (isOpen) => {
  if (isOpen) {
    name.value = ''
    token.value = null
    copied.value = false
    dialogEl.value?.showModal()
  } else {
    dialogEl.value?.close()
  }
})

function enrol() {
  const result = botStore.addHost(name.value)
  // Reveal the one-time token in place rather than closing, mirroring Phase 0 in the design.
  token.value = result.token
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
          Name the host and hand its token to the agent. The agent dials in to Osmium, so there is no
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
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="open = false">Cancel</button>
          <button class="btn btn-primary btn-sm" type="submit">Enrol</button>
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
          Put it in the agent's config as <span class="font-mono">OSMIUM_AGENT_TOKEN</span>. The host
          appears offline until the agent connects.
        </p>
        <div class="modal-action">
          <button class="btn btn-primary btn-sm" type="button" @click="open = false">Done</button>
        </div>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button>close</button></form>
  </dialog>
</template>
