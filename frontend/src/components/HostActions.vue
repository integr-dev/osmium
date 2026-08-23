<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, KeyRound, Server, SquarePen, Trash2, TriangleAlert } from 'lucide-vue-next'
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

const renameDialog = ref<HTMLDialogElement | null>(null)
const renaming = ref<HostResponse | null>(null)
const renameDraft = ref('')
const renameError = ref<string | null>(null)

const rotateDialog = ref<HTMLDialogElement | null>(null)
const rotating = ref<HostResponse | null>(null)
const rotatedToken = ref<string | null>(null)
const rotateError = ref<string | null>(null)
const copied = ref(false)

const removeDialog = ref<HTMLDialogElement | null>(null)
const pendingRemove = ref<HostResponse | null>(null)
const removeError = ref<string | null>(null)

function rename(host: HostResponse) {
  renaming.value = host
  renameDraft.value = host.name
  renameError.value = null
  renameDialog.value?.showModal()
}

async function saveRename() {
  if (!renaming.value) return
  renameError.value = null
  try {
    await agentStore.renameHost(renaming.value.id, renameDraft.value)
    renameDialog.value?.close()
  } catch (failure) {
    renameError.value = failure instanceof Error ? failure.message : t('errors.renameHost')
  }
}

function rotate(host: HostResponse) {
  rotating.value = host
  rotatedToken.value = null
  rotateError.value = null
  copied.value = false
  rotateDialog.value?.showModal()
}

async function confirmRotate() {
  if (!rotating.value) return
  rotateError.value = null
  try {
    rotatedToken.value = await agentStore.rotateHostToken(rotating.value.id)
  } catch (failure) {
    rotateError.value = failure instanceof Error ? failure.message : t('errors.rotateToken')
  }
}

async function copyToken() {
  if (!rotatedToken.value) return
  await navigator.clipboard.writeText(rotatedToken.value)
  copied.value = true
}

function remove(host: HostResponse) {
  pendingRemove.value = host
  removeError.value = null
  removeDialog.value?.showModal()
}

async function confirmRemove() {
  const host = pendingRemove.value
  if (!host) return

  removeError.value = null
  try {
    await agentStore.removeHost(host.id)
    removeDialog.value?.close()
    // Announced rather than assumed: a host's own page has to leave when its host does, and the
    // list it was opened from does not.
    emit('removed', host)
  } catch (failure) {
    removeError.value = failure instanceof Error ? failure.message : t('errors.removeHost')
  }
}

defineExpose({ rename, rotate, remove })
</script>

<template>
  <div>
    <dialog ref="renameDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <SquarePen class="text-primary size-5" />
          {{ t('hosts.rename') }}
        </h3>
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
          <div v-if="renameError" role="alert" class="alert alert-error alert-soft">
            <TriangleAlert class="size-4" />
            <span>{{ renameError }}</span>
          </div>
          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="renameDialog?.close()">
              {{ t('common.cancel') }}
            </button>
            <button class="btn btn-primary btn-sm" type="submit">{{ t('common.save') }}</button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>

    <dialog ref="rotateDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <KeyRound class="text-primary size-5" />
          {{ t('hosts.rotateTitle', { name: rotating?.name }) }}
        </h3>

        <div v-if="!rotatedToken" class="mt-4 flex flex-col gap-4">
          <p class="text-sm opacity-70">{{ t('hosts.rotateIntro') }}</p>
          <div v-if="rotateError" role="alert" class="alert alert-error alert-soft">
            <TriangleAlert class="size-4" />
            <span>{{ rotateError }}</span>
          </div>
          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="rotateDialog?.close()">
              {{ t('common.cancel') }}
            </button>
            <button class="btn btn-primary btn-sm" type="button" @click="confirmRotate">
              {{ t('hosts.rotate') }}
            </button>
          </div>
        </div>

        <div v-else class="mt-4 flex flex-col gap-4">
          <div role="alert" class="alert alert-warning alert-soft">
            <TriangleAlert class="size-4" />
            <span>{{ t('hosts.tokenWarning') }}</span>
          </div>
          <label class="input w-full">
            <KeyRound class="size-4 opacity-60" />
            <input class="font-mono text-sm" :value="rotatedToken" readonly />
            <button type="button" class="btn btn-ghost btn-xs gap-1" @click="copyToken">
              <Copy class="size-3.5" />
              {{ copied ? t('common.copied') : t('common.copy') }}
            </button>
          </label>
          <div class="modal-action">
            <button class="btn btn-primary btn-sm" type="button" @click="rotateDialog?.close()">
              {{ t('common.done') }}
            </button>
          </div>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>

    <dialog ref="removeDialog" class="modal" @close="pendingRemove = null">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <TriangleAlert class="text-error size-5" />
          {{ t('hosts.removeTitle', { name: pendingRemove?.name }) }}
        </h3>
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
        <div v-if="removeError" role="alert" class="alert alert-error alert-soft mt-4">
          <TriangleAlert class="size-4" />
          <span>{{ removeError }}</span>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="removeDialog?.close()">
            {{ t('common.cancel') }}
          </button>
          <button class="btn btn-error btn-sm gap-2" type="button" @click="confirmRemove">
            <Trash2 class="size-4" />
            {{ t('hosts.removeAction') }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>
  </div>
</template>
