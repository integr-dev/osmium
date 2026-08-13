import { ref } from 'vue'

/**
 * The access token — **in memory only, never persisted**.
 *
 * It used to live in `localStorage`, which survived a reload at the cost of being readable by any
 * script that got a foothold: an XSS could take the token off the machine and use it elsewhere for
 * its full lifetime. Nothing here is written to storage, so there is nothing on disk to steal and
 * nothing left behind on a shared machine.
 *
 * A reload therefore starts with no token. `src/api/session.ts` gets one back from the refresh
 * cookie before the app renders — that cookie is `HttpOnly`, so this module could not read it even
 * if it wanted to, which is the entire point.
 *
 * What this does **not** buy: an XSS on an open page can still call the API as the user, and can
 * call refresh itself. Moving the credential out of reach shortens what an attacker keeps after
 * the tab closes; it does not stop them acting inside it.
 */
export const token = ref<string | null>(null)
