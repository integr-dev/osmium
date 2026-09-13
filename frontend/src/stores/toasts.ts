import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

/**
 * Transient notices, stacked in a corner.
 *
 * **Deliberately narrow.** Osmium already says most of what it has to say inline: a form error sits
 * under the field that failed, a stopped stream posts a banner above the page, a copy button turns
 * into "Copied". None of that moves here. An inline notice is attached to the thing it is about and
 * stays until it stops being true, and a toast gives up the first of those.
 *
 * What is left over is the two cases inline cannot cover, and they are the only two this exists for:
 *
 * 1. **A receipt for something whose result is somewhere else.** Removing a host leaves the page
 *    that was showing it, so the confirmation has nowhere to land — the operator arrives at the
 *    list and has to infer that it worked from an absence.
 * 2. **Something the stream reported while you were looking elsewhere.** A job finishing and a
 *    piece failing are the two things an operator is actually waiting on, and both happen to a card
 *    that is very likely off screen, on a page they are not on.
 *
 * **Nothing that matters expires.** A notice is dismissed by the person who read it and by nobody
 * else, which is the only arrangement under which an operator who stepped away can trust that the
 * corner still holds everything that happened while they were gone. It is also what makes the cap
 * below the one real compromise in this file.
 *
 * **Two kinds of notice go by themselves, because keeping them is keeping noise.** One that only
 * says something went as asked - an agent arrived, a host was removed - is posted to {@link fade},
 * and closes after {@link FADES_MS} unless the deck is open to read it. And one that a newer notice
 * about the same thing makes untrue - the arrival of a journey the agent has since given up, the
 * failure of one it has since finished - is replaced by it: see {@link NotifyOptions.topic}.
 */
export type ToastKind = 'success' | 'info' | 'warning' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  /**
   * A copy key, translated where it is rendered rather than here.
   *
   * The store holds no prose: the locale can change while a notice is up, and a string frozen at
   * push time would be the one thing on screen still speaking the old language.
   */
  key: string
  params: Record<string, unknown>
  /**
   * What counts as "the same notice", for folding a repeat into the one already up.
   *
   * Two cards fold only when they would be **the same card** — same copy, same subject. A host
   * falling over and a different host falling over are two events about two machines, and counting
   * them as one loses the only thing that made the second one worth saying.
   */
  group: string
  /**
   * How many identical notices this one stands for. One until a second arrives.
   *
   * The whole reason it exists: this is a fleet, and the events worth reporting arrive per agent.
   * Twenty bots losing their host is one thing that happened, and a column of twenty notices about
   * it is a worse account of it than a single line saying twenty.
   */
  count: number
  /**
   * The page the notice is about, when it is about one. The line becomes a link there, and following
   * it dismisses the notice: it has been acted on, which is what dismissing says.
   */
  to?: RouteLocationRaw
  /** Whether it closes by itself. See the note on the store. */
  fades: boolean
  /** What it is a report on, for replacing it with a newer one. See {@link NotifyOptions.topic}. */
  topic?: string
}

export interface NotifyOptions {
  params?: Record<string, unknown>
  to?: RouteLocationRaw
  /**
   * What counts as "the same notice". Defaults to the copy *and* what is filled into it, so what
   * folds is what would render identically — which is what somebody reading a stack of cards means
   * by "the same one again".
   *
   * Pass one only to fold a class of notices together on purpose, against that default.
   */
  group?: string
  /**
   * Closes by itself after {@link FADES_MS}: for a notice that only says something went as asked,
   * which nobody needs to come back to.
   */
  fade?: boolean
  /**
   * What the notice is the latest word on, such as one agent's journey. A new notice on a topic
   * replaces every older one on it that would not fold into it: "arrived" is untrue the moment the
   * same agent reports a failure, and the other way round.
   */
  topic?: string
}

/** How long a fading notice stays up. Long enough to be read from across the room. */
export const FADES_MS = 8_000

/** How long a fading notice that came due while the deck was open stays up after it closes. */
export const RELEASE_MS = 2_000

/**
 * The one compromise. Nothing expires, so without a ceiling a tab left open overnight comes back to
 * a corner nobody can clear, and the oldest notice — the one that has been sitting there longest
 * with nobody acting on it — is the one that goes.
 *
 * Six rather than three because the stack only ever shows three at a time and opens to the rest:
 * the cap is about what is *kept*, not about what fits. Coalescing does most of the work here — a
 * fleet losing its host is one entry however many agents it took down.
 */
const KEPT = 6

export const useToastStore = defineStore('toasts', () => {
  /** Oldest first, which is the order the stack lays them out in: newest nearest the corner. */
  const toasts = ref<Toast[]>([])

  let nextId = 1

  /** The clock on each fading notice. Plain, not reactive: nothing draws a timer. */
  const clocks = new Map<number, ReturnType<typeof setTimeout>>()

  /** Fading notices that came due while the deck was open, waiting for it to close. */
  const overdue = new Set<number>()

  /** Whether somebody is reading the deck, which holds every fading notice where it is. */
  let reading = false

  function wind(id: number, ms: number): void {
    stop(id)
    clocks.set(
      id,
      setTimeout(() => {
        clocks.delete(id)
        if (reading) overdue.add(id)
        else dismiss(id)
      }, ms),
    )
  }

  function stop(id: number): void {
    const clock = clocks.get(id)
    if (clock !== undefined) clearTimeout(clock)
    clocks.delete(id)
    overdue.delete(id)
  }

  function notify(kind: ToastKind, key: string, options: NotifyOptions = {}): void {
    const params = { ...options.params }
    // The subject is part of the identity, not decoration on it: `toast.agentRemoved` for Mason_01
    // and the same key for Mason_04 are two cards, and only two of the *same* card become one ×2.
    const group = options.group ?? key + JSON.stringify(params)
    const fades = options.fade === true

    // The newer word on the same topic makes the older one untrue, whatever it said.
    if (options.topic !== undefined) {
      const stale = toasts.value.filter((toast) => toast.topic === options.topic && toast.group !== group)
      for (const toast of stale) stop(toast.id)
      if (stale.length > 0) toasts.value = toasts.value.filter((toast) => !stale.includes(toast))
    }

    const existing = toasts.value.find((toast) => toast.group === group)

    if (existing) {
      // Counted up in place, so a run of the same event reads as one notice that kept happening
      // rather than as six of the seven things the corner is allowed to remember.
      existing.count += 1
      existing.kind = kind
      // It happened again, so it is news again: a fading one starts its clock over.
      existing.fades = fades
      if (fades) wind(existing.id, FADES_MS)
      else stop(existing.id)
      return
    }

    const id = nextId++
    toasts.value = [
      ...toasts.value,
      {
        id,
        kind,
        key,
        params,
        group,
        count: 1,
        fades,
        ...(options.to ? { to: options.to } : {}),
        ...(options.topic !== undefined ? { topic: options.topic } : {}),
      },
    ]
    if (fades) wind(id, FADES_MS)

    while (toasts.value.length > KEPT) {
      const dropped = toasts.value.shift()
      if (dropped) stop(dropped.id)
    }
  }

  function dismiss(id: number): void {
    stop(id)
    toasts.value = toasts.value.filter((toast) => toast.id !== id)
  }

  function clear(): void {
    for (const toast of toasts.value) stop(toast.id)
    toasts.value = []
  }

  /**
   * Holds every fading notice while somebody is reading the deck, and lets them go when they stop.
   *
   * A notice closing under the pointer is a card taken out of somebody's hands. One that came due in
   * the meantime gets {@link RELEASE_MS} more once the deck shuts, rather than vanishing the instant
   * the pointer leaves it.
   */
  function hold(open: boolean): void {
    reading = open
    if (open) return

    const due = [...overdue]
    overdue.clear()
    for (const id of due) wind(id, RELEASE_MS)
  }

  return { toasts, notify, dismiss, clear, hold }
})
