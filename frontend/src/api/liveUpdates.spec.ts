import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openLiveUpdates } from './liveUpdates'
import { token } from './token'
import { lastCall, respondWith } from '../test/http'

/** A response body the test drives by hand, so the stream stays open until it says otherwise. */
function openBody() {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const encoder = new TextEncoder()
  return {
    stream,
    send: (text: string) => controller!.enqueue(encoder.encode(text)),
    end: () => controller!.close(),
  }
}

/**
 * Drives the fake clock a tick so the client's awaits progress. A real `setTimeout` would never
 * fire here, since the timers are faked.
 */
const settle = () => vi.advanceTimersByTimeAsync(1)

describe('live update client', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it('sends the bearer token, which is why EventSource could not be used', async () => {
    token.value = 'stream-token'
    const body = openBody()
    respondWith(() => ({ stream: body.stream }))

    const handle = openLiveUpdates('/api/stream/fleet', { onEvent: () => {} })
    await settle()

    expect(lastCall().headers.get('Authorization')).toBe('Bearer stream-token')
    handle.close()
  })

  it('reports connection before any event arrives', async () => {
    const body = openBody()
    respondWith(() => ({ stream: body.stream }))
    const onConnect = vi.fn()

    const handle = openLiveUpdates('/api/stream/fleet', { onEvent: () => {}, onConnect })
    await settle()

    expect(onConnect).toHaveBeenCalledOnce()
    handle.close()
  })

  it('parses an event split across chunks', async () => {
    const body = openBody()
    respondWith(() => ({ stream: body.stream }))
    const onEvent = vi.fn()

    const handle = openLiveUpdates('/api/stream/fleet', { onEvent })
    await settle()

    body.send('event:agent\ndata:{"id":')
    await settle()
    body.send('7}\n\n')
    await settle()

    expect(onEvent).toHaveBeenCalledWith('agent', { id: 7 })
    handle.close()
  })

  /**
   * The reason the watchdog exists: a proxy holding the client side open, a sleeping laptop or a
   * NAT timeout all leave a socket that looks healthy and delivers nothing.
   */
  it('gives up on a silent connection and reconnects', async () => {
    const body = openBody()
    respondWith(() => ({ stream: body.stream }))
    const onDisconnect = vi.fn()

    const handle = openLiveUpdates('/api/stream/fleet', { onEvent: () => {}, onDisconnect })
    await settle()
    expect(onDisconnect).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(46_000)

    expect(onDisconnect).toHaveBeenCalled()
    handle.close()
  })

  /** Keep-alive comments carry nothing, so they only count if they re-arm the watchdog. */
  it('treats a keep-alive comment as proof of life', async () => {
    const body = openBody()
    respondWith(() => ({ stream: body.stream }))
    const onDisconnect = vi.fn()

    const handle = openLiveUpdates('/api/stream/fleet', { onEvent: () => {}, onDisconnect })
    await settle()

    // Two ticks of the backend's 30s keep-alive, either side of the 45s idle limit.
    await vi.advanceTimersByTimeAsync(30_000)
    body.send(':keep-alive\n\n')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(onDisconnect).not.toHaveBeenCalled()
    handle.close()
  })

  it('stops retrying once closed', async () => {
    const body = openBody()
    respondWith(() => ({ stream: body.stream }))
    const onDisconnect = vi.fn()

    const handle = openLiveUpdates('/api/stream/fleet', { onEvent: () => {}, onDisconnect })
    await settle()
    handle.close()

    await vi.advanceTimersByTimeAsync(120_000)

    expect(onDisconnect).not.toHaveBeenCalled()
  })

  /** Retrying a 403 cannot help: the account lost the node. */
  it('does not reconnect after a 403', async () => {
    respondWith(() => ({ status: 403, body: { message: 'Forbidden' } }))
    const onDisconnect = vi.fn()

    const handle = openLiveUpdates('/api/stream/fleet', { onEvent: () => {}, onDisconnect })
    await settle()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(onDisconnect).not.toHaveBeenCalled()
    handle.close()
  })
})
