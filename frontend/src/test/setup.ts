import { beforeEach } from 'vitest'
import { token } from '../api/token'
import { resetHttp, stubFetch } from './http'

// Before any test module is imported, so the API client binds to this rather than the real fetch.
globalThis.fetch = stubFetch as typeof globalThis.fetch

beforeEach(() => {
  resetHttp()
  // The token ref is module state read from localStorage once at import; clearing storage alone
  // would not reset it, so reset the ref and let its watcher clear storage.
  token.value = null
})
