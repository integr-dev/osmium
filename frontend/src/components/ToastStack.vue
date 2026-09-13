<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-vue-next'
import { vFlash } from '../lib/motion'
import { useToastStore, type ToastKind } from '../stores/toasts'

/**
 * The corner the notices live in — a deck rather than a column.
 *
 * **They stack like cards.** Nothing expires here, so a list would grow down the page and take over
 * the screen it is supposed to sit beside. Collapsed, only the newest is read: the two behind it
 * show a sliver each, which is how many are waiting without any of them costing room. Pointing at
 * the deck spreads it into a column so every one can be read and dismissed, and moving away closes
 * it again.
 *
 * **The bottom right of the page, not of the window.** The chat rail is a column on the same row
 * and its composer sits in the corner a window-fixed stack would want, so this is positioned inside
 * the page area instead and moves with the rail for free. Nothing here has to follow a scroll: the
 * page itself never scrolls — every view scrolls its own list — so the corner does not move.
 *
 * The container takes no pointer events while the deck is shut; the cards themselves do. Otherwise
 * an invisible box the size of the spread deck would swallow clicks on whatever is under it. Open,
 * it does take them — see `layout`, which is also where it is given a size to take them over.
 */
const { t } = useI18n()
const toasts = useToastStore()

const ICONS: Record<ToastKind, typeof Info> = {
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
}

const TONES: Record<ToastKind, string> = {
  success: 'alert-success',
  info: 'alert-info',
  warning: 'alert-warning',
  error: 'alert-error',
}

/** How much of each card behind the front one shows, and how much smaller it is drawn. */
const PEEK_PX = 9
const PEEK_SCALE = 0.045

/** Cards further back than this are not drawn at all. A third sliver already says "and more". */
const LAYERS = 3

/** Between cards once the deck is spread. */
const GAP_PX = 8

const deck = ref<HTMLElement | null>(null)
const clearAll = ref<HTMLElement | null>(null)
const spread = ref(false)

/**
 * Closes the deck, but only for a pointer or focus that has actually left it.
 *
 * **`pointerout` fires on every crossing inside a card too** - onto its text, onto its dismiss
 * button - and `pointerover` reopens it straight after. Vue runs its update between the two
 * handlers, so the deck was laid out shut and then open again on every such crossing; with the
 * heights read in between, the browser applied the shut position and the cards started sliding
 * down and back. That was the jitter while moving down a spread deck.
 */
function left(event: PointerEvent | FocusEvent): void {
  const into = event.relatedTarget
  if (into instanceof Node && deck.value?.contains(into)) return
  spread.value = false
}

/**
 * Every card is absolutely positioned against the same corner and moved from here, rather than laid
 * out by flow.
 *
 * Flow cannot do the collapsed state at all — the cards overlap — and switching an element between
 * flowed and positioned mid-animation is what makes a deck jump as it opens. Owning both states in
 * one place means opening and closing are the same two properties easing between two sets of
 * numbers, which is a transition the browser can run on the compositor.
 *
 * Heights are measured rather than assumed: a notice is one line or three depending on the copy and
 * the width, and a spread deck has to stack the real ones.
 */
function layout(): void {
  const box = deck.value
  // Not the ones on their way out: `leave` owns those, and laying them out would put them back.
  const cards = box?.querySelectorAll<HTMLElement>('[data-toast]:not([data-leaving])')
  if (!box || !cards) return

  const total = cards.length
  let stacked = 0

  // **Every height read before any style is written.** A height read after moving the card before it
  // makes the browser apply that move there and then, and a move applied mid-flight is a transition
  // already under way - which a later write in the same pass reverses into a twitch.
  const heights = Array.from(cards, (card) => card.offsetHeight)
  const clearing = clearAll.value
  const clearHeight = clearing?.offsetHeight ?? 0

  // Back to front, because a spread card's offset is the sum of the heights of the ones in front of
  // it — which are the ones nearer the corner, and therefore later in the list.
  for (let index = total - 1; index >= 0; index -= 1) {
    const card = cards[index]!
    // 0 is the newest: the one at the front of the deck, nearest the corner.
    const depth = total - 1 - index

    if (spread.value) {
      card.style.translate = `0 ${-stacked}px`
      card.style.scale = '1'
      card.style.opacity = '1'
      // Every card is readable now, so every card takes the pointer again — including the ones the
      // collapsed deck had switched off, whose dismiss button would otherwise not answer.
      card.style.pointerEvents = ''
      stacked += heights[index]! + GAP_PX
    } else {
      card.style.translate = `0 ${-depth * PEEK_PX}px`
      card.style.scale = `${1 - depth * PEEK_SCALE}`
      // Kept in the DOM rather than dropped, so opening the deck reveals it instead of building it.
      const drawn = depth < LAYERS
      card.style.opacity = drawn ? '1' : '0'
      // A card at zero opacity still answers the pointer, and this one sticks out above the deck
      // where nothing is drawn — an invisible strip that opens the deck when brushed past.
      card.style.pointerEvents = drawn ? '' : 'none'
    }

    // The front card is the one that can be read, so it is the one on top.
    card.style.zIndex = `${total - depth}`
  }

  // Clearing sits on top of the spread deck, right-aligned over the oldest card, and is tucked away
  // behind the front card while the deck is shut - there is nothing to clear that cannot be seen.
  if (clearing) {
    clearing.style.translate = `0 ${spread.value ? -stacked : 0}px`
    clearing.style.opacity = spread.value ? '1' : '0'
    clearing.style.pointerEvents = spread.value ? '' : 'none'
    clearing.style.zIndex = `${total + 1}`
    if (spread.value) stacked += clearHeight + GAP_PX
  }

  /*
   * The spread deck is given the height it now occupies, and answers the pointer itself.
   *
   * Without it the container is a zero-height box and the 8px between two cards is a hole: leaving
   * one card to cross that hole reads as leaving the deck, so it collapses under the pointer and
   * springs open again on the next card. Covering its own gaps is what makes a spread deck stay
   * spread while it is being read.
   */
  box.style.height = spread.value ? `${Math.max(0, stacked - GAP_PX)}px` : ''
}

/**
 * A dismissed card slides out towards the edge it came from.
 *
 * **Driven from here rather than by the leave classes**, because every card is positioned by inline
 * styles and an inline style beats a class: `.toast-leave-to` asked for a fade and a slide that the
 * card's own `opacity` and `translate` simply overruled, so a dismissed notice vanished on the spot.
 * So the card is marked as leaving - which takes it out of {@link layout}, and lets the rest restack
 * behind it - and its own inline styles are moved to where it is going.
 *
 * Finished on a timer rather than on `transitionend`: with reduced motion there is no transition to
 * end, and a card waiting for one would never leave.
 */
function leave(element: Element, done: () => void): void {
  const card = element as HTMLElement
  card.dataset['leaving'] = ''
  card.style.pointerEvents = 'none'

  // Across from wherever it stands in the deck, so a card leaving from the back of an open deck
  // slides out of its own row rather than dropping to the corner first.
  const [, rise = '0px'] = (card.style.translate || '0 0px').split(' ')
  card.style.opacity = '0'
  card.style.translate = `1.5rem ${rise}`

  window.setTimeout(done, LEAVE_MS)
  void relayout()
}

/** The longer of the two leave transitions in `style.css`. */
const LEAVE_MS = 220

/** After the DOM has the change: every number here comes off cards that are already laid out. */
async function relayout(): Promise<void> {
  await nextTick()
  layout()
}

watch(spread, (open) => {
  // Nothing closes by itself while it is being read. See `hold` in the store.
  toasts.hold(open)
  layout()
})
watch(() => toasts.toasts.map((toast) => `${toast.id}:${toast.count}`).join('|'), relayout)

let sizes: ResizeObserver | null = null

onMounted(() => {
  void relayout()

  // A card that grows a line — the sidebar dragged, the window narrowed, a count reaching two
  // digits — moves every card the spread deck stacks on top of it.
  sizes = new ResizeObserver(layout)
  if (deck.value) sizes.observe(deck.value)
})

onBeforeUnmount(() => sizes?.disconnect())
</script>

<template>
  <!--
    `polite`, never `assertive`: nothing here is urgent enough to cut across what a screen reader is
    already saying, and the two things that are — a lost session, a stopped stream — are banners on
    the page instead, precisely because they must not expire.

    `pointerover`/`pointerout` rather than the enter/leave pair, because the container takes no
    pointer events of its own: the cards are the targets, and only the bubbling pair reaches an
    ancestor from them.
  -->
  <div
    ref="deck"
    class="absolute inset-x-4 bottom-4 z-50 sm:inset-x-auto sm:right-4 sm:w-80"
    :class="spread ? 'pointer-events-auto' : 'pointer-events-none'"
    role="status"
    aria-live="polite"
    @pointerover="spread = true"
    @pointerout="left"
    @focusin="spread = true"
    @focusout="left"
  >
    <TransitionGroup name="toast" @leave="leave">
      <div
        v-for="toast in toasts.toasts"
        :key="toast.id"
        data-toast
        class="alert alert-soft osmium-toast pointer-events-auto absolute inset-x-0 bottom-0 items-start gap-3"
        :class="TONES[toast.kind]"
      >
        <component :is="ICONS[toast.kind]" class="mt-0.5 size-5 shrink-0" />
        <RouterLink
          v-if="toast.to"
          :to="toast.to"
          class="min-w-0 flex-1 text-sm hover:underline"
          @click="toasts.dismiss(toast.id)"
        >
          {{ t(toast.key, toast.params) }}
        </RouterLink>
        <span v-else class="min-w-0 flex-1 text-sm">{{ t(toast.key, toast.params) }}</span>
        <!--
          The count of a notice that kept happening. Flashed on every increment, because the line
          itself does not change when the second one arrives and a number that ticks up unremarked
          is a number nobody sees move.
        -->
        <span v-if="toast.count > 1" v-flash="toast.count" class="badge badge-sm shrink-0">
          ×{{ toast.count }}
        </span>
        <button
          type="button"
          class="btn btn-ghost btn-xs btn-circle -mt-0.5 shrink-0"
          :aria-label="t('common.dismiss')"
          @click="toasts.dismiss(toast.id)"
        >
          <X class="size-3.5" />
        </button>
      </div>
    </TransitionGroup>
    <!--
      Only with more than one to clear: a single notice already has its own dismiss, and a second
      button beside it saying the same thing is noise. Out of the tab order while the deck is shut,
      because it is not on screen then; focusing any card opens the deck and brings it back.
    -->
    <button
      v-if="toasts.toasts.length > 1"
      ref="clearAll"
      type="button"
      class="btn btn-xs btn-soft osmium-toast-clear absolute right-0 bottom-0"
      :tabindex="spread ? 0 : -1"
      @click="toasts.clear()"
    >
      {{ t('toast.clearAll', { count: toasts.toasts.length }) }}
    </button>
  </div>
</template>
