import { describe, expect, it, vi } from 'vitest'
import { api, errorMessage, setUnauthorizedHandler } from './client'
import { token } from './token'
import { lastCall, respondWith } from '../test/http'

describe('auth middleware', () => {
  it('attaches the bearer token', async () => {
    token.value = 'abc123'

    await api.GET('/api/bots')

    expect(lastCall().headers.get('Authorization')).toBe('Bearer abc123')
  })

  it('sends no Authorization header when signed out', async () => {
    await api.GET('/api/bots')

    expect(lastCall().headers.get('Authorization')).toBeNull()
  })

  it('drops the session on a 401', async () => {
    token.value = 'expired'
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    respondWith(() => ({ status: 401, body: { message: 'Unauthorized' } }))

    await api.GET('/api/bots')

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
