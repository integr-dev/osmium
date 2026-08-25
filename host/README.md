# Osmium host

**Not built here.** This directory is a placeholder; the host is being written separately, in
**Rust** on [azalea](https://github.com/azalea-rs/azalea).

The host runs on a machine you control. It holds the Minecraft credentials, drives the agents, and
is the only component that ever performs a login. Everything it needs to talk to already exists on
the backend side and is covered by tests — see `HostLinkTest` and `ChatListenerServiceTest`.

This file is the **wire reference**: every message that crosses the socket, with its exact JSON.
[`../FLEET_CONNECTIVITY.md`](../FLEET_CONNECTIVITY.md) is the reasoning behind it — read that once
before starting, this one while implementing. The backend imposes no language or library; azalea is
a choice the host makes rather than something the backend knows about.

---

## 1. Connecting

One WebSocket per host, dialled **out** by the host. Nothing ever connects *to* the host, so it
needs no inbound ports and no TLS certificate of its own.

```
GET wss://<backend>/ws/host
Authorization: Bearer osm_host_<hostId>_<secret>
```

The token is issued once when an operator enrols the host, and shown to them exactly once — the
backend stores only a BCrypt hash of the `<secret>` part. Keep it in `OSMIUM_HOST_TOKEN`.

Authentication happens **during the handshake**, before any frame is accepted. A bad token is a
failed handshake, not an error frame: expect the upgrade itself to be refused. Reconnect with
backoff; a rejected token will not start working on its own, so log it loudly rather than retrying
in a tight loop.

A host may hold only one connection. Connecting again **supersedes** the old socket — the backend
closes the previous one. That makes reconnect-after-network-loss safe, and it is also how a token
rotation evicts a session.

The backend records the remote address it observed on connect, which is why enrolment never asks
for one.

**The first frame you send is [`handshake`](#45-handshake--once-immediately-after-connecting)**,
stating what this host is running and what it can log in with. Without the first, a host that has
restarted leaves Osmium asserting sessions that no longer exist. Without the second, none of its
agents can be set up.

---

## 2. The envelope

Every frame in both directions is one JSON object with this shape.

```jsonc
{
  "id":      "cmd-7f3a",   // correlation id; present on commands and echoed on results
  "kind":    "command",    // "command" | "result" | "event"
  "type":    "setup_agent",// what this message is
  "agentId": 42,           // omitted for host-scoped messages
  "ok":      true,         // results only
  "payload": { }           // nested, never spread across the top level
}
```

| Field | Type | When |
|---|---|---|
| `id` | string | On every `command`. **Echo it back** on the matching `result`. Absent on events. |
| `kind` | string | Always. See the table below. |
| `type` | string | Always. |
| `agentId` | number | Whenever the message concerns one agent. Absent on `heartbeat`. |
| `ok` | boolean | On `result` only. |
| `payload` | object | Type-specific. May be absent when there is nothing to carry. |

| `kind` | Direction | Correlated | Semantics |
|---|---|---|---|
| `command` | backend → host | carries `id` | at most one result |
| `result` | host → backend | echoes `id` | answers a command |
| `event` | host → backend | no `id` | unsolicited; never awaited |

Only `setup_agent` is answered with a result today. Every other command is fire and forget, and its
outcome is reported as an `agent_status` event instead — which is per §6 the rule, not an accident:
state advances when the host says so, not when the backend asks.

**There is no destination field.** The connection *is* the host — the backend picked that socket by
resolving the agent's host — so `agentId` only routes *within* a host.

**The payload is nested on purpose.** An unrecognised message still parses far enough to be logged
and ignored; a flat discriminated union would fail the whole parse. Model this as a concrete
envelope with the payload left as a raw JSON value, decoded only after switching on `type`.

---

## 3. Commands the backend sends

### `setup_agent`

Log an account in and report back **only** its resulting identity. This is the one command that must
answer with a `result`.

```jsonc
// backend → host
{ "id": "cmd-7f3a", "kind": "command", "type": "setup_agent", "agentId": 42,
  "payload": { "label": "Mason_04", "method": "device_code" } }
```

| Field | Meaning |
|---|---|
| `label` | The operator's name for this agent. Not a Minecraft account name. |
| `method` | The login **mechanism** the operator chose, relayed uninterpreted. |

> ⚠️ **Changed — this payload no longer carries `serverAddress`.** A host must not expect it.
>
> Setting an agent up is acquiring a credential, and a Minecraft account can join any server, so
> where an agent plays is a separate decision that can change afterwards without touching the
> account. Sending it here handed the host a value that went stale the moment the agent was
> reassigned — and it was never needed, because `connect` carries the address, which is the point at
> which it matters.
>
> An agent may now also be assigned to **no server at all**. It can still be set up from there;
> it simply cannot be told to connect until one is chosen.

`method` is always one of the ids **this host advertised** in its
[`handshake`](#45-handshake--once-immediately-after-connecting). The backend has no idea what any of
them mean and stores nothing about them; it checks the string against your own list and relays it
verbatim.

**`method` is a mechanism, never an account.** It says "use this flow", not "use this identity".
Nothing in this protocol ever tells the host *which* account to acquire — that is the whole point of
the design.

Answer with the identity only:

```jsonc
// host → backend, success  ->  agent becomes LINKED
{ "id": "cmd-7f3a", "kind": "result", "type": "setup_agent", "agentId": 42, "ok": true,
  "payload": { "mcUsername": "Mason_04", "mcUuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5" } }

// host → backend, failure  ->  agent returns to UNLINKED so the operator can retry
{ "id": "cmd-7f3a", "kind": "result", "type": "setup_agent", "agentId": 42, "ok": false,
  "payload": { "reason": "device code expired" } }
```

`type` may be either `setup_agent` or `setup_result`; both are accepted. `reason` is logged, not
shown to the operator, so write it for whoever reads host logs.

**Send it late rather than not at all.** An operator can stop Osmium waiting on a setup — a sign-in
begun on a machine they cannot get back to has no other way out, since nothing here can time a login
out. That returns the agent to `UNLINKED` and **sends you nothing**: it is not a cancellation, and
there is no command to implement for it. Keep going, and report the result whenever it arrives. A
success reaching a backend that has given up still links the agent, because the result is applied on
its own merits rather than on the state the backend expected to find.

> ⚠️ **Changed — the backend no longer invents the list.** It used to offer four placeholders,
> `method_a`–`method_d`, to every host regardless of what that host could do. Now it offers exactly
> what you advertise, and refuses anything else with a **400** before the command is ever sent.
>
> A host that advertises nothing can set nothing up. This is not a failure mode to work around: it
> is the backend declining to guess on your behalf.

An unsupported `method` should still be a normal `ok: false`. The check above closes the common
case, not the race where your list changes between the handshake and the command.

### `connect`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "connect", "agentId": 42,
  "payload": { "serverAddress": "mc.example.com:25565" } }
```

`serverAddress` is **always present and never empty**. It is the authority on where this agent plays:
it is not sent at setup, it can change between one connect and the next, and an agent assigned to no
server is refused by the backend before any command is dispatched. A host should use the address in
this payload rather than anything it remembers.

Fire and forget: **do not send a result.** Report the outcome as an `agent_status` event instead —
`ONLINE` on success, `CONNECT_FAILED` if the server refused, `NEEDS_RELINK` if the stored credential
was rejected.

**Report it, and report it inside 90 seconds.** Dispatching this moves the agent to `CONNECTING` on
the backend — the one state it sets on its own, and the only one it is prepared to take back. It is
what tells an operator the button did something during the seconds a join takes. An agent still
`CONNECTING` after `osmium.agent.connect-window` falls back to `LINKED`, with an activity entry
saying the host never answered.

That fallback is a display correction and nothing else: no command is sent, nothing is cancelled,
and a host reporting `ONLINE` late is still believed. A join that genuinely runs longer than the
window is a reason to raise the setting, not to stay quiet.

The backend advances state only when the host reports, never when it sends — `CONNECTING` included,
which it *withdraws* rather than advances.

### `disconnect`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "disconnect", "agentId": 42, "payload": {} }
```

Fire and forget. Report `agent_status` with `LINKED` once the session is closed.

### `chat`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "chat", "agentId": 42,
  "payload": { "message": "on my way" } }
```

Fire and forget. At most 256 characters — Minecraft's own limit, enforced backend-side.

After it is **actually said in game**, echo it back as a `chat` event with scope `outbound` (§4.3).
Do not echo on receipt: a message that never reached the server must not appear in the feed as
though it did.

### `set_chat_listener`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "set_chat_listener", "agentId": 42,
  "payload": { "enabled": true } }
```

Fire and forget. Grants or revokes this agent's job of forwarding the server's **global** chat.

Start every agent with the role **off**. Forward `global` only while it is on. See §5.

---

## 4. Events the host sends

Events carry no `id` and are never answered.

### 4.1 `heartbeat` — every ~10 seconds

```jsonc
{ "kind": "event", "type": "heartbeat", "payload": { "hostVersion": "0.3.1" } }
```

Host-scoped, so **no `agentId`**. This is the only thing that makes a host reachable: miss the
**30 second** grace window and every agent on this host derives as `STALE` in the UI, and the
backend refuses to dispatch commands to it with a 503.

`hostVersion` is recorded and logged when it does not match what the backend expects. It is **a
signal, not a gate** — a mismatch never blocks the connection, because a hard version check would
lock out the entire fleet the moment the backend is bumped.

### 4.2 `agent_status`

Carries two things with very different lifetimes, and **either half may be sent alone**.

```jsonc
// both halves: a state change that also reports vitals
{ "kind": "event", "type": "agent_status", "agentId": 42,
  "payload": { "state": "ONLINE",
               "health": 18, "food": 17, "pingMs": 42, "dimension": "overworld",
               "position": { "x": 128.5, "y": 71.0, "z": -344.25 },
               "nearby": [ { "name": "Notch", "distance": 12.4,
                             "position": { "x": 140.0, "y": 71.0, "z": -338.0 } } ] } }

// state only, when nothing else is worth reporting
{ "kind": "event", "type": "agent_status", "agentId": 42, "payload": { "state": "CONNECT_FAILED" } }

// vitals only — the ordinary case while an agent is just playing
{ "kind": "event", "type": "agent_status", "agentId": 42,
  "payload": { "health": 20, "food": 19, "pingMs": 38,
               "position": { "x": 130.0, "y": 71.0, "z": -344.0 } } }
```

**The state** is a rare, durable fact. Report it whenever it changes; repeating it unchanged is
harmless and ignored.

**The vitals** are a continuous sample, held in memory and never stored. Send them roughly **every
5 seconds** while an agent is `ONLINE`. There is no need to send them at all otherwise — an agent
that is not in game has no vitals, and Osmium shows that as "not reporting" rather than as zeroes.

| Field | Required | Notes |
|---|---|---|
| `state` | no | omit when nothing changed |
| `health` | **with the other three** | out of 20 |
| `food` | **with the other three** | out of 20 |
| `pingMs` | **with the other three** | round trip to the Minecraft server |
| `position` | **with the other three** | `{x, y, z}`, doubles — all three coordinates |
| `dimension` | no | defaults to `overworld` |
| `nearby` | no | `[{ "name", "distance", "position" }]` — `position` optional; defaults to empty |

**`health`, `food`, `pingMs` and `position` are all-or-nothing.** Send all four or none of them.
A tick carrying only some is **dropped whole** and logged, rather than having the rest filled in with
defaults — a missing `food` defaulting to 0 would render as a starving agent and raise an alert about
one that is fine, and a missing `position` would place it at the world origin. Osmium would rather
show nothing than something it made up. Sending none of the four is not an error; that is simply a
state report.

**A nearby player's `position` is optional**, unlike the agent's own. Send `{x, y, z}` when you have
it and omit the whole object when you do not — never a partial one, which would be a point nobody was
ever at. Omitting it costs only the coordinates; the player is still listed, and that somebody is
there at all is the fact that matters most. Send it whenever you can: it is what lets an operator
tell a player walking past from one standing on the build.

**Do not send `isAgent` on nearby players.** Osmium decides that, because a host sees only its own
agents and a server's fleet can span several hosts — no host can tell one of ours from a stranger.

**Vitals go stale after 30 seconds**, matching the heartbeat grace. Stop reporting and Osmium shows
the agent as not reporting rather than holding the last numbers on screen as though they were
current. Nothing needs to be sent to clear them.

| State | Meaning | Reported by |
|---|---|---|
| `UNLINKED` | no credentials cached for this agent | host |
| `SETUP_PENDING` | login in progress | **backend only** — do not report it |
| `LINKED` | credentials held, not in game | host |
| `CONNECTING` | `connect` sent, no verdict yet | **backend only** — do not report it |
| `ONLINE` | in game | host |
| `NEEDS_RELINK` | stored credentials rejected; cannot self-heal | host |
| `CONNECT_FAILED` | server refused — whitelist, ban, version | host |
| `STALE` | host unreachable | **derived, never reported** — a `STALE` report is discarded |

`STALE` is derived from the heartbeat, because a host that can talk to the backend is by definition
not stale.

> **Blocks placed do not belong here.** Progress against a segment is its own event —
> `build_progress`, §7.5 — keyed by the segment rather than the agent. Sending a block count in
> `agent_status` does nothing.
>
> Extra payload keys are accepted and ignored, so sending them is harmless but has no effect.

### 4.3 `chat`

```jsonc
{ "kind": "event", "type": "chat", "agentId": 42,
  "payload": { "scope": "global", "from": "Notch", "text": "that cathedral is getting huge" } }
```

| Field | Required | Notes |
|---|---|---|
| `scope` | yes | `outbound`, `direct`, `local`, `global` |
| `from` | no | who said it; defaults to the agent's own label |
| `text` | yes | truncated at 512 characters; blank is dropped |

### 4.4 `activity`

```jsonc
{ "kind": "event", "type": "activity", "agentId": 42,
  "payload": { "scope": "system", "severity": "warning",
               "text": "Kicked: flying is not enabled on this server" } }
```

| Field | Required | Notes |
|---|---|---|
| `scope` | yes | `system`, `lifecycle` |
| `severity` | no | `info`, `warning`, `error`; defaults to `info` |
| `text` | yes | truncated at 512 characters; blank is dropped |

---

### 4.5 `handshake` — once, immediately after connecting

```jsonc
{ "kind": "event", "type": "handshake",
  "payload": {
    "agents": [ { "agentId": 42, "state": "ONLINE" } ],
    "loginMethods": [ { "id": "device_code", "label": "Device code",
                        "description": "Approve a code on this machine." } ] } }
```

Host-scoped, so **no `agentId`** on the envelope; everything is inside the payload.

> ⚠️ **Renamed from `agents`.** There is no alias — the old name is not handled. It was accurate
> while the agent list was all this carried, and is not now.

Both keys are **optional and independent**, so you can implement one half first.

#### `agents` — what you are running

This is the only message that says what *exists*. `agent_status` reports transitions, and agent
state is **stored** on the backend, so it outlives the connection that reported it. A host that
reported four agents `ONLINE` and then restarted leaves an Osmium showing four agents in game,
indefinitely, with no telemetry behind them — reachability does not save it, because the host is
back, so `STALE` stops applying and the stale `ONLINE` resurfaces intact.

What the backend does with it, for every agent it owns on this host:

| Believed state | Announced | Not announced |
|---|---|---|
| `ONLINE` | applied as reported | → `LINKED` — credentials survived the restart, the session did not |
| `SETUP_PENDING` | applied as reported | → `UNLINKED` — the command went with the process that was going to answer it |
| `CONNECTING` | applied as reported | → `LINKED` — same reason, and the credentials are still on disk |
| anything else | applied as reported | left alone — none of them claim a live session |

An unannounced agent also loses the listener role, so the next election sees a vacancy rather than a
listener that is gone.

**Send it on every connect, not only after a restart.** A host that kept its sessions across a
dropped socket announces them and nothing changes, which is what makes it safe to send always —
and a host cannot reliably tell the two cases apart anyway.

**An empty list is a real announcement**: `"agents": []` means "I am running none of them", which is
exactly what a freshly started host should say. Omitting the key is treated as saying nothing at all,
so a host that has not implemented this half keeps working — it simply keeps the old failure mode.

#### `loginMethods` — what you can log in with

The mechanisms **this machine can actually perform**. The operator picks one and it comes back to you
as `setup_agent`s `method`.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Opaque to the backend, relayed verbatim. This is what you get back. |
| `label` | no | Short name for the chooser. The `id` is shown when this is absent. |
| `description` | no | One line on what the operator is about to be asked to do. |

The copy is yours because the mechanism is yours: you are the only party that knows what your methods
are, so you are the only one that can describe them. The backend does not translate it and has no
list of its own to fall back on.

**The same rule as `method` binds this: a mechanism, never an account.** `"Device code"` is a
mechanism. `"Sign in as build-bot-4@example.com"` is an identity, and putting one here hands the
backend the very thing this design keeps out of it.

**Not stored.** The backend holds the list with your connection and drops it when the socket closes,
the same way it treats reachability. Re-send it on every connect; there is nothing to update or
revoke.

**Advertise nothing and you can set nothing up.** The operator is told that this host has not said
what it can log in with, rather than being offered a chooser that cannot work.

---

## 5. Chat scoping and the listener role

The host is the only side that can classify chat — it sees the raw packet types, and the backend
cannot infer scope from message text.

| Scope | Event | Feed | Example |
|---|---|---|---|
| `outbound` | `chat` | chat + audit | an operator made the agent speak — echo **after** it is said |
| `direct` | `chat` | chat | a player whispered the agent |
| `local` | `chat` | chat | proximity chat |
| `global` | `chat` | chat, per **server** | ordinary player chat — **listener only** |
| `system` | `activity` | activity | kicked, banned, died, warned |
| `lifecycle` | `activity` | activity | connected, disconnected, setup failed, relink needed |

**An unrecognised scope is dropped, not guessed at.** Filing a kick into chat is worse than losing
it: the whole reason the feeds are split is that an incident must not be buried in conversation.

**Global chat is forwarded by exactly one agent per server.** It is identical for every agent there,
so the rest would multiply it by the fleet size. The backend elects the listener because agents on
one server can belong to several hosts, and no host can see the others.

Rules the host has to hold up its end of:

- Every agent starts with the role **off**, including after a reconnect.
- Forward `global` only while `set_chat_listener` last said `enabled: true` for that agent.
- Do not try to elect locally, and do not assume the role because no one else seems to have it.

The backend re-checks on a timer, so a command missed during a reconnect corrects itself rather than
being permanent.

**There is no timestamp field on any event.** The backend stamps on receipt. Host clocks are not
synchronised with each other, and a skewed one would file its chat into the middle of the feed or
into the future — which in a newest-first feed means invisible or permanently pinned to the top.
Ordering within a reconnect replay is preserved by row id, so replaying a buffer in order is fine.

---

## 6. Rules that must not be broken

**Credentials never leave this machine.** Not in a result, not in telemetry, not in a log line the
backend receives. The backend is designed so that it *cannot* learn them, and that property is only
real if the host upholds it. Store the token cache with mode `0600`, encrypted with a key from the
environment, listed in `.gitignore` and `.dockerignore`, and mounted as a volume rather than baked
into an image.

**An unknown message is never fatal.**

- An unknown **event** or **result** is logged and ignored by the backend. Never close the
  connection over one — a newer peer sending a field the other has not learned about yet is normal.
- An unknown **command** must get `ok: false` with a reason, **never silence**. The backend does not
  block on results today — it dispatches and moves on — but it logs an unrecognised result and
  logs nothing at all for silence, so a reply is the difference between a diagnosable problem and an
  invisible one. It also keeps the host correct against the correlation the protocol reserves.

**The backend is the source of truth for work; the host is the source of truth for agent state.**
The host receives a segment and builds it, it does not schedule. Conversely the backend never
asserts an agent's state back onto the host — on reconnect the host re-enumerates what is actually
live and reports it, in the [`handshake`](#45-handshake--once-immediately-after-connecting). That
re-enumeration is not optional: it is the only thing that clears state the backend is still
asserting from a previous process.

**Commands are never queued.** If the host is not connected, the operator's request fails with a 503
immediately. One firing long after they have resolved things by hand is worse than an outright
failure.

---


---

## 7. Building: jobs, segments, and fetching blocks

This is the half of work assignment that exists. The two messages that would hand you a segment and
take progress back do not, so nothing here is reachable from the socket yet — but the endpoint is
built, tested and stable, and a host can be written against it now.

### 7.1 What a job is

An operator picks a schematic, says where it stands and what it is built out of — that is a **build**
— then picks the agents to work it. Starting it freezes a **job**: the anchor, the substitutions and
the schematic are copied into it, and the division into **segments** is written down rather than
recomputed.

Frozen matters to you. Editing the plan afterwards changes the *next* job, so a segment fetched an
hour after it was handed out describes the same blocks it did then.

A segment is **one agent’s share, as a half-open box in world coordinates**: `max` is the first
block *not* in it. One job is one Minecraft server; one agent holds at most one segment at a time,
across every job.

### 7.2 Fetching a segment’s blocks

```http
GET /api/hostlink/jobs/{jobId}/segments/{segmentId}
X-Osmium-Ticket: 9f2c…
Accept-Encoding: gzip
```

**Over HTTP, not the socket.** The socket is the control plane: sends on it are serialised per host,
so a payload of any size there would stall heartbeats, vitals, chat and every command for every
agent on your machine — and vitals go stale after 30 seconds, so a long transfer would render
healthy agents unreachable. Bulk gets its own request, where a failure is a retry rather than a
dropped connection.

**The ticket is a capability for one segment**, not a second credential to store. It is minted when
that segment is assigned to one of your agents, and it dies when the assignment does — released,
finished, or handed to somebody else. Reassignment mints a new one. Treat it as opaque and do not
persist it: if you have lost it, you have lost the assignment too.

**Never send your enrolment token here.** That one is the credential for the whole machine and every
agent on it; this is a `GET` whose URL and headers end up in logs and proxies.

| Status | Meaning |
|---|---|
| `200` | The blocks, in the format below. |
| `401` | No ticket, an unknown one, or one that does not name this segment. Do not retry with the same ticket. |
| `409` | The job is finished, or this segment is no longer yours to build. Stop and wait to be told again. |

Ask for `gzip`. The body is highly compressible and the backend serves it as sent otherwise.

### 7.3 The segment format

Content type `application/vnd.osmium.segment`. **Big-endian throughout.**

```
"OSM1"                     4 bytes, magic and version
u16                        palette entries
  u16 length, UTF-8 bytes  each block state, repeated
i32 x3                     box minimum: x, y, z (world coordinates)
u32 x3                     box size: dx, dy, dz
u32                        block count
  u32 linear, u16 palette  each block, repeated, ascending
```

A record is six bytes, so the block section is `count * 6` and can be walked with a fixed stride.

**Positions are a linear index into the box**, not coordinates:

```
linear = ((y * dz) + z) * dx + x        // x, y, z measured from the box minimum

y = linear / (dx * dz)
z = (linear / dx) % dz
x = linear % dx
```

That is y outermost, then z, then x — the order Litematica and Sponge both store blocks in, and
therefore **build order**: bottom layer first. Records arrive ascending, so walking the stream in
order is walking the build in order, and you never need to sort or seek.

Seven things worth knowing, each of which is a decision rather than an accident:

- **Only blocks that get placed are sent.** Air never appears — not in the records and not in the
  palette. A segment’s box is mostly empty and you are not charged for it.
- **The substitutions are already applied.** The palette holds what to place, not what the file
  said. A block the operator substituted for *nothing* is simply absent, which is the honest answer
  to not having the material: a hole rather than a wrong block standing in.
- **The palette describes this segment**, not the schematic. It holds only materials actually
  present here, in first-appearance order.
- **Palette entries are block *states*, not block names.** `minecraft:oak_stairs[facing=east,
  half=bottom]`, in the single-string form Sponge palettes already use. Place the state, not the
  block: stairs without their facing are stairs pointing whichever way your server defaults to,
  which is a building that looks almost right and is wrong everywhere it matters. Two facings of
  one block are two palette entries, because they are two different things to place.
- **Properties are sorted by name**, so one state always spells one way. Neither format promises
  an order, and an unsorted spelling would put the same state in a palette twice.
- **Names are as the file wrote them**, usually `minecraft:` but not always — Osmium never resolves
  a block name against a registry, which is what lets it accept a schematic from an older
  Minecraft. A bare name means the vanilla namespace, as it does everywhere in Minecraft. A name
  you do not recognise is not necessarily wrong; report it and move on rather than failing the
  segment.
- **A substitution can flatten states.** A rule names a block, so one rule catches every state of
  it, and what comes back is what the operator wrote — often a plain name with no properties at
  all. Do not assume an entry has any.
- **An empty segment is a valid answer**, with `count = 0` and an empty palette. A box whose every
  block was substituted away still gets handed out; finish it and report it built.

### 7.4 Reading one, roughly

```rust
let n = read_u32()?;
for _ in 0..n {
    let linear = read_u32()? as u64;
    let state = &palette[read_u16()? as usize];   // "minecraft:oak_stairs[facing=east]"

    let y = (linear / (dx as u64 * dz as u64)) as i32;
    let z = ((linear / dx as u64) % dz as u64) as i32;
    let x = (linear % dx as u64) as i32;

    place(min_x + x, min_y + y, min_z + z, state);
}
```

`linear` is unsigned and a large box can exceed `i32`, so widen before dividing. The backend refuses
to serve a box of more than 2³²−1 positions rather than letting an index wrap, so the value always
fits a `u32`.

### 7.5 Being told to build, and reporting back

Two messages, and they close the loop. Both are **implemented and exercised** — the mock host in
this repository fetches a real segment, parses it and reports against it, which is how the
specification below got its bugs shaken out before you inherited it.

#### `build_segment` — backend to host

```jsonc
{ "id": "cmd-7f3a", "kind": "command", "type": "build_segment", "agentId": 42,
  "payload": {
    "jobId": 7,
    "segmentId": 31,
    "ticket": "9f2c…",
    "min": { "x": 128, "y": 64, "z": -340 },
    "max": { "x": 160, "y": 96, "z": -308 },
    "blocks": 20431
  } }
```

Fire and forget: **do not answer with a result.** Report what came of it as `build_progress`,
exactly as `connect` reports through `agent_status`.

The box and the count travel as well as being derivable from the body you are about to fetch, so
you can size the work, refuse one you cannot do, and log something legible before making an HTTP
call. The ticket rides along because this command is the act that minted it.

**The ticket is valid from the moment you receive this.** The backend deliberately sends the
command only after the transaction that minted the ticket has committed — an earlier version sent
it inside that transaction, and a host quick enough to fetch got a 401 for a ticket that was
milliseconds from existing. If you ever see a 401 on a ticket you have only just been given, that
is a backend bug and worth saying so loudly.

#### `cancel_segment` — backend to host

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "cancel_segment", "agentId": 42,
  "payload": { "jobId": 7, "segmentId": 31 } }
```

Stop building that segment. Sent when it is taken back from you, and when its job is paused or
deleted. Fire and forget, and **not an error** for a segment you have already finished or never
started: it asks you to stop, which having stopped satisfies.

Take it seriously. A host that keeps placing blocks after a job is paused defeats the only thing
pausing exists to do.

#### `build_progress` — host to backend

```jsonc
{ "kind": "event", "type": "build_progress", "agentId": 42,
  "payload": { "segmentId": 31, "blocksPlaced": 12480, "state": "building" } }
```

| Field | Required | Notes |
|---|---|---|
| `segmentId` | yes | Which segment. Not the agent — see below. |
| `blocksPlaced` | no | **Total placed in this segment**, not since the last report. |
| `state` | no | `building`, `done` or `failed`. Omit to report only a count. |
| `reason` | no | Why it failed. Written for whoever reads host logs; truncated at 256. |

Send it roughly **every five seconds** while building, alongside the vitals in `agent_status`.

**Last reported, never accumulated** — the same rule the vitals follow. The backend writes the
number down rather than adding it, so a host that restarts mid-segment and recounts what it can see
is correct rather than double-counted. It is also clamped to the segment’s own size, so a generous
recount cannot drive a job past finished.

**Keyed by the segment, not the agent.** An agent holds one segment at a time, so either would
identify it — but a report that arrives just after a segment was taken back would then land on
whatever that agent picked up next, which is one box’s count applied to another. The backend
ignores a report about a segment you do not hold.

`done` is what closes a segment, and the last `done` in a job closes the job — nothing else can
know. It carries the count with it, so you need not send a final total that exactly equals the
size; say `done` and the backend fills it in.

`failed` is for **you tried and could not**. It is not for losing the connection: an agent that
drops out has its segment returned to the pool automatically and handed back when it returns, so
there is nothing to report and nothing to retry. Reporting `failed` on a disconnect turns a blip
into something an operator has to come and look at.

## 8. A minimally compliant host

1. Dial `wss://<backend>/ws/host` with the bearer token; reconnect with backoff, loudly on 4xx.
2. Send `heartbeat` every 10s with `hostVersion`.
3. Run every agent this host owns in **one process**, mapping `agentId` to a client internally.
4. Handle `setup_agent` → reply `ok` with `mcUsername` + `mcUuid`, or `ok: false` with `reason`.
5. Handle `connect` / `disconnect` → no result; report `agent_status` when the state actually moves.
   Report vitals in `agent_status` every ~5s while an agent is `ONLINE`.
6. Handle `chat` → say it, then echo it as a `chat` event with scope `outbound`.
7. Handle `set_chat_listener` → toggle `global` forwarding for that agent; default off.
8. Classify inbound chat into the six scopes and emit `chat` / `activity`.
9. Handle `build_segment` → fetch the blocks with the ticket, place them, and report
   `build_progress` every ~5s with the running total; `done` when finished, `failed` only if you
   genuinely could not. Handle `cancel_segment` → stop, and treat an unknown segment as already
   satisfied.
10. Reply `ok: false` to any command you do not recognise.
11. Send `handshake` immediately on **every** connect, both halves:
    - `agents` — re-enumerate what is actually live. Not optional: it is the only thing that clears
      sessions the backend is still asserting from a previous process. An empty array is a real
      answer.
    - `loginMethods` — what this machine can log in with. **Advertise nothing and no agent on this
      host can be set up at all**, because the backend offers exactly this list and holds none of
      its own.

## Before writing any of it

Read [`../FLEET_CONNECTIVITY.md`](../FLEET_CONNECTIVITY.md). It records the agent state machine, the
credential-custody argument, listener election, retention, and what was rejected and why — which
will save re-deriving it.
