<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Backpack,
  Footprints,
  Bot as Agent,
  Download,
  Hammer,
  HardDrive,
  KeyRound,
  MapPin,
  MessageSquare,
  Pause,
  Play,
  Pickaxe,
  Power,
  ScrollText,
  Server,
  ShieldAlert,
  ShieldCheck,
  SquarePen,
  Trash2,
  Upload,
  User,
  UserPlus,
  Users,
} from 'lucide-vue-next'
import ModalShell from '../components/ModalShell.vue'
import AlertNote from '../components/AlertNote.vue'
import type { AuditEntryResponse } from '../api/client'
import { fetchAuditPage } from '../api/feeds'
import { downloadAuditCsv } from '../api/auditExport'
import TableSkeleton from '../components/TableSkeleton.vue'
import { useAuthStore } from '../stores/auth'
import { useAgentStore } from '../stores/agents'
import { useFeed, useInfiniteScroll } from '../lib/feed'
import { atShort } from '../lib/time'

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
  BUILD_CREATE: MapPin,
  BUILD_UPDATE: MapPin,
  BUILD_DELETE: Trash2,
  // A region is a box of world rather than a placed design, so it takes the pickaxe and the map
  // its jobs are drawn with rather than the placement pin.
  REGION_CREATE: Pickaxe,
  REGION_UPDATE: Pickaxe,
  REGION_DELETE: Trash2,
  BUILD_JOB_START: Hammer,
  BUILD_JOB_PAUSE: Pause,
  BUILD_JOB_RESUME: Play,
  BUILD_JOB_DELETE: Trash2,
  SCHEMATIC_UPLOAD: Upload,
  SCHEMATIC_RENAME: SquarePen,
  SCHEMATIC_DELETE: Trash2,
  AGENT_CREATE: Agent,
  AGENT_UPDATE: SquarePen,
  AGENT_DELETE: Trash2,
  AGENT_SETUP: KeyRound,
  AGENT_SETUP_CANCEL: KeyRound,
  AGENT_CONNECT: Power,
  AGENT_DISCONNECT: Power,
  AGENT_CHAT: MessageSquare,
  AGENT_INVENTORY: Backpack,
  AGENT_PATH: Footprints,
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
  STORAGE_PURGE: HardDrive,
  SESSION_REUSE_DETECTED: ShieldAlert,
  SESSION_REVOKED_ALL: ShieldCheck,
}

/**
 * Red is reserved for entries that change who can do what, or that destroy something: a token
 * rotation, a deletion, a role change. Everything else is routine operation, and colouring it all
 * alike would defeat the point of scanning.
 */
const ACTION_BADGE: Record<AuditAction, string> = {
  BUILD_CREATE: 'badge-ghost',
  BUILD_UPDATE: 'badge-ghost',
  // Takes the coordinates and the substitutions with it; making the plan again is not undoing this.
  BUILD_DELETE: 'badge-error badge-soft',
  REGION_CREATE: 'badge-ghost',
  REGION_UPDATE: 'badge-ghost',
  // Takes the corners with it; writing the region again is not undoing this.
  REGION_DELETE: 'badge-error badge-soft',
  // Putting agents to work is fleet operation, not destruction — and stopping them leaves
  // everything already placed standing, so neither is red.
  BUILD_JOB_START: 'badge-success badge-soft',
  BUILD_JOB_PAUSE: 'badge-ghost',
  BUILD_JOB_RESUME: 'badge-success badge-soft',
  // Takes the segments and their reported counts with it — though not the two entries above, which
  // are what makes clearing the record a tidy-up rather than a way to erase what the fleet did.
  BUILD_JOB_DELETE: 'badge-error badge-soft',
  SCHEMATIC_UPLOAD: 'badge-ghost',
  SCHEMATIC_RENAME: 'badge-ghost',
  // Takes the file, and with it every plan and every measure of progress computed from it.
  SCHEMATIC_DELETE: 'badge-error badge-soft',
  AGENT_CREATE: 'badge-ghost',
  AGENT_UPDATE: 'badge-ghost',
  AGENT_DELETE: 'badge-error badge-soft',
  AGENT_SETUP: 'badge-info badge-soft',
  // Ghost rather than info: nothing was done to the fleet, an operator stopped waiting on it.
  AGENT_SETUP_CANCEL: 'badge-ghost',
  AGENT_CONNECT: 'badge-success badge-soft',
  AGENT_DISCONNECT: 'badge-ghost',
  AGENT_CHAT: 'badge-warning badge-soft',
  // Warning rather than error: most of these are an item moved from one square to another, which
  // undoes by moving it back. A dropped stack does not, and the detail is where that shows.
  AGENT_INVENTORY: 'badge-warning badge-soft',
  // Ghost, like a disconnect. Sending an agent somewhere changes where it is standing and nothing
  // else - what it does when it gets there is whatever the operator does next, and that has its own
  // entry.
  AGENT_PATH: 'badge-ghost',
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
  // Red: records stop existing, and nothing else on this screen does that.
  STORAGE_PURGE: 'badge-error badge-soft',
  // Red, and the only entry here that nobody chose to cause: a session token was presented twice,
  // which means a copy of it exists somewhere it should not.
  SESSION_REUSE_DETECTED: 'badge-error badge-soft',
  // Not an incident: somebody deliberately ending their own sessions, which is the response to one.
  SESSION_REVOKED_ALL: 'badge-warning badge-soft',
}


const { t } = useI18n()

/** Wording lives with the rest of the copy; this is just the lookup. */
const actionLabel = (action: AuditAction) => t('auditAction.' + action)

/** Long enough to swallow a burst of typing, short enough not to feel like a submit button. */
const SEARCH_DEBOUNCE_MS = 250

const query = ref('')
const sentinel = ref<HTMLElement | null>(null)

/** What scrolls now that the page does not, which is what the sentinel has to be measured in. */
const scroller = ref<HTMLElement | null>(null)
let debounce: ReturnType<typeof setTimeout> | null = null

const feed = useFeed((cursor) => fetchAuditPage(cursor, query.value.trim()))
const scroll = useInfiniteScroll(sentinel, () => void loadMore(), scroller)

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

const exportDialog = ref<InstanceType<typeof ModalShell> | null>(null)

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

</script>

<template>
  <div class="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <h1 class="text-2xl font-semibold tracking-tight">{{ t('audit.title') }}</h1>
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

    <ModalShell ref="exportDialog" :title="t('audit.exportTitle')" :icon="Download">
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

      <AlertNote v-if="exportError" kind="error" class="mt-4" :message="exportError" />

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
    </ModalShell>

    <AlertNote v-if="error" kind="error" :message="error" />

    <!--
      The scroller, and the element the sentinel below is measured against. The page cannot
      scroll, so an observer left watching the viewport would see a sentinel that never arrives
      and stop paging entirely.
    -->
    <div class="card border-base-300 bg-base-200 min-h-0 overflow-hidden border">
      <div ref="scroller" class="h-full overflow-auto">
        <table class="table-pin-rows table">
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

          <TransitionGroup v-else name="rows" tag="tbody">
            <tr v-for="entry in entries" :key="entry.id" class="hover:bg-base-300/40">
              <td class="whitespace-nowrap text-sm opacity-70">{{ atShort(entry.at) }}</td>
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
          </TransitionGroup>
        </table>

        <!--
          An indicator rather than more skeleton rows: this is the tail of an infinite scroll, and
          a skeleton row here would be read as a real entry arriving rather than as a wait.
        -->
        <p v-if="loading && entries.length" class="py-10 text-center text-sm opacity-50">
          {{ t('common.loading') }}
        </p>
        <p v-else-if="loading" class="sr-only">{{ t('common.loading') }}</p>
        <p v-else-if="!entries.length && query.trim()" class="py-10 text-center text-sm opacity-50">
          {{ t('audit.noMatches') }}
        </p>
        <p v-else-if="!entries.length" class="py-10 text-center text-sm opacity-50">
          {{ t('audit.none') }}
        </p>
        <p v-else-if="exhausted && !error" class="py-10 text-center text-sm opacity-50">
          {{ t('audit.end') }}
        </p>

        <!--
          Watched by an IntersectionObserver: reaching it fetches the next page. Always rendered,
          so the element the observer holds never goes away underneath it. Inside the scroller,
          because that is what it is now measured against.
        -->
        <div ref="sentinel" aria-hidden="true" class="h-px"></div>
      </div>
    </div>

    <p class="text-xs opacity-50">
      {{ t('audit.retention') }}
    </p>
  </div>
</template>
