<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { EyeOff, Search, Send, Server } from 'lucide-vue-next'
import AlertNote from './AlertNote.vue'
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
import { atTime, dayKey, onDay } from '../lib/time'

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

const { t, locale } = useI18n()
const auth = useAuthStore()
const agentStore = useAgentStore()

const scrollBox = ref<HTMLElement | null>(null)
const sentinel = ref<HTMLElement | null>(null)
const message = ref('')
const sending = ref(false)
const sendError = ref<string | null>(null)

/**
 * What the feed is actually reading.
 *
 * **Nothing here holds what is being typed**, and that is the point. `searching` only moves when
 * the typing settles, so a query is not sent per keystroke - but a ref bound to the box with
 * `v-model` is read by this template, and this template draws the whole transcript. Every
 * character therefore re-ran the render over every line in the panel: the debounce was holding
 * back the request while the expensive half went ahead anyway.
 *
 * The feed is paged in at a hundred lines a time and never trimmed, so a session that has
 * scrolled has thousands of rows, each with a head and a rendered line. Typing into a box above
 * that was re-diffing all of them between keystrokes.
 *
 * So the box keeps its own value, as an ordinary uncontrolled input does, and nothing it holds is
 * reactive until it settles. See {@link onTyped}.
 */
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
  await repin()
})

/** Re-reads which day is at the top, once the lines that decide it are on the page. */
async function repin(): Promise<void> {
  await nextTick()
  onScrolled()
}

/**
 * Typing settles before anything is asked for.
 *
 * Long enough that a name is typed rather than searched letter by letter, short enough that it
 * still feels like the box is answering.
 */
const SEARCH_SETTLES = 250
let pending: number | undefined

/**
 * Whether the box is waiting on something - either still settling, or out asking.
 *
 * **The one reactive thing a keystroke touches, and it only moves twice.** Writing the same value
 * to a ref is not a change, so this goes false to true on the first character of a search and
 * back again when the answer lands; everything between is free. That is what keeps the
 * transcript out of it - see {@link searching}.
 */
const looking = ref(false)

/**
 * A keystroke, read off the element rather than out of a ref.
 *
 * The value is taken from the event and held in a closure, so nothing this template renders from
 * has changed and the transcript below is left alone until there is an answer to show.
 */
function onTyped(event: Event): void {
  const typed = (event.target as HTMLInputElement).value

  looking.value = true
  window.clearTimeout(pending)
  pending = window.setTimeout(() => void apply(typed.trim()), SEARCH_SETTLES)
}

// Changing the reach re-asks the question. Only while one is being asked: toggling it against an
// empty box would reload the same conversation it is already showing.
watch(everywhere, () => {
  if (searching.value) void reload()
})

async function apply(value: string): Promise<void> {
  // Cleared whatever happens, including on the path that has nothing to do: typing a word and
  // deleting it again settles back to where it started and must not leave the box spinning.
  try {
    if (value === searching.value) return
    searching.value = value
    await reload()
  } finally {
    looking.value = false
  }
}

async function reload(): Promise<void> {
  await feed.reset()
  await scroll.rearm()
  await repin()
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
  await repin()
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
    // Kept only once it has gone. A line the backend refused is still in the box, and recalling it
    // would put a second copy of it there.
    sent.value = text
    message.value = ''
  } catch (failure) {
    sendError.value = failure instanceof Error ? failure.message : t('errors.sendMessage')
  } finally {
    sending.value = false
  }
}

/**
 * The last line this panel actually sent, for Up to bring back.
 *
 * One line rather than a history. What Up is for is the message you just sent and want to send
 * again, or the one you sent with a typo in it - and a stack of them needs Down, an index, and a
 * decision about what typing halfway through the stack means. In the panel, and not persisted:
 * recalling a line into a different conversation than the one it was said in is a way to say
 * something in the wrong room.
 */
const sent = ref('')

/**
 * Up recalls it; Down clears the box again.
 *
 * Only from an empty box. A line half typed is worth more than the last one, and losing it to a
 * stray arrow key is the kind of small theft an interface should not commit — the caret moves to
 * the start of a single-line input on Up, so somebody editing a long message presses it on purpose.
 */
function recall(event: KeyboardEvent): void {
  if (message.value !== '' || !sent.value) return

  event.preventDefault()
  message.value = sent.value
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

/**
 * Everything a row of the transcript is drawn from, for `v-memo`.
 *
 * **A line arriving used to redraw every line already there.** The feed is a list, a new line is a new
 * list, and the template walks all of it - so a busy server re-rendered the whole transcript once per
 * message, and the transcript is paged in a hundred lines at a time and never trimmed. A row whose
 * inputs have not changed is now skipped outright, so the work a new line does is the work of drawing
 * one line.
 *
 * **On the element that carries the `v-for`**, which is a wrapper around the row and the day rule above
 * it, because that is the only place `v-memo` means anything. Set on the row inside the loop it is not
 * a memo at all - Vue ignores it there, and the linter says so - which is how the first go at this
 * changed nothing. Whether a row opens a day is on the list for the same reason the rule is inside
 * the wrapper.
 *
 * The list is short and exact, because anything left off it is something a row stops updating for. A
 * spoken line never changes once it has arrived, so its id stands for its text, sender and time; what
 * can still move is who in the fleet an account belongs to, whether the server has more than one agent
 * to tell apart, and the language. A gap row is rewritten in place as more is suppressed into it - see
 * `foldRun` - so its count, time and name are on the list as well.
 */
function drawnFrom(line: ChatRow, at: number): unknown[] {
  const seam = opensDay(at)

  return isSuppressed(line)
    ? [line.id, line.at, line.count, line.from, seam, locale.value]
    : [line.id, line.at, seam, fleetNames.value, agentsHere.value, locale.value]
}

/**
 * Whether a line is the first of its day, reading the transcript downwards.
 *
 * `items` runs newest first, so the line after this one in the list is the one before it in time.
 * A day opens where the two fall on different dates.
 *
 * The oldest line loaded never opens one, even though it always begins *some* day: there is more
 * above it that has not been fetched, and a rule drawn there would be claiming a seam that the
 * next page is about to move.
 */
/**
 * The day showing at the top of the transcript, or null when none is worth naming.
 *
 * Read off the rules themselves rather than worked out from the scroll position: they are the
 * elements that know where a day begins, and there are only ever a handful of them - one a day -
 * so measuring the lot on a scroll costs nothing. Measuring the *lines* would be the same mistake
 * this panel has already made once, with thousands of them.
 */
const pinned = ref<string | null>(null)

let framed = 0

/**
 * Works out which day the top of the view is inside.
 *
 * The rule for a day sits directly above that day's first line, so the day being read is the one
 * whose rule is nearest the top edge without having passed below it. Scrolled back far enough that
 * no rule is above the edge, there is nothing to pin: what is up there is the oldest page loaded,
 * whose own rule has not been fetched yet.
 *
 * Coalesced onto a frame, because a scroll fires far more often than one and each pass reads
 * layout.
 */
function onScrolled(): void {
  if (framed) return

  framed = requestAnimationFrame(() => {
    framed = 0

    const box = scrollBox.value
    if (!box) return

    const edge = box.getBoundingClientRect().top
    let nearest: string | null = null
    let above = -Infinity

    for (const rule of box.querySelectorAll<HTMLElement>('[data-day]')) {
      const top = rule.getBoundingClientRect().top
      if (top > edge || top <= above) continue

      above = top
      nearest = rule.dataset.day ?? null
    }

    /*
     * **The oldest line loaded, when no rule is above the edge.**
     *
     * Two ways that happens and both want the same answer. A transcript that has not yet reached
     * back past a midnight has no boundary in it at all, so there is no rule to find - and that is
     * the ordinary case, a panel opened on a busy afternoon, where the label was simply never drawn.
     * Scrolled up past every rule is the same question again: what is up there is the oldest page,
     * whose own rule belongs to a day that has not been fetched.
     *
     * The list runs newest first, so its last entry is the line at the top of the view.
     */
    const oldest = items.value[items.value.length - 1]

    pinned.value = nearest ?? (oldest ? onDay(oldest.at) : null)
  })
}

onBeforeUnmount(() => cancelAnimationFrame(framed))

function opensDay(at: number): boolean {
  const line = items.value[at]
  const before = items.value[at + 1]
  if (!line || !before) return false

  return dayKey(line.at) !== dayKey(before.at)
}

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
      <!--
        Deliberately unbound. The element keeps what is typed on its own, which is all that is
        wanted here - binding it would make every character a render of the transcript below. The
        native clear on a `search` input fires `input` like any other edit, so it settles too.
      -->
      <input
        type="search"
        class="grow"
        :placeholder="t('chat.searchPlaceholder')"
        :aria-label="t('chat.searchPlaceholder')"
        @input="onTyped"
      />
      <!--
        In the box rather than over the transcript, because it is the box that is busy: the lines
        below are still the last answer until a new one arrives, and dropping a spinner on them
        would say they had gone when they have not.
      -->
      <span v-if="looking" class="loading loading-spinner loading-xs shrink-0 opacity-40"></span>
    </label>

    <!-- Offered only while searching: with an empty box it would govern nothing. -->
    <label v-if="searching" class="flex cursor-pointer items-center gap-2 text-xs opacity-70">
      <input v-model="everywhere" type="checkbox" class="toggle toggle-xs" />
      <span>{{ everywhere ? t('chat.searchingEverywhere') : t('chat.searchingHere') }}</span>
    </label>

    <AlertNote v-if="error" kind="error" :message="error" />

    <div class="relative flex min-h-0 flex-1 flex-col">
      <!--
        **The day being read, held at the top of the transcript.**

        Over the lines rather than among them - the rules themselves are in the flow, and this is
        the one that has scrolled off. Not a pointer target: it names what is behind it, and
        swallowing a click meant for a line would be the worst thing it could do.

        On the rail's own `base-200` rather than a tint or a blur, so it reads as the rule itself
        held in place rather than as a bar bolted across the top. It has to have *some* ground: with
        none, lines pass straight through the words as they scroll under it.
      -->
      <Transition name="fade">
        <div
          v-if="pinned"
          aria-hidden="true"
          class="bg-base-200 pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-1 py-1"
        >
          <span class="border-base-content/15 h-px flex-1 border-t"></span>
          <span class="font-mono text-[0.65rem] tracking-wide opacity-50">{{ pinned }}</span>
          <span class="border-base-content/15 h-px flex-1 border-t"></span>
        </div>
      </Transition>

      <div
        ref="scrollBox"
        class="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto"
        @scroll.passive="onScrolled"
      >
        <!--
          **A row of the transcript, not a badge over it.**

          At the bottom, because that is where a new line arrives: the box is reversed, so its first
          child is the one nearest the composer and the newest line sits directly above this.

          It used to float over that corner, on the argument that a flush of thirty lines should not
          also move the conversation down by a row. What it actually did was cover the newest line -
          the one the flush had just delivered, and the one being waited for - with a note saying
          more were coming. Taking a row is the cheaper of the two: the transcript is anchored at
          this end and shifts by a row either way whenever anything arrives.

          Announced politely: it is reassurance about motion on screen, not something to interrupt a
          screen reader mid-line for.
        -->
        <Transition name="fade">
          <p
            v-if="catchingUp"
            role="status"
            aria-live="polite"
            class="text-base-content/60 flex shrink-0 items-center gap-2 px-1 py-1 text-xs italic"
          >
            <span class="loading loading-spinner loading-xs shrink-0"></span>
            {{ t('chat.catchingUp') }}
          </p>
        </Transition>

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
          <div v-for="(line, at) in items" :key="line.id" v-memo="drawnFrom(line, at)" class="flex flex-col-reverse gap-1">
            <!--
              A gap, drawn as one row that grows rather than as the lines it stands for — which is
              the point, since those were refused precisely so they would not be kept. Dimmed and
              italic because nobody said it: it is the panel talking, not the server.
            -->
            <p v-if="isSuppressed(line)" class="flex items-center gap-2 px-1 text-xs italic opacity-50">
              <span class="shrink-0 font-mono tabular-nums">{{ atTime(line.at) }}</span>
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
              <span class="shrink-0 pt-0.5 font-mono text-xs tabular-nums opacity-50">{{ atTime(line.at) }}</span>
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
              <span v-if="involvesAgent(line)" class="shrink-0 pt-0.5 font-mono text-xs opacity-50">
                {{ line.agentLabel }}
              </span>
              <!--
                Styled as the server sent it, falling back to the plain line. A host may send no tree at
                all - anything an agent said itself has none - so the plain text is what is always there.
              -->
              <McText :components="line.components" :text="line.text" class="min-w-0 flex-1 break-words opacity-80" />
            </p>

            <!--
              **The day, written once, where it changes.**

              A date on every row is the same eleven characters repeated down the whole panel, and
              the question it answers - which day am I reading - is only ever asked at the seam.

              After the line rather than before it, because the box is reversed: later in the DOM is
              higher on the screen, so this lands directly above the first line of its day.

              Carries the day it opens, which is what {@link dayAtTop} reads to decide what to pin
              above the transcript. `position: sticky` cannot do that job here: the scroller is
              reversed, which puts its scroll origin at the bottom and stops `top: 0` behaving like
              a header at all, and every rule shares one containing block - so even where it stuck,
              they would all pin at once instead of handing over.
            -->
            <div
              v-if="opensDay(at)"
              :data-day="onDay(line.at)"
              class="flex items-center gap-2 py-1"
            >
              <span class="border-base-content/15 h-px flex-1 border-t"></span>
              <span class="font-mono text-[0.65rem] tracking-wide opacity-50">{{ onDay(line.at) }}</span>
              <span class="border-base-content/15 h-px flex-1 border-t"></span>
            </div>
          </div>
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

      <AlertNote v-if="sendError" kind="error" class="py-2" :message="sendError" />

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
          @keydown.up="recall"
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
