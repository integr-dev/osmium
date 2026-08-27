<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock, Send, Server, TriangleAlert } from 'lucide-vue-next'
import PlayerHead from './PlayerHead.vue'
import McText from './McText.vue'

import type { ChatMessageResponse } from '../api/client'
import { fetchChatPage } from '../api/feeds'
import { belongsTo, scopeFilter, scopeKey, type ChatScope } from '../lib/chat'
import { useFeed, useInfiniteScroll } from '../lib/feed'
import { isOnline, useAgentStore, type FleetAgent } from '../stores/agents'
import { useAuthStore } from '../stores/auth'
import { atTime } from '../lib/time'

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

/**
 * Lines sent from here that the host has not echoed back yet.
 *
 * Sending cleared the box on a 2xx and put nothing anywhere. But a 2xx only means the backend
 * accepted the message for delivery — the line enters the transcript when the host echoes it, which
 * is a round trip through a Minecraft server away. In between, the message was simply gone from the
 * screen; and if the host dropped it, gone for good with nothing ever saying so.
 *
 * So it is shown immediately, marked as unconfirmed, and either replaced by the real line or —
 * after [ECHO_GRACE_MS] — marked as never having arrived. What is never done is claim it was said.
 */
interface PendingLine {
  key: number
  text: string
  at: string
  stalled: boolean
}

const pending = ref<PendingLine[]>([])

/** Local identity only. The backend's id arrives with the echo, by which point this line is gone. */
let nextKey = 0

/**
 * Echoes that arrived before the send they belong to had come back.
 *
 * The placeholder is added once the backend has accepted the message — deliberately, see above —
 * and the host can beat that. It goes to the host over a socket that is already open, into the
 * game and back onto the feed while the POST is still in flight; on a local host that round trip
 * is a few milliseconds and the POST is not. The echo then found nothing to retire, the
 * placeholder was added behind it, and the transcript showed the line twice — once said, once
 * sending — until the grace ran out and the second copy accused the first of never arriving.
 *
 * So an unmatched echo is remembered instead, and the send it belongs to skips its placeholder.
 * Matched on text like the other direction, because there is still no id in common at this point.
 */
let overtook: Array<{ text: string; at: number }> = []

/**
 * How long the host gets to echo before the line is called into question.
 *
 * A message goes to the host, into Minecraft, and comes back on the chat feed. Several seconds is
 * ordinary; ten is not, and quietly waiting forever is what this exists to stop.
 */
const ECHO_GRACE_MS = 10_000

/** What the host calls a line it could not attribute to a player. */
const SERVER_SENDER = 'server'

const stopListening = agentStore.onFeedEvent((name, data) => {
  if (name !== 'chat') return
  const line = data as ChatMessageResponse
  if (!belongsTo(line, props.scope)) return

  // The echo of something sent from here retires its placeholder. Matched on the text of the
  // oldest unconfirmed line rather than on an id, because the two have no id in common: the
  // backend mints one when the host reports the line, long after this was drawn.
  if (line.scope === 'OUTBOUND') {
    // Contained rather than equal. What comes back is the server's rendering of the line — a rank,
    // a colour, `<Name>` in front — and only the words that were typed survive inside it.
    const at = pending.value.findIndex((entry) => line.text.includes(entry.text))
    if (at !== -1) pending.value = pending.value.filter((_, index) => index !== at)
    else overtook.push({ text: line.text, at: Date.now() })
  }

  feed.prepend(line)
})

// A pending line belongs to the conversation it was sent into. Carried across a scope change it
// would appear under somebody else's transcript as though it had been said there.
watch(() => scopeKey(props.scope), () => {
  pending.value = []
  overtook = []
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
  // The field stays enabled while a message is in flight, so this is what stops a fast second Enter
  // from sending the same line twice - the box is not cleared until the first one comes back.
  if (sending.value) return
  if (!props.speaker || !message.value.trim()) return

  const text = message.value.trim()
  sending.value = true
  sendError.value = null

  try {
    await agentStore.say(props.speaker.id, text)
    message.value = ''

    // Nothing to wait for: the echo of this very message is already on the transcript.
    const now = Date.now()
    overtook = overtook.filter((echo) => now - echo.at < ECHO_GRACE_MS)
    const raced = overtook.findIndex((echo) => echo.text.includes(text))
    if (raced !== -1) {
      overtook.splice(raced, 1)
      return
    }

    // Only once the backend has accepted it. Drawn before the request, a refused message would
    // have appeared in the transcript and then vanished, which is worse than never showing it.
    const entry: PendingLine = { key: nextKey++, text, at: new Date().toISOString(), stalled: false }
    pending.value = [entry, ...pending.value]

    window.setTimeout(() => {
      const waiting = pending.value.find((line) => line.key === entry.key)
      if (waiting) waiting.stalled = true
    }, ECHO_GRACE_MS)
  } catch (failure) {
    sendError.value = failure instanceof Error ? failure.message : t('errors.sendMessage')
  } finally {
    sending.value = false
  }
}

/**
 * Whether to name the agent beside a line. See the template: only on a server feed, and only for
 * lines that are not the public channel.
 */
/**
 * Whether a line is the server talking rather than a player.
 *
 * The host says so by naming the sender , which it uses for anything it could not read a
 * player out of - join notices, command output, a formatter it does not have a pattern for. It is a
 * reserved name: Mojang does not allow one that short to be taken in mixed case, and a line really
 * from a player called that would only be mislabelled, never misattributed.
 */
function fromServer(line: ChatMessageResponse): boolean {
  return line.from === SERVER_SENDER
}

/**
 * Every Minecraft account the fleet plays, by name, pointing at the agent that plays it.
 *
 * Chat names an account; an operator thinks in agents. The two are the same thing seen from either
 * end of the setup, and this is the only place that can join them — a host reports who spoke, and
 * has no idea which of Osmium's agents that is.
 *
 * Lower-cased, because Minecraft compares names that way and a formatter may not preserve the case
 * the account was registered with.
 */
const fleetNames = computed(() => {
  const named = new Map<string, string>()

  for (const agent of agentStore.agents) {
    if (agent.mcUsername) named.set(agent.mcUsername.toLowerCase(), agent.label)
  }

  return named
})

/** The agent behind a line, when the account that said it is one of ours. */
function agentBehind(line: ChatMessageResponse): string | undefined {
  return fleetNames.value.get(line.from.toLowerCase())
}

/**
 * How many of the fleet's agents are on the server this panel is showing.
 *
 * Decides whether naming one adds anything: a server running a single agent has only one thing
 * "me" can refer to.
 */
const agentsHere = computed(() => {
  // Taken into a local so the narrowing survives into the callback.
  const scope = props.scope
  if (scope.kind !== 'server') return 0

  return agentStore.agents.filter((agent) => agent.serverAddress === scope.address).length
})

function involvesAgent(line: ChatMessageResponse): boolean {
  // Not on our own lines. The question this answers is "who was this to", which a whisper or a
  // proximity line raises and an outbound one does not — there the speaker is already the head and
  // the server's own rendering of the line, so the label only repeats it.
  //
  // And only where it distinguishes something. A whisper renders as "… -> me", which needs a name
  // put to it exactly when more than one agent could be "me"; on a server running one, the label is
  // the same word on every private line.
  return (
    props.scope.kind === 'server' &&
    agentsHere.value > 1 &&
    line.scope !== 'GLOBAL' &&
    line.scope !== 'OUTBOUND'
  )
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
        <!--
          Unconfirmed lines, newest-first like everything else, and therefore first in the reversed
          column. Dimmed and marked rather than drawn as ordinary chat: the point is that the host
          has not said this was said, and rendering it identically would be claiming that it was.
        -->
        <p
          v-for="line in pending"
          :key="`pending-${line.key}`"
          class="flex items-start gap-2 px-1 text-sm"
        >
          <span class="shrink-0 pt-0.5 font-mono text-xs opacity-40">{{ atTime(line.at) }}</span>
          <component
            :is="line.stalled ? TriangleAlert : Clock"
            class="mt-1 size-3.5 shrink-0"
            :class="line.stalled ? 'text-warning' : 'opacity-40'"
          />
          <span class="min-w-0 flex-1 break-words italic opacity-50">{{ line.text }}</span>
          <span
            class="shrink-0 pt-0.5 text-xs"
            :class="line.stalled ? 'text-warning' : 'opacity-40'"
          >
            {{ line.stalled ? t('chat.notEchoed') : t('chat.sending') }}
          </span>
        </p>

        <p v-for="line in items" :key="line.id" class="flex items-start gap-2 px-1 text-sm">
          <span class="shrink-0 pt-0.5 font-mono text-xs opacity-40">{{ atTime(line.at) }}</span>
          <!--
            Global chat is where strangers show up, so a head is not decoration — it is how a player
            nobody recognises is told apart from an agent at a glance. A line the host could not
            attribute to anybody gets a server mark instead of a face nobody owns.
          -->
          <Server v-if="fromServer(line)" class="mt-1 size-3.5 shrink-0 opacity-40" />
          <PlayerHead v-else :id="line.from" :name="line.from" size="xs" class="mt-0.5 shrink-0" />
          <!--
            The agent behind the account, when the account is one of ours. Chat names a Minecraft
            account and an operator thinks in agents, so a line from the fleet says which one — and
            it comes first, because that is the name the operator gave it and the one they are
            looking for.
          -->
          <span v-if="agentBehind(line)" class="shrink-0 pt-0.5 font-mono text-xs text-primary/70">
            {{ agentBehind(line) }}
          </span>
          <!--
            The account name, but only when the line does not already carry one. A server-rendered
            line comes with its own prefix — rank, colours, the speaker — so printing `from` beside it
            would say the name twice, once ours and once theirs.
          -->
          <span
            v-if="!line.components"
            class="shrink-0 font-medium"
            :class="[line.scope === 'OUTBOUND' ? 'text-primary' : '', fromServer(line) ? 'italic opacity-60' : '']"
          >
            {{ fromServer(line) ? t('chat.fromServer') : line.from }}
          </span>
          <!--
            Which agent a line involves, on a server feed only. Everything said on the server is
            here, so a whisper to one agent would otherwise be indistinguishable from public chat -
            and "who was this to" is the whole question a private line raises. On an agent feed it
            would be the same name on every row.
          -->
          <span v-if="involvesAgent(line)" class="shrink-0 pt-0.5 font-mono text-xs opacity-40">
            {{ line.agentLabel }}
          </span>
          <!--
            Styled as the server sent it, falling back to the plain line. A host may send no tree at
            all - anything an agent said itself has none - so the plain text is what is always there.
          -->
          <McText :components="line.components" :text="line.text" class="min-w-0 flex-1 break-words opacity-80" />
        </p>
      </TransitionGroup>

      <p v-if="loading" class="py-10 text-center text-sm opacity-50">{{ t('common.loading') }}</p>
      <p v-else-if="!items.length && !pending.length" class="py-10 text-center text-sm opacity-50">
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
        <!--
          Disabled only when the box is shut, never merely while a message is in flight. Disabling
          an input blurs it, and re-enabling does not give the focus back — so every send dropped
          the operator out of the field they were typing in, mid-conversation. The button still
          goes dead while sending; the field stays live and ready for the next line.
        -->
        <input
          v-model="message"
          class="input input-sm w-full"
          type="text"
          :placeholder="t('agents.chatPlaceholder')"
          :disabled="blocked !== null"
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
