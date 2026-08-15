import { beforeEach, describe, expect, it } from 'vitest'
import { api, backendEverReached, backendReachable } from './client'
import { refreshSession } from './session'
import { token } from './token'
import { calls, respondWith } from '../test/http'

/**
 * The session is a refresh cookie this code cannot read plus an access token it holds in memory.
 * What is worth testing is the seam between them: when a new access token is fetched, how often,
 * and what happens when there is no session left to resume.
 */
const ACCOUNT = { id: 1, username: 'admin', role: 'administrator', nodes: ['user.read.self'] }

/** 401s every ordinary call until a refresh has happened, then answers normally. */
function expiredUntilRefreshed(options: { refreshWorks?: boolean } = {}) {
  const { refreshWorks = true } = options
  let refreshed = false

  respondWith((call) => {
    if (call.url.endsWith('/api/auth/refresh')) {
      if (!refreshWorks) return { status: 401 }
      refreshed = true
      return { body: { token: 'second-token' } }
    }
    return refreshed ? { body: ACCOUNT } : { status: 401, body: { message: 'Expired' } }
  })
}

beforeEach(() => {
  token.value = 'first-token'
})

describe('refreshSession', () => {
  it('takes a new access token from the refresh endpoint', async () => {
    respondWith(() => ({ body: { token: 'second-token' } }))

    expect(await refreshSession()).toBe(true)
    expect(token.value).toBe('second-token')
  })

  it('drops the token when there is no session left', async () => {
    respondWith(() => ({ status: 401 }))

    expect(await refreshSession()).toBe(false)
    expect(token.value).toBeNull()
  })

  it('refreshes once however many callers ask at the same moment', async () => {
    respondWith(() => ({ body: { token: 'second-token' } }))

    await Promise.all([refreshSession(), refreshSession(), refreshSession()])

    // Each rotation spends the cookie, so three concurrent refreshes would have two of them
    // presenting a token that had already been spent - which the backend reads as theft and
    // answers by ending the session.
    expect(calls.filter((call) => call.url.endsWith('/api/auth/refresh'))).toHaveLength(1)
  })

  it('keeps the token when the backend cannot be reached', async () => {
    respondWith(() => {
      throw new Error('offline')
    })

    expect(await refreshSession()).toBe(false)
    // Unreachable is not signed out. Dropping the session over a sleeping laptop would cost the
    // operator their work for no reason.
    expect(token.value).toBe('first-token')
  })

  /**
   * This is the only request a signed-out tab makes, so it is the only thing that can tell the
   * login screen whether there is a backend behind it. Without this the screen has no way to
   * separate a wrong password from a backend that is not running, and finds out by spending one.
   */
  it('reports that the backend answered, even when it says no', async () => {
    respondWith(() => ({ status: 401 }))

    await refreshSession()

    // A 401 is the backend working: it means there is no session to resume, which is the ordinary
    // state of a first visit.
    expect(backendReachable.value).toBe(true)
    expect(backendEverReached.value).toBe(true)
  })

  it('reports that the backend did not answer', async () => {
    respondWith(() => {
      throw new Error('offline')
    })

    await refreshSession()

    expect(backendReachable.value).toBe(false)
    // Never reached, so there is nothing on screen that was ever true — the distinction the login
    // screen and the app shell both branch on.
    expect(backendEverReached.value).toBe(false)
  })
})

describe('an expired access token', () => {
  it('is renewed and the request replayed, invisibly to the caller', async () => {
    expiredUntilRefreshed()

    const { data, error } = await api.GET('/api/auth/me')

    expect(error).toBeUndefined()
    expect(data?.username).toBe('admin')
  })

  it('sends the replay with the new token, not the one that just failed', async () => {
    expiredUntilRefreshed()

    await api.GET('/api/auth/me')

    const replay = calls.at(-1)
    expect(replay?.headers.get('Authorization')).toBe('Bearer second-token')
  })

  it('gives up rather than looping when the session is genuinely over', async () => {
    expiredUntilRefreshed({ refreshWorks: false })

    const { error } = await api.GET('/api/auth/me')

    expect(error).toBeDefined()
    // One attempt, one refresh, and no retry. A loop here is a request storm against a backend
    // that has already said no.
    expect(calls.filter((call) => call.url.endsWith('/api/auth/me'))).toHaveLength(1)
  })

  it('does not try to refresh a failed login', async () => {
    respondWith(() => ({ status: 401, body: { message: 'Invalid username or password' } }))

    await api.POST('/api/auth/login', { body: { username: 'ada', password: 'wrong' } })

    // Refreshing in response to a rejected login would ask for a session that was never started.
    expect(calls.filter((call) => call.url.endsWith('/api/auth/refresh'))).toHaveLength(0)
  })
})
