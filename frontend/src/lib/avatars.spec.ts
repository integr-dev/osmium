import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calls, respondWith } from '../test/http'
import { token } from '../api/token'
import { avatarUrl, clearAvatars } from './avatars'

/**
 * The interesting part is not that a head is fetched — it is that it is fetched **once**, carries
 * the token, and never lets a failure become anything louder than a missing image.
 */
let created = 0

/**
 * jsdom implements neither half of the object-URL API, so the two statics are added and taken away
 * again. Replacing the whole `URL` global instead would break `fetch`, which parses URLs with it —
 * and the symptom is a request that silently never happens.
 */
beforeEach(() => {
  clearAvatars()
  created = 0
  URL.createObjectURL = () => `blob:head-${++created}`
  URL.revokeObjectURL = () => {}
  token.value = 'a-token'
})

afterEach(() => {
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
})

describe('avatarUrl', () => {
  it('sends the access token, because the endpoint is gated like every other route', async () => {
    await avatarUrl('Mason_01')

    expect(calls.at(-1)?.url).toContain('/api/avatars/Mason_01')
    expect(calls.at(-1)?.headers.get('Authorization')).toBe('Bearer a-token')
  })

  it('fetches one head per player, however many elements ask for it', async () => {
    // Not awaited in turn: a page renders thirty of these in the same tick, and the promise being
    // cached rather than the result is what stops that becoming thirty requests.
    await Promise.all([avatarUrl('Mason_01'), avatarUrl('Mason_01'), avatarUrl('mason_01')])

    expect(calls.filter((call) => call.url.includes('/api/avatars/')).length).toBe(1)
  })

  it('has no head for a player the backend does not answer for', async () => {
    respondWith(() => ({ status: 404 }))

    expect(await avatarUrl('Nobody_here')).toBeNull()
  })

  it('asks again a minute later, because a missing head is usually a slow moment', async () => {
    respondWith(() => ({ status: 404 }))
    expect(await avatarUrl('Mason_slow')).toBeNull()

    const asked = calls.length

    // Straight away it is believed: whatever went wrong is still going wrong, and a page full of
    // faces must not turn one bad answer into a request per render.
    expect(await avatarUrl('Mason_slow')).toBeNull()
    expect(calls.length).toBe(asked)

    // A minute on, it is worth another go. The proxy answers 404 for an upstream that was slow as
    // well as for a player who has none, and slow is the common one - a skin service that has not
    // seen a player takes seconds to look them up and no time at all afterwards.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 61_000)
      respondWith(() => ({ status: 200 }))

      expect(await avatarUrl('Mason_slow')).toBe('blob:head-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reach the backend at all without a token', async () => {
    token.value = null

    expect(await avatarUrl('Mason_01')).toBeNull()
    expect(calls.length).toBe(0)
  })

  it('forgets what it knew when the token changes', async () => {
    token.value = null
    expect(await avatarUrl('Mason_01')).toBeNull()

    // The watcher clears the cache, so logging in does not inherit "this player has no head".
    token.value = 'a-fresh-token'

    expect(await avatarUrl('Mason_01')).toBe('blob:head-1')
  })
})
