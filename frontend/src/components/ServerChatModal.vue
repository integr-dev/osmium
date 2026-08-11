<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessagesSquare, TriangleAlert } from 'lucide-vue-next'
import PlayerHead from './PlayerHead.vue'
import type { ChatMessageResponse } from '../api/client'
import { fetchChatPage } from '../api/feeds'
import { useFeed, useInfiniteScroll } from '../lib/feed'
import { useAgentStore } from '../stores/agents'
import type { ServerSummary } from '../stores/agents'

/**
 * One server's global chat.
 *
 * Newest first, like the audit and activity feeds, rather than the bottom-anchored window a chat
 * client uses. This is a log being read, not a conversation being held — and reading downwards means
 * older, which is the same gesture everywhere else in the app.
 */
const props = defineProps<{ server: ServerSummary | null }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const agentStore = useAgentStore()

const dialog = ref<HTMLDialogElement | null>(null)
const scrollBox = ref<HTMLElement | null>(null)
const sentinel = ref<HTMLElement | null>(null)

const feed = useFeed<ChatMessageResponse>((cursor) =>
  fetchChatPage(cursor, { server: props.server?.address ?? '' }),
)
const { items, loading, error, exhausted } = feed
const scroll = useInfiniteScroll(sentinel, () => void loadMore(), scrollBox)

let stopListening: (() => void) | null = null

watch(
  () => props.server,
  async (server) => {
    if (!server) {
      dialog.value?.close()
      stopListening?.()
      stopListening = null
      return
    }

    dialog.value?.showModal()
    await feed.reset()
    scroll.start()

    // A line arriving while the modal is open belongs at the top, where the newest already is.
    stopListening = agentStore.onFeedEvent((name, data) => {
      if (name !== 'chat') return
      const line = data as ChatMessageResponse
      if (line.serverAddress === server.address && line.scope === 'GLOBAL') feed.prepend(line)
    })
  },
)

onBeforeUnmount(() => stopListening?.())

async function loadMore(): Promise<void> {
  await feed.more()
  if (!exhausted.value) await scroll.rearm()
}

/** Time only: everything in the box happened within the last three days. */
function formatAt(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <dialog ref="dialog" class="modal" @close="emit('close')">
    <div class="modal-box max-w-2xl">
      <h3 class="flex items-center gap-2 text-lg font-semibold">
        <MessagesSquare class="text-primary size-5" />
        {{ t('servers.chatTitle') }}
      </h3>
      <p class="mt-1 font-mono text-xs opacity-60">{{ server?.address }}</p>

      <p v-if="server && !server.listener" class="mt-3 flex items-center gap-2 text-sm opacity-60">
        <TriangleAlert class="text-warning size-4 shrink-0" />
        {{ t('servers.noListener') }}
      </p>
      <p v-else class="mt-3 text-xs opacity-50">
        {{ t('servers.via', { name: server?.listener?.label ?? '' }) }}
      </p>

      <div v-if="error" role="alert" class="alert alert-error alert-soft mt-3">
        <TriangleAlert class="size-4" />
        <span>{{ error }}</span>
      </div>

      <div ref="scrollBox" class="mt-3 flex max-h-96 flex-col gap-1 overflow-y-auto">
        <!--
          Global chat is where strangers show up, so a head is not decoration here — it is how a
          player nobody recognises is told apart from an agent at a glance. Insertions animate and
          the first render does not; see the dashboard for the full note.
        -->
        <TransitionGroup name="feed" tag="div" class="flex flex-col gap-1">
          <p v-for="line in items" :key="line.id" class="flex items-center gap-2 text-sm">
            <span class="shrink-0 font-mono text-xs opacity-40">{{ formatAt(line.at) }}</span>
            <PlayerHead :id="line.from" :name="line.from" size="xs" />
            <span class="shrink-0 font-medium">{{ line.from }}</span>
            <span class="min-w-0 flex-1 opacity-70">{{ line.text }}</span>
          </p>
        </TransitionGroup>

        <p v-if="loading" class="py-6 text-center text-sm opacity-50">{{ t('common.loading') }}</p>
        <p v-else-if="!items.length" class="py-10 text-center text-sm opacity-50">
          {{ t('dashboard.noChat') }}
        </p>

        <!-- Reaching this fetches the next, older page. See src/lib/feed.ts. -->
        <div ref="sentinel" aria-hidden="true" class="h-px shrink-0"></div>
      </div>

      <div class="modal-action">
        <button class="btn btn-sm" @click="dialog?.close()">{{ t('common.close') }}</button>
      </div>
    </div>

    <form method="dialog" class="modal-backdrop">
      <button>{{ t('common.close') }}</button>
    </form>
  </dialog>
</template>
