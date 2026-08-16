<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot as Agent, Copy, KeyRound, Plus, Server, SquarePen, Trash2, TriangleAlert } from 'lucide-vue-next'
import AddHostModal from '../components/AddHostModal.vue'
import FormField from '../components/FormField.vue'
import TableSkeleton from '../components/TableSkeleton.vue'
import type { HostResponse } from '../api/client'
import { vFlash } from '../lib/motion'
import { useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'

const { t } = useI18n()
const agentStore = useAgentStore()
const auth = useAuthStore()

const addOpen = ref(false)
const pendingRemove = ref<HostResponse | null>(null)
const removeDialog = ref<HTMLDialogElement | null>(null)
const error = ref<string | null>(null)

const renameDialog = ref<HTMLDialogElement | null>(null)
const renaming = ref<HostResponse | null>(null)
const renameDraft = ref('')
const renameError = ref<string | null>(null)

const rotateDialog = ref<HTMLDialogElement | null>(null)
const rotating = ref<HostResponse | null>(null)
const rotatedToken = ref<string | null>(null)
const rotateError = ref<string | null>(null)
const copied = ref(false)

onMounted(() => void agentStore.refresh())

function openRename(host: HostResponse) {
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

function openRotate(host: HostResponse) {
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

function askRemove(host: HostResponse) {
  pendingRemove.value = host
  removeDialog.value?.showModal()
}

async function confirmRemove() {
  if (!pendingRemove.value) return
  error.value = null
  try {
    await agentStore.removeHost(pendingRemove.value.id)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.removeHost')
  }
  pendingRemove.value = null
  removeDialog.value?.close()
}
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{{ t('hosts.title') }}</h1>
        <p class="text-sm opacity-60">
          {{ t('hosts.subtitle') }}
          {{
            t('hosts.onlineCount', {
              online: agentStore.hosts.filter((host) => host.reachable).length,
              total: agentStore.hosts.length,
            })
          }}
        </p>
      </div>
      <button v-if="auth.can('host.write')" class="btn btn-primary btn-sm gap-2" @click="addOpen = true">
        <Plus class="size-4" />
        {{ t('hosts.enrol') }}
      </button>
    </header>

    <div v-if="error || agentStore.error" role="alert" class="alert alert-error alert-soft">
      <TriangleAlert class="size-4" />
      <span>{{ error ?? agentStore.error }}</span>
    </div>

    <div class="card border-base-300 bg-base-200 border">
      <div class="overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('hosts.host') }}</th>
              <th>{{ t('common.status') }}</th>
              <th>{{ t('hosts.version') }}</th>
              <th>{{ t('hosts.agents') }}</th>
              <th class="text-right">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <!-- Rows, not an empty state: "no hosts" is not yet known to be true. -->
          <TableSkeleton v-if="!agentStore.loaded" :columns="5" />

          <tbody v-else>
            <!--
              A host going unreachable takes its agents with it, and it happens on the stream with
              nobody having pressed anything. This is the row that says so.
            -->
            <tr
              v-for="host in agentStore.hosts"
              :key="host.id"
              v-flash="host.reachable"
              class="hover:bg-base-300/40"
            >
              <td>
                <div class="flex items-center gap-3">
                  <div class="rounded-field bg-base-300/40 flex size-8 items-center justify-center">
                    <Server class="size-4 opacity-70" />
                  </div>
                  <div class="font-medium">{{ host.name }}</div>
                </div>
              </td>
              <td>
                <span
                  class="badge badge-sm gap-1"
                  :class="host.reachable ? 'badge-success badge-soft' : 'badge-error badge-soft'"
                >
                  <span class="size-1.5 rounded-full" :class="host.reachable ? 'bg-success' : 'bg-error'"></span>
                  {{ host.reachable ? t('hosts.reachable') : t('hosts.unreachable') }}
                </span>
              </td>
              <td class="font-mono text-sm opacity-70">{{ host.hostVersion ?? '—' }}</td>
              <td>
                <span class="badge badge-ghost badge-sm gap-1">
                  <Agent class="size-3" />
                  {{ host.agentCount }}
                </span>
              </td>
              <td>
                <!--
                  Three authorities, not one: renaming is administration, rotating replaces the
                  credential the host authenticates with, and removing takes every agent on it.
                -->
                <div class="flex justify-end gap-1">
                  <button
                    v-if="auth.can('host.write')"
                    class="btn btn-ghost btn-xs gap-1"
                    @click="openRename(host)"
                  >
                    <SquarePen class="size-3.5" />
                    {{ t('hosts.rename') }}
                  </button>
                  <button
                    v-if="auth.can('host.token')"
                    class="btn btn-ghost btn-xs gap-1"
                    @click="openRotate(host)"
                  >
                    <KeyRound class="size-3.5" />
                    {{ t('hosts.rotateToken') }}
                  </button>
                  <button
                    v-if="auth.can('host.delete')"
                    class="btn btn-ghost btn-xs text-error gap-1"
                    @click="askRemove(host)"
                  >
                    <Trash2 class="size-3.5" />
                    {{ t('hosts.removeAction') }}
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="agentStore.hosts.length === 0">
              <td colspan="5">
                <div class="flex flex-col items-center gap-2 py-10 opacity-60">
                  <Server class="size-6" />
                  <span class="text-sm">{{ t('hosts.none') }}</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <AddHostModal v-model:open="addOpen" />

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
            <button class="btn btn-ghost btn-sm" type="button" @click="renameDialog?.close()">{{ t('common.cancel') }}</button>
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
          <p class="text-sm opacity-70">
            {{ t('hosts.rotateIntro') }}
          </p>
          <div v-if="rotateError" role="alert" class="alert alert-error alert-soft">
            <TriangleAlert class="size-4" />
            <span>{{ rotateError }}</span>
          </div>
          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="rotateDialog?.close()">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary btn-sm" type="button" @click="confirmRotate">{{ t('hosts.rotate') }}</button>
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
            <button class="btn btn-primary btn-sm" type="button" @click="rotateDialog?.close()">{{ t('common.done') }}</button>
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
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="removeDialog?.close()">{{ t('common.cancel') }}</button>
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
