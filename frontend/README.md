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

**Jobs are not part of that mock.** `agentStore.jobs` is real: a plan frozen, divided into segments,
each assigned to an agent, all of it stored by the backend. What is still missing is a host that can
be sent a segment and report blocks against it, so every job reads 0% — which the Jobs panel states
outright. The two live side by side in one store and are easy to confuse: `agent.build.blocksPlaced`
is invented, `job.segments[].blocksPlaced` is a real column nothing has written to yet.

**And marked on the screen, not only in the source.** Configuration has carried a banner since it
was built; the dashboard had nothing, while being both the landing page and the most numerically
confident screen in the application — its invented figures roll, animate and carry sparklines
exactly as the real ones do. It now names them in a banner, *and* each invented panel carries a
`placeholder` badge of its own: a banner at the top of a scrolling page cannot be relied on to still
be in view beside the sector table. Agents online, vitals, what needs attention and the activity feed
are real and unmarked, which is the distinction the marking exists to draw.

**Configuration** is mock end to end: `src/lib/configuration.ts` holds the field list, the values
and a `saveSettings` that writes to a map in that module and resolves. Nothing reaches a host, and
the screen says so in a banner rather than only in a comment. It is kept out of the fleet store for
the same reason build progress is — a mock inside real state is one that outlives its purpose.

What is meant to survive that mock is the **shape**: fields are declared as a schema and rendered
generically by type, so adding a setting later is an entry in that file plus a copy key, not another
block of markup. The field list itself is a placeholder, not a specification.

**Schematics are real**: uploaded, read through, measured, divided, and started. A job records what
is being built, where, by whom and how far along. What no schematic has yet is an agent actually
placing a block — carrying a segment to a host needs the host side, which does not exist — so the
pipeline now stops one step later, with segments assigned and nothing sent. Both the last wizard
step and the Jobs panel say so rather than leaving it to be inferred.

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

## Resources

What the deployment is *made of*, as opposed to what is being done with it — which is the line
between this page and Operations. Three tabs, and an operator moves between them in one sitting:
which agents exist, which machines run them, and how the two are wired together right now.

| Tab | What it answers |
|---|---|
| Bots | what have I got — account, host, server, state, across the whole fleet |
| Hosts | which machines are answering, and the three things that can be done to one |
| Graph | what is connected to what, at this moment |

The host table used to be its own page at `/hosts`. That path now redirects here rather than 404ing,
because it is the one URL an operator may have bookmarked.

**Bots is not the sidebar list again.** The sidebar answers "take me to one"; this answers "what
have I got" — four facts per agent, compared down a column, which is the thing a list of links
cannot do. It carries no per-row actions either: everything doable to an agent lives on its own page
or, for a group, on Operations, and a third place would be a third thing to keep in step.

### The graph

Three tiers — Osmium, the hosts dialled into it, the agents each host runs. Not four: a Minecraft
server would be a different kind of line entirely, because nothing on that link reports to Osmium,
so its health would have to be invented.

**Colour and motion both carry health**, which is not redundancy. Colour alone fails anyone who
cannot separate the hues, and across a whole graph the eye catches movement long before it reads a
legend. A live link is green with three packets crossing every 2.4s; a faltering one is amber with a
single packet crawling; a dead one is a grey dashed line with nothing on it.

`stale` is not a lesser `down`. It is where something is genuinely in flight or genuinely unknown —
a setup command mid-air, or an agent whose host has gone — and drawing either as a dead line claims
knowledge we do not have.

**A host is green or grey, never amber for being slow.** An earlier version read freshness off
`lastSeenAt` to fade a host whose heartbeat was overdue, which cannot work: heartbeats are not
published, deliberately, so that timestamp freezes at the moment the host connected and ages
forever. Every host went amber a few seconds after the page loaded and stayed there — the graph was
measuring how long the tab had been open. The backend owns that judgement, against the heartbeats it
actually receives, and now announces every change; the browser simply believes `reachable`. Amber is
left to the one case it can see for itself: reachable, but never once heard from.

**An agent can never be healthier than the socket carrying it.** Its stored state may say `ONLINE`,
but if its host is unreachable the only party that can see that session has gone, so the node greys
out with the host.

The layout and the health rules are in `fleetGraph.ts` and specced; the component is paint. It is
**SVG rather than canvas**, the opposite call from the voxel viewer — there are tens of nodes here,
not tens of thousands, and each wants to be a link with a tooltip, all of which the DOM gives free.
Packets are `<animateMotion>` rather than a JS loop: the browser runs them off the main thread, and
they stop dead under `prefers-reduced-motion` instead of being throttled.

The one wrinkle is that `RouterLink` cannot be used inside the `<svg>` — the anchor it renders lands
in the wrong namespace — so nodes are real SVG `<a>` elements with real hrefs, and a plain left
click is intercepted and handed to the router. Modified clicks are left alone so open-in-new-tab
keeps working.

### A host has its own page

`/hosts/:id`, reached from the sidebar, the list, the graph or the command palette. The list answers
"which of these is in trouble"; this answers "what is going on with *that* one" — the agents that go
down with it, when it was last heard from, and the login methods it advertised. That last panel is
where an operator ends up when the setup dialog refuses, because an empty list there is the reason.

Its three actions are shared with the list rather than written twice: `HostActions.vue` owns the
dialogs and exposes the openers. They are the only place a rotated token is shown in the clear,
which is markup worth having exactly once.

## Operations

Four tabs, because they are the same act with a different verb — pick a group, then do one thing to
all of it — and because an operator moves between them in one sitting: choose what to build, point
the agents at the server, bring them in.

| Tab | What it does |
|---|---|
| Schematics | upload, read, divide between agents, start building |
| Jobs | what the fleet is building: segments, who is on each, how far along |
| Servers | point a group of agents at one Minecraft server |
| Connections | bring a group in or out of game |

Each tab is **node-gated**. A viewer reaches the page for the library and is not shown two tabs that
would answer 403 — an interface offering what it will refuse reads as broken rather than as
restricted.

The first three share `AgentPicker.vue` in the same column at the same width, so moving between them does
not move the thing being reached for. Two of them **lock the selection**, which the picker has to
know about: choosing a builder narrows the list to that agent's server, and selecting all would
otherwise leave agents selected but invisible — the count saying nine while the list shows four.
Nothing stays selected once it leaves the list.

### The build is four steps

```
Schematic  ->  Plan  ->  Agents  ->  Split
```

The order is strict rather than a preference: nothing can be divided before it has been read, and
nothing can be divided at all until somebody is going to build it. All of it on one screen was a
library, a viewer, a material list, a placement, a substitution table, a picker, a mode and a set of
segments competing for the same attention, with that order invisible. Steps make it the shape of the
screen.

Forward is gated and **says what is missing** rather than only grimacing at a disabled button;
backwards is always free.

**One server per build.** Agents on two servers cannot share one — they would be placing blocks into
different worlds that happen to have the same coordinates. The first pick decides which, and the
rest of the fleet greys out with the reason attached. The server is then *stated*, not chosen: a
second control for it would be a way to disagree with the agents.

**The count is the selection.** Asking for a number of agents *and* which agents is asking the same
question twice, and lets the two disagree.

### Starting a job

The last step's **Start building** is live: it freezes the plan into a job — its own copy of the
anchor and the substitutions, divided into segments assigned to the chosen agents — and moves the
operator to the Jobs tab. Which of its four preconditions is missing is *said*, not left to a
disabled button: the node, a saved plan, a placement, and at least one builder.

The division on screen is **not** sent. It is a pure function of the index, the mode and the number
of agents, and the backend recomputes it as it writes the segments down; sending the one on screen
would ask it to trust a division a stale tab produced.

**Nothing is dispatched yet.** A segment is assigned and stays assigned, because carrying one to a
host needs a wire message that does not exist. The Jobs panel says so at the top rather than leaving
an operator to infer it from a progress bar that never moves.

Jobs live in the **fleet store**, not in the panel that shows them. An agent’s assignment is a fact
about the agent — the fleet list, the sidebar, the picker and its own page all read it — and two
copies would disagree the first time one was refreshed.

**Building replaces the state badge rather than sitting beside it.** There is no such backend state
and never will be: an agent is `ONLINE` and separately holds a piece of a job. Shown as two badges
it invites somebody to explain why an agent is both; shown as one it says the more specific of two
true things, and building already says in game. Substituted only over `ONLINE`, so a stale
assignment can never paint a disconnected agent as busy — and it is the same substitution for the
sidebar dot, which has room for exactly one colour.

**Pause, resume, delete — and no cancel.** Cancel stopped a job and then left nothing to do with it
but delete it, so the interface offered two buttons for one decision and the divided, crewed work
could not be picked up again. A paused job keeps its crew, which the card says outright, because
that is what an operator needs to know when a bot will not take other work.
### The plan: where it goes, and what out of

Placement and substitutions belong to a **build**, not to the schematic — the same schematic is
legitimately built twice, in two places, under different rules. So the step offers the plans for a
schematic rather than editing one set of fields hanging off the file.

**Placement does not gate the rest of the pipeline.** A plan usually exists before anybody has stood
in the world and read a coordinate off the screen, and requiring it would stop an operator dividing a
build they have not sited yet. Starting a job is where it becomes mandatory — a job has to know
where the blocks go — and that is the only step that refuses without it.

What the plan comes to is computed here, not fetched — `lib/placement.ts`, and specced, because it
is the part that can be wrong without looking wrong. Two rules in it are worth stating:

- **Blocks replaced by the same target merge into one line.** Somebody counting out chests wants one
  number for stone, not three lines to add up.
- **Blocks replaced by nothing stay on the list, struck through and counted separately.** What is
  being left out is exactly what an operator wants to see before agreeing to it, and a line that
  silently vanished would read as a material the schematic never had.

An empty replacement field means "leave it out", which is what the placeholder says. It is stored as
null rather than as an empty name, so "place nothing" has one representation instead of two that
behave alike but do not compare equal.

**The steps after it use the plan, not the file.** Two places were still reading the schematic raw,
which is the same number only until somebody substitutes something.

The agent step divided `content.blockCount` by the number of builders — the file's own total, before
substitutions. An operator who had just told the previous step to place nothing for forty thousand
beacons was shown a division that still included them, so the one figure they would plan around was
wrong by exactly the amount they had asked to leave out. It now divides `blocksToPlace`, the same
arithmetic the planner's own "Blocks placed" stat shows, and names the difference when there is one —
a total that silently shrank would read as a miscount rather than as the rules they had just written.

The split step drew the segments in the **schematic's** coordinates. The backend divides the file, so
that is what comes back; the plan step exists precisely to say where that file stands in the world,
and two steps reading different numbers for the same corner is the pipeline contradicting itself.
Segments are shifted by the plan's offset, and the caption says which space is on screen either way —
"is this where I fly to" has no answer an operator can infer from the numbers alone. The library's
own bounds view stays in file coordinates on purpose: its corner labels exist to be read off and
typed *into* a placement, which only works if they are the file's.

### Blocks have names, and the picker knows them

`minecraft:white_terracotta` is what the file says and what the host is told; **White Terracotta** is
what a person chooses between. Both are shown — the readable name to pick by, the id underneath
because that is what is actually stored and sent — with a colour chip from the same table the voxel
viewer paints with.

The names are **generated and committed** (`scripts/generate-block-names.mjs`, from PrismarineJS
`minecraft-data`; about 1,200 blocks in 50 KB). Not fetched at runtime: Osmium sits behind a strict
CSP and may run with no route to GitHub, and a picker that needs the internet to show a block name
is empty exactly when somebody is working offline. Regenerate it when the game moves.

**Nothing treats an unknown block as an error.** The dataset lags the game by a version or two, and a
schematic can legitimately name a block newer than it — or from a mod. So `blockName` falls through
to prettifying the id (`some_future_block` → *Some Future Block*), the picker accepts anything typed
and marks it as unrecognised, and the suggestions are help rather than a gate. Refusing an unknown
block would make the picker worse than the plain text box it replaced.

A combobox rather than a `<select>`: eleven hundred options is past what a dropdown can be scrolled.
Suggestions are **ranked, not filtered** — exact id, then prefix, then a word inside the name
starting with the query, then anything containing it, shortest first within a rank. Alphabetical
buries **Stone** under its own variants, and word-start is what puts **Bricks** ahead of **Nether
Bricks** for somebody typing a material rather than a modifier. Blocks already in the schematic come
first and are badged, because substituting is almost always swapping something already there.

The suggestion list is allowed to be wider than the field it hangs off, and the id truncates before
the name does. Two pickers side by side in one column left about 150px each, which holds none of
those three things — so a substitution rule is two stacked lines rather than one row.

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

Two views of one schematic, **and only in the library**. **Shape** is the building itself as voxels,
which is what answers "is this the right one". **Bounds** is the box it occupies with its corner
coordinates, which are the numbers that get typed into a placement.

The split step has no such switch: it draws boxes and nothing else. A division *is* a set of
coordinate ranges, so the voxel model cannot express one — offering shape there was a tab that hid
the thing the operator had just asked for, and a caption underneath apologising for it. Which
question belongs where turns out to be the whole point of the steps: what a schematic *is* is asked
in the library, and how it divides is asked while dividing it.

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
routine, not an expiry. A second 401, or a 403, is not fixed by reconnecting and stops the loop —
but it still **announces the disconnect on the way out**. Returning in silence left the connection
indicator claiming a live stream forever, so every list on screen quietly stopped updating with
nothing anywhere saying why.

**Losing the stream gets a banner, not just an icon.** Every list here is stream-fed and none of them
poll, deliberately — so a dropped stream freezes upload bars, agent states and arriving rows while
each page goes on looking entirely normal. A 16px glyph in the corner of the sidebar behind a hover
tooltip was not enough to carry that, so `AppLayout` also puts a line above the router view saying
what is on screen is real but has stopped moving, and that nothing has been lost. It waits six
seconds first: the stream is disconnected for the first moment of every page load and reconnects
with backoff after any blip, and a banner that flashed on each of those teaches an operator to
ignore it.

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

**A sent line is shown before it is confirmed, and marked as unconfirmed.** A 2xx from the send
endpoint means the backend accepted the message for delivery, not that anything was said — the line
enters the transcript when the host echoes it back, a round trip through a Minecraft server away.
Clearing the box on that 2xx and drawing nothing meant the message was simply gone from the screen
in between, and gone permanently if the host dropped it.

So it appears at once, dimmed and italic with a clock beside it, and the echo retires it. Matched on
text rather than id, because the two have no id in common: the backend mints one when the host
reports the line, long after the placeholder was drawn. After ten seconds with no echo the clock
becomes a warning and the line reads *not confirmed* — not *failed*, since the message may well have
been said and only the echo lost, but not left looking like ordinary chat either.

Live lines are not accumulated in the store — it has no way to know which page one belongs on. The
store hands `chat`, `activity`, `audit`, `user` and `user-removed` events to whichever view is
showing the matching list, via `onFeedEvent`, and that view prepends or replaces.

A live audit entry is only prepended **while the search box is empty**. It has not been through the
server-side search, so prepending it during one would put a row on screen that does not match what
was typed.

## Saying what happened

A screen that does something and then reports nothing is indistinguishable from one that did
nothing. That is one bug, and it turned up in nine places at once; the fixes share a shape, so the
reasoning lives here rather than nine times over.

**A save says it saved, and a form says when it is unsaved.** `ConfigurationView` had the pattern
already — a `dirty` computed comparing draft to stored, a marker while they differ, a named
confirmation after, and a button whose label changes while it works — and `BuildPlanner` now uses
it. Without it there was no way to tell an edited plan from a written one: the button read the same
before and after, the coordinates read the same, and the material list beside them was already
showing the *unsaved* draft. Both compare serialised values rather than field by field, so
whitespace cannot make an unchanged form look edited.

**A long-running command gets a state, not just a disabled button.** See `CONNECTING` in
FLEET_CONNECTIVITY.md: the backend accepts a connect in milliseconds and the host answers in
seconds, so the badge used to go on reading `LINKED` throughout — the same thing it read before the
click. The frontend's whole part in this is rendering the state and refusing a second connect while
one is out, in `FleetConnections` as well as on the agent page.

**A bulk run says how far it got.** Both bulk panels loop sequentially on purpose, so stopping part
way is the normal case — one banned agent, one full server. Reporting only the failure left the
operator unable to tell an untouched fleet from a half-moved one, so the message now carries both
halves (*"Stopped at Mason_08 after 7 went through — …"*), the button counts through the run rather
than saying "Applying…" for a minute, and **only the agents that succeeded leave the selection**, so
pressing the button again does not re-run work that is already done.

**A cancellation is an outcome.** Cancelling an upload is a choice rather than a failure, so it is
not an error — but saying nothing left the bar vanishing from a dialog that otherwise looked
untouched. It now says how far it got and what became of it: the partial transfer stays in the
library as an unfinished schematic, and sending again starts a new one rather than resuming.

**A one-time secret cannot fail quietly.** `navigator.clipboard.writeText` rejects on a denied
permission and in any non-secure context. Unhandled, the promise died and the button simply stayed
on "Copy" — so an operator who clicked it, saw nothing change, clicked Done and pasted an empty
clipboard had permanently lost a host's credential. Both token dialogs now catch it and say to
select the value by hand while it is still on screen.

**Never claim something was done when that cannot be checked.** "End every session" clears this
browser whatever the server said — someone pressing it believes they are compromised, and leaving
them signed in over an awkward request would be the worst reading of a failure. But it then lands on
a login screen, which is exactly what success looks like. So `endAllSessions` returns whether the
server actually did it, and a failure carries `?revoked=failed` to the login view, which says the
other sessions should be treated as still active. Of everywhere in this application, that is the
worst place to be quietly wrong.

**A redirect explains itself.** The route guard sends anyone without a route's node to the
dashboard. Doing that silently made a bookmarked `/audit` read as a broken link rather than as a
restriction, so the node travels along as `?denied=` and the dashboard names it once, dismissibly.

**An outcome does not outlive what it described.** Operations shows one banner for all three of its
tabs, and nothing used to clear it — not a tab change, not a new selection, not time — so "12 agents
connected" stayed pinned above the Schematics tab for the rest of the session, describing something
that happened somewhere the operator was no longer looking. It now clears on a tab change and can be
dismissed where it stands.

**But a banner only where the screen does not already say it.** Schematics was the one tab that
never reported success, and the fix is one message rather than four: deleting is the only act there
whose outcome is invisible where it happened — an unselected row simply disappears from a list of
thirty, and the file is gone for good. Upload, re-read and split all announce themselves by changing
what is drawn, so banners for those would be noise rather than news.

## The sign-in screen

**The status line asks for itself.** It reads `backendReachable`, which every request writes as a
side effect — and on this page the only request is the session refresh the route guard makes on the
way in. One answer, at page load, from a call made for another purpose: a backend that stopped while
somebody was reading the page went on being reported as fine until they tried to sign in, which is
the worst moment to find out. `probeBackend()` runs on mount and every ten seconds while the page is
open.

It probes an *authenticated* endpoint on purpose. **Any HTTP answer counts, the 401 included** — the
same reasoning `session.ts` already applies, that a refusal is the backend refusing and therefore
proof it is running. Only a transport failure means it is not. So no public health endpoint is
needed, and the probe carries `credentials: 'omit'`: it runs on a timer, and the one thing it must
never do is spend a refresh cookie or rotate a session.

**The backdrop is deliberately faint.** `SchematicBackdrop` draws a disc of blocks placing
themselves, at roughly half the opacity it started at and over a longer loop. It sits behind a
translucent, blurred card carrying a password field, and at the old weight the blocks read as
content — something the eye kept returning to mid-keystroke. The ratios between the three faces are
unchanged, so it is the same solid in a dimmer room rather than a flatter one. `prefers-reduced-motion`
stops it entirely; it conveys nothing, so there is nothing to restore.

## No dead ends

**A schematic can have more than one plan, and now there is a way to make one.** That a plan is its
own entity rather than fields hanging off the file is justified by the same building going up on two
servers, or twice on one under different substitutions — and none of it was reachable. `load()`
always selected the first plan, nothing ever cleared that selection, so once one plan existed the
button was permanently "Save changes" and the `mine.length > 1` selector could never render.
`deleteBuild()` was exported and called from nowhere; `updateBuild` took a `name` no control set,
under a comment saying renaming was the operator's.

The selector now shows from the *first* plan, because the row beside it — add, rename, delete — is
how a second one gets made. A plan being written appears in the list as "New plan (unsaved)", so the
control never claims the operator is editing something they are not.

**A pending setup can be abandoned.** `SETUP_PENDING` is open-ended by design and should stay that
way — see FLEET_CONNECTIVITY.md — but open-ended is not the same as inescapable, and the Set-up
button being disabled *because a setup is in progress* made it a dead end. The agent page offers
"Stop waiting" while pending. The copy is careful about what that does: it stops Osmium waiting, it
does not reach into the host, and a login finished afterwards still links the agent.

**A disabled button says why it is disabled.** Connect carried five separate disabling conditions
inline and showed none of them. The wizard in Operations already did the opposite — *"a disabled
button with no reason is the interface declining to explain itself"* — so the three commands on an
agent's page now compute a reason or null, the same shape `ChatPanel`'s `blocked` uses for its send
box. The reason is on each button's `title` and in a line under the row, deduplicated: an unreachable
host blocks all three and is said once. Only reasons for actions this operator can actually see are
listed, since naming a precondition of a button that is not on their screen explains nothing.

## Tabs and steps live in the URL

Operations' three tabs, Resources' three, and the four-step schematic pipeline all kept their
position in a `ref`. That cost the same three things every time: nothing could be linked or
bookmarked, a reload dropped the operator back on the first tab at step one, and **browser Back left
the page entirely** rather than stepping back — at the one moment in the app where Back is most
likely to be pressed, part way through a wizard.

`src/lib/queryState.ts` holds the two composables. The route is the only source of truth, so Back
and Forward work with no listener of ours.

A **query parameter rather than a nested route**. These are panels within one screen, not screens of
their own: the page keeps its header, its node gate and its loaded fleet across a tab change, and
modelling that as a route would mean restructuring the router to describe something that is not a
navigation.

**Tabs and steps push; a selection replaces.** `useQueryTab` pushes, because moving to the next step
is a move an operator expects Back to undo. `useQueryValue` — which holds *which* schematic is being
looked at — replaces, because picking a row refines the view they are already on. Pushing it would
make Back walk every row that was tried before it reached the step they actually wanted. Replacing
still survives a reload and still travels in a shared link; it simply does not stack.

**The default is kept out of the address bar.** Writing `?tab=bots` when bots is what an absent
parameter already means adds length and says nothing, so the key is removed instead.

**What the URL asks for and what the screen can show are two different things.** The pipeline's
`go()` guards forward movement within the page, which was enough while the step lived in a `ref`
nobody outside could write. Once it is in the address bar, anyone can arrive at `?step=split` with
nothing selected — from a bookmark taken mid-pipeline, a shared link, or Back after the selection
was cleared — and land on a panel with nothing in it. So `wanted` is what the URL says and `step` is
that clamped to `furthest`, the last step the current state can actually fill. It clamps rather than
redirects: the URL is left saying what was asked for, so choosing a schematic opens the step that was
wanted instead of making the operator ask twice.

## Asking before acting

**Anything destructive asks, in a `<dialog>` rather than `window.confirm`.** The native one cannot
name what is being destroyed, cannot be read by anyone using the interface in German, and looks like
the browser warning about a script. The question is part of the application, the thing is named in
the title, and the consequence is spelled out — not just "are you sure".

Deleting an account was the last one still firing straight from its click handler. It sat two
buttons along from *signing a user out*, which does ask, and whose own comment says it "should not
happen on a stray click next to Edit". The permanent one should not either.

**Every dialog submit guards against a second press.** They all stayed live for the whole round
trip, so a slow request and a dead button looked identical — which is exactly what invites the
second click. Each now sets a flag, disables both its buttons, and changes the primary label to
say what is happening. `AllAccountsView` uses **one** flag for its four dialogs rather than four,
since only one can be open at a time and four booleans that could only ever disagree through a bug
is four chances to write that bug.

Rotating a host token is the one where this was doing real damage: a second press mints a second
token, and the one on screen — which the operator may already have pasted into the host's config —
is dead, with nothing on screen indicating it changed. That one guards on the token being present
as well as on the flag.

**A one-time secret cannot be dismissed by accident.** Both token panels refuse Escape while the
token is showing, by preventing the `cancel` event a `<dialog>` fires for that key, and daisyUI's
backdrop — which is a form that submits the dialog — is simply not rendered in that state. Done
still closes, so nobody is trapped: what is blocked is the accidental exit, not the deliberate one.

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

**The stream case also raises a banner**, after a six-second grace. An icon in the corner of the
sidebar was not enough to carry it: every list here is stream-fed and none of them poll, so a
dropped stream freezes upload bars, agent states and arriving rows while each page goes on looking
entirely normal. See *Saying what happened*.

`backendReachable` and `backendEverReached` live in `src/api/reachability.ts` rather than a store, so
every call updates them — including the account lookup a viewer makes without ever touching the
fleet. `src/api/client.ts` re-exports them and stays the module everything imports from; they sit in
their own file only because `session.ts` writes them too, and `client.ts` already imports
`session.ts`.

The **sign-in screen** used to read whatever that second writer had left: refreshing the session is
the only request a signed-out tab makes, and the route guard awaits it before the screen renders. One
answer, at page load, from a call made for another purpose — so a backend that stopped while somebody
was reading the page went on being reported as fine. It probes for itself now; see *The sign-in
screen*.

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
a string literal in a template is legal code. Five had slipped past it — `of {total}`,
`Layer n of m`, `unassigned`, `stalled` and a delete dialog's `Delete {name}?` — all on the two
screens whose numbers move most, which is exactly where a stray literal is least likely to be read
as text at all.

**Numbers go through `n()`, never `toLocaleString()`.** The two disagree: vue-i18n's formatter
follows the locale the operator picked, `Number.toLocaleString` follows the *browser's*. A German
interface in an `en-US` browser printed `1,000` on one tile and `1.000` on the next — including
inside `RollingNumber`, which is the shared counter behind three dashboard tiles and therefore the
one place that decides how every animated figure is grouped.

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

295 unit tests on Vitest with jsdom, in two groups.

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
                 the build planner and block picker, the agent and host lists and the host
                 action dialogs, the fleet graph, the server-assignment and connection panels
src/layouts/     AppLayout: sidebar, nav, drawer
src/i18n/        every user-facing string, one file per locale
src/lib/         everything computed away from a component: cursor-paged feeds, chat scopes,
                 build and vitals arithmetic, chart, box and voxel geometry, fleet-graph layout
                 and link health, placement offsets and substituted materials, block names and
                 their search, shortcuts, panel resizing, and presentation maps for agent state,
                 roles and permissions. `blockNames.generated.ts` is generated — see
                 `scripts/`
src/router/      routes and node-based guards
src/stores/      auth, fleet, the chat rail, and the sampled history behind the sparklines (Pinia)
src/test/        Vitest setup and the fetch stub
src/views/       dashboard, map, operations, resources, configuration, agent detail, host detail,
                 accounts, audit, login
scripts/         one-off generators, run by hand: the block-name table
```

Specs sit next to what they test as `*.spec.ts`, so they are type-checked with everything else — but
only by `npm run build`, which runs `vue-tsc -b`. `vue-tsc --noEmit` is **not** the same check: it
passed a component missing a required prop and a spec using a field that no longer existed. The
build is the one to trust.
