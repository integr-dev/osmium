<script setup lang="ts">
import { computed, ref } from 'vue'
import { Info, KeyRound, MessageSquare, Power, ScrollText, Server, User } from 'lucide-vue-next'

/**
 * The operator audit trail: who triggered what, not what happened to a bot. Bot-side events
 * (died, kicked, connected) are the *activity* feed and live on the dashboard and bot pages.
 *
 * MOCK. Nothing writes an audit record yet — there is no audit entity, table or endpoint on the
 * backend. These rows exist so the surface and its shape are settled before the log is built.
 * See the Audit section of BOT_CONNECTIVITY.md.
 */
type AuditAction = 'setup' | 'connect' | 'disconnect' | 'chat' | 'host'

interface AuditEntry {
  at: string
  account: string
  action: AuditAction
  target: string
  /** Outbound message text for `chat`; a short outcome for everything else. */
  detail: string
}

const ACTION_ICON = {
  setup: KeyRound,
  connect: Power,
  disconnect: Power,
  chat: MessageSquare,
  host: Server,
}

const ACTION_BADGE: Record<AuditAction, string> = {
  setup: 'badge-info badge-soft',
  connect: 'badge-success badge-soft',
  disconnect: 'badge-ghost',
  chat: 'badge-warning badge-soft',
  host: 'badge-ghost',
}

const ACTION_LABEL: Record<AuditAction, string> = {
  setup: 'Set up',
  connect: 'Connect',
  disconnect: 'Disconnect',
  chat: 'Chat',
  host: 'Host',
}

const ENTRIES: AuditEntry[] = [
  { at: '2026-08-10 13:42', account: 'admin', action: 'chat', target: 'Mason_02', detail: 'gg everyone' },
  { at: '2026-08-10 13:38', account: 'admin', action: 'connect', target: 'Mason_02', detail: 'Accepted by the host' },
  { at: '2026-08-10 12:55', account: 'builder', action: 'disconnect', target: 'Mason_03', detail: 'Requested by operator' },
  { at: '2026-08-10 11:20', account: 'builder', action: 'setup', target: 'Mason_03', detail: 'Method A, completed on eu-1' },
  { at: '2026-08-09 18:04', account: 'admin', action: 'host', target: 'eu-2', detail: 'Enrolled, token issued once' },
]

const query = ref('')

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return ENTRIES
  return ENTRIES.filter((entry) =>
    [entry.account, entry.target, entry.detail, ACTION_LABEL[entry.action]]
      .join(' ')
      .toLowerCase()
      .includes(needle),
  )
})
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p class="text-sm opacity-60">Every command an operator issued, and what a bot was made to say.</p>
      </div>
      <label class="input input-sm w-full max-w-xs">
        <ScrollText class="size-4 shrink-0 opacity-60" />
        <input v-model="query" type="search" placeholder="Filter by account, bot or text" />
      </label>
    </header>

    <div role="alert" class="alert alert-info alert-soft">
      <Info class="size-4" />
      <span>
        Sample rows. Nothing records audit entries yet — the backend has no audit trail, so this
        shows the shape the log will take.
      </span>
    </div>

    <div class="card border-base-300 bg-base-200 border">
      <div class="overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Account</th>
              <th>Action</th>
              <th>Target</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in filtered" :key="`${entry.at}-${entry.target}`" class="hover:bg-base-300/40">
              <td class="whitespace-nowrap text-sm opacity-70">{{ entry.at }}</td>
              <td>
                <div class="flex items-center gap-2">
                  <User class="size-4 opacity-50" />
                  <span class="font-medium">{{ entry.account }}</span>
                </div>
              </td>
              <td>
                <span class="badge badge-sm gap-1" :class="ACTION_BADGE[entry.action]">
                  <component :is="ACTION_ICON[entry.action]" class="size-3" />
                  {{ ACTION_LABEL[entry.action] }}
                </span>
              </td>
              <td class="text-sm">{{ entry.target }}</td>
              <td class="text-sm opacity-70">{{ entry.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!filtered.length" class="py-10 text-center text-sm opacity-50">
        Nothing matches that filter.
      </p>
    </div>

    <p class="text-xs opacity-50">
      Audit entries are kept for 30 days. Bot activity is kept for 10 days and chat for 3.
    </p>
  </div>
</template>
