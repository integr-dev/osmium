import { ref } from 'vue'
import { apiBaseUrl } from './base'

/**
 * Whether the backend is answering, tracked apart from the client that mostly writes it.
 *
 * These two live here rather than in `client.ts` because `session.ts` writes them as well, and
 * `client.ts` already imports `session.ts` — putting them in either would make the pair a cycle.
 * `client.ts` re-exports them, so it stays the module everything else imports from.
 */

/**
 * Whether the last request reached the backend at all. Not in a store so every call updates it,
 * including the account lookup a viewer makes without ever touching the fleet.
 */
export const backendReachable = ref(true)

/**
 * Whether the backend has *ever* answered this session. It separates the two failures that look
 * identical otherwise: never got started, versus was working and went away. The first has nothing
 * worth showing, the second has data on screen that is merely stale.
 */
export const backendEverReached = ref(false)

/**
 * Asks the backend whether it is there, without changing anything.
 *
 * The flags above are otherwise only written as a side effect of requests the app happened to make.
 * On the login screen that means one answer at page load and then nothing — so a backend that went
 * down while somebody was reading the page went on being reported as fine until they tried to sign
 * in and found out the hard way.
 *
 * **Any HTTP answer counts, including the 401.** The same reasoning `session.ts` already applies:
 * a refusal is the backend refusing, which is proof it is running. Only a transport failure means
 * it is not. That is why this can point at an authenticated endpoint rather than needing a public
 * one — it is asking whether anybody is listening, not asking for anything.
 *
 * `credentials: 'omit'` on purpose. This must not carry the refresh cookie: it is a probe, it runs
 * on a timer, and the one thing it must never do is spend a credential or rotate a session.
 */
export async function probeBackend(): Promise<void> {
  try {
    await fetch(`${apiBaseUrl}/api/users/me`, { method: 'GET', credentials: 'omit' })
    backendReachable.value = true
    backendEverReached.value = true
  } catch {
    backendReachable.value = false
  }
}
