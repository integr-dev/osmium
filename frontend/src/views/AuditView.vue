<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import type { AuditEntryResponse } from '../api/client'
import { fetchAuditPage } from '../api/feeds'
import { useFeed, useInfiniteScroll } from '../lib/feed'

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

/** Long enough to swallow a burst of typing, short enough not to feel like a submit button. */
const SEARCH_DEBOUNCE_MS = 250

const query = ref('')
const sentinel = ref<HTMLElement | null>(null)
let debounce: ReturnType<typeof setTimeout> | null = null

const feed = useFeed((cursor) => fetchAuditPage(cursor, query.value.trim()))
const scroll = useInfiniteScroll(sentinel, () => void loadMore())

onMounted(async () => {
  await feed.reset()
  scroll.start()
})

onBeforeUnmount(() => {
  if (debounce) clearTimeout(debounce)
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
            <tr v-for="entry in entries" :key="entry.id" class="hover:bg-base-300/40">
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
