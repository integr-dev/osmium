import { watch } from 'vue'
import { apiBaseUrl } from '../api/base'
import { token } from '../api/token'

/**
 * Player heads, fetched with the access token and handed to an `<img>` as a blob URL.
 *
 * `/api/avatars` is gated on `fleet.read` like everything else, and an `<img src>` cannot send an
 * `Authorization` header. The access token is not a cookie — the only cookie in this app is the
 * refresh token, scoped to `/api/auth` — so the head is fetched here and the element is given an
 * object URL instead. That is the cost of not leaving the endpoint open, and it is worth paying:
 * the alternative was an unauthenticated route whose outbound requests answered to nobody.
 *
 * Two things this has to get right, because a fleet page renders the same head many times over:
 *
 * **One request per player, not per element.** The promise is cached, not the result, so thirty
 * `<img>` elements mounting in the same tick share a single fetch rather than racing.
 *
 * **The URLs are revoked when evicted.** An object URL pins its blob until it is released, and a
 * long session watching global chat meets a lot of distinct names.
 */

/** Bounded LRU of identifier → the in-flight or settled fetch. Null means there is no head. */
const heads = new Map<string, Promise<string | null>>()

const MAX_HEADS = 200

export function avatarUrl(identifier: string): Promise<string | null> {
  const key = identifier.toLowerCase()

  const existing = heads.get(key)
  if (existing) {
    // Re-inserted to move it to the end: Map iterates in insertion order, which is what makes the
    // first key the least recently used one.
    heads.delete(key)
    heads.set(key, existing)
    return existing
  }

  const request = fetchHead(identifier)
  heads.set(key, request)
  evict()
  return request
}

async function fetchHead(identifier: string): Promise<string | null> {
  const bearer = token.value
  if (!bearer) return null

  try {
    const response = await fetch(`${apiBaseUrl}/api/avatars/${encodeURIComponent(identifier)}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    // Deliberately not routed through the API client: its middleware logs the session out on a 401,
    // and a decorative image is the last thing that should be able to do that. Every failure here
    // is a missing head and nothing more.
    if (!response.ok) return null
    return URL.createObjectURL(await response.blob())
  } catch {
    return null
  }
}

function evict(): void {
  while (heads.size > MAX_HEADS) {
    const oldest = heads.keys().next().value
    if (oldest === undefined) return
    const dropped = heads.get(oldest)
    heads.delete(oldest)
    void dropped?.then((url) => url && URL.revokeObjectURL(url))
  }
}

/**
 * Dropped when the token changes. A head that could not be fetched while logged out must not stay
 * cached as "this player has none" for the session that follows.
 */
// Synchronous: a logout invalidating the cache is not something to defer to a microtask, because
// the next thing that happens may well be a render that reads it.
watch(token, () => clearAvatars(), { flush: 'sync' })

export function clearAvatars(): void {
  for (const pending of heads.values()) {
    void pending.then((url) => url && URL.revokeObjectURL(url))
  }
  heads.clear()
}
