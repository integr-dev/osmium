import createClient, { type Middleware } from 'openapi-fetch'
import { ref } from 'vue'
import type { paths, components } from './schema'
import { t } from '../i18n'
import { token } from './token'

/**
 * The generated schema marks every property optional: springdoc does not emit `required` for
 * Kotlin's non-null types, so the document is weaker than the DTOs behind it. The backend always
 * sends these fields, so assert that here rather than sprinkling `?.` through every component.
 */
export type UserResponse = Required<components['schemas']['UserResponse']>
export type RoleResponse = Required<components['schemas']['RoleResponse']>
export type HostResponse = Required<components['schemas']['HostResponse']>
export type AgentResponse = Required<components['schemas']['AgentResponse']>
export type AuditEntryResponse = Required<components['schemas']['AuditEntryResponse']>

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

/**
 * Whether the last request reached the backend at all. Lives here rather than in a store so every
 * call updates it, including the account lookup a viewer makes without ever touching the fleet.
 */
export const backendReachable = ref(true)

/**
 * Whether the backend has *ever* answered this session. It separates the two failures that look
 * identical otherwise: never got started, versus was working and went away. The first has nothing
 * worth showing, the second has data on screen that is merely stale.
 */
export const backendEverReached = ref(false)

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
  onResponse({ request, response }) {
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

    // The token expired or the account was removed/renamed. There is no refresh flow by design,
    // so drop the session and let the user log in again. Login itself must not trigger this.
    if (response.status === 401 && !request.url.endsWith('/api/auth/login')) {
      token.value = null
      onUnauthorized?.()
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

function unreachableResponse(): Response {
  return new Response(JSON.stringify({ message: UNREACHABLE_MESSAGE }), {
    status: UNREACHABLE_STATUS,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const api = createClient<paths>({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
})

api.use(auth)

/** Pulls the message out of an ApiError body, falling back to something printable. */
export function errorMessage(error: unknown, fallback = t('errors.generic')): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as ApiError).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return fallback
}
