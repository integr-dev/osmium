<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Bot as Agent,
  KeyRound,
  MessageSquare,
  Power,
  ScrollText,
  Server,
  SquarePen,
  Trash2,
  TriangleAlert,
  User,
  UserPlus,
  Users,
} from 'lucide-vue-next'
import { api, errorMessage, type AuditEntryResponse } from '../api/client'

/**
 * The operator audit trail: who triggered what, not what happened to an agent. Agent-side events
 * (died, kicked, connected) are the *activity* feed and live on the dashboard and agent pages.
 *
 * Filtering is client-side because the endpoint returns a bounded, newest-first page: with a 30-day
 * retention and a row per command rather than per event, the whole window is small enough to hold.
 * Server-side search becomes worth building when that stops being true.
 */
type AuditAction = AuditEntryResponse['action']

const ACTION_ICON: Record<AuditAction, typeof KeyRound> = {
  AGENT_CREATE: Agent,
  AGENT_UPDATE: SquarePen,
  AGENT_DELETE: Trash2,
  AGENT_SETUP: KeyRound,
  AGENT_CONNECT: Power,
  AGENT_DISCONNECT: Power,
  AGENT_CHAT: MessageSquare,
  HOST_ENROL: Server,
  HOST_RENAME: SquarePen,
  HOST_ROTATE_TOKEN: KeyRound,
  HOST_DELETE: Trash2,
  USER_CREATE: UserPlus,
  USER_UPDATE: SquarePen,
  USER_DELETE: Trash2,
  USER_ROLE_CHANGE: Users,
  USER_PASSWORD_CHANGE: KeyRound,
}

/**
 * Red is reserved for entries that change who can do what, or that destroy something: a token
 * rotation, a deletion, a role change. Everything else is routine operation, and colouring it all
 * alike would defeat the point of scanning.
 */
const ACTION_BADGE: Record<AuditAction, string> = {
  AGENT_CREATE: 'badge-ghost',
  AGENT_UPDATE: 'badge-ghost',
  AGENT_DELETE: 'badge-error badge-soft',
  AGENT_SETUP: 'badge-info badge-soft',
  AGENT_CONNECT: 'badge-success badge-soft',
  AGENT_DISCONNECT: 'badge-ghost',
  AGENT_CHAT: 'badge-warning badge-soft',
  HOST_ENROL: 'badge-info badge-soft',
  HOST_RENAME: 'badge-ghost',
  HOST_ROTATE_TOKEN: 'badge-error badge-soft',
  HOST_DELETE: 'badge-error badge-soft',
  USER_CREATE: 'badge-info badge-soft',
  USER_UPDATE: 'badge-warning badge-soft',
  USER_DELETE: 'badge-error badge-soft',
  USER_ROLE_CHANGE: 'badge-error badge-soft',
  USER_PASSWORD_CHANGE: 'badge-warning badge-soft',
}


const { t } = useI18n()

/** Wording lives with the rest of the copy; this is just the lookup. */
const actionLabel = (action: AuditAction) => t('auditAction.' + action)

const entries = ref<AuditEntryResponse[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const query = ref('')

onMounted(load)

async function load() {
  loading.value = true
  error.value = null
  const { data, error: failure } = await api.GET('/api/audit')
  loading.value = false

  if (failure) {
    error.value = errorMessage(failure, 'Could not load the audit log')
    return
  }
  entries.value = (data ?? []) as AuditEntryResponse[]
}

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return entries.value
  return entries.value.filter((entry) =>
    [entry.account, entry.target, entry.detail ?? '', actionLabel(entry.action)]
      .join(' ')
      .toLowerCase()
      .includes(needle),
  )
})

/** Local time: an operator reading this is reasoning about their own working day. */
function formatAt(at: string): string {
  return new Date(at).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{{ t('audit.title') }}</h1>
        <p class="text-sm opacity-60">{{ t('audit.subtitle') }}</p>
      </div>
      <label class="input input-sm w-full max-w-xs">
        <ScrollText class="size-4 shrink-0 opacity-60" />
        <input v-model="query" type="search" :placeholder="t('audit.filterPlaceholder')" />
      </label>
    </header>

    <div v-if="error" role="alert" class="alert alert-error alert-soft">
      <TriangleAlert class="size-4" />
      <span>{{ error }}</span>
    </div>

    <div class="card border-base-300 bg-base-200 border">
      <div class="overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('audit.when') }}</th>
              <th>{{ t('audit.who') }}</th>
              <th>{{ t('audit.action') }}</th>
              <th>{{ t('audit.target') }}</th>
              <th>{{ t('audit.detail') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in filtered" :key="entry.id" class="hover:bg-base-300/40">
              <td class="whitespace-nowrap text-sm opacity-70">{{ formatAt(entry.at) }}</td>
              <td>
                <div class="flex items-center gap-2">
                  <User class="size-4 opacity-50" />
                  <span class="font-medium">{{ entry.account }}</span>
                </div>
              </td>
              <td>
                <span class="badge badge-sm gap-1" :class="ACTION_BADGE[entry.action]">
                  <component :is="ACTION_ICON[entry.action]" class="size-3" />
                  {{ actionLabel(entry.action) }}
                </span>
              </td>
              <td class="text-sm">{{ entry.target }}</td>
              <td class="text-sm opacity-70">{{ entry.detail ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="loading" class="py-10 text-center text-sm opacity-50">{{ t('common.loading') }}</p>
      <p v-else-if="!entries.length" class="py-10 text-center text-sm opacity-50">
        {{ t('audit.none') }}
      </p>
      <p v-else-if="!filtered.length" class="py-10 text-center text-sm opacity-50">
        {{ t('audit.noMatches') }}
      </p>
    </div>

    <p class="text-xs opacity-50">
      {{ t('audit.retention') }}
    </p>
  </div>
</template>
