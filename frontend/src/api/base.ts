/**
 * Where the API lives.
 *
 * Empty in both supported deployments, which proxy `/api` and are therefore same-origin. It sits in
 * its own module rather than in `client.ts` because the generated client is not the only thing that
 * calls the API — the session, player heads and the audit export are all hand-written — and having
 * those import it from the client would make a cycle out of a single string.
 */
export const apiBaseUrl: string = import.meta.env.VITE_API_BASE_URL ?? ''
