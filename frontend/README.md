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

**Schematics are real**: uploaded, read through, measured and divided. What no schematic has yet is
an agent building it — carrying a segment to a host needs the host side, which does not exist. So
the pipeline stops at a division nothing is sent, and the last step says so rather than offering a
button that would do nothing.

**Operations** holds everything done to the fleet as a group. See below.

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

### The login methods are the host's, not ours

The setup dialog offers exactly what the agent's host advertised in its handshake, read off
`host.loginMethods`. There is no list in the frontend: it held four placeholders before this and
offered all four to every host, which is a chooser where most selections are wrong and nothing on
screen says which.

Their copy comes from the host too, and is therefore **not translated** — the host is the only party
that knows what its own mechanisms are, so it is the only one that can describe them. The id is
shown when a host sends no label, which is at least the string it will be asked to act on.

**An empty list is a real state and says so.** A host that is disconnected, or connected and
advertising nothing, gets a warning naming the host rather than an empty radio list, and the start
button stays disabled. The backend refuses an unadvertised method with a 400 regardless, so this is
the interface agreeing with the API rather than guarding it.

## Operations

Three tabs, because they are the same act with a different verb — pick a group, then do one thing to
all of it — and because an operator moves between them in one sitting: choose what to build, point
the agents at the server, bring them in.

| Tab | What it does |
|---|---|
| Schematics | upload, read, divide between agents |
| Servers | point a group of agents at one Minecraft server |
| Connections | bring a group in or out of game |

Each tab is **node-gated**. A viewer reaches the page for the library and is not shown two tabs that
would answer 403 — an interface offering what it will refuse reads as broken rather than as
restricted.

All three share `AgentPicker.vue` in the same column at the same width, so moving between them does
not move the thing being reached for. Two of them **lock the selection**, which the picker has to
know about: choosing a builder narrows the list to that agent's server, and selecting all would
otherwise leave agents selected but invisible — the count saying nine while the list shows four.
Nothing stays selected once it leaves the list.

### The build is three steps

```
Schematic  ->  Agents  ->  Split
```

The order is strict rather than a preference: nothing can be divided before it has been read, and
nothing can be divided at all until somebody is going to build it. All of it on one screen was a
library, a viewer, a material list, a picker, a mode and a set of segments competing for the same
attention, with that order invisible. Steps make it the shape of the screen.

Forward is gated and **says what is missing** rather than only grimacing at a disabled button;
backwards is always free.

**One server per build.** Agents on two servers cannot share one — they would be placing blocks into
different worlds that happen to have the same coordinates. The first pick decides which, and the
rest of the fleet greys out with the reason attached. The server is then *stated*, not chosen: a
second control for it would be a way to disagree with the agents.

**The count is the selection.** Asking for a number of agents *and* which agents is asking the same
question twice, and lets the two disagree.

### Getting there takes a while, so say where it got to

A schematic passes through three states before it can be looked at, and on a large file each is
minutes long: bytes arriving, then waiting for the reader, then being read. One bar covers all three
— an operator does not care where sending ends and reading begins, they care that it is still
moving — with a line under it saying how far in.

| State | Under the bar |
|---|---|
| Uploading | `24.0 MB of 180 MB · 13%`, a chunk at a time |
| Queued | how many are ahead of it, from the backend's `queuePosition` |
| Reading | the percentage, and which of the two passes it is on |

**Queued was the one state that said nothing.** Just the word, and a bar that was not there — for
what is usually several minutes of a *different* schematic being read, with nothing on screen to say
that is what it was waiting for. It now gets an indeterminate bar rather than one sitting at zero,
because there is no percentage of waiting and a still bar reads as stuck.

**Reading says which pass** because the file is read twice — once for what it is, once for where its
blocks are. Without that, a bar that goes past halfway and keeps climbing looks like it restarted.

The upload bar moves a chunk at a time and is not smoothed. `fetch` reports nothing about a request
body in flight, so the alternative is a bar that is guessing, and a guess is exactly what makes a
stalled transfer look like a working one.

**Finishing an upload is not news about the schematic.** What the last chunk answers with is a
snapshot from inside its own transaction, so it always says `PENDING` and never carries a place in
the queue — and the reading that follows can be over before that promise resolves, which on a small
file takes tens of milliseconds. Applied over what the stream has already delivered it put the row
back to waiting: Vue renders once, so the reading was erased before it was ever painted, and when
`READY` arrived first the row stayed at waiting for good, because nothing publishes that schematic
again. The stream owns the row; the upload's own answer is a fallback for the one case it cannot
cover, an upload that outlived a reconnect which dropped the schematic's arrival.

### The box viewer

`BoxViewer.vue` draws the schematic as a box that can be turned, and the same component draws the
segments a split produced — a split that looked unlike the thing it divided would be harder to read,
not easier. Corner coordinates show for one box and drop for several, where eight labels per segment
is a reading of nothing.

SVG rather than a 3D renderer, and `src/lib/box3d.ts` is why: labels stay screen-aligned instead of
rotating with the geometry, depth order is exact rather than approximate because the boxes are
disjoint and axis-aligned, and the geometry stays testable, which nothing drawn to a canvas is.

### Shape, and bounds

Two views of one schematic, and the switch between them is not a preference. **Shape** is the
building itself as voxels, which is what answers "is this the right one". **Bounds** is the box, and
a split is expressed in coordinates — drawing the division over a voxel model would hide the
division behind the thing being divided. So the default follows the step: shape while choosing,
bounds while dividing, either one click from the other.

`VoxelViewer.vue` is **canvas**, unlike everything else here. Tens of thousands of cubes is hundreds
of thousands of polygons and the DOM will not hold that many nodes, let alone re-lay them out during
a drag. What that costs is the geometry being testable — so the geometry is not in the component:
the rotation stays in `box3d.ts` and the draw order and face selection in `voxels.ts`, both specced.
The component is the paint call.

The ordering is worth knowing about. Axis-aligned cubes on a grid have an **exact** painter's order
that depends only on which octant the camera is in — walk each axis away from the viewer and a cube
is always drawn after anything it could be behind. Eight cases, and since there are only eight the
sorted order is cached per octant: a drag that stays on one side of the model reuses it for every
frame, and crossing to another side costs one sort.

Four more things keep a frame cheap, and they are all the same idea — do it once instead of per
face:

- **Face visibility is decided once per frame**, not per voxel. Which of the six directions can face
  a camera depends only on the rotation, so it is one calculation and then a bitwise `and` per cube.
- **Shade is baked into the colour** rather than set as `globalAlpha`. Transparency was the expensive
  part: an alpha change is a canvas state change *and* it forces the compositor to blend rather than
  overwrite.
- **Faces are batched by colour.** Two faces of one material and one direction now share a fill, so
  they share a path — and the run is flushed the moment the colour changes, which is what keeps the
  order between different colours exact. Safe under the nonzero fill rule because every face drawn
  is turned towards the camera, and consistently wound faces seen from the front project with
  consistent winding.
- **The voxels are an `Int32Array`**, converted once per model rather than read as boxed numbers out
  of parsed JSON on every frame.

The resolution is the operator's to choose, as voxels along the longest axis — the honest control,
since it is what bounds the work, where asking for blocks-per-voxel directly would let a large
schematic ask for millions of cubes. What the slider reads back is the blocks-per-voxel it worked
out to, which is the number anybody actually cares about.

**The slider asks on release, not on the way.** A range input's `input` fires for every position the
thumb passes over and its `change` fires once, when the drag ends; bound to the first, a single drag
across the track read the occupancy index a dozen times to arrive at the one resolution that was
wanted, each answer redrawing the viewer under a hand that had already moved on. The control follows
the thumb, and only what has been *committed* is fetched. Several neighbouring positions request the
same model anyway — a voxel is a power-of-two multiple of an index cell — so most of those reads
were returning a picture that was already on screen.

**Nothing in that row changes width.** The readout beside the slider used to hold whatever had come
back, so it grew and shrank between a spinner, `One voxel per block.` and a full sentence about
massing models — which moved the slider out from under the thumb mid-drag and, at the wrong window
width, wrapped the row. The slider's own position now sits in a fixed box beside it, and the
sentence about what came back is a line of its own, truncated to one line with its height reserved,
so it cannot push anything whatever it says.

### Knowing which way is up

Both viewers share the rotation, and they now share three decisions about orientation, because
without them a schematic is a shape you cannot place yourself in.

**The light is fixed to the world, not to the camera.** View-space lighting was the first attempt,
on the reasoning that a face holding one brightness through a drag looks calmer. It does, and it
costs the only thing shading is for: the top of the model was bright from one angle and dark from
another, so nothing in the picture said which end was the roof. Fixed to the world, the top is
always the brightest face and the underside always the darkest.

The brightness *wraps* rather than clamping at zero. Clamping puts every face turned away from the
light on the same ambient floor, and three sides at one grey read as a single surface — the model
loses its corners exactly where it most needs them.

**Negative pitch looks down.** Nothing in the arithmetic says so and the sign is easy to get
backwards, which is how the viewer used to open underneath the building looking up at its floor. The
default is stated once in `box3d.ts` and both viewers take it from there.

**The range is lopsided on purpose.** Looking down stops short of vertical, where the model
collapses to a plan. Looking *up* stops just past the horizon, and that one is about feel rather
than the picture: from underneath, dragging left turns the model the way dragging right does from
above. The arithmetic is correct and it reads as the control inverting itself, so the view does not
go there. A shallow angle still shows an overhang or the underside of a floor.

Related, and the other half of the same complaint: the drag and the arrow keys disagreed about which
way was up — the pointer lowered the camera where `ArrowUp` raised it. Both now raise it, so
dragging down rolls the top of the model towards you, the way taking hold of it would.

The voxel viewer also strokes a **ground grid** on the `y = 0` plane before the model, extending a
little past its footprint. Shading says which face is the top; a floor says where the bottom is,
which shading alone cannot when the underside is not in view.

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

Anything the store does not own state for is handed on to whichever view is showing it: chat, the
activity feed, the audit trail, the account list, and **schematics**. That last one is why the
library never polls — an upload and the pass that follows it run for minutes with nobody touching
anything, and a screen that only moved when refreshed is a screen an operator sits and refreshes.

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

Two scopes, and they are **not mirror images**. A **server** scope is everything that happened
there — the global channel forwarded once by the elected listener, plus whispers, proximity chat and
the agents' own lines — because all of it happened on that server. An **agent** scope is the
conversation to or about that agent, and excludes the global channel, which is identical for every
agent standing there and would bury the lines actually about this one.

Global lines arrive tagged with whichever agent forwarded them, which is why the agent side has to
exclude them explicitly, or the listener's conversation quietly becomes the whole server's. On a
server feed the agent is named beside any line that is not public: everything is in there, so a
whisper would otherwise be indistinguishable from public chat, and "who was this to" is the whole
question a private line raises.

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

`backendReachable` and `backendEverReached` live in `src/api/reachability.ts` rather than a store, so
every call updates them — including the account lookup a viewer makes without ever touching the
fleet. `src/api/client.ts` re-exports them and stays the module everything imports from; they sit in
their own file only because `session.ts` writes them too, and `client.ts` already imports
`session.ts`.

That second writer is what the **sign-in screen** reads. Refreshing the session is the only request
a signed-out tab makes, and the route guard has already awaited it by the time the screen renders,
so the screen can say whether Osmium is answering **before** a password is spent finding out. Any
response counts, including the 401 that means there is simply no session to resume.

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

233 unit tests on Vitest with jsdom, in two groups.

**Where a bug is invisible** until someone is locked out or over-privileged: the route guard, the
auth store, the API client's middleware, the fleet store's derived state, the cursor paging in
`useFeed` — where a cursor that is not carried forward silently re-reads page one — and
translation parity, where a missing placeholder swallows a value without erroring.

**Where a bug renders as a plausible wrong answer** rather than an error. Everything in `src/lib`
that computes something is a plain function with its own spec, because the failures are arithmetic
and they all look fine on screen: a sparkline with one sample or a flat series (`series.ts`),
distance measured across a dimension or a server (`vitals.ts`), a fleet reported finished because
two servers' progress was added against one schematic (`build.ts`), which chat scope a live line
belongs in (`chat.ts`), which pane a drag widens (`resizable.ts`), what the tab says
(`browserStatus.ts`), the isometric projection behind the sign-in screen (`schematic.ts`), which is
chosen in projected space rather than on a grid that is projected afterwards — the obvious way
round gives a 2:1 diamond, a perfectly good render of the wrong shape — and the rotatable box in
Operations (`box3d.ts`), where drawing the faces turned away renders a box that reads inside out and
fitting each box to itself draws every segment of a split the same size.

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
src/api/         generated schema, typed client, token storage, live-update and feed clients,
                 resumable schematic upload
src/components/  FormField and AgentPicker, the add-host, add-agent and upload modals, the chat
                 rail and panel, the command palette, the sparkline and hourly bars, the language
                 picker, the sign-in backdrop, the schematic library, the box and voxel viewers,
                 the server-assignment and connection panels
src/layouts/     AppLayout: sidebar, nav, drawer
src/i18n/        every user-facing string, one file per locale
src/lib/         everything computed away from a component: cursor-paged feeds, chat scopes,
                 build and vitals arithmetic, chart, box and voxel geometry, shortcuts, panel
                 resizing, and presentation maps for agent state, roles and permissions
src/router/      routes and node-based guards
src/stores/      auth, fleet, the chat rail, and the sampled history behind the sparklines (Pinia)
src/test/        Vitest setup and the fetch stub
src/views/       dashboard, map, operations, configuration, hosts, agent detail, accounts, audit, login
```

Specs sit next to what they test as `*.spec.ts`, so they are type-checked with everything else — but
only by `npm run build`, which runs `vue-tsc -b`. `vue-tsc --noEmit` is **not** the same check: it
passed a component missing a required prop and a spec using a field that no longer existed. The
build is the one to trust.
