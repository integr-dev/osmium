<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, KeyRound, Server, TriangleAlert } from 'lucide-vue-next'
import FormField from './FormField.vue'
import { useAgentStore } from '../stores/agents'

const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const agentStore = useAgentStore()

const dialogEl = ref<HTMLDialogElement | null>(null)
const name = ref('')
const token = ref<string | null>(null)
const copied = ref(false)
/** Set when the clipboard refused. The token is shown once, so this cannot be swallowed. */
const copyFailed = ref(false)
const error = ref<string | null>(null)
const busy = ref(false)

watch(open, (isOpen) => {
  if (isOpen) {
    name.value = ''
    token.value = null
    copied.value = false
    copyFailed.value = false
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

/**
 * Wrapped, because this is the one click in the application whose silent failure is permanent.
 *
 * `writeText` rejects on a denied permission and in any non-secure context. Unhandled, the button
 * simply stayed on "Copy" - and an operator who clicked it, saw nothing change and closed the dialog
 * had lost the host's only credential.
 */
async function copy() {
  if (!token.value) return
  try {
    await navigator.clipboard.writeText(token.value)
    copied.value = true
  } catch {
    copyFailed.value = true
  }
}
</script>

<template>
  <!--
    Escape is refused while the token is on screen. It is shown once and never again, and `cancel`
    is the event a <dialog> fires for that key, so preventing it is the only way to stop an idle
    keystroke taking the credential with it. Done still closes; only the accidental exit is blocked.
  -->
  <dialog ref="dialogEl" class="modal" @close="open = false" @cancel="token && $event.preventDefault()">
    <div class="modal-box">
      <h3 class="flex items-center gap-2 text-lg font-semibold">
        <Server class="text-primary size-5" />
        {{ t('hosts.enrolTitle') }}
      </h3>

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
        <div v-if="error" role="alert" class="alert alert-error alert-soft">
          <TriangleAlert class="size-4" />
          <span>{{ error }}</span>
        </div>

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
        <div role="alert" class="alert alert-warning alert-soft">
          <TriangleAlert class="size-4" />
          <span>{{ t('hosts.tokenWarning') }}</span>
        </div>
        <label class="input w-full">
          <KeyRound class="size-4 opacity-60" />
          <input class="font-mono text-sm" :value="token" readonly />
          <button type="button" class="btn btn-ghost btn-xs gap-1" @click="copy">
            <Copy class="size-3.5" />
            {{ copied ? t('common.copied') : t('common.copy') }}
          </button>
        </label>
        <!-- Says what to do instead. The token is still on screen, so this is recoverable — but
             only if the operator is told the click did not work. -->
        <div v-if="copyFailed" role="alert" class="alert alert-warning alert-soft">
          <TriangleAlert class="size-4" />
          <span>{{ t('common.copyFailed') }}</span>
        </div>
        <p class="text-xs opacity-60">{{ t('hosts.tokenHint') }}</p>
        <div class="modal-action">
          <button class="btn btn-primary btn-sm" type="button" @click="open = false">
            {{ t('common.done') }}
          </button>
        </div>
      </div>
    </div>
    <!-- Not rendered once there is something to lose: daisyUI's backdrop is a form that submits
         the dialog, so an off-target click would dismiss the only display of the token. -->
    <form v-if="!token" method="dialog" class="modal-backdrop">
      <button>{{ t('common.close') }}</button>
    </form>
  </dialog>
</template>
