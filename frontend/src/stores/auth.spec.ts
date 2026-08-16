import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from './auth'
import { token } from '../api/token'
import { calls, respondWith } from '../test/http'

const ACCOUNT = { id: 1, username: 'admin', role: 'administrator', nodes: ['user.read', 'chat.speak'] }

/** Answers /api/auth/login and /api/auth/me; anything else is a test bug. */
function backend(options: { meStatus?: number } = {}) {
  respondWith((call) => {
    if (call.url.endsWith('/api/auth/login')) return { body: { token: 'issued-token' } }
    if (call.url.endsWith('/api/auth/logout')) return { status: 204 }
    if (call.url.endsWith('/api/auth/me')) {
      return options.meStatus
        ? { status: options.meStatus, body: { message: 'Forbidden' } }
        : { body: ACCOUNT }
    }
    throw new Error(`Unexpected request to ${call.url}`)
  })
}

describe('auth store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('stores the token and loads the account on login', async () => {
    backend()
    const auth = useAuthStore()

    await auth.login('admin', 'admin')

    expect(token.value).toBe('issued-token')
    expect(auth.isAuthenticated).toBe(true)
    expect(auth.user?.username).toBe('admin')
  })

  it('throws the backend message and stays signed out when login fails', async () => {
    respondWith(() => ({ status: 401, body: { message: 'Invalid username or password' } }))
    const auth = useAuthStore()

    await expect(auth.login('admin', 'wrong')).rejects.toThrow('Invalid username or password')
    expect(token.value).toBeNull()
    expect(auth.isAuthenticated).toBe(false)
  })

  // A token without user.read.self is a valid session, just one that cannot describe itself.
  // Treating that as signed out would lock the account out of the app entirely.
  it('keeps the session when the account cannot be read', async () => {
    backend({ meStatus: 403 })
    const auth = useAuthStore()
    token.value = 'valid-but-unprivileged'

    await auth.loadUser()

    expect(auth.isAuthenticated).toBe(true)
    expect(auth.user).toBeNull()
  })

  /**
   * An unreachable backend says nothing about the account. Clearing it blanked the username and
   * role on My Account whenever the backend was merely down.
   */
  it('keeps the cached account when the backend is unreachable', async () => {
    backend()
    const auth = useAuthStore()
    await auth.login('admin', 'admin')

    respondWith(() => {
      throw new TypeError('Failed to fetch')
    })
    await auth.loadUser()

    expect(auth.user?.username).toBe('admin')
    expect(auth.isAuthenticated).toBe(true)
  })

  it('mirrors the granted nodes in can()', async () => {
    backend()
    const auth = useAuthStore()
    await auth.login('admin', 'admin')

    expect(auth.can('user.read')).toBe(true)
    expect(auth.can('chat.speak')).toBe(true)
    expect(auth.can('user.delete')).toBe(false)
  })

  it('denies every node before the account is loaded', () => {
    expect(useAuthStore().can('user.read')).toBe(false)
  })

  it('loads the account once across repeated ensureLoaded calls', async () => {
    backend()
    const auth = useAuthStore()
    token.value = 'from-a-previous-session'

    await auth.ensureLoaded()
    await auth.ensureLoaded()

    expect(calls.filter((call) => call.url.endsWith('/api/auth/me'))).toHaveLength(1)
  })

  it('makes no request when signed out', async () => {
    await useAuthStore().ensureLoaded()

    expect(calls).toHaveLength(0)
  })

  it('clears the token and the account on logout', async () => {
    backend()
    const auth = useAuthStore()
    await auth.login('admin', 'admin')

    await auth.logout()

    expect(token.value).toBeNull()
    expect(auth.user).toBeNull()
    expect(auth.isAuthenticated).toBe(false)
  })

  it('ends the session at the backend, not only in this tab', async () => {
    backend()
    const auth = useAuthStore()
    await auth.login('admin', 'admin')

    await auth.logout()

    // Without this the refresh cookie outlives the logout, and the next person at this browser can
    // mint a fresh access token from it.
    expect(calls.some((call) => call.url.endsWith('/api/auth/logout'))).toBe(true)
  })

  it('picks the session back up from the refresh cookie after a reload', async () => {
    // No token: the access token lives in memory only, so a reload starts without one.
    respondWith((call) =>
      call.url.endsWith('/api/auth/refresh')
        ? { body: { token: 'minted-from-cookie' } }
        : { body: { id: 1, username: 'admin', role: 'administrator', nodes: ['user.read.self'] } },
    )
    const auth = useAuthStore()

    await auth.restore()

    expect(token.value).toBe('minted-from-cookie')
    expect(auth.user?.username).toBe('admin')
  })

  it('stays signed out when there is no session to resume', async () => {
    respondWith(() => ({ status: 401 }))
    const auth = useAuthStore()

    await auth.restore()

    expect(auth.isAuthenticated).toBe(false)
    expect(auth.user).toBeNull()
  })
})

/**
 * The recourse an operator has when they think a session has been taken. Ending everything has to
 * clear the local session whatever the backend says — this is the button somebody presses when they
 * believe they are compromised, and staying signed in because the request was awkward is the worst
 * available reading of a failure.
 */
describe('ending sessions', () => {
  // Its own store per test. Leaning on the block above having set one would make these pass for a
  // reason that has nothing to do with what they assert.
  beforeEach(() => setActivePinia(createPinia()))

  it('lists the account sessions', async () => {
    respondWith(() => ({
      body: [{ id: 1, startedAt: '2026-08-13T10:00:00Z', expiresAt: '2026-08-13T22:00:00Z', clientIp: null, userAgent: null, current: true }],
    }))

    const sessions = await useAuthStore().sessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.current).toBe(true)
  })

  it('signs the tab out even when the request fails', async () => {
    backend()
    const auth = useAuthStore()
    await auth.login('admin', 'admin')
    respondWith(() => ({ status: 500, body: { message: 'boom' } }))

    await auth.endAllSessions()

    expect(token.value).toBeNull()
    expect(auth.isAuthenticated).toBe(false)
  })
})
