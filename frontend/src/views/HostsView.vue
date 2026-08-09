<script setup lang="ts">
import { ref } from 'vue'
import { Bot, Plus, Server, Trash2, TriangleAlert } from 'lucide-vue-next'
import AddHostModal from '../components/AddHostModal.vue'
import { useBotStore, type Host } from '../stores/bots'

const botStore = useBotStore()

const addOpen = ref(false)
const pendingRemove = ref<Host | null>(null)
const removeDialog = ref<HTMLDialogElement | null>(null)

function askRemove(host: Host) {
  pendingRemove.value = host
  removeDialog.value?.showModal()
}

function confirmRemove() {
  if (pendingRemove.value) botStore.removeHost(pendingRemove.value.id)
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
          Agent machines that run the bots.
          {{ botStore.hosts.filter((host) => host.online).length }} of
          {{ botStore.hosts.length }} online.
        </p>
      </div>
      <button class="btn btn-primary btn-sm gap-2" @click="addOpen = true">
        <Plus class="size-4" />
        Enrol host
      </button>
    </header>

    <div class="card border-base-300 bg-base-200 border">
      <div class="overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Host</th>
              <th>Status</th>
              <th>Agent</th>
              <th>Bots</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="host in botStore.hosts" :key="host.id" class="hover:bg-base-300/40">
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
                  :class="host.online ? 'badge-success badge-soft' : 'badge-error badge-soft'"
                >
                  <span class="size-1.5 rounded-full" :class="host.online ? 'bg-success' : 'bg-error'"></span>
                  {{ host.online ? 'Online' : 'Unreachable' }}
                </span>
              </td>
              <td class="font-mono text-sm opacity-70">{{ host.agentVersion }}</td>
              <td>
                <span class="badge badge-ghost badge-sm gap-1">
                  <Bot class="size-3" />
                  {{ botStore.botsOnHost(host.id).length }}
                </span>
              </td>
              <td>
                <div class="flex justify-end">
                  <button class="btn btn-ghost btn-xs text-error gap-1" @click="askRemove(host)">
                    <Trash2 class="size-3.5" />
                    Remove
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="botStore.hosts.length === 0">
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

    <dialog ref="removeDialog" class="modal" @close="pendingRemove = null">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <TriangleAlert class="text-error size-5" />
          Remove {{ pendingRemove?.name }}?
        </h3>
        <p class="mt-3 text-sm opacity-70">
          <template v-if="pendingRemove && botStore.botsOnHost(pendingRemove.id).length">
            This host runs
            <span class="text-error font-medium">
              {{ botStore.botsOnHost(pendingRemove.id).length }} bot(s)
            </span>
            , which will be removed with it.
          </template>
          <template v-else>This host has no bots.</template>
          The agent token is invalidated.
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
