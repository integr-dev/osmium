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
 *
 * Starts optimistic. Every screen that reads it is drawn before anything has been asked, and
 * "not responding" under a page that has not tried yet is a worse guess than the other one.
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
 * **The 401 is the answer it is looking for.** The endpoint requires a session and the probe
 * deliberately sends none, so a backend that is up refuses it — and a refusal is proof of life in
 * a way that needs no public endpoint to exist for it.
 *
 * **Anything else is not.** A transport failure is obvious, but the case this used to get wrong is
 * subtler: in development the app is served by Vite and `/api` is proxied, so a backend that is
 * down produces a proxy error — a real HTTP response, 500 or 504, from something that is not the
 * backend. Counting "any answer" as alive meant the login screen reported a dead backend as fine
 * until somebody tried to sign in and found out the hard way.
 *
 * `credentials: 'omit'` on purpose. This must not carry the refresh cookie: it is a probe, it runs
 * on a timer, and the one thing it must never do is spend a credential or rotate a session.
 */
export async function probeBackend(): Promise<void> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/users/me`, {
      method: 'GET',
      credentials: 'omit',
    })

    // 401 from the endpoint itself, or 2xx if one day it stops needing a session. A gateway
    // answering for a backend that is not there is neither.
    const answered = response.ok || response.status === 401

    backendReachable.value = answered
    if (answered) backendEverReached.value = true
  } catch {
    backendReachable.value = false
  }
}
