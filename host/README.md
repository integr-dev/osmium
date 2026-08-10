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
  "payload": { "label": "Mason_04", "serverAddress": "mc.example.com:25565", "method": "method_a" } }
```

| Field | Meaning |
|---|---|
| `label` | The operator's name for this agent. Not a Minecraft account name. |
| `serverAddress` | Where it will play. Already normalised, lowercase, usually with a port. |
| `method` | The login **mechanism** the operator chose, relayed uninterpreted. |

`method` is currently one of four placeholders, `method_a`–`method_d`, until real mechanisms are
chosen. The backend has no idea what any of them mean and stores nothing about them.

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

An unsupported `method` is a normal `ok: false` — hosts do **not** advertise which methods they
support, deliberately.

### `connect`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "connect", "agentId": 42,
  "payload": { "serverAddress": "mc.example.com:25565" } }
```

Fire and forget: **do not send a result.** Report the outcome as an `agent_status` event instead —
`ONLINE` on success, `CONNECT_FAILED` if the server refused, `NEEDS_RELINK` if the stored credential
was rejected. The backend advances state only when the host reports, never when it sends.

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

```jsonc
{ "kind": "event", "type": "agent_status", "agentId": 42, "payload": { "state": "ONLINE" } }
```

`state` is the only field currently read. Report a state whenever it changes; sending it unchanged
is harmless and ignored.

| State | Meaning | Reported by |
|---|---|---|
| `UNLINKED` | no credentials cached for this agent | host |
| `SETUP_PENDING` | login in progress | **backend only** — do not report it |
| `LINKED` | credentials held, not in game | host |
| `ONLINE` | in game | host |
| `NEEDS_RELINK` | stored credentials rejected; cannot self-heal | host |
| `CONNECT_FAILED` | server refused — whitelist, ban, version | host |
| `STALE` | host unreachable | **derived, never reported** — a `STALE` report is discarded |

`STALE` is derived from the heartbeat, because a host that can talk to the backend is by definition
not stale.

> Telemetry — health, food, position, ping, blocks placed — is **not consumed yet**. Extra payload
> keys are accepted and ignored, so sending them early is harmless but does nothing.

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
live and reports it.

**Commands are never queued.** If the host is not connected, the operator's request fails with a 503
immediately. One firing long after they have resolved things by hand is worse than an outright
failure.

---

## 7. A minimally compliant host

1. Dial `wss://<backend>/ws/host` with the bearer token; reconnect with backoff, loudly on 4xx.
2. Send `heartbeat` every 10s with `hostVersion`.
3. Run every agent this host owns in **one process**, mapping `agentId` to a client internally.
4. Handle `setup_agent` → reply `ok` with `mcUsername` + `mcUuid`, or `ok: false` with `reason`.
5. Handle `connect` / `disconnect` → no result; report `agent_status` when the state actually moves.
6. Handle `chat` → say it, then echo it as a `chat` event with scope `outbound`.
7. Handle `set_chat_listener` → toggle `global` forwarding for that agent; default off.
8. Classify inbound chat into the six scopes and emit `chat` / `activity`.
9. Reply `ok: false` to any command you do not recognise.
10. On reconnect, re-enumerate live sessions and report each one's `agent_status`.

## Before writing any of it

Read [`../FLEET_CONNECTIVITY.md`](../FLEET_CONNECTIVITY.md). It records the agent state machine, the
credential-custody argument, listener election, retention, and what was rejected and why — which
will save re-deriving it.
