import { token } from './token'

/**
 * A minimal server-sent-events client built on `fetch`.
 *
 * The browser's native `EventSource` cannot set an `Authorization` header, and the access token is
 * a Bearer token. Putting it in the query string would land it in access logs and referrers, and
 * moving to cookies would reintroduce CSRF — so the stream is read from a `fetch` body instead,
 * which keeps the Bearer pattern unchanged. See FLEET_CONNECTIVITY.md.
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
 * Opens a stream and keeps it open, reconnecting with backoff until `close()` is called.
 *
 * Reconnection is ours to write here: the native `EventSource` would have handled it, and giving
 * that up is the cost of being able to authenticate. Backoff is capped so a backend that is down
 * does not get hammered by every open tab.
 */
export function openLiveUpdates(path: string, handlers: LiveUpdateHandlers): LiveUpdateHandle {
  const controller = new AbortController()
  let closed = false
  let retryMs = BASE_RETRY_MS
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  async function connect(): Promise<void> {
    if (closed) return

    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ''}${path}`, {
        headers: {
          Accept: 'text/event-stream',
          ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}),
        },
        signal: controller.signal,
      })

      // A 401 or 403 will not fix itself by retrying: the session is gone or the account lost the
      // node. Give up and let the next REST call drive the user back to the login screen.
      if (response.status === 401 || response.status === 403) return
      if (!response.ok || !response.body) throw new Error(`Stream failed: ${response.status}`)

      retryMs = BASE_RETRY_MS
      handlers.onConnect?.()
      await read(response.body)
    } catch (failure) {
      if (closed || (failure instanceof DOMException && failure.name === 'AbortError')) return
    }

    if (closed) return
    handlers.onDisconnect?.()
    retryTimer = setTimeout(connect, retryMs)
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
  }

  async function read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    // Decoded incrementally with `stream: true`, since a chunk boundary can fall mid-character.
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) return

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
      controller.abort()
    },
  }
}
