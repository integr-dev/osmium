import { apiBaseUrl } from './base'
import { refreshSession } from './session'
import { token } from './token'

/**
 * A minimal server-sent-events client built on `fetch`.
 *
 * The browser's native `EventSource` cannot set an `Authorization` header, and the access token is
 * a Bearer token. Putting it in the query string would land it in access logs and referrers, so the
 * stream is read from a `fetch` body instead. The refresh token is a cookie now, but the access
 * token is not and will not be — `EventSource` also swallows keep-alive comments and retries
 * forever, and this client depends on seeing the first and refusing the second.
 * See FLEET_CONNECTIVITY.md.
 */
export interface LiveUpdateHandlers {
  /** Called per event, with the SSE `event:` name and the parsed `data:` payload. */
  onEvent: (name: string, data: unknown) => void
  /**
   * Called once the response is established, before any event arrives. Separate from `onEvent` so a
   * connected-but-quiet stream is distinguishable from one that has not connected at all — the
   * whole point of showing a connection indicator.
   */
  onConnect?: () => void
  /** Called when the stream drops and a reconnect is scheduled. */
  onDisconnect?: () => void
}

export interface LiveUpdateHandle {
  close: () => void
}

const BASE_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000

/**
 * How long a silent connection is tolerated. The backend sends a keep-alive comment every 30s, so
 * anything approaching twice that means the connection is dead even though the socket looks open.
 */
const IDLE_TIMEOUT_MS = 45_000

/**
 * Opens a stream and keeps it open, reconnecting with backoff until `close()` is called.
 *
 * Reconnection is ours to write here: the native `EventSource` would have handled it, and giving
 * that up is the cost of being able to authenticate. Backoff is capped so a backend that is down
 * does not get hammered by every open tab.
 */
export function openLiveUpdates(path: string, handlers: LiveUpdateHandlers): LiveUpdateHandle {
  let closed = false
  let retryMs = BASE_RETRY_MS
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | null = null

  /**
   * A dead connection does not always announce itself. A proxy holding the client side open, a
   * sleeping laptop or a NAT timeout all leave a socket that looks healthy and never delivers
   * anything — so silence is treated as failure rather than waited on indefinitely.
   *
   * Re-armed on every chunk, keep-alive comments included: that is what those comments are for, and
   * a keep-alive nothing checks is decoration.
   */
  function armWatchdog(attempt: AbortController): void {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => attempt.abort(), IDLE_TIMEOUT_MS)
  }

  /** Opens the stream with whatever access token is current. Read at call time, not captured. */
  function open(attempt: AbortController): Promise<Response> {
    return fetch(`${apiBaseUrl}${path}`, {
      headers: {
        Accept: 'text/event-stream',
        ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}),
      },
      signal: attempt.signal,
    })
  }

  async function connect(): Promise<void> {
    if (closed) return

    // One controller per attempt. A single shared one would stay aborted after the first timeout,
    // so every later reconnect would fail instantly.
    const attempt = new AbortController()
    controller = attempt

    try {
      let response = await open(attempt)

      // A 401 here is usually just an access token that aged out. The token is checked when the
      // request arrives and never again, so a stream outlives its own token and only finds out on
      // the next connect. One refresh, one retry.
      if (response.status === 401 && (await refreshSession())) response = await open(attempt)

      // Still refused. A 403 means the account lost the node and a second 401 means the session is
      // genuinely over; neither is fixed by reconnecting, so give up and let the next REST call
      // drive the user back to the login screen.
      if (response.status === 401 || response.status === 403) return

      if (!response.ok || !response.body) throw new Error(`Stream failed: ${response.status}`)

      retryMs = BASE_RETRY_MS
      handlers.onConnect?.()
      armWatchdog(attempt)
      await read(response.body, attempt)
    } catch {
      // Only an explicit close() stops the loop. A watchdog abort lands here too and *should*
      // reconnect, which is why this no longer bails out on AbortError.
      if (closed) return
    } finally {
      clearTimeout(watchdog)
    }

    if (closed) return
    handlers.onDisconnect?.()
    retryTimer = setTimeout(connect, retryMs)
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
  }

  async function read(body: ReadableStream<Uint8Array>, attempt: AbortController): Promise<void> {
    const reader = body.getReader()
    // Decoded incrementally with `stream: true`, since a chunk boundary can fall mid-character.
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) return

      armWatchdog(attempt)
      buffer += decoder.decode(value, { stream: true })

      // Events are separated by a blank line. A chunk can hold several, or half of one.
      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        dispatch(buffer.slice(0, split))
        buffer = buffer.slice(split + 2)
        split = buffer.indexOf('\n\n')
      }
    }
  }

  function dispatch(frame: string): void {
    let name = 'message'
    const data: string[] = []

    for (const line of frame.split('\n')) {
      // Comments keep the connection alive through proxies and carry nothing.
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }

    if (data.length === 0) return
    try {
      handlers.onEvent(name, JSON.parse(data.join('\n')))
    } catch {
      // A frame we cannot parse is not a reason to drop a working stream.
    }
  }

  void connect()

  return {
    close() {
      closed = true
      clearTimeout(retryTimer)
      clearTimeout(watchdog)
      controller?.abort()
    },
  }
}
