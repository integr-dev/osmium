<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot as Agent, KeyRound, Plus, Server, SquarePen, Trash2 } from 'lucide-vue-next'
import AddHostModal from './AddHostModal.vue'
import HostActions from './HostActions.vue'
import TableSkeleton from './TableSkeleton.vue'
import { vFlash } from '../lib/motion'
import { useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'

/**
 * The machines that run the fleet, as a table.
 *
 * A component rather than a page because it is one of three answers to the same question — what
 * this deployment is made of — and Resources asks all three side by side. The dialogs it opens are
 * shared with a host's own page, which is why they are not in here.
 */
const { t } = useI18n()
const agentStore = useAgentStore()
const auth = useAuthStore()

const addOpen = ref(false)
const actions = ref<InstanceType<typeof HostActions> | null>(null)
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm opacity-60">
        {{
          t('hosts.onlineCount', {
            online: agentStore.hosts.filter((host) => host.reachable).length,
            total: agentStore.hosts.length,
          })
        }}
      </p>
      <button v-if="auth.can('host.write')" class="btn btn-primary btn-sm gap-2" @click="addOpen = true">
        <Plus class="size-4" />
        {{ t('hosts.enrol') }}
      </button>
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
                <RouterLink
                  :to="{ name: 'host', params: { id: host.id } }"
                  class="flex items-center gap-3"
                >
                  <div class="rounded-field bg-base-300/40 flex size-8 items-center justify-center">
                    <Server class="size-4 opacity-70" />
                  </div>
                  <div class="link-hover font-medium">{{ host.name }}</div>
                </RouterLink>
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
                <div class="flex justify-end gap-1">
                  <button
                    v-if="auth.can('host.write')"
                    class="btn btn-ghost btn-xs gap-1"
                    @click="actions?.rename(host)"
                  >
                    <SquarePen class="size-3.5" />
                    {{ t('hosts.rename') }}
                  </button>
                  <button
                    v-if="auth.can('host.token')"
                    class="btn btn-ghost btn-xs gap-1"
                    @click="actions?.rotate(host)"
                  >
                    <KeyRound class="size-3.5" />
                    {{ t('hosts.rotateToken') }}
                  </button>
                  <button
                    v-if="auth.can('host.delete')"
                    class="btn btn-ghost btn-xs text-error gap-1"
                    @click="actions?.remove(host)"
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
    <HostActions ref="actions" />
  </div>
</template>
