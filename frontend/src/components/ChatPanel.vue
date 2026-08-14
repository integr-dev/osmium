<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Send, TriangleAlert } from 'lucide-vue-next'
import PlayerHead from './PlayerHead.vue'
import type { ChatMessageResponse } from '../api/client'
import { fetchChatPage } from '../api/feeds'
import { belongsTo, scopeFilter, scopeKey, type ChatScope } from '../lib/chat'
import { useFeed, useInfiniteScroll } from '../lib/feed'
import { isOnline, useAgentStore, type FleetAgent } from '../stores/agents'
import { useAuthStore } from '../stores/auth'

/**
 * One conversation: the lines, and the box that adds to them.
 *
 * Bottom-anchored, unlike the audit and activity feeds. Those are logs being read, where downwards
 * means older and the newest belongs at the top. This one has a send box under it, which makes it a
 * conversation — and a conversation whose newest line is nowhere near the box you type into is one
 * nobody can follow.
 *
 * `flex-col-reverse` buys that for nothing: the array stays newest-first exactly as every other feed
 * is, the browser pins the view to the bottom as lines arrive, and the "older" sentinel ends up
 * visually at the top without `useInfiniteScroll` knowing anything changed.
 *
 * The panel does not size itself. The rail gives it a column and the agent page gives it a card, and
 * either way the scroll box takes what is left.
 */
const props = defineProps<{ scope: ChatScope; speaker: FleetAgent | null }>()

const { t } = useI18n()
const auth = useAuthStore()
const agentStore = useAgentStore()

const scrollBox = ref<HTMLElement | null>(null)
const sentinel = ref<HTMLElement | null>(null)
const message = ref('')
const sending = ref(false)
const sendError = ref<string | null>(null)

const feed = useFeed<ChatMessageResponse>((cursor) => fetchChatPage(cursor, scopeFilter(props.scope)))
const { items, loading, error, exhausted } = feed
const scroll = useInfiniteScroll(sentinel, () => void loadMore(), scrollBox)

// `start()` only after the box exists — the observer takes its root at construction, and a null one
// means the viewport, which would page in the whole feed the moment the panel appeared.
onMounted(async () => {
  await feed.reset()
  scroll.start()
})

// Keyed on the scope's identity rather than the object, so a parent rebuilding an equivalent scope
// does not throw away the page it is already showing. Re-arms rather than starting again: the
// sentinel is the same element, and a second observer on it would never be disconnected.
watch(
  () => scopeKey(props.scope),
  async () => {
    await feed.reset()
    await scroll.rearm()
  },
)

const stopListening = agentStore.onFeedEvent((name, data) => {
  if (name !== 'chat') return
  const line = data as ChatMessageResponse
  if (belongsTo(line, props.scope)) feed.prepend(line)
})

onBeforeUnmount(stopListening)

async function loadMore(): Promise<void> {
  await feed.more()
  if (!exhausted.value) await scroll.rearm()
}

/**
 * Why the box is shut, or null when it is not.
 *
 * Every one of these would come back a 409 or a 503. Saying which in advance is the difference
 * between a disabled field and a disabled field that explains itself.
 */
const blocked = computed(() => {
  if (!props.speaker) return t('chat.noSpeaker')
  if (!isOnline(props.speaker)) return t('chat.speakerOffline', { name: props.speaker.label })
  const host = agentStore.hostById(props.speaker.hostId)
  if (host?.reachable !== true) return t('chat.hostOffline', { host: props.speaker.hostName })
  return null
})

async function send(): Promise<void> {
  if (!props.speaker || !message.value.trim()) return
  sending.value = true
  sendError.value = null
  try {
    await agentStore.say(props.speaker.id, message.value)
    message.value = ''
  } catch (failure) {
    sendError.value = failure instanceof Error ? failure.message : t('errors.sendMessage')
  } finally {
    sending.value = false
  }
}

/** Time only: chat is kept three days, so the clock is what locates a line. */
function formatAt(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <div v-if="error" role="alert" class="alert alert-error alert-soft">
      <TriangleAlert class="size-4" />
      <span>{{ error }}</span>
    </div>

    <div ref="scrollBox" class="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
      <!--
        Reversed a second time inside, so the newest line is the first one the eye meets coming up
        off the send box. Insertions animate and the first render does not; see the dashboard for
        the full note.
      -->
      <TransitionGroup name="feed" tag="div" class="flex flex-col-reverse gap-1">
        <p v-for="line in items" :key="line.id" class="flex items-start gap-2 px-1 text-sm">
          <span class="shrink-0 pt-0.5 font-mono text-xs opacity-40">{{ formatAt(line.at) }}</span>
          <!--
            Global chat is where strangers show up, so a head is not decoration — it is how a player
            nobody recognises is told apart from an agent at a glance.
          -->
          <PlayerHead :id="line.from" :name="line.from" size="xs" class="mt-0.5 shrink-0" />
          <!-- What we said, rather than what was said to us. The one line in the feed we caused. -->
          <span class="shrink-0 font-medium" :class="line.scope === 'OUTBOUND' ? 'text-primary' : ''">
            {{ line.from }}
          </span>
          <span class="min-w-0 flex-1 break-words opacity-80">{{ line.text }}</span>
        </p>
      </TransitionGroup>

      <p v-if="loading" class="py-4 text-center text-sm opacity-50">{{ t('common.loading') }}</p>
      <p v-else-if="!items.length" class="py-10 text-center text-sm opacity-50">
        {{ t('dashboard.noChat') }}
      </p>

      <!-- Reaching this fetches the next, older page. See src/lib/feed.ts. -->
      <div ref="sentinel" aria-hidden="true" class="h-px shrink-0"></div>
    </div>

    <div v-if="auth.can('chat.speak')" class="flex flex-col gap-1">
      <div v-if="sendError" role="alert" class="alert alert-error alert-soft py-2">
        <TriangleAlert class="size-4" />
        <span>{{ sendError }}</span>
      </div>

      <form class="flex gap-2" @submit.prevent="send">
        <input
          v-model="message"
          class="input input-sm w-full"
          type="text"
          :placeholder="t('agents.chatPlaceholder')"
          :disabled="sending || blocked !== null"
        />
        <button
          class="btn btn-primary btn-sm btn-square"
          type="submit"
          :aria-label="t('agents.send')"
          :disabled="sending || blocked !== null || !message.trim()"
        >
          <Send class="size-4" />
        </button>
      </form>

      <p v-if="blocked" class="px-1 text-xs opacity-50">{{ blocked }}</p>
    </div>
  </div>
</template>
