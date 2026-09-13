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
 * **Nothing here expires.** A notice is dismissed by the person who read it and by nobody else,
 * which is the only arrangement under which an operator who stepped away can trust that the corner
 * still holds everything that happened while they were gone. It is also what makes the cap below
 * the one real compromise in this file.
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
}

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

  function notify(kind: ToastKind, key: string, options: NotifyOptions = {}): void {
    const params = { ...options.params }
    // The subject is part of the identity, not decoration on it: `toast.agentRemoved` for Mason_01
    // and the same key for Mason_04 are two cards, and only two of the *same* card become one ×2.
    const group = options.group ?? key + JSON.stringify(params)
    const existing = toasts.value.find((toast) => toast.group === group)

    if (existing) {
      // Counted up in place, so a run of the same event reads as one notice that kept happening
      // rather than as six of the seven things the corner is allowed to remember.
      existing.count += 1
      existing.kind = kind
      return
    }

    toasts.value = [
      ...toasts.value,
      { id: nextId++, kind, key, params, group, count: 1, ...(options.to ? { to: options.to } : {}) },
    ]

    while (toasts.value.length > KEPT) toasts.value.shift()
  }

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((toast) => toast.id !== id)
  }

  function clear(): void {
    toasts.value = []
  }

  return { toasts, notify, dismiss, clear }
})
