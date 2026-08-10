# Osmium frontend

Vue 3 / Vite single-page app: the operator dashboard for the agent fleet.

Not a meta-framework. The backend is a standalone JWT API, so there is no SEO need and no
server-side session to render against — a static bundle behind nginx does the job and deploys as
files rather than a Node process.

## Running it

Needs **Node 24** and a backend on `:8080`.

```bash
npm install
npm run dev        # :5173, proxies /api to the backend
```

The dev proxy keeps things same-origin, which is why the backend needs no CORS configuration.

| Script | Does |
|---|---|
| `npm run dev` | dev server with HMR |
| `npm run build` | type-check with `vue-tsc`, then bundle |
| `npm test` | Vitest unit suite |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | ESLint |
| `npm run api:generate` | regenerate `src/api/schema.d.ts` from `openapi.json` |

## Talking to the backend

API types are **generated from the backend's OpenAPI document**, so `UserResponse`, `AgentState` and
the rest come straight from the Kotlin. Rename a field in the backend and this fails to compile.

```bash
curl -s localhost:8080/v3/api-docs -o openapi.json
npm run api:generate
```

`openapi.json` is committed so codegen works without a running backend — but it is only as current
as the last time someone refreshed it. Re-run both commands after changing the API.

One wrinkle worth knowing: springdoc marks every property optional, because it does not derive
`required` from Kotlin's non-null types. `src/api/client.ts` asserts them with `Required<…>` at the
boundary rather than sprinkling `?.` through every component. That is an assertion, not a guarantee
the document makes.

### What is real and what is mock

Hosts, agents, their lifecycle states, all commands, the **audit log** and **live updates** are
real. Telemetry, chat and build progress are **mock**, and marked as such in `src/stores/agents.ts`
— nothing reports them until a host connects.

## Live updates

`src/api/liveUpdates.ts` is a small fetch-based SSE client. The browser's native `EventSource`
cannot set an `Authorization` header, and the token is a Bearer token — putting it in the query string would
land it in access logs and referrers, and cookies would reintroduce CSRF. Reading the stream from a
`fetch` body keeps the Bearer pattern unchanged. The cost is that reconnection is ours to write, so
it backs off from 1s to 30s and gives up entirely on 401 or 403, which retrying cannot fix.

`AppLayout` holds one stream open for the session. Events land in the store's `applyEvent`, which is
the seam between transport and state — exported so the ingest is testable without a socket.

**Silence is treated as failure.** A dead connection does not always announce itself: a proxy
holding the client side open, a sleeping laptop or a NAT timeout all leave a socket that looks
healthy and delivers nothing. The client re-arms a 45s watchdog on every chunk — keep-alive comments
included, since that is what they are for — and aborts to reconnect when it fires. Without it the
disconnected indicator only reacts to errors the browser happens to notice, which in dev behind the
Vite proxy can be never.

**Commands no longer refetch.** Anything that changes stored state publishes an event that arrives
before the response is written, so a refetch would only re-read what the stream already applied.

The audit log filters client-side. That is a deliberate limit, not an oversight: with a 30-day
retention and a row per command rather than per event, the whole window fits in memory. Server-side
search becomes worth building when that stops being true.

## Authorization in the UI

`GET /api/auth/me` returns the account's flattened permission nodes, and the UI gates on the same
strings the backend checks:

```ts
v-if="auth.can('fleet.chat')"      // hides what @PreAuthorize would reject
```

Same source of truth, so there is no duplicated role logic. Route guards use `meta.node`.

## Tests

```bash
npm test
```

52 unit tests on Vitest with jsdom. They cover the parts where a bug is invisible until someone is
locked out or over-privileged: the route guard, the auth store, the API client's middleware, and the
fleet store's derived state.

No component or browser tests. That is a deliberate limit rather than an omission — every frontend
bug so far has been a **daisyUI class or CSS selector** problem, and jsdom evaluates no CSS, so a
mounted-component test would have caught none of them. Only a real browser would.

`src/test/setup.ts` replaces `globalThis.fetch` before any module imports the API client, because
openapi-fetch resolves `fetch` once when `createClient` runs — a stub installed inside a test would
never be seen. Tests declare responses through `respondWith` and inspect what was sent via `calls`.

## Security posture

The access token lives in **`localStorage`**. That is a deliberate trade: it survives a reload, but
an XSS would expose a token valid for its full TTL. There are no refresh tokens, so the alternative
was re-authenticating on every reload.

Two mitigations carry that decision, and both matter more once real agent credentials are in play:

- **A strict CSP** is served by nginx in production — `script-src 'self'` with no `unsafe-inline`,
  so an injected script simply does not execute. See `nginx.conf.template`.
- **`vue/no-v-html` is an error**, not a warning. `v-html` is the main XSS vector in a Vue app.

## Theme

daisyUI 5 on Tailwind 4, configured CSS-first in `src/style.css`. The base ramp is evenly spaced and
tinted toward the primary green; `--depth: 0` means borders, not shadows, do the separating.

## Docker

Two-stage: Node builds the bundle, nginx serves it.

```bash
docker build -t osmium-frontend .
docker run -p 8080:80 -e BACKEND_URL=http://backend:8080 osmium-frontend
```

`BACKEND_URL` is a **runtime** variable — the nginx config is a template that gets substituted at
start-up, so one image works across environments. `/api` is proxied there, keeping the SPA
same-origin, and unknown paths fall through to `index.html` for `createWebHistory`.

The upstream is resolved per request through a configurable `DNS_RESOLVER` rather than at boot. A
literal `proxy_pass` makes nginx resolve the host on start-up, so the container crash-looped when it
started before the backend; now it boots and returns 502 until the backend appears.

## CI

`.github/workflows/frontend-tests.yml` runs the suite, ESLint and the `vue-tsc` build on pull
requests touching `frontend/`. All three run even after one fails, so a lint error never hides the
test results; any failure fails the job. Failing tests become inline annotations and a job summary
table.

`.github/workflows/frontend-image.yml` builds and pushes the image to
`ghcr.io/integr-dev/osmium/frontend`, tagged from the `version` in `package.json`. It **calls the
test workflow first** and gates publishing on it with `needs`, so a failing suite means no image.
That is also why the test workflow has no `push` trigger: on `main` this one drives it, and the
suite runs once instead of twice.

## Layout

```
src/api/         generated schema, typed client, token storage, live-update client
src/components/  FormField, the add-host and add-agent modals
src/layouts/     AppLayout: sidebar, nav, drawer
src/lib/         presentation maps for agent state, roles, node labels and login methods
src/router/      routes and node-based guards
src/stores/      auth and fleet state (Pinia)
src/test/        Vitest setup and the fetch stub
src/views/       dashboard, hosts, agent detail, accounts, audit log, login
```

Specs sit next to what they test as `*.spec.ts`, so `vue-tsc` type-checks them with everything else.
