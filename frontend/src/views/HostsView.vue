<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Bot as Agent, Copy, KeyRound, Plus, Server, SquarePen, Trash2, TriangleAlert } from 'lucide-vue-next'
import AddHostModal from '../components/AddHostModal.vue'
import FormField from '../components/FormField.vue'
import type { HostResponse } from '../api/client'
import { useAgentStore } from '../stores/agents'

const agentStore = useAgentStore()

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
    renameError.value = failure instanceof Error ? failure.message : 'Could not rename the host'
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
    rotateError.value = failure instanceof Error ? failure.message : 'Could not rotate the token'
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
    error.value = failure instanceof Error ? failure.message : 'Could not remove the host'
  }
  pendingRemove.value = null
  removeDialog.value?.close()
}
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Hosts</h1>
        <p class="text-sm opacity-60">
          Machines that run your agents.
          {{ agentStore.hosts.filter((host) => host.reachable).length }} of
          {{ agentStore.hosts.length }} online.
        </p>
      </div>
      <button class="btn btn-primary btn-sm gap-2" @click="addOpen = true">
        <Plus class="size-4" />
        Enrol host
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
              <th>Host</th>
              <th>Status</th>
              <th>Agent</th>
              <th>Agents</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="host in agentStore.hosts" :key="host.id" class="hover:bg-base-300/40">
              <td>
                <div class="flex items-center gap-3">
                  <div class="rounded-field bg-base-300/40 flex size-8 items-center justify-center">
                    <Server class="size-4 opacity-70" />
                  </div>
                  <div>
                    <div class="font-medium">{{ host.name }}</div>
                    <div class="font-mono text-xs opacity-50">
                      {{ host.address ?? 'not yet connected' }}
                    </div>
                  </div>
                </div>
              </td>
              <td>
                <span
                  class="badge badge-sm gap-1"
                  :class="host.reachable ? 'badge-success badge-soft' : 'badge-error badge-soft'"
                >
                  <span class="size-1.5 rounded-full" :class="host.reachable ? 'bg-success' : 'bg-error'"></span>
                  {{ host.reachable ? 'Online' : 'Unreachable' }}
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
                <div class="flex justify-end gap-1">
                  <button class="btn btn-ghost btn-xs gap-1" @click="openRename(host)">
                    <SquarePen class="size-3.5" />
                    Rename
                  </button>
                  <button class="btn btn-ghost btn-xs gap-1" @click="openRotate(host)">
                    <KeyRound class="size-3.5" />
                    Rotate token
                  </button>
                  <button class="btn btn-ghost btn-xs text-error gap-1" @click="askRemove(host)">
                    <Trash2 class="size-3.5" />
                    Remove
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="agentStore.hosts.length === 0">
              <td colspan="5">
                <div class="flex flex-col items-center gap-2 py-10 opacity-60">
                  <Server class="size-6" />
                  <span class="text-sm">No hosts enrolled.</span>
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
          Rename host
        </h3>
        <p class="mt-1 text-sm opacity-60">
          Only the name is yours to set — address, version and reachability are observed when the
          host connects.
        </p>
        <form class="mt-5 flex flex-col gap-4" @submit.prevent="saveRename">
          <FormField
            v-model="renameDraft"
            label="Host name"
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
            <button class="btn btn-ghost btn-sm" type="button" @click="renameDialog?.close()">Cancel</button>
            <button class="btn btn-primary btn-sm" type="submit">Save</button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>

    <dialog ref="rotateDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <KeyRound class="text-primary size-5" />
          Rotate token for {{ rotating?.name }}
        </h3>

        <div v-if="!rotatedToken" class="mt-4 flex flex-col gap-4">
          <p class="text-sm opacity-70">
            Issues a new token and invalidates the current one. The host is disconnected and has to
            reconnect with the replacement — its agents are kept.
          </p>
          <div v-if="rotateError" role="alert" class="alert alert-error alert-soft">
            <TriangleAlert class="size-4" />
            <span>{{ rotateError }}</span>
          </div>
          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="rotateDialog?.close()">Cancel</button>
            <button class="btn btn-primary btn-sm" type="button" @click="confirmRotate">Rotate</button>
          </div>
        </div>

        <div v-else class="mt-4 flex flex-col gap-4">
          <div role="alert" class="alert alert-warning alert-soft">
            <TriangleAlert class="size-4" />
            <span>Copy this now — it is shown once and cannot be recovered.</span>
          </div>
          <label class="input w-full">
            <KeyRound class="size-4 opacity-60" />
            <input class="font-mono text-sm" :value="rotatedToken" readonly />
            <button type="button" class="btn btn-ghost btn-xs gap-1" @click="copyToken">
              <Copy class="size-3.5" />
              {{ copied ? 'Copied' : 'Copy' }}
            </button>
          </label>
          <div class="modal-action">
            <button class="btn btn-primary btn-sm" type="button" @click="rotateDialog?.close()">Done</button>
          </div>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>

    <dialog ref="removeDialog" class="modal" @close="pendingRemove = null">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <TriangleAlert class="text-error size-5" />
          Remove {{ pendingRemove?.name }}?
        </h3>
        <p class="mt-3 text-sm opacity-70">
          <template v-if="pendingRemove && agentStore.agentsOnHost(pendingRemove.id).length">
            This host runs
            <span class="text-error font-medium">
              {{ agentStore.agentsOnHost(pendingRemove.id).length }} agent(s)
            </span>
            , which will be removed with it.
          </template>
          <template v-else>This host has no agents.</template>
          Its token stops working.
        </p>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="removeDialog?.close()">Cancel</button>
          <button class="btn btn-error btn-sm gap-2" type="button" @click="confirmRemove">
            <Trash2 class="size-4" />
            Remove
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>
  </div>
</template>
