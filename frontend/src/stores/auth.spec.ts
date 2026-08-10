import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from './auth'
import { token } from '../api/token'
import { calls, respondWith } from '../test/http'

const ACCOUNT = { id: 1, username: 'admin', role: 'administrator', nodes: ['user.read', 'agent.chat'] }

/** Answers /api/auth/login and /api/auth/me; anything else is a test bug. */
function backend(options: { meStatus?: number } = {}) {
  respondWith((call) => {
    if (call.url.endsWith('/api/auth/login')) return { body: { token: 'issued-token' } }
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

  it('mirrors the granted nodes in can()', async () => {
    backend()
    const auth = useAuthStore()
    await auth.login('admin', 'admin')

    expect(auth.can('user.read')).toBe(true)
    expect(auth.can('agent.chat')).toBe(true)
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

    auth.logout()

    expect(token.value).toBeNull()
    expect(auth.user).toBeNull()
    expect(auth.isAuthenticated).toBe(false)
  })
})
