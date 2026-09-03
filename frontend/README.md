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

Nothing here is mock any more. Hosts, agents, their lifecycle states, all commands, the **audit
log**, **chat**, **activity**, **telemetry**, **live updates** and **configuration** are real. They
stay empty until a host connects and starts reporting, but nothing about them is faked.

The rest of this section is kept because it records what each mock cost and how it came off, which
is the part worth having when the next one is written.

**Build progress is no longer mock.** It was the last one: an invented block count per agent, five
hardcoded sectors named after parts of a cathedral nobody had uploaded, a layer counter, and a
throughput of 38 blocks per builder per minute — a constant with no basis at all. All of it is
gone, along with `agent.build`, `lib/build.ts` and a task string nothing had rendered in months.

What replaced it comes from hosts reporting against segments they were given: blocks placed per
segment, a rate measured over the time a job has been open, and an estimate derived from that rate
rather than from a guess. `src/lib/jobs.ts` holds the arithmetic and has its own spec.

Two consequences worth knowing. A fleet with nothing running now reads **zero and says so**, where
the mock always had something to show. And the numbers are scoped by the server picker, because a
job is per-server and a fleet-wide figure is a sum across separate builds — meaningful as a total,
not as a percentage of anything.

**A mock is marked on the screen, not only in the source** — and the marking comes off with the
mock. The dashboard carried a banner naming its invented figures, plus a `placeholder` badge on
each panel, because a banner at the top of a scrolling page cannot be relied on to still be in view
further down. All of it went when the numbers became real: a warning about invented data on a page
that has none is its own kind of wrong, and it teaches an operator to ignore the next one.

**Configuration was the last one**, and it went the same way. `src/lib/configuration.ts` used to
hold the field list, the values *and* a `saveSettings` that wrote to a map in that module and
resolved; the values now come off the agent like everything else, and the write is a real
`PUT /api/agents/{id}/settings`.

What survived the mock is the **shape**, which is why it was built that way: fields are declared as
a schema and rendered generically by type, so adding a setting is an entry in that file plus a copy
key rather than another block of markup — and the tabs render from the same declaration, so a new
group needs nothing in the view. That schema is now a specification rather than a placeholder: the
keys in it are what a host reads.

**Schematics are real, all the way through**: uploaded, read, measured, divided, started, dispatched
and built. A job records what is being built, where, by whom and how far along, and the figure moves
because a host reported blocks against it. What is still missing is **building on the host** — it
signs agents in, plays and reports, but nothing places a block yet.

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

**One column, one row shape.** The sidebar stacks hosts directly above agents, and they were drawn
as two different kinds of thing: a bare dot, a name and a count badge over a tile, a corner status
and two lines. One list reading unlike the other made the sidebar look like two sidebars. Hosts now
take the agent shape — the tile is `InitialTile.vue`, shared with `PlayerHead`’s own fallback rather
than copied, since a host has no avatar and never will and two copies would drift the first time
either was touched.

The host’s agent count moved off the right and under the name with that change. It is detail about
the host rather than a count of anything on screen, and a badge in the far-right slot reads as a
notification — which is exactly what the chat rail puts there, a few rows below.

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

**A picker offers only what the backend will accept.** Choosing builders asks three questions, not
one: in game, not already on a job, and on this build’s server. Two of them were the backend’s alone
for a while, so an operator could pick a crew, walk to the end of a four-step wizard, press the last
button, and be told there about one of them. Agents that fail any of the three still appear, greyed
with the reason — a busy one carries the blue dot and *Building* label, so "why not that one, it is
right there" answers itself.

**"On a job" is not "holding a piece"**, and reading the wrong one was the bug that outlasted the
rest. Agents are a pool now: one can be on a build while building nothing, waiting for the floor
under its next piece to be finished. Asking what an agent *holds* called that agent free — so the
picker offered it and the backend refused it, which is the exact failure the paragraph above exists
to prevent, back again through a door nobody had thought to close. Both pickers read membership.

**Pieces are counted separately from agents.** The split step has its own field, blank by default,
and blank means one piece each — what it used to be fixed at, and what somebody who does not want
to think about it should get. A bigger number is the useful setting: agents queue for work instead
of owning a share of it, so a slow bot takes fewer and anything cut on height pipelines rather than
standing still.

**A blocked piece says what it is waiting on.** A piece nobody holds while three agents stand idle
reads as broken, and for any build cut on height it is the ordinary case — a bot is two blocks tall
and builds from the floor up, so a piece with unbuilt work beneath it has nowhere for anybody to
stand. The backend sends the ordinals it is waiting on and the row prints them, because the
alternative is an operator counting boxes to work out whether the fleet is stuck.

**It searches past five agents**, on the same threshold and in the same markup as the schematic
library, over the label, the Minecraft account and the server — "which of these is on the build
server" is as ordinary a question as "where is Mason_14". Two rules make it safe on a fleet this
size:

- **Filtering hides, it does not deselect.** A search is how the next agent to tick gets found, so
  one already ticked stays ticked while the search looks past it. That is the opposite of what
  happens when an agent stops being *eligible*, which does drop it — a distinction worth keeping,
  since one changes what can be acted on and the other only what is on screen.
- **Select-all takes what is shown**, adding to the selection rather than replacing it, and clears
  only the rows on screen. Otherwise ticking all of one search would silently drop everything
  picked under the last one. It says *Select all shown* while a search is active, because a control
  reading "all" and taking four of twenty is the interface misreporting itself.

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

## Configuration

Pick agents on the left, edit on the right, and the same `AgentPicker` Operations uses — so the two
cannot drift apart.

**The settings are declared here, in `src/lib/configuration.ts`, and nowhere else.** A host does not
advertise what it supports: it applies the keys it recognises and ignores the rest, so a setting
exists the moment that list and one host agree on a name. The backend stores the map and relays it
without interpreting anything, exactly as it relays a login `method`. That keeps a new setting to an
entry in that file plus the code that reads it, rather than a release on three sides in order.

`connect.rejoin` is the one exception and the exception is structural: putting an agent back into
the game is a decision about where an agent belongs, and a host is never allowed to make one of
those. The backend reads that key, and the host ignores it like any other it does not know.

The fields render from the schema by **type** rather than from markup per setting — `regex`, `text`,
`switch`, `choice` — and so do the tabs, one per group, so adding a group needs nothing in the view.
The groups exist because a chat pattern and a reconnect policy are not read in the same sitting;
underneath, it is still **one form**. Every tab edits the same map and Update sends the whole of it,
which is why the buttons sit outside the tabs: a save inside one would look like it covered only
what was on screen.

**A switch writes `''` for off, not `'false'`.** An absent key is what both the backend and a host
already read as "no", so writing the word would give "turned off" and "never touched" two spellings
of one answer. A setting where off and unset genuinely differ is a `choice` with three options
instead, which is what `mc.knockback` is — unset means "decide from the version".

The form is seeded from the **first agent checked** and pushed to every agent checked. Two agents
can hold different values for one field and there is no honest way to show both in one input, so one
has to be the source; that is named above the fields, and unchecking it hands the role to the next.

### Who may command an agent, and with which commands

`players.whitelist` is one string holding a list of players and, for each, **exactly the commands
they may use** — `Notch:say+run`, or `Notch:none` for somebody on the list who may do nothing.
`+` joins the commands because the entries themselves are comma-separated.

**No tiers in the interface.** The setting used to hold `name` for chat commands and
`name:commands` for all of them, and both are still *read* — a stored setting holds them — but
nothing writes one, and a tier read is expanded into its commands on the way in. A tier is a name
for a set somebody has to learn, while every question actually asked of this list ("can they use
`run`?") is a question about the set. So the set is the whole model, and an entry normalises the
first time the form is saved.

That normalisation is worth the longer string: what is stored then says what is granted, and adding
a command to a later build cannot widen a grant somebody already made.

The picker is a dialog rather than a row that unfolds. Ten commands and their descriptions do not
fit beside a username, and a whitelist is read *down* — a row growing to three times its height
while being edited pushes the rest of the list off the screen. It borrows the add-agent dialog's
frame and the agent picker's checkbox rows, and edits **a copy**: a tick writing straight through
would leave the form dirty after a dialog somebody then cancelled. The row itself shows only a
count, coloured when any of `run`, `disconnect` or `reconnect` are in there — what a list is
scanned for is "does anybody hold more than they should", which a number and a colour answer.

Two rules that both exist so a grant is never widened by accident:

- **A word after the colon that is not a tier is a list of one**, never a tier guessed at. So
  `Notch:everything` from some future Osmium grants nothing here rather than falling back to chat
  and handing over seven commands. A host refuses any command it cannot name, which is what makes
  that safe.
- **A command this build cannot name survives a round trip untouched**, shown as a greyed chip.
  Dropping it would revoke a grant every time an older interface saved this form.

The command table is duplicated from the host, which is the authority — a host is a separate program
and may be newer. What that costs is a list that can go stale; what it buys is a picker that can
show names and descriptions at all.

### The pattern box highlights what it is

`RegexField.vue` draws a syntax-highlighted layer under a transparent `<input>`. The tokeniser lives
in `src/lib/regexHighlight.ts`, and every function in it is total against a non-string, since it runs
on whatever is being typed mid-keystroke. The order matters: the input paints **under** the layer, so
selection and caret stay the browser's own rather than something re-implemented in CSS.

It says what a pattern does to a real sample line rather than only whether it compiles, because a
pattern that matches and captures nothing is the mistake worth catching — it can never name a player.

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
there — the global channel forwarded once by the elected listener, plus whispers and the agents' own
lines — because all of it happened on that server. An **agent** scope is the conversation to or
about that agent, and excludes the global channel, which is identical for every agent standing there
and would bury the lines actually about this one.

Global lines arrive tagged with whichever agent forwarded them, which is why the agent side has to
exclude them explicitly, or the listener's conversation quietly becomes the whole server's. On a
server feed the agent is named beside any line that is not public: everything is in there, so a
whisper would otherwise be indistinguishable from public chat, and "who was this to" is the whole
question a private line raises.

Sending is impersonation through one agent, so a server scope names which — the listener first,
since it is the one already forwarding the conversation being read. A server nobody is forwarding
has no global feed at all, so the rail says so rather than showing an empty panel, which would read
as a quiet server instead of a missing one.

### A gap where somebody was repeating themselves

The backend refuses global chat from a player saying the same thing over and over, and refusing it
means there is no row — so the panel would simply lose lines, which reads as the feed being broken.
It draws **one row that grows** instead: "412 suppressed as repetition", counting up until something
gets through, and the next run starting a new row at one.

The count comes from the backend, which resets it when a line lands, so `foldRun` reads which of the
two things to do off the count rather than off what is on screen. A panel that missed an event then
corrects itself on the next one instead of growing a gap that should have closed.

The rows are **live only**. They have no id from the backend because nothing was stored, so they take
negative ones here, and a reload shows the conversation without the hole and without them. That is
the honest end state rather than a shortcoming: nothing was stored, so there is no hole in what was.

### Up brings back the last line

The chat box recalls the message it last **sent**, not the last one typed: a line the backend refused
is still in the box, and recalling it would put a second copy there. One line rather than a history,
because what Up is for is the message you just sent and want to send again — a stack of them needs
Down, an index, and an answer to what typing halfway through the stack means.

Only from an empty box. A half-typed line is worth more than the last one, and losing it to a stray
arrow key is the kind of small theft an interface should not commit. It lives in the panel and is not
persisted: recalling a line into a different conversation than the one it was said in is a way to say
something in the wrong room.

### Searching what was said

The search box matches message text **and sender**, case-insensitively, against the stored feed
rather than the lines already fetched — searching what is on screen would look through the newest
hundred of a three-day retention and report nothing, which reads as an answer.

A toggle decides whether it searches the current view or everything. Scoped is the default because
that is what is being read; unscoped is the one that earns its place, since a phrase somebody
half-remembers rarely comes with the server it was said on. Backed by one endpoint filtered two
ways: `query` narrows whichever of `agentId` or `server` was given, and with neither it goes across
every server the fleet has listened to. Reading still needs a scope — an unfiltered firehose is not
something any view wants — so supplying a query is what buys the right to omit one.

**Sending is fire and forget.** The box clears on a 2xx and the line appears when the host echoes it
back, the same way everybody else's does — carrying the rank, the colours and the prefix the server
put on it. That is the version worth reading, and waiting for it is the only honest way to show it.

There used to be a placeholder: the line drawn dimmed the moment the backend accepted it, matched
against the echo by text, and marked *not confirmed* after ten seconds. It cost a race with the echo
— a local host can beat the POST it was sent by, which drew the line twice — a grace timer, and an
unmatched-echo buffer to unpick the race. All to answer a question the feed itself already answers.

**Which agent said a line is matched on the account *and* the server.** Chat names a Minecraft
account, an operator thinks in agents, and one account can be played by two agents on two servers.
Keyed on the account alone the second overwrote the first, and every line from either was labelled
with whichever agent happened to be built last. An account played by exactly one agent still
resolves by name alone, so moving an agent between servers does not blank its own history.

**A first page and an older one are different waits.** Switching servers empties the panel and
fetches a whole transcript, which takes long enough that a single centred word read as a blank
panel; it now draws skeleton lines in place of what it is about to show. Paging older keeps the one
line, because the conversation is still on screen and the wait happens off the top edge.

### Chat is drawn as the server styled it

A line arrives with the **components** the server sent, not only the flattened string, and
`McText.vue` renders them: rank prefixes, the colour that separates a whisper from the room, the
styling on a player's name. `src/lib/mcText.ts` turns the tree into spans and has its own spec.

**Style is resolved by the host, absolutely, and not inherited here.** A component tree inherits
colour and formatting down its children in Minecraft, and doing that resolution in the browser meant
every renderer had to agree about it. The host answers it once and sends every node fully specified,
so this side is a `v-for`. `black` and `white` deliberately fall through to the theme rather than
being painted: a server that says "white" means "the default colour", and honouring it literally
makes half of chat invisible in a light theme.

Everything interactive — `clickEvent`, `hoverEvent`, `insertion`, `font` — is stripped by the host
before it ever gets here. Nothing in a chat line should be able to make the operator's browser do
anything.

Obfuscated text (`§k`) is animated in `src/lib/obfuscate.ts` on **one shared 50ms clock** rather
than a timer per span, and the scramble preserves whitespace and character count so the line does
not jitter its own width. Codepoint-safe, because a naive character swap turns an emoji into two
replacement boxes.

**Who said it comes from the packet where the packet says so.** `playerChat` carries a signed uuid
that cannot be spoofed by typing `<Notch>` into a message; only when there is none does the host
fall back to the configured `chat.sender` pattern, and a line it cannot attribute is filed as
`server` rather than as the agent that happened to overhear it. Every agent on a server sees the
same room, so guessing would turn that room into one bot's monologue.

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

**Change server** was the same dead end one level further in: the button always opened, and the
dialog behind it had its field and its Save disabled whenever the agent was in game. So the reason
arrived only after a click, in a box that could do nothing. It computes a reason like the other
three now. The guards inside the dialog stay — an agent can connect while it is open, and the field
then disables itself under the operator — because the two answer different questions: the button is
about whether to start, the field about the state changing mid-edit.

## Tabs live in the URL; steps do not

Operations' tabs and Resources' kept their position in a `ref`. That cost the same two things each
time: nothing could be linked or bookmarked, and **browser Back left the page entirely** rather
than returning to the tab before it.

`src/lib/queryState.ts` holds `useQueryTab`. The route is the only source of truth, so Back and
Forward work with no listener of ours.

A **query parameter rather than a nested route**. These are panels within one screen, not screens of
their own: the page keeps its header, its node gate and its loaded fleet across a tab change, and
modelling that as a route would mean restructuring the router to describe something that is not a
navigation.

**The default is kept out of the address bar.** Writing `?tab=bots` when bots is what an absent
parameter already means adds length and says nothing, so the key is removed instead.

**A tab id is the tab’s name.** `?tab=power` for a tab labelled *Connections* is a URL an operator
cannot read back, and one nobody can guess at when writing a link by hand. The ids track the
labels, and renaming one means renaming the other.

### The wizard is the exception, and it is the interesting one

The four-step schematic pipeline held its step here too, and it was the case that did not fit. A URL
can ask for step four; nothing in a URL can carry **who is building**, which is what step four is
about. So `?step=split` with nobody picked was a request that could never be honoured — and it
arrived by the most ordinary route there is: start a job, get moved to the Jobs tab, press Back.

That was patched first, and the patch is worth recording because it is what a clamp costs. `step`
became the *minimum* of what the URL asked for and what the state could fill, so the screen showed
the agent picker while the address bar said `split` — a disagreement a reload then resolved the
other way. And because it was a minimum, choosing a single builder lifted the ceiling and teleported
the operator straight to the division, skipping the button whose whole purpose is to say they had
finished choosing. Correcting the URL fixed both and added a third moving part to a screen that
already had two.

**So the step went back into component state and the wizard restarts at the top.** Every step after
the first depends on an answer given on the one before it, so a pipeline that always begins at the
beginning can never be asked for a step it cannot fill: the whole class of bug leaves with the
persistence rather than being defended against. The schematic and the plan went with it — each was
in the URL to keep the *step* honest, and neither has anything left to answer for.

The cost is real and was paid deliberately: browser Back now leaves Operations rather than stepping
back through the wizard. The wizard has its own Back button, which is what steps.

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

## The world viewer

An agent's surroundings, rendered live, at `/agents/:id/view` behind `agent.view`. Offered from the
agent screen while it is in game, because there is no world to watch otherwise.

The renderer is **prismarine-viewer's own, unmodified at runtime**: writing one would mean
reimplementing Minecraft's block models. What this app supplies is the transport — upstream talks
socket.io straight to a host, and Osmium's hosts dial out and are never reachable — and the assets.

Free camera and first person are a **camera choice** over the same stream. Neither sends anything to
the agent; watching is all `agent.view` grants, and driving one would be a second node.

### Its assets are built, not shipped

`scripts/viewer-assets.mjs` stages everything the renderer fetches at runtime into `public/viewer/`,
and runs before `dev` and `build`. It is gitignored — the atlas and block-state pair is ~14 MB per
version.

Upstream ships those prebuilt only up to **1.21.4**. Anything newer is generated from
`minecraft-assets`, and the meshing worker is rebuilt against the `minecraft-data` this project
resolves, because the bundle upstream ships predates every version published since its release and
answers a newer one by throwing. Set `OSMIUM_VIEWER_VERSIONS` to change what is staged; a fleet on a
major nobody staged fails at build time rather than per browser.

**The build proves what it produced.** It starts the worker it just built, feeds it every staged
version, and checks that the data the mesher reaches for by name survived the filter. All of that
fails inside a Web Worker otherwise, where it surfaces as `Uncaught` lines with no stack into this
project and a viewer that silently renders nothing.

### Block entities are drawn as boxes

A chest and a shulker box render as **nothing at all** in an unpatched build, and the reason is not
a missing texture. They are *block entities*: Minecraft draws them with a dedicated entity renderer
from `entity/chest/*`, and their block model file is deliberately empty — a particle texture and no
geometry. A mesher builds from model elements, so it emits none, and a wall of chests is thin air.

The staging step gives those blocks a box of their own particle texture, at roughly the size the
real thing occupies. A shulker box *is* a full cube, so that one is nearly exact; a chest is inset a
pixel either side and comes out a shade large and plank-coloured. Both are the right size, in the
right place, and visible, which is the whole difference that matters when the point of the screen is
seeing what is around an agent.

Heads and skulls get the same treatment at an eighth of a block, and **their colour is the one thing
this gets wrong**: the only texture a skull model declares is its particle, which is `soul_sand`,
because what vanilla draws is an entity texture — and for a player head that texture is a skin
fetched per player. A head therefore comes out a soul-sand-coloured cube of the right size in the
right cell. That is the whole choice on offer: a wrong colour, or nothing there at all. Which way a
wall head faces is not in the block states either — vanilla leaves skull rotation entirely to the
block entity — so those sit centred in their cell, which is never badly wrong for any facing.

Only the ones a box describes. Beds, signs, banners, conduits and decorated pots are left alone: a
solid block where a flat wall sign should be reads as a wall nobody can walk through, which is worse
than the gap it replaces. Drawing those properly means implementing a second renderer, which is a
different project.

It also reaches the map and the inventory icons for free — both derive from the same block states —
so a chest now has a colour from above and a picture in a slot.

### Players wear their own skins

The renderer builds every player from one texture named in its entity table — `steve.png` — with no
notion that two players look different. What it does give is a **material per mesh**, so the texture
on one player can be replaced without touching the others or the renderer itself.

Each player gets a texture of its own, built rather than reused. Upstream caches textures by URL, so
the one hanging off a player belongs to every player *and* to the agent's own body; writing an image
into it dressed the whole world in whichever skin arrived last.

**A slim skin gets a slim body, because the difference is geometry rather than texture.** An arm is
four pixels wide on the classic model and three on the slim one, and a three-pixel sheet worn on the
wide model runs a column of the sleeve's neighbour down each arm. The model is derived in
`scripts/viewer-assets.mjs` and written into the renderer's entity table there — it cannot be
registered from application code, because `Entity.js` does `require('./entities.json')` and the
bundler inlines that table into its pre-bundle. Which of the two a skin was drawn for is read off
the sheet: the slim layout leaves a column empty on the four faces that run across each arm, and
that is the only thing in the file that says which model it is for.

**Legacy skins are ordinary, not a rarity to defend against.** Of the first three accounts this was
checked against, two came back **64x32** — the pre-1.8 layout, which has one arm and one leg and
lets the game mirror them. The model samples the bottom half of a 64x64 sheet, so an unconverted
legacy skin renders a player with transparent limbs, and the skin service does not normalise. So
`src/lib/skins.ts` does, on a canvas: the sheet is copied over and the missing limbs are drawn face
by face, each flipped. Face by face because a block copied whole comes out with its front and back
swapped — the faces change sides as the limb crosses the body.

Converted in the browser rather than in the proxy on purpose. The browser is decoding the PNG to
render it anyway, and the alternative is teaching a service that is currently a byte proxy to decode
and re-encode untrusted images.

A player whose skin the service does not know, or a deployment with `osmium.avatar.skin-upstream`
blank, simply stays Steve.

### Four accommodations for a renderer built for webpack

Upstream's build does things Vite does not, and each gap is a different failure:

- **`canvas`** — its nametag drawing imports Node's `canvas`. Aliased to `src/lib/nodeCanvas.ts`; a
  browser's own canvas is what that package exists to emulate.
- **`process` and `__dirname`** — read before the code decides it is not in Node. `process` is set
  before the renderer is imported, `__dirname` defined away.
- **`worker.js`, textures and block states** — resolved by bare relative path against the page URL.
  The worker's constructor is swapped for the moment its workers are made; the atlas and states are
  handed over directly; entity textures are rewritten through three's loading manager.
- **the global `THREE`** — its entity models read one rather than importing it.

### Three patches to the mesher, at build time

Two are the assumption that a world starts at y=0: the section lookup reads the array as though
index 0 were y=0, and a face whose neighbour lies below y=0 is culled as though it faced the void.
Together they left everything under bedrock level invisible except blocks with no cullable faces.

The third is a substring test standing in for an equality test, and it is the more instructive bug.
The mesher opens by refusing to model air:

```js
if (block.name.includes('air')) return []
```

`'oak_stairs'.includes('air')` is **true** — *st**air**s* contains *air*. Every staircase in the game
was therefore treated as air and given no model at all, so none had ever been drawn. Narrowed to the
three blocks that actually are air. `missing_texture` is deliberately not among them: it has a
model, and it is the fallback the line beneath depends on.

That one was found by running the mesher headlessly rather than by reading it — a synthetic world
holding one block, counting the faces that came back. Stairs returned zero where a slab of the
identical first element returned six, which is what pointed at the lookup rather than at the
geometry. Worth reaching for early on this file: three separate theories about culling and variant
matching were wrong before the measurement settled it.

Patching a dependency is not free. It was taken because the checks sit inside a Web Worker two
callers deep, so there is nothing to wrap from outside, and vendoring the files to change three
expressions would mean owning the rest of them. Each patch asserts how many occurrences it expects,
so an upstream change fails the build rather than quietly reverting.

### Every mob came out in pieces

Upstream's entity builder, `Entity.js`, has five defects between it and the model format, and
together they accounted for every mob that looked wrong. All five are corrected by
`viewer-assets.mjs`, in the package, for the same reason the mesher patches are: the code runs two
callers deep inside the renderer with nothing to wrap from outside.

**A bone's ancestors are never applied.** A cube is placed using its own bone's rotation and no
other. The skeleton would normally supply the rest of the chain, and cannot: `bind()` calculates each
bone's inverse *after* the bones are already in their bind pose, so every bone matrix comes out equal
to the mesh's own world matrix and the chain cancels itself exactly — measured on a cow, to zero. A
head parented to a rotated body is then drawn where an unrotated body would have put it: 1.3 blocks
out on a cow, 2.8 on a polar bear. 97 cubes, 18 entities.

**A cube's own rotation turns about the model origin.** `cube.rotation` is applied before the pivot
is subtracted, so a rotated cube swings around the entity's feet rather than spinning where it
stands. The chicken's body is the clearest: laid flat about the origin it lands below the ground and
behind the bird. 33 cubes, including every minecart.

**`mirror` is ignored**, on 14 cubes, and **per-face UVs are read as a pair**, on 13. The format
allows `uv` to be an object of faces rather than one origin for the whole unwrap, and `cube.uv[0]` on
an object is `undefined` — which makes every coordinate on that cube `NaN`, and takes the bounding
sphere and the mesh with it.

**A missing parent throws.** Six entries name a bone that is not in their own list — five only in the
wrong case, `rightItem` hanging off `rightarm` where the bone is `rightArm`, and the witch naming a
`head` it does not have. Upstream indexes the parent unconditionally, so the whole model threw while
being built and the renderer fell back to a magenta box. Six entities never drew at all.

The fix is checked by re-deriving every cube's vertices from the model JSON, independently of the
renderer, and comparing against what was emitted: 81 entities, no disagreement.

### Two entries are simply wrong, and no renderer can fix them

Separate from the five above: a few entries carry a bone at a coordinate the rest of their own model
disagrees with. The renderer draws exactly what it is given, so these are corrected in the table.

The **enderman** is a biped derivative stretched to 2.9 blocks. Its legs reach y 26, its body runs 26
to 38 and its arms end at 38 — but its head was still at 24, the height a *player's* head sits at,
leaving it buried in the torso with nothing on top. Two independent things in the same entry say
where it belongs: the body's pivot, and the head's own child `hat`, which is the piece drawn at the
top of the model. Both sit at 38.

The **enderman**'s and the **drowned**'s own-left arms sit inside their torsos while the other arm
hangs clear. Those are derived from the opposite limb rather than written out, because that is the
statement being made — the two are meant to be mirror images and one of them is right. Which one is
not a guess: in both entries the other limb sits flush against the edge of the torso, which is what a
shoulder does. Only x moves.

Both are found by measurement rather than by eye, and the searches are worth keeping: one asks which
left/right pairs are not mirror images, the other which limbs intersect their own torso while their
partner does not. The first alone is too noisy to act on — a wolf's legs are genuinely off-centre in
vanilla, and a blaze's twelve rods are not six pairs.

### Names and boxes over what matters

Every player carries a nametag and a box, and the agent's own body carries both too — it is not one
of the streamed entities, because the host omits the agent from its own view, so nothing in the
renderer's entity list describes it and the pass that decorates everybody else never sees it.

The box takes **the map's colours**, `--color-primary` for the fleet and `--color-error` for everyone
else, so the two screens never disagree about who is ours. Whether somebody is ours arrives with the
telemetry, which can land after the entity does, so the box is rebuilt when the answer changes rather
than left the colour it was first drawn.

The label says exactly what the map says, from the same function: an agent's Osmium label above its
Minecraft name and vitals, a stranger's name above theirs. It is drawn onto a fixed 500-pixel canvas,
so a long line is scaled to fit rather than run off both ends.

### Entities leave the skinning path

Upstream builds every entity as a `SkinnedMesh` and then never moves a bone: it tweens the whole
thing's position and yaw and nothing below. Every bone matrix stays equal to the mesh's own world
matrix, so the skinning the shader performs reduces to `inverse(matrixWorld) * matrixWorld * v`.

That identity is not free. The shader evaluates it in float32 where the CPU would have folded the
world out in float64, and `bindMatrixInverse` carries the entity's position scaled by sixteen. Past
about x = 8,000,000 consecutive float32 values there are a whole block apart, every x within a body
rounds to the same number, and the model collapses to a sheet that shifts to the next cell as the
entity walks — flat, and flickering. The other axes survive or not depending on their own magnitude,
which is why it reads as corruption rather than as an obvious failure.

Switching skinning off leaves `projectionMatrix * modelViewMatrix * position`, and three builds that
model-view on the CPU relative to the camera, so nothing large reaches the GPU at all.

### What it does not draw

Block entities — chests, heads, signs, beds — have deliberately empty block models, because vanilla
draws them with dedicated renderers. They appear as holes.

An entity type the streaming library does not recognise arrives without a name, and upstream then
falls through to a box sized from a width and height that a movement update does not carry either.
Those are filtered out rather than shown as the magenta box upstream substitutes. Entity *models*
are no longer among them: the six that could not be assembled now build — see above.

## The map

The ground the fleet has charted, at `/map`, drawn one pixel per block column — vanilla's zoom
zero, so it lines up with the coordinates an operator reads off F3. Full bleed like the viewer, with
every control floating over it: a map is read by looking at a lot of it at once, and a card with a
header above it spends a third of the screen saying what the screen is.

Unlike the viewer it asks nothing of a host. Agents report the surface they walk over as they work,
so the map is already drawn by the time somebody opens it.

### It stores blocks and draws colours

What comes back from the API is block **names** and heights, never colours. The palette is generated
by the same pipeline that builds the viewer's atlas — every block's top texture, averaged, with the
biome tints the mesher applies — so the two views cannot disagree about the colour of grass, and
restyling the whole map costs nothing rather than an agent re-walking the world.

Terrain is shaded by the step up or down to the column to its **north**, including vanilla's parity
dither, which is what gives a Minecraft map its stippled slopes. Most of what makes the picture read
as landscape rather than as a chart of what blocks are where is in that one rule.

### Regions, not tiles

A viewport at one pixel per block covers several thousand chunks. Painting is cached per chunk, but
*drawing* is batched into **32×32 chunk regions** — one 512×512 canvas each — because a `drawImage`
per chunk per frame is thousands of calls a frame, and panning crawled until it was a couple of
dozen. The draw loop walks the regions the viewport covers rather than every tile ever loaded.

### The window has to fit

The backend answers at most 4096 chunks a request, so the client shrinks a larger window about its
centre, keeping the viewport's shape. A window is always an odd number of chunks across — a centre
plus a half either side — so scaling by the ratio and halving is not enough: 81×51 is 4131 against
the cap, the ratio is 0.996, and both halves round straight back. It floors to the odd size below and
then trims the longer side until it genuinely fits.

### Dimensions are separate maps

The worlds share a coordinate system and are otherwise unrelated, so the dimension is part of the
address rather than a filter. Switching one throws away every painted tile: the coordinates carry
over, so what is held is not stale, it is somewhere else. Agents in another dimension are dropped
from the overlay — drawing a Nether agent on the Overworld map puts it on ground it has never seen.

### Who is standing on it

Agents are drawn in the theme's accent with a fading trail of their last thirty positions, because
motion is what makes a fleet read as working rather than as a list of dots. **A player who is not
one of ours is drawn in red** — a stranger walking onto a build is the question an operator opens a
map to answer. Strangers are collapsed by name, since two agents seeing one person is one person.

## The inventory card

What an agent is carrying, on its own page under the vitals. Here rather than on a screen of its
own because it is one of the readings: an operator asking why an agent stopped mining is asking
about its pickaxe, and a page that answers that two clicks away is one they check less often than
they should.

Laid out the way Minecraft lays it out — armour and the off hand, then the backpack above the
hotbar — because whoever is reading it has the game's own screen in their head, and a grid in any
other order is one they have to translate. The slot numbers underneath are the game's too, all the
way to the click the host performs, so what is drawn in a square and what a click says about it
cannot disagree.

### Absent is not empty

An empty grid is a perfectly ordinary thing for an agent to be carrying, so drawing one for an agent
that has reported nothing is not a blank screen but a wrong answer. The API answers `204` for the
second case and the card says so in words.

### Laid out the way the game lays it out

The twenty-seven, the nine set apart below them, and the worn things together off to one side.
Whoever is reading this has the game's own screen in their head, and a grid in any other order is
one they have to translate every time.

The one departure is where that last group goes. Minecraft stacks the armour *above* the twenty-
seven because it has a whole window to spend; a card does not, so the column sits beside them, which
costs a strip that was empty anyway instead of five rows of height.

**The two columns are sized off different axes.** The nine squares are driven by the width they are
given; the armour by the height the nine end up occupying — one grid of seven rows, five of them
equal fractions, stretched to whatever the left column comes to. So the two always end level, and
the armour squares come out smaller, which is the right way round: there are five of them against
thirty-six. All five are in *one* grid rather than two stacked blocks, because split across two the
armour's own row gaps would make it the smaller of the pair.

Squares are sized by their cell rather than in rem. The first cut fixed them at 2.25rem, reasoning
that a 16-pixel sprite in a 31.4-pixel box has a seam through it — true of a bitmap scaled by a
fraction, false of `image-rendering: pixelated` over a background sized in percentages. What it
actually bought was a grid using a third of the row with the rest of it empty.

Which square is **in hand** is part of it and can be changed from here: it decides what the agent
hits, places and eats with, so it is a fact worth both showing and setting. An empty hotbar square
is therefore selectable even though there is nothing in it — an empty hand is a real choice — while
an empty square anywhere else is not, because no click there could mean anything.

### The hand travels

Which hotbar square is in hand is one ring that slides between them, not a border that lights up on
each square in turn — the same single-marker trick as `TabBar`, measured off the laid-out button and
translated. The reason is the same too: switching hand is a *movement* along the bar, and nine
borders taking turns can only say it happened, never that it travelled. The square underneath keeps
a hint of the same colour, which is what stops the ring reading as floating over an unrelated square
halfway through the slide.

It is not shared with `TabBar`: that marker is a background a tab sits on and is sized to fill it,
this one is a ring drawn over something already there. What they share is the idea, not the code.

### It locks while the agent is building

A third reason the squares go inert, alongside no permission and not in game — and the only one that
is temporary and the operator's own doing. What an agent carries while it builds *is* the build, so
the backend refuses these outright; saying so on the card is what stops somebody discovering it by
having a click fail.

### Moving is a drag; clicking opens a panel

It was both for a while, sharing one selection — which meant clicking two squares in a row moved an
item, and therefore that every click was half of a move somebody might not have meant to start. A
drag says what it is doing while it is doing it and is abandoned by letting go somewhere else. The
square under the cursor is filled in hard while a drag is over it: that is a question being asked
with an item in hand and half a second to read the answer, so it is louder than any of the states
that merely describe how things are.

A click opens a small panel anchored to the square — put in hand, drop one, drop stack. Over the
square rather than in a row under the grid, which is where it started: a strip at the bottom of the
card is a long way from the square somebody just clicked, and on a thirty-six square grid it is not
obvious which one it is about.

Nothing is written locally. What an agent is carrying is the host's to say, so a move is sent and
the grid waits: showing it done before the server had agreed is showing something that then has to
be taken back. The whole grid is disabled while a move is out, because the answer is a whole new
inventory and a second click lands on squares that are about to be renumbered.

**The square in hand is ringed; the square an operator picked up is filled.** One is a fact about
the agent and the other is a selection somebody made, and they must not look alike on one grid.

### Its icons are built, not shipped

The same pipeline as the viewer's atlas and the map's palette, and the same bargain: the API sends
item *names*, and `scripts/viewer-assets.mjs` generates a sprite sheet from `minecraft-assets`.

Minecraft has two kinds of item and the sheet has two sources. Something you hold — a pickaxe, a
carrot — has a flat sprite of its own. Something you place has none, because the game draws its icon
by rendering the block; what stands in for it is the same face the map reads, copied out of the
block atlas and tinted the same way, so a stack of grass blocks is the colour grass is everywhere
else in this app. A cube drawn in perspective would be closer to the game and is a renderer this
project has no reason to own.

**An item's name is not its texture's name**, and assuming it was cost a hundred and forty icons.
An enchanted golden apple is drawn from `items/golden_apple`, a waxed copper block from
`block/copper_block`, every stair and slab from the block it is cut out of. `items_textures.json`
is the mapping; a block texture is resolved by handing its name back to the same block lookup, which
is how a slab inherits the tint and the face ordering its parent already gets right. The item's own
sprite and its own block are still tried first, because where they apply they are the better answer
— a block's model gives grass a green top rather than the dirt its texture reference points at.

Two more things worth knowing before touching it:

- **A face in the block atlas carries the crop its model samples, not the whole texture.** A torch's
  top face is the two pixels by two it happens to be, which as an icon is four yellow pixels of
  flame. Snapping back out to the tile that crop sits in recovers the texture, which is what an icon
  is. The map wants the opposite and reads the crop, because there the question is what that face
  looks like.
- **Coverage is a floor, not an exact count**, and it is there to catch a resolver regression: it
  sat at 87% while the texture mapping was missing. It cannot be total either, because
  `minecraft-assets` lags `minecraft-data` by about a release — at 1.21.4 it carries no pale oak
  and no resin at all, which is 27 items nothing can find a texture for. Five named items guard the
  five paths through the resolver, which is the part that actually catches a break.

An item the sheet has never heard of is drawn as its name in the square rather than as an empty one:
it is still an item somebody has to decide about.

## Pages that scroll themselves

Most views are given the height of the frame and put a scrollbar on the part of themselves that is
long — the table, the list of jobs — so the title and the filters above it stay put while the rows
move. A page that is simply a column of cards has no such part: the whole column is the long thing.

Those pages set `meta.scrolls` and the layout hands them the frame's own margins, which they apply
*inside* their scroller. The scroller is the full width of the frame and the centred column sits
within it, so the scrollbar runs down the right edge next to the chat rail. The other way round — a
centred column that scrolls — puts the scrollbar wherever that column happens to end, which on a
wide screen is a bar down the middle of the page with content on both sides of it.

The two layout-level notices keep their margin either way. They belong to the frame rather than to
the page, and a warning hard against the window edge reads as broken.

## The storage screen

Under All accounts, gated on `storage.read`, which only administrators hold. What the deployment is
keeping on disk, by area, with a bar scaled against the **largest area** rather than the database —
the database total carries the catalogue and free pages, so scaling to it leaves every real bar
short and the picture flat, which is the one thing a bar chart is for.

The screen is built around a distinction the interface cannot show on its own: **deleting frees
space inside the database, and only rewriting the tables returns it to the disk.** Somebody who
deletes a month of chat and watches the number not move concludes the button is broken. So space
that has been freed but not returned is a column of its own, the total is a stat of its own, and
returning it is a separate button that says what it costs — every table locked while it is rewritten.

Two areas carry an explanation instead of a button: the audit trail, because it is the record of
this screen being used, and everything whose rows hang off other rows, because those are owned by
pages that understand what would go with them.

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

389 unit tests on Vitest with jsdom, in two groups.

**Where a bug is invisible** until someone is locked out or over-privileged: the route guard, the
auth store, the API client's middleware, the fleet store's derived state, the cursor paging in
`useFeed` — where a cursor that is not carried forward silently re-reads page one — and
translation parity, where a missing placeholder swallows a value without erroring.

**Where a bug renders as a plausible wrong answer** rather than an error. Everything in `src/lib`
that computes something is a plain function with its own spec, because the failures are arithmetic
and they all look fine on screen: a sparkline with one sample or a flat series (`series.ts`),
distance measured across a dimension or a server (`vitals.ts`), how far along a job is and what the
fleet places per minute (`jobs.ts`), where rounding up would call a build finished one block short
of it and a rate measured over too short a window reads as an ETA of minutes, which chat scope a live line
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
