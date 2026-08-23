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
const renameBusy = ref(false)

const rotateDialog = ref<HTMLDialogElement | null>(null)
const rotating = ref<HostResponse | null>(null)
const rotatedToken = ref<string | null>(null)
const rotateError = ref<string | null>(null)
const copied = ref(false)
/** Set when the clipboard refused. The token is shown once, so this cannot be swallowed. */
const copyFailed = ref(false)
const rotateBusy = ref(false)

const removeDialog = ref<HTMLDialogElement | null>(null)
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
  copied.value = false
  copyFailed.value = false
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

/**
 * The one place in the application where a silent failure cannot be recovered from.
 *
 * `writeText` rejects on a denied permission and in any non-secure context. Unhandled, the promise
 * died quietly and the button simply stayed on "Copy" — so an operator who clicked it, saw nothing
 * change, clicked Done and pasted an empty clipboard had permanently lost the host's credential.
 */
async function copyToken() {
  if (!rotatedToken.value) return
  try {
    await navigator.clipboard.writeText(rotatedToken.value)
    copied.value = true
  } catch {
    copyFailed.value = true
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
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>

    <!--
      Escape is refused while the token is on screen. `cancel` is the event a `<dialog>` fires for
      Escape, and preventing it is the only way to keep the key from dismissing the one and only
      display of a credential that cannot be retrieved. Done still closes, so nobody is trapped —
      what is blocked is the accidental dismissal, not the deliberate one.
    -->
    <dialog ref="rotateDialog" class="modal" @cancel="rotatedToken && $event.preventDefault()">
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
          <!-- Says what to do instead. The token is still on screen, so this is recoverable — but
               only if the operator is told the click did not work. -->
          <div v-if="copyFailed" role="alert" class="alert alert-warning alert-soft">
            <TriangleAlert class="size-4" />
            <span>{{ t('common.copyFailed') }}</span>
          </div>
          <div class="modal-action">
            <button class="btn btn-primary btn-sm" type="button" @click="rotateDialog?.close()">
              {{ t('common.done') }}
            </button>
          </div>
        </div>
      </div>
      <!--
        The backdrop closes this only up to the point where there is something to lose. daisyUI's
        backdrop is a form that submits the dialog, so it is simply not rendered once the token is
        showing — an off-target click there would otherwise take the credential with it.
      -->
      <form v-if="!rotatedToken" method="dialog" class="modal-backdrop">
        <button>{{ t('common.close') }}</button>
      </form>
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
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>
  </div>
</template>
