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

  // Module state, and nothing else clears it: the access token lives in memory only, so it would
  // otherwise leak from one test into the next.
  token.value = null
})
