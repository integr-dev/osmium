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

export async function stubFetch(request: Request): Promise<Response> {
  const raw = await request.clone().text()
  const call: RecordedCall = {
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: raw.length > 0 ? JSON.parse(raw) : null,
  }
  calls.push(call)

  const { status = 200, body = {} } = responder(call)
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
