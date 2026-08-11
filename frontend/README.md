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

Hosts, agents, their lifecycle states, all commands, the **audit log**, **chat**, **activity**,
**telemetry** and **live updates** are real. They stay empty until a host connects and starts
reporting, but nothing about them is faked.

Only **build progress** is still mock — blocks placed, sectors, throughput, the schematic. It hangs
off `agent.build` rather than `agent.telemetry`, so the invented and the reported are not mixed in
one object. Marked in `src/stores/agents.ts`.

Telemetry is **absent rather than zeroed** when an agent has not reported: `agent.telemetry` is
null, the vitals panel says so, and **Needs attention** raises nothing. Zeroes would render as an
agent on no health standing at the world origin, which is a much more convincing lie than an empty
panel.

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

**What arrives depends on the account, not the endpoint.** One stream carries the fleet, the account
list, the audit trail and the reader's own permissions, and the backend filters each event against
the subscriber's nodes — so an orchestrator watching the same URL simply never sees `audit`.

The `permissions` event is the odd one, and the reason it exists: authorities resolve per request on
the backend, so a role change bites immediately there, while the browser learned what it may do once
at login. Without it the UI keeps offering buttons that now 403, which reads as a bug rather than as
access having changed. It is applied in the fleet store's `applyEvent` — not because permissions are
fleet state, but because there is one stream and therefore one ingest.

## Paged feeds

The audit log, activity and chat are all long enough that no view holds one. They page by **cursor
and scroll**: `src/lib/feed.ts` has `useFeed`, which owns the items and the cursor, and
`useInfiniteScroll`, which watches a sentinel element and asks for the next page when it comes into
view. `src/api/feeds.ts` is the three requests behind them.

Two things there exist because of a real failure mode:

- **A short page leaves the sentinel still on screen**, and an IntersectionObserver does not fire
  again for an element that never left. `rearm` re-observes it, which asks for the current state.
- **A failed request marks the feed exhausted.** Otherwise the observer retries against a backend
  that is not answering, on every scroll event. Scrolling away and back re-arms it, which is the
  retry.

Search is **server-side**, which came with paging rather than as a separate improvement: a filter
over only the rows already fetched would search the newest hundred of a thirty-day trail and report
"nothing matches", which reads as an answer rather than as a limit.

### Exporting the audit log

`src/api/auditExport.ts` is deliberately not built on the generated client: openapi-fetch parses
the body, which is the point of it everywhere else and exactly wrong for an attachment. The token is
a header, so the browser cannot simply be navigated to the URL — the blob is assembled and handed to
a synthetic anchor instead.

The pickers hold a **day**, not an instant, and each is converted to the matching local instant
before it is sent. `toISOString` on a picked date would shift the day for anyone not on UTC, and the
operator asking for "the 11th" means their own. The end day is inclusive on screen and exclusive on
the wire, so the request asks for the start of the day after.

The CSV itself is English whatever the interface is set to — see the backend README for why.

Live lines are not accumulated in the store — it has no way to know which page one belongs on. The
store hands `chat`, `activity`, `audit`, `user` and `user-removed` events to whichever view is
showing the matching list, via `onFeedEvent`, and that view prepends or replaces.

A live audit entry is only prepended **while the search box is empty**. It has not been through the
server-side search, so prepending it during one would put a row on screen that does not match what
was typed.

## When the backend is unreachable

Two failures that look identical on screen are treated differently.

**Never reached it this session** — the app is withheld and a retry card shown instead. A dashboard
of zeroes reads as "no agents configured", which is the wrong conclusion to invite.

**Reached it and then lost it** — the app stays, with a sidebar icon saying so and offering a retry.
The data was really loaded, so it is still worth something; only its freshness is in doubt.

Two icons, never both. `ServerOff` means the backend is unreachable and nothing is updating;
`WifiOff` means the backend answers but the event stream does not. The second is conditioned on the
first being fine, because a dead backend takes the stream with it — and when both fired they said
the same thing twice, with the stream noticing up to 45s later than the first failed request.

`backendReachable` and `backendEverReached` live in `src/api/client.ts` rather than a store, so every
call updates them — including the account lookup a viewer makes without ever touching the fleet.

Two things make this work that are easy to get wrong:

- **openapi-fetch throws on a transport failure** rather than returning `{ error }`. An `onError`
  middleware turns that into an ordinary error result, so call sites have one failure path, not two.
- **A dead backend usually arrives as a 502, not a transport error**, because both dev and
  production proxy `/api`. Handling only the transport case misses what actually happens. 503 is
  deliberately excluded — the API returns it when an agent's host is offline, which is a real answer
  from a healthy backend.

Unreachable never clears the session. It says nothing about whether the token is valid, and dropping
it over a blip would cost the operator their session.

## Copy

Every string the operator sees lives in `src/i18n/`, one file per locale — English and German. The
value is not only translation but having a single place where the product's voice is decided,
instead of it accumulating in templates a phrase at a time.

English is the source. `Copy` in `en.ts` is the shape every other locale is typed against, so a key
added there and not translated **fails the build** rather than falling back silently at runtime.
Three things a type cannot see are tested instead: that the key sets really match, that a
translation keeps every `{placeholder}`, and that it keeps the same number of `|` plural forms. Each
of those fails silently — a dropped placeholder renders the phrase without the value, a dropped
plural form loses the singular.

**Nothing user-facing is written in a component.** That includes error fallbacks in `<script>` and
the task and alert wording the fleet store derives — those were the last places English leaked
through with a locale selected. The rule is worth stating because the compiler cannot enforce it:
a string literal in a template is legal code.

The picker is at the bottom of the sidebar. Switching is instant, since every component reads its
copy through `useI18n()`; the choice persists in `localStorage` and moves `<html lang>` with it. A
first visit follows `navigator.languages`, and an explicit choice outranks it from then on.

Components read copy with `useI18n()`. Code that is not a component — stores, presentation maps —
imports `t` from `src/i18n` directly. Those calls resolve at call time, so they follow the locale as
long as the caller re-renders.

Two rules for anything added:

- **Say what happened and what to do, not why the code works that way.** Design reasoning belongs in
  comments and in `FLEET_CONNECTIVITY.md`. A message that explains it asks the reader to care about
  a decision they cannot act on.
- **Never call Osmium "the server".** In this product a server is a *Minecraft* server, so Osmium is
  named directly and its parts are hosts and agents.

One trap worth knowing: **vue-i18n reads a dot in a key as a path separator**. Permission nodes
contain dots (`fleet.chat`), so `t('permission.fleet.chat')` looks for `permission → fleet → chat`,
finds nothing, and silently returns the key. `nodeLabel` therefore indexes the copy object directly
rather than going through `t()` — which means picking the locale by hand too — and `i18n.spec.ts`
pins that.

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

85 unit tests on Vitest with jsdom. They cover the parts where a bug is invisible until someone is
locked out or over-privileged: the route guard, the auth store, the API client's middleware, the
fleet store's derived state, the cursor paging in `useFeed` — where a cursor that is not carried
forward silently re-reads page one — and translation parity, where a missing placeholder swallows a
value without erroring.

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
src/api/         generated schema, typed client, token storage, live-update and feed clients
src/components/  FormField, the add-host and add-agent modals, the server chat modal, the language picker
src/layouts/     AppLayout: sidebar, nav, drawer
src/i18n/        every user-facing string, one file per locale
src/lib/         cursor-paged feeds, presentation maps for agent state, roles and permissions
src/router/      routes and node-based guards
src/stores/      auth and fleet state (Pinia)
src/test/        Vitest setup and the fetch stub
src/views/       dashboard, hosts, agent detail, accounts, audit log, login
```

Specs sit next to what they test as `*.spec.ts`, so `vue-tsc` type-checks them with everything else.
