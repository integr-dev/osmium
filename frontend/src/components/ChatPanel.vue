<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { EyeOff, Search, Send, Server, TriangleAlert } from 'lucide-vue-next'
import PlayerHead from './PlayerHead.vue'
import McText from './McText.vue'

import type { ChatMessageResponse } from '../api/client'
import { fetchChatPage } from '../api/feeds'
import {
  agentBehind,
  agentsByAccount,
  belongsTo,
  foldRun,
  isSuppressed,
  scopeFilter,
  type ChatRow,
  type ChatScope,
  type ChatSuppressedRun,
} from '../lib/chat'
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

/**
 * What is being searched for, and what the feed is actually reading.
 *
 * Two refs rather than one: every keystroke would otherwise be a query. `searching` is what the
 * feed reads and only moves when the typing settles.
 */
const search = ref('')
const searching = ref('')

/**
 * Whether a search reaches past what is on screen.
 *
 * Off by default: the panel is showing one conversation, and a box above it is read as searching
 * that. Widening it is the deliberate act, because it answers a different question - a phrase
 * somebody half-remembers rarely comes with the server it was said on.
 */
const everywhere = ref(false)

const feed = useFeed<ChatRow>((cursor) =>
  fetchChatPage(
    cursor,
    searching.value && everywhere.value ? {} : scopeFilter(props.scope),
    searching.value,
  ),
)
const { items, loading, error, exhausted } = feed

/**
 * Past this many lines, the feed stops animating movement. See the note on the list itself.
 *
 * Chosen as "more than fills the panel": below it the animation is worth its cost and visible;
 * above it the lines that would slide are off screen, and measuring them is pure waste.
 */
const SETTLED_LINES = 150
const scroll = useInfiniteScroll(sentinel, () => void loadMore(), scrollBox)

// `start()` only after the box exists — the observer takes its root at construction, and a null one
// means the viewport, which would page in the whole feed the moment the panel appeared.
onMounted(async () => {
  await feed.reset()
  scroll.start()
})

/**
 * Typing settles before anything is asked for.
 *
 * Long enough that a name is typed rather than searched letter by letter, short enough that it
 * still feels like the box is answering.
 */
const SEARCH_SETTLES = 250
let pending: number | undefined

watch(search, (value) => {
  window.clearTimeout(pending)
  pending = window.setTimeout(() => void apply(value.trim()), SEARCH_SETTLES)
})

// Changing the reach re-asks the question. Only while one is being asked: toggling it against an
// empty box would reload the same conversation it is already showing.
watch(everywhere, () => {
  if (searching.value) void reload()
})

async function apply(value: string): Promise<void> {
  if (value === searching.value) return
  searching.value = value
  await reload()
}

async function reload(): Promise<void> {
  await feed.reset()
  await scroll.rearm()
}

/** What the host calls a line it could not attribute to a player. */
const SERVER_SENDER = 'server'

/**
 * Lines arriving faster than anybody is reading them.
 *
 * A backgrounded tab keeps its stream open and the browser holds the events; looking at it again
 * flushes the lot in one go, and a transcript that grows by thirty lines in a frame reads as a
 * glitch rather than as a conversation. This says which it was. It is about the **live** stream and
 * so is not `loading`, which is a fetch nobody triggered here.
 */
const catchingUp = ref(false)

/** Enough lines at once to be a flush rather than a conversation. */
const BURST = 3
/**
 * ...and going on long enough to be worth saying anything about.
 *
 * The count alone is not the question. Three lines land inside a second all the time on a busy
 * server - that is a conversation, and a spinner over it says something is wrong when nothing is.
 * What deserves a word is a flush that is still arriving after somebody has had time to notice it,
 * so the burst has to still be producing lines this long after it began.
 */
const BURST_SHOWS_AFTER_MS = 700
/** How long the stream has to go quiet before the burst is over. */
const BURST_QUIET_MS = 600

let arrived = 0
/** When the current burst began, for the delay above. */
let burstSince = 0
let settle: number | undefined

/**
 * Sending is fire and forget.
 *
 * There used to be a placeholder here: the line was drawn dimmed the moment the backend accepted
 * it, matched against the host's echo by text, and marked "not confirmed" if no echo arrived. It
 * cost a race with the echo, a grace timer, and a second copy of every line that overtook its own
 * placeholder — all to answer a question an operator can already answer by looking at the feed.
 *
 * A message appears when it is said, the same way everybody else's does, carrying the rank and the
 * colours the server put on it. That is the version worth reading, and waiting for it is the only
 * honest way to show it.
 */
/**
 * Ids for the gap rows, which the backend has none for because it stored nothing.
 *
 * Counting down from zero, so however long a panel is left open they can never meet a real line's.
 */
let nextRunId = 0

const stopListening = agentStore.onFeedEvent((name, data) => {
  if (name === 'chat-suppressed') {
    // A search is a question about the past, and a gap in the live stream is not part of the answer.
    if (searching.value) return

    const run = data as Omit<ChatSuppressedRun, 'id'>
    // Global chat only ever appears on a server feed, so a gap in it can only belong to one.
    if (props.scope.kind !== 'server' || run.serverAddress !== props.scope.address) return

    const fresh = foldRun(items.value, run, (nextRunId -= 1))
    if (fresh) feed.prepend(fresh)
    return
  }

  if (name !== 'chat') return
  const line = data as ChatMessageResponse
  // A search is a question about the past. Dropping new lines into the middle of its answer would
  // show something that does not match what was asked for.
  if (searching.value) return
  if (!belongsTo(line, props.scope)) return

  feed.prepend(line)

  arrived += 1
  if (arrived === 1) burstSince = Date.now()
  // Read on arrival rather than on a timer: if nothing more comes, the flush was over before it was
  // worth mentioning, and a pill that appears once the screen has already settled is noise.
  if (arrived >= BURST && Date.now() - burstSince >= BURST_SHOWS_AFTER_MS) catchingUp.value = true

  window.clearTimeout(settle)
  settle = window.setTimeout(() => {
    arrived = 0
    catchingUp.value = false
  }, BURST_QUIET_MS)
})

onBeforeUnmount(() => window.clearTimeout(pending))
onBeforeUnmount(() => {
  stopListening()
  window.clearTimeout(settle)
})

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

/** Every account the fleet plays, by account **and** server — see `agentsByAccount`. */
const fleetNames = computed(() => agentsByAccount(agentStore.agents))

/** The agent behind a line, when the account that said it is one of ours. */
function nameBehind(line: ChatMessageResponse): string | undefined {
  return agentBehind(line, fleetNames.value)
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
  <div class="relative flex min-h-0 flex-1 flex-col gap-2">
    <!--
      Searching is a question about everything the fleet ever heard, not a filter on what is on
      screen - so it says which of the two it is currently showing.
    -->
    <label class="input input-sm w-full gap-2">
      <Search class="size-4 shrink-0 opacity-40" />
      <input
        v-model="search"
        type="search"
        class="grow"
        :placeholder="t('chat.searchPlaceholder')"
        :aria-label="t('chat.searchPlaceholder')"
      />
    </label>

    <!-- Offered only while searching: with an empty box it would govern nothing. -->
    <label v-if="searching" class="flex cursor-pointer items-center gap-2 text-xs opacity-70">
      <input v-model="everywhere" type="checkbox" class="toggle toggle-xs" />
      <span>{{ everywhere ? t('chat.searchingEverywhere') : t('chat.searchingHere') }}</span>
    </label>

    <div v-if="error" role="alert" class="alert alert-error alert-soft">
      <TriangleAlert class="size-4" />
      <span>{{ error }}</span>
    </div>

    <!--
      The transcript, and the one thing that floats over it.
    -->
    <div class="relative flex min-h-0 flex-1 flex-col">
      <!--
        At the bottom, because that is where a new line arrives: the transcript is reversed, so the
        newest is the one nearest the composer. Over the transcript rather than in it, so a flush of
        thirty lines does not also move the conversation down by a row - and at this end rather than
        the top, where it sat over the search box and covered the very control somebody uses while
        catching up. Announced politely: it is reassurance about motion on screen, not something to
        interrupt a screen reader mid-line for.
      -->
      <Transition name="fade">
        <p
          v-if="catchingUp"
          role="status"
          aria-live="polite"
          class="bg-base-300/80 text-base-content/70 pointer-events-none absolute inset-x-0 bottom-0 z-10 mx-auto flex w-fit items-center gap-2 rounded-t-lg px-3 py-1 text-xs backdrop-blur"
        >
          <span class="loading loading-spinner loading-xs"></span>
          {{ t('chat.catchingUp') }}
        </p>
      </Transition>

      <div ref="scrollBox" class="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
        <!--
          Reversed a second time inside, so the newest line is the first one the eye meets coming up
          off the send box. Insertions animate and the first render does not; see the dashboard for
          the full note.
        -->
        <!--
          The move transition is dropped once the feed is long, which is why `name` is bound.

          `TransitionGroup` animates reordering with FLIP: on every change it measures the position of
          **every** child, applies the update, measures them all again, and transforms the difference.
          That is a forced synchronous layout over the whole list, per line received - so a panel left
          open on a busy server spends longer blocking the main thread with each message that arrives,
          which is felt everywhere, including as a stutter in the 3D viewer on another screen.

          Vue only takes that path when a `-move` class actually exists, so an empty name skips it
          outright. A line still fades in; what it stops doing is sliding the thousand lines beneath
          it, which nobody can see in a scrolling panel anyway.
        -->
        <TransitionGroup :name="items.length > SETTLED_LINES ? '' : 'feed'" tag="div" class="flex flex-col-reverse gap-1">
          <template v-for="line in items" :key="line.id">
            <!--
              A gap, drawn as one row that grows rather than as the lines it stands for — which is
              the point, since those were refused precisely so they would not be kept. Dimmed and
              italic because nobody said it: it is the panel talking, not the server.
            -->
            <p v-if="isSuppressed(line)" class="flex items-center gap-2 px-1 text-xs italic opacity-40">
              <span class="shrink-0 font-mono">{{ atTime(line.at) }}</span>
              <EyeOff class="size-3.5 shrink-0" />
              <span class="min-w-0 flex-1 break-words">
                {{
                  line.from
                    ? t('chat.suppressedFrom', { count: line.count, name: line.from })
                    : t('chat.suppressed', { count: line.count })
                }}
              </span>
            </p>
            <p v-else class="flex items-start gap-2 px-1 text-sm">
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
              <span v-if="nameBehind(line)" class="shrink-0 pt-0.5 font-mono text-xs text-primary/70">
                {{ nameBehind(line) }}
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
          </template>
        </TransitionGroup>

        <!--
          A first page and an older one are different waits and read differently. Switching servers
          empties the panel and fetches a whole transcript, which takes long enough that a single
          centred word looked like a blank panel — so it stands in for the lines it is about to
          replace. Paging older keeps the one line, because the conversation is still on screen and
          the wait happens off the top edge.
        -->
        <div v-if="loading && !items.length" class="flex flex-col-reverse gap-2 py-2" aria-busy="true">
          <div v-for="row in 8" :key="row" class="flex items-start gap-2 px-1">
            <div class="skeleton h-3 w-10 shrink-0"></div>
            <div class="skeleton size-4 shrink-0 rounded"></div>
            <div class="skeleton h-3 shrink-0" :style="{ width: `${3 + ((row * 7) % 5)}rem` }"></div>
            <div class="skeleton h-3 flex-1" :style="{ maxWidth: `${8 + ((row * 11) % 13)}rem` }"></div>
          </div>
        </div>
        <p v-else-if="loading" class="flex items-center justify-center gap-2 py-6 text-sm opacity-50">
          <span class="loading loading-spinner loading-xs"></span>
          {{ t('common.loading') }}
        </p>
        <p v-else-if="!items.length" class="py-10 text-center text-sm opacity-50">
          {{ t('dashboard.noChat') }}
        </p>

        <!-- Reaching this fetches the next, older page. See src/lib/feed.ts. -->
        <div ref="sentinel" aria-hidden="true" class="h-px shrink-0"></div>
      </div>
    </div>

    <div v-if="auth.can('chat.speak')" class="flex flex-col gap-1">
      <!--
        Whoever is about to speak, named directly above the box that will say it. Filled by the rail,
        which owns the scope and the choice; this only decides where it belongs, and that is beside
        the act rather than at the top of a transcript it says nothing about.
      -->
      <slot name="speaker" />

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
