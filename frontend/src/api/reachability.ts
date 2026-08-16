import { ref } from 'vue'

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
