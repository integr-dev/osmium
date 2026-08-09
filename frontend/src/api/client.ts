import createClient, { type Middleware } from 'openapi-fetch'
import type { paths, components } from './schema'
import { token } from './token'

/**
 * The generated schema marks every property optional: springdoc does not emit `required` for
 * Kotlin's non-null types, so the document is weaker than the DTOs behind it. The backend always
 * sends these fields, so assert that here rather than sprinkling `?.` through every component.
 */
export type UserResponse = Required<components['schemas']['UserResponse']>
export type RoleResponse = Required<components['schemas']['RoleResponse']>

/** Not in the document either - the @RestControllerAdvice return type is never scanned. */
export type ApiError = { message?: string }

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
    // The token expired or the account was removed/renamed. There is no refresh flow by design,
    // so drop the session and let the user log in again. Login itself must not trigger this.
    if (response.status === 401 && !request.url.endsWith('/api/auth/login')) {
      token.value = null
      onUnauthorized?.()
    }
    return response
  },
}

export const api = createClient<paths>({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
})

api.use(auth)

/** Pulls the message out of an ApiError body, falling back to something printable. */
export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as ApiError).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return fallback
}
