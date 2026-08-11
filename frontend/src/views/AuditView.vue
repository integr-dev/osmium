<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Bot as Agent,
  Download,
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
import type { AuditEntryResponse } from '../api/client'
import { fetchAuditPage } from '../api/feeds'
import { downloadAuditCsv } from '../api/auditExport'
import TableSkeleton from '../components/TableSkeleton.vue'
import { useAuthStore } from '../stores/auth'
import { useAgentStore } from '../stores/agents'
import { useFeed, useInfiniteScroll } from '../lib/feed'

const auth = useAuthStore()
const agentStore = useAgentStore()

/**
 * The operator audit trail: who triggered what, not what happened to an agent. Agent-side events
 * (died, kicked, connected) are the *activity* feed and live on the dashboard and agent pages.
 *
 * Paged by cursor and scrolled rather than clicked: the trail is long enough that a fixed page
 * hides most of it, and an offset would drift as commands are recorded while it is being read.
 *
 * Searching is done by the backend. A filter over only the rows already fetched would search the
 * newest hundred of thirty days and report that nothing matches, which reads as an answer.
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
  AUDIT_EXPORT: Download,
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
  // Red: a copy of the trail left the system, and nothing here can see it again.
  AUDIT_EXPORT: 'badge-error badge-soft',
}


const { t } = useI18n()

/** Wording lives with the rest of the copy; this is just the lookup. */
const actionLabel = (action: AuditAction) => t('auditAction.' + action)

/** Long enough to swallow a burst of typing, short enough not to feel like a submit button. */
const SEARCH_DEBOUNCE_MS = 250

const query = ref('')
const sentinel = ref<HTMLElement | null>(null)
let debounce: ReturnType<typeof setTimeout> | null = null

const feed = useFeed((cursor) => fetchAuditPage(cursor, query.value.trim()))
const scroll = useInfiniteScroll(sentinel, () => void loadMore())

let stopListening: (() => void) | null = null

onMounted(async () => {
  await feed.reset()
  scroll.start()

  stopListening = agentStore.onFeedEvent((name, data) => {
    // Only while unfiltered. A live entry has not been through the server-side search, so
    // prepending it during a search would put a row on screen that does not match what was typed.
    if (name === 'audit' && !query.value.trim()) feed.prepend(data as AuditEntryResponse)
  })
})

onBeforeUnmount(() => {
  if (debounce) clearTimeout(debounce)
  stopListening?.()
})

/** Typing rewinds to the newest matching entry rather than filtering what is already on screen. */
watch(query, () => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(async () => {
    await feed.reset()
    await scroll.rearm()
  }, SEARCH_DEBOUNCE_MS)
})

async function loadMore(): Promise<void> {
  await feed.more()
  if (!feed.exhausted.value) await scroll.rearm()
}

const entries = feed.items
const loading = feed.loading
const error = feed.error
const exhausted = feed.exhausted

// ---- export ----------------------------------------------------------------------------------

/**
 * Defaults to the last seven days, in local time. Both pickers hold a day rather than an instant:
 * an operator asking for "the 11th" means their own 11th, and `downloadAuditCsv` turns each day
 * into the matching instant so the backend never has to assume a timezone.
 */
const today = new Date()
const exportTo = ref(asDay(today))
const exportFrom = ref(asDay(new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)))
const exporting = ref(false)
const exportError = ref<string | null>(null)

const exportDialog = ref<HTMLDialogElement | null>(null)

// Guarded here as well as on the server: a range that runs backwards is a slip, and a 400 is a
// worse way to learn about it than a disabled button.
const rangeOrdered = computed(() => exportFrom.value <= exportTo.value)

async function runExport() {
  exporting.value = true
  exportError.value = null
  exportError.value = await downloadAuditCsv(exportFrom.value, exportTo.value)
  exporting.value = false
  if (!exportError.value) exportDialog.value?.close()
}

/** `YYYY-MM-DD` in local time. `toISOString` would shift the day for anyone east or west of UTC. */
function asDay(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

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
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{{ t('audit.title') }}</h1>
        <p class="text-sm opacity-60">{{ t('audit.subtitle') }}</p>
      </div>
      <!--
        `w-full` on the search box made it claim the whole row, so the button wrapped underneath it
        rather than sitting beside it. A fixed width leaves room for both on one line.
      -->
      <div class="flex items-center gap-2">
        <label class="input input-sm w-64">
          <ScrollText class="size-4 shrink-0 opacity-60" />
          <input v-model="query" type="search" :placeholder="t('audit.filterPlaceholder')" />
        </label>
        <button
          v-if="auth.can('audit.export')"
          type="button"
          class="btn btn-sm gap-2"
          @click="exportDialog?.showModal()"
        >
          <Download class="size-4" />
          {{ t('audit.export') }}
        </button>
      </div>
    </header>

    <dialog ref="exportDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <Download class="text-primary size-5" />
          {{ t('audit.exportTitle') }}
        </h3>
        <p class="mt-1 text-sm opacity-60">{{ t('audit.exportHint') }}</p>

        <div class="mt-5 grid gap-4 sm:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="text-xs opacity-60">{{ t('audit.exportFrom') }}</span>
            <input v-model="exportFrom" type="date" class="input input-sm w-full" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs opacity-60">{{ t('audit.exportTo') }}</span>
            <input v-model="exportTo" type="date" class="input input-sm w-full" />
          </label>
        </div>

        <p v-if="!rangeOrdered" class="text-warning mt-3 text-sm">{{ t('audit.exportOrder') }}</p>
        <p v-else class="mt-3 text-xs opacity-50">{{ t('audit.exportRecorded') }}</p>

        <div v-if="exportError" role="alert" class="alert alert-error alert-soft mt-4">
          <TriangleAlert class="size-4" />
          <span>{{ exportError }}</span>
        </div>

        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="exportDialog?.close()">
            {{ t('common.cancel') }}
          </button>
          <button
            class="btn btn-primary btn-sm gap-2"
            type="button"
            :disabled="exporting || !rangeOrdered"
            @click="runExport"
          >
            <Download class="size-4" />
            {{ exporting ? t('audit.exporting') : t('audit.export') }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>

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
              <th class="whitespace-nowrap">{{ t('audit.action') }}</th>
              <th>{{ t('audit.target') }}</th>
              <th>{{ t('audit.detail') }}</th>
            </tr>
          </thead>

          <!-- Only the first page. Once there are rows, more arriving is an append, not a redraw. -->
          <TableSkeleton v-if="loading && !entries.length" :rows="6" :columns="5" />

          <tbody v-else>
            <tr v-for="entry in entries" :key="entry.id" class="hover:bg-base-300/40">
              <td class="whitespace-nowrap text-sm opacity-70">{{ formatAt(entry.at) }}</td>
              <td>
                <div class="flex items-center gap-2">
                  <User class="size-4 opacity-50" />
                  <span class="font-medium">{{ entry.account }}</span>
                </div>
              </td>
              <!-- The action names the row; wrapping it costs two lines to save a few pixels. -->
              <td class="whitespace-nowrap">
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

      <!--
        An indicator rather than more skeleton rows: this is the tail of an infinite scroll, and a
        skeleton row here would be read as a real entry arriving rather than as a wait.
      -->
      <div v-if="loading && entries.length" class="flex justify-center py-6">
        <span class="loading loading-dots loading-sm opacity-50"></span>
      </div>
      <p v-else-if="loading" class="sr-only">{{ t('common.loading') }}</p>
      <p v-else-if="!entries.length && query.trim()" class="py-10 text-center text-sm opacity-50">
        {{ t('audit.noMatches') }}
      </p>
      <p v-else-if="!entries.length" class="py-10 text-center text-sm opacity-50">
        {{ t('audit.none') }}
      </p>
      <p v-else-if="exhausted && !error" class="py-6 text-center text-xs opacity-40">
        {{ t('audit.end') }}
      </p>

      <!--
        Watched by an IntersectionObserver: reaching it fetches the next page. Always rendered, so
        the element the observer holds never goes away underneath it.
      -->
      <div ref="sentinel" aria-hidden="true" class="h-px"></div>
    </div>

    <p class="text-xs opacity-50">
      {{ t('audit.retention') }}
    </p>
  </div>
</template>
