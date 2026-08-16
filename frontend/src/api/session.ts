import { apiBaseUrl } from './base'
import { backendEverReached, backendReachable } from './reachability'
import { token } from './token'

/**
 * The session, as distinct from the access token it hands out.
 *
 * The refresh token lives in an `HttpOnly` cookie this code cannot read, so everything here works
 * by asking the backend rather than by inspecting anything. Written against `fetch` rather than the
 * generated client on purpose: the client's middleware refreshes on a 401, and routing these calls
 * through it would let a failing refresh trigger another refresh.
 *
 * `credentials: 'same-origin'` is the default for same-origin requests and is stated anyway — the
 * cookie is the whole credential, and a split-origin deployment that quietly dropped it would fail
 * in a way nobody would think to look for.
 */

/**
 * In flight, if one is. Ten calls that all 401 at once must produce **one** refresh, not ten: each
 * rotation spends the cookie and mints a successor, so ten concurrent rotations would have nine of
 * them presenting a token that had already been spent.
 */
let inFlight: Promise<boolean> | null = null

/** Named so every tab of this app contends for the same one. */
const REFRESH_LOCK = 'osmium.session.refresh'

/**
 * Exchanges the refresh cookie for a new access token. Resolves false when there is no session to
 * resume, which is the ordinary state on a first visit and after an expiry — not an error.
 *
 * Serialised **across tabs**, not only within one. The guard above is module state, and a second
 * tab is a second module instance sharing the same cookie — so two tabs waking together would each
 * present the value the browser last stored, one would win, and the other would look to the backend
 * exactly like a replayed token. That ends the session and writes a security incident, for two tabs
 * being open.
 *
 * The lock makes the second tab wait and then refresh from the cookie the first one left behind,
 * which is an ordinary rotation. `navigator.locks` is absent in jsdom and in older browsers, so its
 * absence falls through to the single-tab behaviour rather than failing; the backend's retry grace
 * window is what covers the cases a lock cannot reach anyway — a dropped connection, a restored
 * session, a second browser entirely.
 */
export function refreshSession(): Promise<boolean> {
  inFlight ??= withLock(exchange).finally(() => {
    inFlight = null
  })
  return inFlight
}

function withLock(work: () => Promise<boolean>): Promise<boolean> {
  return navigator.locks?.request(REFRESH_LOCK, work) ?? work()
}

async function exchange(): Promise<boolean> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
    })
    // Any answer proves the backend is up, including the 401 that means there is no session to
    // resume. Recorded here and not only in the API client's middleware because this call runs
    // before every other one — the route guard awaits it during the app's first navigation — and it
    // is the *only* request a signed-out tab makes. Without this the login screen has no way to
    // tell a wrong password from a backend that is not running.
    backendReachable.value = true
    backendEverReached.value = true

    if (!response.ok) {
      token.value = null
      return false
    }
    const body = (await response.json()) as { token?: string }
    if (!body.token) return false
    token.value = body.token
    return true
  } catch {
    // Transport failure. The session may well be fine, so the token is left alone rather than
    // logging the operator out because their laptop slept.
    backendReachable.value = false
    return false
  }
}

/**
 * Ends the session at the backend, which revokes the refresh token and clears the cookie. Failure
 * is ignored: the local half of a logout must happen either way, and an operator who cannot reach
 * the backend still expects the button to work.
 */
export async function endSession(): Promise<void> {
  try {
    await fetch(`${apiBaseUrl}/api/auth/logout`, { method: 'POST', credentials: 'same-origin' })
  } catch {
    // Nothing to do; the caller clears the local session regardless.
  } finally {
    token.value = null
  }
}
