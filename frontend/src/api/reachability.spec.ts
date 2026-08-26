import { afterEach, describe, expect, it, vi } from 'vitest'
import { backendEverReached, backendReachable, probeBackend } from './reachability'

/**
 * The probe asks an endpoint that needs a session while deliberately sending none, so the answer it
 * is looking for is the refusal. What it must not accept is an answer from something that is not
 * the backend — in development `/api` is proxied, and a proxy answers for a backend that is gone.
 */
function answers(status: number, ok = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok, status } as Response),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  backendReachable.value = true
  backendEverReached.value = false
})

describe('probing', () => {
  it('reads a refusal as proof of life', async () => {
    answers(401)
    await probeBackend()

    expect(backendReachable.value).toBe(true)
    expect(backendEverReached.value).toBe(true)
  })

  it('reads a plain answer as proof of life too', async () => {
    answers(200, true)
    await probeBackend()

    expect(backendReachable.value).toBe(true)
  })

  /** The bug: a dev proxy erroring for a backend that is down is still an HTTP response. */
  it('does not take a gateway error for the backend', async () => {
    answers(504)
    await probeBackend()

    expect(backendReachable.value).toBe(false)
    expect(backendEverReached.value).toBe(false)
  })

  it('takes a transport failure for what it is', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')))
    await probeBackend()

    expect(backendReachable.value).toBe(false)
  })
})
