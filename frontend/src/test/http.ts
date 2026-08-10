/**
 * A fetch stub standing in for the backend.
 *
 * It has to be installed on `globalThis` before `src/api/client.ts` is ever imported, because
 * openapi-fetch resolves `globalThis.fetch` once, when `createClient` runs. `setup.ts` does that;
 * a `vi.stubGlobal` inside a test would be too late to be seen.
 */

export interface RecordedCall {
  url: string
  method: string
  headers: Headers
  /** Parsed request body, or null when the request had none. */
  body: unknown
}

export interface StubReply {
  status?: number
  body?: unknown
  /**
   * Serve this stream as the response body instead of JSON-encoding `body`. Needed for the
   * server-sent-event client, which is only interesting while a response is still open.
   */
  stream?: ReadableStream<Uint8Array>
}

type Responder = (call: RecordedCall) => StubReply

export const calls: RecordedCall[] = []

const ok: Responder = () => ({ status: 200, body: {} })
let responder: Responder = ok

/** Answers every request for the rest of the test. Inspect `calls` for what was sent. */
export function respondWith(next: Responder): void {
  responder = next
}

export function resetHttp(): void {
  calls.length = 0
  responder = ok
}

export function lastCall(): RecordedCall {
  const call = calls.at(-1)
  if (!call) throw new Error('Expected a request, but none was made')
  return call
}

/**
 * Makes a response body fail when the request is aborted, which a real `fetch` does for free. The
 * stub does not, so without this an abort is invisible to the reader and anything that cancels a
 * stream — the live-update watchdog, for one — looks broken when it is working.
 */
function abortable(stream: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const source = stream.getReader()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener('abort', () =>
        controller.error(new DOMException('The operation was aborted.', 'AbortError')),
      )
    },
    async pull(controller) {
      const { done, value } = await source.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
  })
}

export async function stubFetch(input: Request | string, init?: RequestInit): Promise<Response> {
  // openapi-fetch hands over a built Request; the live-update client calls fetch(url, init). Both
  // have to work, and getting this wrong makes a request vanish silently rather than fail loudly.
  const request = input instanceof Request ? input : new Request(input, init)
  const raw = await request.clone().text()
  const call: RecordedCall = {
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: raw.length > 0 ? JSON.parse(raw) : null,
  }
  calls.push(call)

  const { status = 200, body = {}, stream } = responder(call)
  if (stream) {
    return new Response(abortable(stream, request.signal), {
      status,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
