import { beforeEach } from 'vitest'
import { token } from '../api/token'
import { resetHttp, stubFetch } from './http'

// Before any test module is imported, so the API client binds to this rather than the real fetch.
globalThis.fetch = stubFetch as typeof globalThis.fetch

beforeEach(async () => {
  resetHttp()

  // Imported here rather than at the top: `createClient` captures `globalThis.fetch` when the
  // module first loads, so a static import would run it before the line above and every request
  // would bypass the stub. Deferring to the first `beforeEach` keeps that ordering intact.
  const { backendReachable, backendEverReached } = await import('../api/client')
  backendReachable.value = true
  backendEverReached.value = false

  // The token ref is module state read from localStorage once at import; clearing storage alone
  // would not reset it, so reset the ref and let its watcher clear storage.
  token.value = null
})
