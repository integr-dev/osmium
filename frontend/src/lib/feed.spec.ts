import { describe, expect, it } from 'vitest'
import { useFeed, type FeedPage } from './feed'

/**
 * The paging contract every feed shares. These are the parts where a bug is invisible: a cursor that
 * is not carried forward silently re-reads page one, and an exhausted feed that never says so leaves
 * the scroll observer asking for more forever.
 */

/** A backend holding `total` items, handing them out `size` at a time. */
function backend(total: number, size: number) {
  const calls: (string | null)[] = []

  async function fetchPage(cursor: string | null): Promise<FeedPage<number>> {
    calls.push(cursor)
    const start = cursor === null ? 0 : Number(cursor)
    const items = Array.from({ length: Math.min(size, total - start) }, (_, i) => start + i)
    const next = start + items.length
    return { items, nextCursor: items.length === size && next < total ? String(next) : null }
  }

  return { calls, fetchPage }
}

describe('useFeed', () => {
  it('loads the newest page on reset', async () => {
    const { calls, fetchPage } = backend(10, 3)
    const feed = useFeed(fetchPage)

    await feed.reset()

    expect(feed.items.value).toEqual([0, 1, 2])
    expect(calls).toEqual([null])
    expect(feed.exhausted.value).toBe(false)
  })

  it('appends older pages rather than replacing them', async () => {
    const feed = useFeed(backend(10, 3).fetchPage)

    await feed.reset()
    await feed.more()

    expect(feed.items.value).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('carries the cursor forward, so a page is never re-read', async () => {
    const { calls, fetchPage } = backend(10, 3)
    const feed = useFeed(fetchPage)

    await feed.reset()
    await feed.more()
    await feed.more()

    expect(calls).toEqual([null, '3', '6'])
  })

  /** A null cursor is the backend saying there is nothing older; asking again would loop forever. */
  it('stops asking once the feed says it has ended', async () => {
    const { calls, fetchPage } = backend(4, 2)
    const feed = useFeed(fetchPage)

    await feed.reset()
    await feed.more()
    expect(feed.exhausted.value).toBe(true)

    await feed.more()
    expect(calls).toEqual([null, '2'])
  })

  it('throws away what is loaded when reset, and starts from the newest again', async () => {
    const { calls, fetchPage } = backend(10, 3)
    const feed = useFeed(fetchPage)

    await feed.reset()
    await feed.more()
    await feed.reset()

    expect(feed.items.value).toEqual([0, 1, 2])
    expect(calls.at(-1)).toBe(null)
  })

  /** Otherwise the observer retries against a backend that is not answering, on every scroll event. */
  it('treats a failure as exhausted so it is not retried in a loop', async () => {
    const feed = useFeed(async () => ({ error: 'Could not load' }))

    await feed.reset()

    expect(feed.error.value).toBe('Could not load')
    expect(feed.exhausted.value).toBe(true)
    expect(feed.loading.value).toBe(false)
  })

  it('puts a live item at the top, where the newest already is', async () => {
    const feed = useFeed(backend(3, 3).fetchPage)

    await feed.reset()
    feed.prepend(99)

    expect(feed.items.value).toEqual([99, 0, 1, 2])
  })

  /** Two requests in flight would interleave pages and duplicate rows. */
  it('ignores a second request while one is in flight', async () => {
    const { calls, fetchPage } = backend(10, 3)
    const feed = useFeed(fetchPage)
    await feed.reset()

    await Promise.all([feed.more(), feed.more()])

    expect(calls).toEqual([null, '3'])
  })
})
