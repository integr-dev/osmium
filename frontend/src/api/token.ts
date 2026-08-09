import { ref, watch } from 'vue'

const STORAGE_KEY = 'osmium.token'

/**
 * The access token, persisted so a reload does not log the user out.
 *
 * Deliberate tradeoff: localStorage survives reloads, but an XSS bug would expose a token valid
 * for its full TTL. The backend issues no refresh tokens, so the alternative was re-authenticating
 * on every reload. No CSP or lint guard is configured yet - both are still outstanding.
 */
export const token = ref<string | null>(localStorage.getItem(STORAGE_KEY))

watch(token, (value) => {
  if (value) localStorage.setItem(STORAGE_KEY, value)
  else localStorage.removeItem(STORAGE_KEY)
})
