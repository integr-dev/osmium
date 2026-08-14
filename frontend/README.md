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

Two things are still mock. **Build progress** — blocks placed, sectors, throughput, the schematic —
hangs off `agent.build` rather than `agent.telemetry`, so the invented and the reported are not
mixed in one object. Marked in `src/stores/agents.ts`.

**Configuration** is mock end to end: `src/lib/configuration.ts` holds the field list, the values
and a `saveSettings` that writes to a map in that module and resolves. Nothing reaches a host, and
the screen says so in a banner rather than only in a comment. It is kept out of the fleet store for
the same reason build progress is — a mock inside real state is one that outlives its purpose.

What is meant to survive that mock is the **shape**: fields are declared as a schema and rendered
generically by type, so adding a setting later is an entry in that file plus a copy key, not another
block of markup. The field list itself is a placeholder, not a specification.

**Operations** holds the first real fleet-wide action: assigning a server to a group of agents. It
lives there rather than on Configuration deliberately — Configuration is mock end to end, and one
real field among invented ones is how a mock stops being obvious. Both screens share
`AgentPicker.vue`, so the two lists cannot drift apart.

### An agent may have no server

`serverAddress` is nullable. An agent assigned nowhere is set up and idle: it cannot connect, the
button is disabled, and it contributes no entry to **Active servers**. That state used to be faked
by pointing an agent at a server it was not connected to, which then appeared in that list with
nobody on it.

Assignment is its own action — a dialog on the agent page, and in bulk on Operations — rather than a
field on the edit, because it is a different kind of change: a rename is cosmetic and always
allowed, while this decides what the next connection targets and is refused while the agent is
online. Every place the address is displayed names the empty case rather than showing a blank.

Telemetry is **absent rather than zeroed** when an agent has not reported: `agent.telemetry` is
null, the vitals panel says so, and **Needs attention** raises nothing. Zeroes would render as an
agent on no health standing at the world origin, which is a much more convincing lie than an empty
panel.

## Charts

Every figure the API reports is **instantaneous** — how many agents are online, what the throughput
is, where an agent is standing. There is no series to ask for, because nothing stores one.

So the browser keeps its own. `src/stores/history.ts` samples the live figures every ten seconds and
holds the last half hour, which is what the sparklines under the stat tiles draw. That makes them
**session-scoped by construction**: a reload starts an empty chart, and the caption says how much
past there is rather than letting an empty chart read as an idle fleet. A durable series would be a
table, an endpoint and a retention policy — this is the version that pays for itself immediately.

**Incidents per hour** is different: it is real stored data, bucketed client-side from the activity
page already on screen. The window stops at the oldest entry loaded rather than running a fixed
twelve hours back — the feed is paged, so earlier hours are not empty, they are *unread*, and
drawing them as empty bars would state something the client cannot know.

`src/lib/series.ts` holds the geometry, away from the components, because the cases that actually
break a sparkline are arithmetic: nothing sampled yet, one sample, and a series that never moves are
all divide-by-zero, and all three look like a bug on screen rather than throwing. Marks follow the
usual rules — one series each, so no legend and no palette to validate; the heading names it.

## Command palette

**Ctrl/⌘-K** from anywhere in the app: jump to a page, an agent or a host; connect and disconnect an
agent; point the chat rail at a server; add an agent; reload the fleet; switch language. The sidebar carries a button showing the shortcut for the
platform it is running on — a shortcut is invisible by nature, and one nobody knows about is one
nobody uses.

`src/lib/commands.ts` holds both parts worth testing, away from the component:

- **What is offered.** Gated on exactly the nodes the route guard and the API check, so the palette
  never hands back a 403 for a keystroke that looked like it should work. Actions appear only when
  they would currently go through — right state, a server to connect to, a host that has been heard
  from — and **deleting is deliberately absent**: a palette is for fast reversible moves, and one
  wrong Enter should not destroy anything.
- **What ranks first.** Matching is a **subsequence**, not a substring, so `eu1a1` finds
  `eu-1-agent-1` — which is the shape of name a fleet actually gets and exactly what substring
  search misses. The score is how far the match had to travel, so tight hits beat scattered ones,
  and a hit on the name always beats one on the second line.

The list is rebuilt on every open rather than cached: the fleet moves underneath it, and a stale
list would offer to connect an agent that is already online.

## Live updates

`src/api/liveUpdates.ts` is a small fetch-based SSE client. The browser's native `EventSource`
cannot set an `Authorization` header, and the access token is a Bearer token — putting it in the
query string would land it in access logs and referrers, and moving it to a cookie would reintroduce
CSRF on every route. Reading the stream from a `fetch` body keeps the Bearer pattern unchanged. The
cost is that reconnection is ours to write, so it backs off from 1s to 30s.

A **401 is retried once** after a refresh. The token is checked when the request arrives and never
again, so a stream outlives its own access token and only discovers it on the next connect — that is
routine, not an expiry. A second 401, or a 403, is not fixed by reconnecting and stops the loop.

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

**Chat is the exception to newest-first.** The audit log and activity are logs being read, so
downwards means older. Chat has a send box under it, which makes it a conversation — and a
conversation whose newest line is nowhere near the box you type into is one nobody can follow. The
panel gets that from `flex-col-reverse`: the array stays newest-first like every other feed, the
browser pins the view to the bottom as lines arrive, and the sentinel ends up visually at the top
without `useInfiniteScroll` knowing anything changed.

Search is **server-side**, which came with paging rather than as a separate improvement: a filter
over only the rows already fetched would search the newest hundred of a thirty-day trail and report
"nothing matches", which reads as an answer rather than as a limit.

### Exporting the audit log

`src/api/auditExport.ts` is deliberately not built on the generated client: openapi-fetch parses
the body, which is the point of it everywhere else and exactly wrong for an attachment. The access
token is a header, so the browser cannot simply be navigated to the URL — the blob is assembled and
handed to a synthetic anchor instead.

The pickers hold a **day**, not an instant, and each is converted to the matching local instant
before it is sent. `toISOString` on a picked date would shift the day for anyone not on UTC, and the
operator asking for "the 11th" means their own. The end day is inclusive on screen and exclusive on
the wire, so the request asks for the start of the day after.

The CSV itself is English whatever the interface is set to — see the backend README for why.

## The tab

A fleet is watched out of the corner of an eye, so `src/lib/browserStatus.ts` uses the two things a
browser shows a background tab. The **title** rotates every five seconds through what is worth a
glance — `Osmium · 3/4 in game`, `Osmium · 62% built`, `Osmium · ETA 14m` — and collapses to one
frame when the backend stops answering, because a title cycling through numbers that stopped being
true reads as a live fleet. The name stays in front of every frame: a tab reading "62% built" on its
own says nothing about which of a dozen tabs it is, which is the first thing a tab has to answer.

The **favicon** carries a connection dot: green, amber for a lost event stream, red for a backend
that is not answering. It is built by splicing a `<circle>` into `logo.svg` rather than by drawing on
a canvas, so it stays sharp on a scaled display. This is the one place a permanent green dot earns
its keep — a tab sits in a strip of other tabs with nothing else to say, and an absent dot would read
as an icon that failed to load rather than as a fleet that is fine.

It is mounted at the root, not in `AppLayout`, so it covers the login screen too: somebody who cannot
sign in because the backend is down should be able to read that off the tab.

## Chat

Chat lives in a **rail** beside the page, not behind a click. It is the ambient texture of a live
server and the only place a person talks to the fleet, so it stays open across navigation with its
scope and open state in `localStorage`, and a badge on the sidebar button counts what arrived while
it was shut. Ctrl/⌘-J toggles it, and the palette offers the same under Actions.

Both the rail and the sidebar are **draggable**, and both remember their width — `src/lib/resizable.ts`
owns the sign, since the two are mirror images and dragging right widens one while narrowing the
other. The handles are pointer-only but focusable, so arrow keys set the width too.

It is the **only** place chat is shown. There was a modal on the dashboard and a card on the agent
page; both are gone, along with the dashboard's server list, whose counts and listener status now
ride on the rail's own picker. The agent page keeps a button that points the rail at that agent —
an entry point, not a second copy.

The **scope is chosen, not inferred from the route** — a panel that rewrites itself every time the
operator navigates is one nobody can read. `src/lib/chat.ts` holds what that means: which live lines
belong in which scope, and who may speak into one.

Two scopes, kept apart because the backend keeps them apart. A **server** scope is the global chat
everyone standing there saw, forwarded once by the elected listener; an **agent** scope is the
conversation to or about that agent. Global lines arrive tagged with whichever agent forwarded them,
so an agent scope has to exclude them explicitly or the listener's conversation quietly becomes the
whole server's.

Sending is impersonation through one agent, so a server scope names which — the listener first,
since it is the one already forwarding the conversation being read. A server nobody is forwarding
has no global feed at all, so the rail says so rather than showing an empty panel, which would read
as a quiet server instead of a missing one.

Live lines are not accumulated in the store — it has no way to know which page one belongs on. The
store hands `chat`, `activity`, `audit`, `user` and `user-removed` events to whichever view is
showing the matching list, via `onFeedEvent`, and that view prepends or replaces.

A live audit entry is only prepended **while the search box is empty**. It has not been through the
server-side search, so prepending it during one would put a row on screen that does not match what
was typed.

## Loading states

**Skeletons where the shape is known, an indicator where it is not.** A table already has its
columns, so placeholder rows keep the header, the widths and the page height put; a spinner in the
same place collapses the table and then shoves the page down when the data lands.
`TableSkeleton.vue` is that, for the three tables. The tail of an infinite scroll gets an indicator
instead — a skeleton row there reads as an entry arriving rather than as a wait.

The rule this exists to enforce: **an empty state is a claim, and it must not be made before the
answer is known.** Hosts said "No hosts yet." during its first request, the agent page said "Agent
not found." on a reload before the fleet arrived, and the dashboard showed zeroes. All three read as
facts. The fleet store therefore carries `loaded` alongside `loading`, since only the first tells an
empty fleet apart from one nobody has asked for yet.

`loaded` stays true once set. A later refresh is a background update over content already on screen,
and blanking it back to skeletons would be a worse lie than briefly stale numbers.

## Player heads

Agents, nearby players and chat lines carry a Minecraft head. It comes from Osmium's own
`/api/avatars/{name-or-uuid}`, never from a skin service directly — proxying is what keeps the CSP
off a third-party image host, and it means no operator's browser tells one which agents exist or how
often somebody is looking at them.

That endpoint is gated on `agent.read` like every other route, and an `<img src>` cannot send an
`Authorization` header. So `src/lib/avatars.ts` fetches each head with the token and hands the
element a blob URL — which is why `img-src` carries `blob:`. Object URLs are same-origin by
construction; they can only name a blob this document already created.

Two things that module has to get right, because a page renders the same head many times: it caches
the **promise** rather than the result, so thirty elements mounting in one tick share one request;
and it revokes evicted URLs, since an object URL pins its blob and a long session watching global
chat meets a lot of names. It also does not go through the API client — that middleware logs the
session out on a 401, and a decorative image must never be able to do that.

`PlayerHead.vue` is the only component that knows about any of it. Nothing there is load-bearing:
the name is beside the head everywhere it appears, so an agent that has never logged in, a
deployment with `osmium.avatar.upstream` blank and a skin service having a bad minute all land on
the same initial, and the interface reads as it did before heads existed.

## Motion

Two effects, one rule: **movement marks the instant something changed, and nothing else.**

That is the other side of the line the sidebar already draws — a permanent green dot is decoration
nobody reads, but Osmium is fed by a live stream, so values move while nobody is watching them.
Without motion at the moment of change, an operator who looked away has no way to learn that they
did.

- `v-flash="someValue"` from `src/lib/motion.ts` tints a row for a moment when the bound value
  changes. On the sidebar agents (state), the agent page's status badge, and the hosts table
  (reachability). **Not** on telemetry: vitals move every second, and constant motion carries no
  news.
- `RollingNumber.vue` travels to a new figure instead of swapping it. Dashboard counts only, and
  never on the first value — counting up from zero on load is an animation about nothing.
- A `<TransitionGroup name="feed">` slides in newly arrived feed lines. It animates insertions but
  not the first render, which is exactly the distinction wanted: a line arriving live moves, a page
  of history simply appears.

Every one of them is off under `prefers-reduced-motion`, honoured rather than softened. All of it is
decorative by construction, so removing it loses nothing that is not also written on the page.

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
contain dots (`chat.speak`), so `t('permission.chat.speak')` looks for
`permission → fleet → chat → speak`,
finds nothing, and silently returns the key. `nodeLabel` therefore indexes the copy object directly
rather than going through `t()` — which means picking the locale by hand too — and `i18n.spec.ts`
pins that.

## Authorization in the UI

`GET /api/auth/me` returns the account's flattened permission nodes, and the UI gates on the same
strings the backend checks:

```ts
v-if="auth.can('chat.speak')"      // hides what @PreAuthorize would reject
```

Same source of truth, so there is no duplicated role logic. Route guards use `meta.node`.

## Tests

```bash
npm test
```

138 unit tests on Vitest with jsdom. They cover the parts where a bug is invisible until someone is
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

**No credential is readable by script.** The access token lives in a module-scoped ref and is never
written to storage; the refresh token is an `HttpOnly` cookie this code could not read if it tried.
A reload therefore starts with no access token, and `src/api/session.ts` mints a fresh one from the
cookie. That happens in the **route guard**, not in `main.ts`: vue-router begins its initial
navigation inside `install()` — the `app.use(router)` line — so anything the entry point awaits runs
after the guard has already decided who the visitor is. Restoring there let a reload bounce an
operator with a live session back to the password box while the cookie sat in the browser the whole
time. `restore()` is memoised, so it costs one request per page load rather than one per navigation.

Be clear about what that buys. An XSS on an open page can still call the API as the operator, and
can call refresh itself; moving the credential out of reach shortens what an attacker keeps **after
the tab closes**, it does not stop them acting inside it. The layer that stops a script running at
all is still the CSP.

Two things carry that, and both matter more once real agent credentials are in play:

- **A strict CSP** — `script-src 'self'` with no `unsafe-inline`, so an injected script simply does
  not execute. See `nginx.conf.template`.
- **`vue/no-v-html` is an error**, not a warning. `v-html` is the main XSS vector in a Vue app.
  There is no `v-html` in the app, and no `innerHTML`, `eval` or `new Function` either.

**The CSP is a property of the nginx image, not of the bundle.** It exists in exactly one file, so
serving `dist/` any other way — a static bucket, a CDN, `vite preview` — ships no policy at all and
gives no signal that it is missing. The image is therefore the only supported way to serve this,
and that is a deployment constraint rather than a preference.

`src/test/securityHeaders.spec.ts` pins the policy so it cannot be weakened without a failing test:
`script-src` stays exactly `'self'`, no directive names an external host or a wildcard, and no
`add_header` appears inside a `location` block — in nginx that **replaces** the inherited set rather
than adding to it, which would silently drop every header for that path. The caching and proxy
locations use `expires` and `proxy_set_header` for exactly that reason. Verified against a running
container: the policy ships on `/`, on `/assets/` and on the SPA fallback alike.

**My account lists the live sessions** (`AccountSessions.vue`), with this browser's marked, and can
end any one of them or all of them. "Sign out everywhere" deliberately ends the current session too:
somebody pressing it believes they are compromised, and the version that spares the current session
spares the attacker's if the attacker is the one pressing it. It clears the local session whatever
the request returns, for the same reason.

The address and browser on each row are only as good as the request that carried them — an address
is the proxy's unless the deployment passes headers through, and a browser names itself — so the
copy presents them as recognition aids rather than as evidence.

When a refresh token for the account is replayed, a **banner appears on every page** after the next
sign-in. It is the only way the person it happened to hears about it — the audit trail needs
`audit.read`, so it reaches an administrator and not them, and they were simply signed out. The copy
says a token was used twice and what to do about it; it does not assert an attack, because "presented
twice" is what the system knows and theft is only the usual explanation.

`src/api/session.ts` takes a `navigator.locks` lock around the refresh for the same reason. The
single-flight guard is module state, so a second tab is a second instance sharing one cookie: two
tabs waking together would both present the value the browser last stored, one would win, and the
other would look like a replay — ending the session and filing an incident because somebody had two
tabs open. The backend's fifteen-second grace window covers what a lock cannot reach.

**All accounts** gets a matching action for administrators, but only the button: sign an account out
of everything, no list. Only the person holding a session can tell which one is theirs, so showing
an administrator another operator's devices and addresses would trade privacy for data nobody in
that seat can read. Setting a password there ends that account's sessions too, and the dialog says
so before the fact rather than leaving it to be discovered.

The refresh cookie is `HttpOnly; Secure; SameSite=Strict; Path=/api/auth`. The narrow path means it
is sent to the three session endpoints and to nothing else, so the long-lived credential is on the
wire twice an hour rather than on every request — and `SameSite=Strict` is what stops another site
POSTing to `refresh` or `logout` from an operator's browser, since those are authenticated by the
cookie alone.

`liveUpdates.ts`, `avatars.ts` and `auditExport.ts` stay hand-rolled. They exist because
`EventSource`, `<img>` and navigation cannot send a header, and the **access** token is still a
header — moving it to a cookie as well would reintroduce CSRF on every route. Native `EventSource`
would also be a downgrade for its own reasons: it never surfaces keep-alive comments, which is what
the idle watchdog re-arms on, and it retries forever, where this client deliberately gives up on a
403.

`?redirect=` on the login screen is the one piece of URL a visitor controls. vue-router neutralises
most hostile values by resolving them as paths under this origin, but `//evil.com` survives intact,
so `safeRedirect` in `src/router/index.ts` accepts a single-slash path and nothing else.

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
src/components/  FormField, the add-host and add-agent modals, the chat rail and panel, the language picker
src/layouts/     AppLayout: sidebar, nav, drawer
src/i18n/        every user-facing string, one file per locale
src/lib/         cursor-paged feeds, presentation maps for agent state, roles and permissions
src/router/      routes and node-based guards
src/stores/      auth and fleet state (Pinia)
src/test/        Vitest setup and the fetch stub
src/views/       dashboard, map, operations, configuration, hosts, agent detail, accounts, audit, login
```

Specs sit next to what they test as `*.spec.ts`, so `vue-tsc` type-checks them with everything else.
