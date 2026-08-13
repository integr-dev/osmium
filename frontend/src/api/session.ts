import { apiBaseUrl } from './base'
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
 * them presenting a token that had already been spent — which the backend correctly reads as theft
 * and answers by ending the session.
 */
let inFlight: Promise<boolean> | null = null

/**
 * Exchanges the refresh cookie for a new access token. Resolves false when there is no session to
 * resume, which is the ordinary state on a first visit and after an expiry — not an error.
 */
export function refreshSession(): Promise<boolean> {
  inFlight ??= exchange().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function exchange(): Promise<boolean> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
    })
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
