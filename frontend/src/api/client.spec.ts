import { describe, expect, it, vi } from 'vitest'
import {
  api,
  backendEverReached,
  backendReachable,
  errorMessage,
  isUnreachable,
  UNREACHABLE_MESSAGE,
  setUnauthorizedHandler,
} from './client'
import { token } from './token'
import { lastCall, respondWith } from '../test/http'

describe('auth middleware', () => {
  it('attaches the bearer token', async () => {
    token.value = 'abc123'

    await api.GET('/api/agents')

    expect(lastCall().headers.get('Authorization')).toBe('Bearer abc123')
  })

  it('sends no Authorization header when signed out', async () => {
    await api.GET('/api/agents')

    expect(lastCall().headers.get('Authorization')).toBeNull()
  })

  it('drops the session on a 401', async () => {
    token.value = 'expired'
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    respondWith(() => ({ status: 401, body: { message: 'Unauthorized' } }))

    await api.GET('/api/agents')

    expect(token.value).toBeNull()
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  // Otherwise a mistyped password would look like an expired session and bounce the login screen.
  it('leaves the session alone when the login itself is rejected', async () => {
    token.value = 'still-valid'
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    respondWith(() => ({ status: 401, body: { message: 'Invalid credentials' } }))

    await api.POST('/api/auth/login', { body: { username: 'admin', password: 'wrong' } })

    expect(token.value).toBe('still-valid')
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe('an unreachable backend', () => {
  const dead = () =>
    respondWith(() => {
      throw new TypeError('Failed to fetch')
    })

  /**
   * openapi-fetch throws on a transport failure rather than returning `{ error }`. Every call site
   * handled the latter only, so a dead backend used to surface as an unhandled rejection with no
   * error state at all — and the UI rendered its empty state.
   */
  it('is reported as an error instead of throwing', async () => {
    dead()

    const { error } = await api.GET('/api/agents')

    expect(errorMessage(error)).toBe(UNREACHABLE_MESSAGE)
    expect(isUnreachable(error)).toBe(true)
  })

  it('is distinguishable from a rejection by the API', async () => {
    respondWith(() => ({ status: 403, body: { message: 'Forbidden' } }))

    const { error } = await api.GET('/api/agents')

    expect(isUnreachable(error)).toBe(false)
  })

  /** Unreachable is not logged out. Dropping the token over a blip would cost a live session. */
  it('leaves the session alone', async () => {
    token.value = 'still-valid'
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    dead()

    await api.GET('/api/agents')

    expect(token.value).toBe('still-valid')
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('tracks reachability, and that the backend was once reached', async () => {
    respondWith(() => ({ status: 200, body: [] }))
    await api.GET('/api/agents')
    expect(backendReachable.value).toBe(true)
    expect(backendEverReached.value).toBe(true)

    dead()
    await api.GET('/api/agents')
    expect(backendReachable.value).toBe(false)
    // Still true: this is what separates "never started" from "was working and went away".
    expect(backendEverReached.value).toBe(true)
  })

  /**
   * The case that actually happens. Both dev and production proxy `/api`, so a dead backend
   * arrives as a gateway error rather than a transport failure — the first version of this handled
   * only the latter and would have missed it entirely.
   */
  it('treats a 502 from the proxy as unreachable', async () => {
    respondWith(() => ({ status: 502, body: '<html>Bad Gateway</html>' }))

    const { error } = await api.GET('/api/agents')

    expect(isUnreachable(error)).toBe(true)
    expect(backendReachable.value).toBe(false)
  })

  /**
   * The API returns 503 when an agent's host has no live connection. That is a real answer from a
   * healthy backend, and reporting it as "backend down" would be actively misleading.
   */
  it('does not treat the host-offline 503 as unreachable', async () => {
    respondWith(() => ({ status: 503, body: { message: "Host 'eu-1' has no connected host" } }))

    const { error } = await api.POST('/api/agents/{id}/connect', { params: { path: { id: 1 } } })

    expect(isUnreachable(error)).toBe(false)
    expect(backendReachable.value).toBe(true)
    expect(errorMessage(error)).toBe("Host 'eu-1' has no connected host")
  })

  /** Any answer proves the backend is up, including one that rejects the request. */
  it('counts a 403 as reachable', async () => {
    dead()
    await api.GET('/api/agents')
    expect(backendReachable.value).toBe(false)

    respondWith(() => ({ status: 403, body: { message: 'Forbidden' } }))
    await api.GET('/api/agents')

    expect(backendReachable.value).toBe(true)
  })
})

describe('errorMessage', () => {
  it('uses the backend message', () => {
    expect(errorMessage({ message: 'Host is unreachable' })).toBe('Host is unreachable')
  })

  it('falls back when the body carries nothing printable', () => {
    expect(errorMessage(undefined, 'nope')).toBe('nope')
    expect(errorMessage({}, 'nope')).toBe('nope')
    expect(errorMessage({ message: '' }, 'nope')).toBe('nope')
  })
})
