import createClient, { type Middleware } from 'openapi-fetch'
import type { paths, components } from './schema'
import { t } from '../i18n'
import { apiBaseUrl } from './base'
import { backendEverReached, backendReachable } from './reachability'
import { refreshSession } from './session'
import { token } from './token'

/**
 * The generated schema marks every property optional: springdoc does not emit `required` for
 * Kotlin's non-null types, so the document is weaker than the DTOs behind it. The backend always
 * sends these fields, so assert that here rather than sprinkling `?.` through every component.
 */
export type UserResponse = Required<components['schemas']['UserResponse']>
export type RoleResponse = Required<components['schemas']['RoleResponse']>
export type HostResponse = Required<components['schemas']['HostResponse']>
/**
 * `position` is the second genuinely nullable field, alongside `telemetry`: the host may know a
 * player is nearby without a usable position, and null says so rather than inventing coordinates.
 * Its own x/y/z still need asserting, since the backend sends all three or nothing.
 */
export type NearbyPlayerResponse = Required<components['schemas']['NearbyPlayerResponse']> & {
  position: Required<components['schemas']['PositionResponse']> | null
}

/** Nested objects need asserting too — `Required` only reaches the top level. */
export type AgentTelemetryResponse = Required<components['schemas']['AgentTelemetryResponse']> & {
  position: Required<components['schemas']['PositionResponse']>
  nearby: NearbyPlayerResponse[]
}

/**
 * `telemetry` is the one field that is genuinely nullable rather than merely undocumented: null is
 * the backend saying this agent has not reported recently, which is different from zero.
 */
export type AgentResponse = Required<components['schemas']['AgentResponse']> & {
  telemetry: AgentTelemetryResponse | null
}
/**
 * `clientIp` and `userAgent` are genuinely nullable: they are whatever the request happened to
 * carry, and a deployment that does not pass proxy headers through records neither.
 */
export type SessionResponse = Required<components['schemas']['SessionResponse']> & {
  clientIp: string | null
  userAgent: string | null
}
export type AuditEntryResponse = Required<components['schemas']['AuditEntryResponse']>

/**
 * `contentHash` and `failure` are genuinely nullable, and so is every field of `content`: nothing
 * inside a schematic is known until the file has been read through, which is minutes after the row
 * exists.
 */
export type SchematicResponse = Required<components['schemas']['SchematicResponse']> & {
  contentHash: string | null
  failure: string | null
  content: components['schemas']['SchematicContentResponse']
}
export type MaterialResponse = Required<components['schemas']['MaterialResponse']>
export type SegmentResponse = Required<components['schemas']['SegmentResponse']>

/**
 * `Omit` rather than an intersection, unlike the ones above. Intersecting an array does not replace
 * its element type — `Segment[] & OptionalSegment[]` still indexes to something optional — so the
 * assertion has to remove the property before adding it back.
 */
export type SplitResponse = Omit<
  Required<components['schemas']['SplitResponse']>,
  'segments'
> & { segments: SegmentResponse[] }
export type ChatMessageResponse = Required<components['schemas']['ChatMessageResponse']>
export type ActivityEntryResponse = Required<components['schemas']['ActivityEntryResponse']>


/** Not in the document either - the @RestControllerAdvice return type is never scanned. */
export type ApiError = { message?: string }

/**
 * What a transport failure is reported as. Not a real HTTP status — the request never got far
 * enough to have one — but callers already branch on `error`, and inventing a status keeps every
 * one of them working without a second failure path.
 */
export const UNREACHABLE_STATUS = 599
export const UNREACHABLE_MESSAGE = t('errors.unreachable')

/**
 * Gateway failures, which mean the proxy in front of the backend could not reach it. Both dev and
 * production put a proxy in the path — Vite and nginx — so a dead backend usually arrives as a 502
 * rather than as a transport error, and treating only the latter as "unreachable" misses the case
 * that actually happens.
 *
 * **503 is deliberately absent.** The API returns it when a host has no live connection, which is a
 * real answer from a healthy backend. Folding it in here would report the backend as down every
 * time an agent's host was offline.
 */
const GATEWAY_STATUSES = new Set([502, 504])

/** True when a failure was the network rather than a rejection from the API. */
export function isUnreachable(error: unknown): boolean {
  return errorMessage(error, '') === UNREACHABLE_MESSAGE
}

/** Written here and in `session.ts`; re-exported so this stays the one module callers import. */
export { backendReachable, backendEverReached } from './reachability'

let onUnauthorized: (() => void) | null = null

/** Wired up in main.ts, once the router exists, to avoid a router/store import cycle. */
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler
}

const auth: Middleware = {
  onRequest({ request }) {
    if (token.value) request.headers.set('Authorization', `Bearer ${token.value}`)
    return request
  },
  async onResponse({ request, response }) {
    // A gateway error is the proxy saying it could not reach the backend, so it is reshaped into
    // the same result a transport failure produces. Its body is the proxy's HTML, which would
    // otherwise surface to the operator as an unhelpful fallback message.
    if (GATEWAY_STATUSES.has(response.status)) {
      backendReachable.value = false
      return unreachableResponse()
    }

    // A response this middleware synthesised for a transport failure comes back through here, so
    // it must not be read as proof of life.
    if (response.status !== UNREACHABLE_STATUS) {
      // Any other answer — including a 403, or the 503 that means a host is offline — proves the
      // backend itself is up.
      backendReachable.value = true
      backendEverReached.value = true
    }

    // The access token has expired, or the account was removed or renamed. The first is routine —
    // access tokens are minted for half an hour and refreshed silently — so a 401 asks for a new
    // one and replays the request rather than ending the session.
    //
    // Retried exactly once. If the replay 401s too the session is genuinely over, and a loop here
    // would be a request storm against a backend that has already said no.
    if (response.status === 401 && !isSessionCall(request.url)) {
      const resumed = await refreshSession()
      if (!resumed) {
        onUnauthorized?.()
        return response
      }
      // A fresh Request: the original is consumed, and its Authorization header holds the token
      // that just failed.
      const retry = new Request(request.url, request)
      retry.headers.set('Authorization', `Bearer ${token.value}`)
      return fetch(retry)
    }

    return response
  },
  /**
   * openapi-fetch returns `{ error }` for an HTTP error *response*, but **throws** when the
   * transport fails — a dead backend, DNS, an offline laptop. Every call site handled the first
   * case only, so an unreachable backend surfaced as an unhandled rejection with no error state,
   * and the UI rendered its empty state: indistinguishable from "nothing configured yet".
   *
   * Converting it here rather than at each call site means one failure path instead of two.
   * Deliberately does **not** clear the session: unreachable is not logged out, and dropping a
   * token over a blip would cost the operator their session for no reason.
   */
  onError() {
    backendReachable.value = false
    return unreachableResponse()
  },
}

/**
 * The three endpoints that manage the session itself. A 401 from one of them is the answer, not a
 * prompt to go and get a new token — refreshing in response to a failed refresh is a loop.
 */
function isSessionCall(url: string): boolean {
  return SESSION_PATHS.some((path) => url.includes(path))
}

const SESSION_PATHS = ['/api/auth/login', '/api/auth/refresh', '/api/auth/logout']

function unreachableResponse(): Response {
  return new Response(JSON.stringify({ message: UNREACHABLE_MESSAGE }), {
    status: UNREACHABLE_STATUS,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const api = createClient<paths>({ baseUrl: apiBaseUrl })

api.use(auth)

/** Pulls the message out of an ApiError body, falling back to something printable. */
export function errorMessage(error: unknown, fallback = t('errors.generic')): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as ApiError).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return fallback
}
