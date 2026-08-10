import { onBeforeUnmount, ref, type Ref } from 'vue'
import { nextTick } from 'vue'

/**
 * The shape every paged feed comes back in: the audit trail, activity and chat all page the same
 * way, because they are all append-only and read newest-first.
 *
 * `nextCursor` is null when the backend has nothing older. It is opaque — the client only ever
 * hands it back.
 */
export interface FeedPage<T> {
  items: T[]
  nextCursor: string | null
}

export interface Feed<T> {
  items: Ref<T[]>
  loading: Ref<boolean>
  error: Ref<string | null>
  /** True once the backend has said there is nothing older, or a request failed. */
  exhausted: Ref<boolean>
  /** Throws away what is loaded and fetches the newest page. Used on mount and when a filter changes. */
  reset: () => Promise<void>
  /** Fetches the next, older page. A no-op while one is in flight or once exhausted. */
  more: () => Promise<void>
  /** Puts a live-streamed item at the top, where the newest already is. */
  prepend: (item: T) => void
}

/**
 * Cursor-paged feed state.
 *
 * `fetchPage` receives the cursor to continue from — null for the newest page — and returns either a
 * page or an error message. Returning rather than throwing keeps the caller's error handling in one
 * place, since every call site already turns an API failure into a string.
 */
export function useFeed<T>(
  fetchPage: (cursor: string | null) => Promise<FeedPage<T> | { error: string }>,
): Feed<T> {
  const items = ref<T[]>([]) as Ref<T[]>
  const loading = ref(false)
  const error = ref<string | null>(null)
  const exhausted = ref(false)
  const cursor = ref<string | null>(null)

  async function load(fresh: boolean): Promise<void> {
    if (loading.value) return
    loading.value = true
    error.value = null

    const result = await fetchPage(fresh ? null : cursor.value)
    loading.value = false

    if ('error' in result) {
      error.value = result.error
      // Stops an observer retrying against a backend that is not answering. Scrolling away and back
      // re-arms it, which is the retry.
      exhausted.value = true
      return
    }

    items.value = fresh ? result.items : [...items.value, ...result.items]
    cursor.value = result.nextCursor
    exhausted.value = result.nextCursor === null
  }

  return {
    items,
    loading,
    error,
    exhausted,
    reset: async () => {
      cursor.value = null
      exhausted.value = false
      items.value = []
      await load(true)
    },
    more: async () => {
      if (exhausted.value) return
      await load(false)
    },
    prepend: (item: T) => {
      items.value = [item, ...items.value]
    },
  }
}

/**
 * Calls [onReach] when [sentinel] scrolls into view — the "load more" button, without the button.
 *
 * Returns `rearm`, which callers must invoke after a page lands. A page that does not fill the
 * window leaves the sentinel still intersecting, and an observer does not fire again for an element
 * that never left; re-observing asks it for the current state instead.
 */
export function useInfiniteScroll(
  sentinel: Ref<HTMLElement | null>,
  onReach: () => void,
  /** The scrolling ancestor, when it is not the page — a modal body, a fixed-height panel. */
  root?: Ref<HTMLElement | null>,
): { start: () => void; rearm: () => Promise<void> } {
  let observer: IntersectionObserver | null = null

  onBeforeUnmount(() => observer?.disconnect())

  function rearmNow(): void {
    if (!observer || !sentinel.value) return
    observer.unobserve(sentinel.value)
    observer.observe(sentinel.value)
  }

  return {
    /** Called once the first page has landed, so the observer cannot race the initial load. */
    start() {
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry?.isIntersecting) onReach()
        },
        {
          root: root?.value ?? null,
          // Fetch a little before the sentinel is actually reached, so the next page is usually
          // already there by the time it is scrolled to.
          rootMargin: '300px',
        },
      )
      rearmNow()
    },
    async rearm() {
      await nextTick()
      rearmNow()
    },
  }
}
