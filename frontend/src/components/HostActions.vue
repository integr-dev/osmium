<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { KeyRound, Server, SquarePen, Trash2, TriangleAlert } from 'lucide-vue-next'
import ModalShell from './ModalShell.vue'
import TokenReveal from './TokenReveal.vue'
import AlertNote from './AlertNote.vue'
import FormField from './FormField.vue'
import type { HostResponse } from '../api/client'
import { useAgentStore } from '../stores/agents'

/**
 * The three things that can be done to a host, as dialogs the caller opens.
 *
 * One component because the same three are reached from the list and from a host's own page, and
 * because they are the only place a **rotated token is shown in the clear** — markup worth having
 * exactly once rather than kept in step by hand across two files.
 *
 * Three authorities, not one: renaming is administration, rotating replaces the credential the host
 * authenticates with, and removing takes every agent on it. The caller gates the buttons; this
 * gates nothing, because a dialog nobody can open needs no opinion of its own.
 */
const { t } = useI18n()
const agentStore = useAgentStore()

const emit = defineEmits<{ removed: [HostResponse] }>()

const renameDialog = ref<InstanceType<typeof ModalShell> | null>(null)
const renaming = ref<HostResponse | null>(null)
const renameDraft = ref('')
const renameError = ref<string | null>(null)
const renameBusy = ref(false)

const rotateDialog = ref<InstanceType<typeof ModalShell> | null>(null)
const rotating = ref<HostResponse | null>(null)
const rotatedToken = ref<string | null>(null)
const rotateError = ref<string | null>(null)
const rotateBusy = ref(false)

const removeDialog = ref<InstanceType<typeof ModalShell> | null>(null)
const pendingRemove = ref<HostResponse | null>(null)
const removeError = ref<string | null>(null)
const removeBusy = ref(false)

function rename(host: HostResponse) {
  renaming.value = host
  renameDraft.value = host.name
  renameError.value = null
  renameBusy.value = false
  renameDialog.value?.showModal()
}

/**
 * All three of these guard on their own busy flag.
 *
 * Their buttons stayed live for the whole round trip, and rotate is the one that bites: a second
 * press mints a second token, and the one on screen — which the operator may already have copied
 * into the host's config — is dead, with nothing to indicate that it changed.
 */
async function saveRename() {
  if (!renaming.value || renameBusy.value) return
  renameBusy.value = true
  renameError.value = null
  try {
    await agentStore.renameHost(renaming.value.id, renameDraft.value)
    renameDialog.value?.close()
  } catch (failure) {
    renameError.value = failure instanceof Error ? failure.message : t('errors.renameHost')
  } finally {
    renameBusy.value = false
  }
}

function rotate(host: HostResponse) {
  rotating.value = host
  rotatedToken.value = null
  rotateError.value = null
  rotateBusy.value = false
  rotateDialog.value?.showModal()
}

async function confirmRotate() {
  // Also guarded on the token already being here: this is the one action where a second press
  // silently invalidates what the first press put on screen.
  if (!rotating.value || rotateBusy.value || rotatedToken.value) return
  rotateBusy.value = true
  rotateError.value = null
  try {
    rotatedToken.value = await agentStore.rotateHostToken(rotating.value.id)
  } catch (failure) {
    rotateError.value = failure instanceof Error ? failure.message : t('errors.rotateToken')
  } finally {
    rotateBusy.value = false
  }
}

function remove(host: HostResponse) {
  pendingRemove.value = host
  removeError.value = null
  removeBusy.value = false
  removeDialog.value?.showModal()
}

async function confirmRemove() {
  const host = pendingRemove.value
  if (!host || removeBusy.value) return

  removeBusy.value = true
  removeError.value = null
  try {
    await agentStore.removeHost(host.id)
    removeDialog.value?.close()
    // Announced rather than assumed: a host's own page has to leave when its host does, and the
    // list it was opened from does not.
    emit('removed', host)
  } catch (failure) {
    removeError.value = failure instanceof Error ? failure.message : t('errors.removeHost')
  } finally {
    removeBusy.value = false
  }
}

defineExpose({ rename, rotate, remove })
</script>

<template>
  <div>
    <ModalShell ref="renameDialog" :title="t('hosts.rename')" :icon="SquarePen">
      <p class="mt-1 text-sm opacity-60">{{ t('hosts.renameHint') }}</p>
      <form class="mt-5 flex flex-col gap-4" @submit.prevent="saveRename">
        <FormField
          v-model="renameDraft"
          :label="t('hosts.name')"
          :icon="Server"
          type="text"
          maxlength="64"
          required
        />
        <AlertNote v-if="renameError" kind="error" :message="renameError" />
        <div class="modal-action">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="renameBusy"
            @click="renameDialog?.close()"
          >
            {{ t('common.cancel') }}
          </button>
          <button class="btn btn-primary btn-sm" type="submit" :disabled="renameBusy">
            {{ renameBusy ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </form>
    </ModalShell>

    <!--
      Escape is refused while the token is on screen. `cancel` is the event a `<dialog>` fires for
      Escape, and preventing it is the only way to keep the key from dismissing the one and only
      display of a credential that cannot be retrieved. Done still closes, so nobody is trapped —
      what is blocked is the accidental dismissal, not the deliberate one.
    -->
    <ModalShell
      ref="rotateDialog"
      :title="t('hosts.rotateTitle', { name: rotating?.name })"
      :icon="KeyRound"
      :dismissible="!rotatedToken"
    >
      <div v-if="!rotatedToken" class="mt-4 flex flex-col gap-4">
        <p class="text-sm opacity-70">{{ t('hosts.rotateIntro') }}</p>
        <AlertNote v-if="rotateError" kind="error" :message="rotateError" />
        <div class="modal-action">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="rotateBusy"
            @click="rotateDialog?.close()"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            class="btn btn-primary btn-sm"
            type="button"
            :disabled="rotateBusy"
            @click="confirmRotate"
          >
            {{ rotateBusy ? t('hosts.rotating') : t('hosts.rotate') }}
          </button>
        </div>
      </div>

      <div v-else class="mt-4 flex flex-col gap-4">
        <TokenReveal :token="rotatedToken" />
        <div class="modal-action">
          <button class="btn btn-primary btn-sm" type="button" @click="rotateDialog?.close()">
            {{ t('common.done') }}
          </button>
        </div>
      </div>
    </ModalShell>

    <ModalShell
      ref="removeDialog"
      :title="t('hosts.removeTitle', { name: pendingRemove?.name })"
      :icon="TriangleAlert"
      tone="error"
      @close="pendingRemove = null"
    >
      <p class="mt-3 text-sm opacity-70">
        <template v-if="pendingRemove && agentStore.agentsOnHost(pendingRemove.id).length">
          <!-- The count is passed twice: once to interpolate, once to pick the plural form. -->
          {{
            t(
              'hosts.removeWithAgents',
              { count: agentStore.agentsOnHost(pendingRemove.id).length },
              agentStore.agentsOnHost(pendingRemove.id).length,
            )
          }}
        </template>
        <template v-else>{{ t('hosts.removeNoAgents') }}</template>
      </p>
      <AlertNote v-if="removeError" kind="error" class="mt-4" :message="removeError" />
      <div class="modal-action">
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="removeBusy"
          @click="removeDialog?.close()"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          class="btn btn-error btn-sm gap-2"
          type="button"
          :disabled="removeBusy"
          @click="confirmRemove"
        >
          <Trash2 class="size-4" />
          {{ removeBusy ? t('hosts.removing') : t('hosts.removeAction') }}
        </button>
      </div>
    </ModalShell>
  </div>
</template>
