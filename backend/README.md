# Osmium backend

Spring Boot 4.1 / Kotlin. Provides JWT authentication with role-grouped permission nodes, the host
and agent domain, and the WebSocket that hosts dial into.

Routes authorize against **nodes only** — never against roles. Roles exist purely as named bundles
of nodes, so adding a role never requires touching a route annotation.

It holds **no Minecraft credentials**. Commands are relayed to the host that owns an agent; that
host performs any login itself and reports back only an identity. See
[`../FLEET_CONNECTIVITY.md`](../FLEET_CONNECTIVITY.md).

## Requirements

- JDK 25 (the Gradle toolchain pins `languageVersion = 25`)
- Docker — needed to run Postgres, and also to run the test suite

## Running it

Start the database:

```bash
docker compose up -d
```

Then the app:

```bash
./gradlew bootRun          # gradlew.bat on Windows
```

Flyway builds the schema on first boot from `db/migration`, and `DataInitializer` seeds the
permission nodes, the three roles, and — only while the `users` table is empty — a bootstrap
administrator. A database that predates Flyway is adopted rather than rebuilt; see
[Schema migrations](#schema-migrations).

The app listens on `:8080`. Postgres is published on `:5432` with database, user and password all
set to `osmium`.

## Configuration

| Property | Env var | Default | Notes |
|---|---|---|---|
| `osmium.jwt.secret` | `OSMIUM_JWT_SECRET` | dev key in `application.properties` | HS256, needs ≥ 32 bytes |
| `osmium.jwt.ttl` | `OSMIUM_JWT_TTL` | `30m` | access token lifetime, i.e. the interval between silent refreshes |
| `osmium.jwt.refresh-ttl` | `OSMIUM_JWT_REFRESH_TTL` | `12h` | session length, from **login**; refreshing does not extend it |
| `osmium.jwt.cookie-secure` | `OSMIUM_JWT_COOKIE_SECURE` | `true` (**`false` in `application.properties`**, for development) | `Secure` on the refresh cookie |
| `osmium.bootstrap.username` | `OSMIUM_BOOTSTRAP_USERNAME` | `admin` | seeded account |
| `osmium.bootstrap.password` | `OSMIUM_BOOTSTRAP_PASSWORD` | `admin` | seeded account |
| `osmium.cors.origins` | `OSMIUM_CORS_ORIGINS` | empty | comma-separated exact origins for `/api/**` |
| `osmium.audit.retention` | `OSMIUM_AUDIT_RETENTION` | `30d` | how long audit entries are kept |
| `osmium.activity.retention` | `OSMIUM_ACTIVITY_RETENTION` | `10d` | how long agent incidents are kept |
| `osmium.agent.connect-window` | `OSMIUM_AGENT_CONNECT_WINDOW` | `90s` | how long a host gets to report a connect before the agent falls back to LINKED |
| `osmium.agent.rejoin-delay` | `OSMIUM_AGENT_REJOIN_DELAY` | `15s` | first wait before an automatic reconnect, doubling with each attempt |
| `osmium.agent.rejoin-delay-max` | `OSMIUM_AGENT_REJOIN_DELAY_MAX` | `5m` | the ceiling that backoff grows to |
| `osmium.agent.rejoin-attempts` | `OSMIUM_AGENT_REJOIN_ATTEMPTS` | `10` | attempts before it stops trying — see **Rejoining** |
| `osmium.chat.retention` | `OSMIUM_CHAT_RETENTION` | `3d` | how long chat is kept |
| `osmium.chat.messages-per-minute` | `OSMIUM_CHAT_MESSAGES_PER_MINUTE` | `30` | outbound chat allowance, per agent |
| `osmium.avatar.upstream` | `OSMIUM_AVATAR_UPSTREAM` | Minotar | skin service URL with `{id}`/`{size}`; **blank turns heads off** |
| `osmium.avatar.size` | `OSMIUM_AVATAR_SIZE` | `64` | pixel size requested upstream |
| `osmium.schematic.min-data-version` | `OSMIUM_SCHEMATIC_MIN_DATA_VERSION` | `1519` (1.13) | oldest Minecraft a schematic may come from — see below |
| `osmium.schematic.max-data-version` | `OSMIUM_SCHEMATIC_MAX_DATA_VERSION` | `4903` (26.2) | newest, i.e. the version the fleet plays |
| `osmium.schematic.directory` | `OSMIUM_SCHEMATIC_DIRECTORY` | `data/schematics` | where uploaded files live; **must be a volume in a container** |
| `osmium.schematic.max-size` | `OSMIUM_SCHEMATIC_MAX_SIZE` | `8GB` | largest upload accepted, checked before any bytes are sent |
| `osmium.avatar.ttl` | `OSMIUM_AVATAR_TTL` | `12h` | how long a fetched head is cached |

CORS is **off** unless origins are listed, because both supported deployments proxy `/api` and are
therefore same-origin. `*` is rejected outright: the configuration allows credentials, and no
browser accepts that combination.

> The committed JWT secret and the `admin`/`admin` bootstrap credentials are development defaults.
> The bootstrap account is a full administrator from the first boot and **nothing forces a password
> rotation**, so both must be overridden before the first boot of anything that is not local
> development. `osmium.jwt.cookie-secure` is the third of these: it ships `false` in
> `application.properties` and must be `true` anywhere with TLS.

A browser refuses a `Secure` cookie over plain HTTP unless the origin is `localhost` or `127.0.0.1`,
and Safari refuses it even there. That is why development turns it off: reaching the dev server by
LAN address, machine hostname or Safari otherwise makes the browser discard the refresh cookie
silently — the `Set-Cookie` arrives, nothing stores it, and the session quietly lasts only as long
as one access token.

## Authorization model

Normalized across four tables: `users`, `roles`, `permission_nodes`, and the join table
`role_nodes`. A node's string *is* its primary key, so there is no surrogate id to keep in sync.

An account holds **at most one role**, via `users.role_id`. Roles are strictly nested seniority
levels, so a set of them could never grant more than the highest one — a single assignment keeps the
model honest. A null role means no permissions at all.

### Nodes

| Node | Grants |
|---|---|
| `user.read.self` | read your own account |
| `user.edit.self` | rename your own account |
| `user.read` | list all accounts |
| `user.edit` | edit any account, including resetting its password |
| `user.create` | create accounts |
| `user.delete` | delete accounts |
| `user.role.write` | change the role of an account |
| `user.sessions.revoke` | end every session an account holds |
| `role.read` | list roles and their nodes |
| `audit.read` | read the operator audit trail, including outbound message text |
| `audit.export` | pull the trail out as a CSV file |
| `agent.read` | see agents, their telemetry and player heads |
| `host.read` | see the hosts that run them |
| `activity.read` | read the incident feed |
| `chat.read` | read what was said in game |
| `schematic.read` | see the schematic library, its materials and how it divides |
| `chat.speak` | **speak in game as an agent** |
| `agent.run` | connect and disconnect agents |
| `agent.write` | create and rename agents, and place them on a server |
| `agent.delete` | delete an agent, and its history with it |
| `agent.setup` | trigger `setup_agent` on a host |
| `host.write` | enrol and rename hosts |
| `host.token` | rotate a host's enrolment token |
| `host.delete` | remove a host, and every agent on it |
| `schematic.write` | upload and rename schematics |
| `schematic.delete` | delete a schematic and its file |

**The split is by what an act costs, not by which resource it touches.** `run` is the all-day verb
and undoes itself — an agent connected by mistake is disconnected again. `write` reshapes the fleet
but leaves it recoverable. `delete` does not. Reading chat is separated from `agent.read` for a
different reason: chat is content rather than state, and knowing which agents are online is not the
same as reading what everyone on the server said.

Speaking and setting up stay apart from everything else because of what they are rather than what
they cost. `chat.speak` is impersonation under an account you own; `agent.setup` decides
which Microsoft account gets linked. Collapsing either into a general write node would make that
distinction unrecoverable.

### Roles

Each tier unions the tier below it. Inheritance is materialized at seed time — the union is computed
in `RoleDefinitions` and the flattened result is written into `role_nodes`, so authorization stays a
single flat set lookup and the table is self-describing.

| Role | Nodes |
|---|---|
| `viewer` | `user.read.self`, `user.edit.self`, `role.read`, `agent.read`, `host.read`, `chat.read`, `activity.read`, `schematic.read` |
| `orchestrator` | *viewer* + `agent.run`, `agent.write`, `agent.setup`, `chat.speak`, `host.write`, `host.token`, `schematic.write` |
| `administrator` | *orchestrator* + `agent.delete`, `host.delete`, `schematic.delete`, `user.read`, `user.edit`, `user.create`, `user.delete`, `user.role.write`, `user.sessions.revoke`, `audit.read`, `audit.export` |

A viewer is read-only throughout: the three read nodes gate listing hosts and agents, the feeds and
the live streams, and nothing else, so it can watch the fleet without being able to touch it. Every
way to change the fleet is a separate node, which is what makes that tier possible without a second
set of routes.

**An orchestrator holds none of the deletions.** It runs the fleet all day and has no need to
destroy part of it — an agent is gone with its history, a host takes every agent on it, and a
schematic takes a file that may have cost hours to transfer along with every plan computed from it —
so all three sit with the
tier that already carries the irreversible operations. That is the point of the split: the tier that
does the work no longer has to be trusted with the things that cannot be undone.

Above that the division is "runs the agents" versus "runs the people": an orchestrator adds acting
on the fleet, and what an administrator adds is user management plus the audit trail.

`audit.read` sits outside the `fleet.*` tier deliberately. Running the fleet is not the same as
being entitled to read every other operator's actions and the text they had an agent speak.

Changing the hierarchy is a code change plus a restart. `DataInitializer` diffs the desired node set
against the stored one on every boot and rewrites it on mismatch, so an existing database picks up
changes automatically.

## API

| Method | Path | Required node |
|---|---|---|
| `POST` | `/api/auth/login` | — (public; access token in the body, refresh token in a cookie) |
| `POST` | `/api/auth/refresh` | — (the refresh cookie is the credential; rotates it) |
| `POST` | `/api/auth/logout` | — (revokes the session family and clears the cookie) |
| `POST` | `/api/auth/session-alert/acknowledge` | `user.read.self` (dismisses the replayed-session notice) |
| `GET` | `/api/auth/sessions` | `user.read.self` (own live sessions, caller's marked) |
| `DELETE` | `/api/auth/sessions/{id}` | `user.read.self` (own only; another account's reads as 404) |
| `POST` | `/api/auth/sessions/revoke-all` | `user.read.self` (every session **and** every access token) |
| `POST` | `/api/auth/password` | authenticated (rotates your own password, requires the current one; revokes every session) |
| `GET` | `/api/auth/me` | `user.read.self` |
| `GET` | `/api/users` | `user.read` |
| `POST` | `/api/users` | `user.create` |
| `PATCH` | `/api/users/me` | `user.edit.self` |
| `PATCH` | `/api/users/{id}` | `user.edit` |
| `POST` | `/api/users/{id}/sessions/revoke-all` | `user.sessions.revoke` (ends that account's sessions; no matching read) |
| `DELETE` | `/api/users/{id}` | `user.delete` |
| `PUT` | `/api/users/{id}/role` | `user.role.write` |
| `GET` | `/api/roles` | `role.read` |
| `GET` | `/api/audit` | `audit.read` (cursor-paged, `query` searches, `limit` clamped to 1..500) |
| `GET` | `/api/audit/export` | `audit.export` (CSV attachment; `from` inclusive, `to` exclusive) |
| `GET` | `/api/activity` | `activity.read` (cursor-paged; `agentId` narrows to one agent) |
| `GET` | `/api/chat` | `chat.read` (cursor-paged; **exactly one** of `agentId` or `server`) |
| `GET` | `/api/stream` | `user.read.self` (server-sent events; each event gated separately) |
| `GET` | `/api/stream/agents/{id}` | `user.read.self` (server-sent events, narrowed to one agent) |
| `GET` | `/api/hosts` | `host.read` |
| `POST` | `/api/hosts` | `host.write` (returns the enrolment token once) |
| `PATCH` | `/api/hosts/{id}` | `host.write` (rename) |
| `POST` | `/api/hosts/{id}/rotate-token` | `host.token` |
| `DELETE` | `/api/hosts/{id}` | `host.delete` (cascades to its agents) |
| `GET` | `/api/agents`, `/api/agents/{id}` | `agent.read` |
| `POST` | `/api/agents` | `agent.write` (`serverAddress` optional) |
| `PATCH` | `/api/agents/{id}` | `agent.write` (rename) |
| `PUT` | `/api/agents/{id}/server` | `agent.write` (assign a server, or null for none; offline only) |
| `PUT` | `/api/agents/{id}/settings` | `agent.write` (the whole map, not a patch; saved even when the host is unreachable) |
| `DELETE` | `/api/agents/{id}` | `agent.delete` |
| `POST` | `/api/agents/{id}/setup` | `agent.setup` |
| `DELETE` | `/api/agents/{id}/setup` | `agent.setup` (stop waiting on one; sends the host nothing) |
| `POST` | `/api/agents/{id}/connect`, `/disconnect` | `agent.run` (connect holds the agent at CONNECTING; **409** while one is in flight) |
| `POST` | `/api/agents/{id}/chat` | `chat.speak` (rate limited per agent; **429** when exceeded) |
| `GET` | `/api/avatars/{name-or-uuid}` | `agent.read` (a player's head, as an image) |
| `GET` | `/api/schematics`, `/api/schematics/{id}` | `schematic.read` |
| `GET` | `/api/schematics/{id}/materials` | `schematic.read` (by block, heaviest first) |
| `GET` | `/api/schematics/{id}/shape` | `schematic.read` (a voxel model; `detail` bounds what comes back) |
| `GET` | `/api/schematics/{id}/split` | `schematic.read` (`mode` and `parts`; computed, never stored) |
| `POST` | `/api/schematics` | `schematic.write` (declares name, filename and size; no bytes yet) |
| `PUT` | `/api/schematics/{id}/content` | `schematic.write` (raw bytes at `offset`; **409** carries the real one) |
| `PATCH` | `/api/schematics/{id}` | `schematic.write` (rename) |
| `DELETE` | `/api/schematics/{id}` | `schematic.delete` (takes the file and the index with it) |
| `GET` | `/api/builds`, `/api/builds/{id}` | `schematic.read` (a plan: where a schematic goes, and what out of) |
| `POST` | `/api/builds` | `schematic.write` (placement and substitutions both settleable later) |
| `PATCH` | `/api/builds/{id}` | `schematic.write` (omitted fields are left alone; `unplace` clears a placement) |
| `DELETE` | `/api/builds/{id}` | `schematic.delete` (the coordinates and the rules go with it; **409** while a job is building) |
| `GET` | `/api/jobs`, `/api/jobs/{id}` | `agent.read` (a job: a plan frozen and being carried out; `buildId` filters) |
| `POST` | `/api/builds/{buildId}/jobs` | `agent.run` (freezes the plan and hands out the pieces; the agents *are* the part count) |
| `POST` | `/api/jobs/{id}/pause`, `/resume` | `agent.run` (stops it keeping its crew, and picks it up again) |
| `DELETE` | `/api/jobs/{id}` | `agent.delete` (clears the record and frees the crew; **409** while it is still building) |
| `POST`/`DELETE` | `/api/jobs/{jobId}/segments/{segmentId}/assignment` | `agent.run` (give a piece to an agent, or take it back) |
| `GET` | `/api/hostlink/jobs/{jobId}/segments/{segmentId}` | **a fetch ticket**, not a node — see below |

There is no self-registration — administrators create accounts, choosing the username and password.
An account cannot delete itself, change its own role, or edit itself through the administrative
route, so those paths cannot be used to lock yourself out or bypass the current-password check.

Agent commands answer **503** when the owning host has no live connection. They are never queued: a
disconnect firing long after an operator fixed things by hand is worse than an immediate failure.

OpenAPI is generated from annotations by springdoc:

- Swagger UI — <http://localhost:8080/swagger-ui.html>
- Raw document — <http://localhost:8080/v3/api-docs>

Both are `permitAll`.

### Getting a token

```bash
curl -s -X POST localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
```

```json
{ "token": "eyJhbGciOiJIUzI1NiJ9...", "expiresAt": "2026-08-08T22:58:43.512Z" }
```

Send it as `Authorization: Bearer <token>`.

## How authentication works

A session is **two credentials, held in different places**.

The **access token** is the JWT above, sent as `Authorization: Bearer`. It is short-lived — 30
minutes — and the browser keeps it in memory only, so a reload loses it and nothing on disk holds
it. The **refresh token** is an opaque 32-byte random value in an `HttpOnly` cookie scoped to
`/api/auth`, which JavaScript cannot read and which is not sent on ordinary API calls at all.

That split is the point: an XSS can act as the operator while the page is open, whatever holds the
credential, but it cannot carry a session off the machine to use later.

```
POST /api/auth/login     → access token in the body, refresh token in a Set-Cookie
POST /api/auth/refresh   → a new access token, and a rotated cookie
POST /api/auth/logout    → revokes the family, clears the cookie
```

**Rotation is one-time.** Every refresh mints a successor and marks its predecessor spent, so a
token is only ever valid once. The legitimate holder replaces its cookie and never presents the old
value again — so a second presentation means a copy exists somewhere it should not. The answer is to
revoke the whole *family*, every token descended from that login, because there is no way to tell
whether the replay came from the thief or the victim. It is recorded as `SESSION_REUSE_DETECTED` in
the audit trail, the one entry there that nobody chose to cause.

**Except within fifteen seconds of the rotation**, where a replay is read as a retry and gets a
successor of its own. That window is not a concession — it is what makes the alarm worth listening
to. Two tabs share one cookie and not the single-flight guard in front of it, so a woken laptop had
both presenting the value the browser last stored: one won, the other looked exactly like theft, and
the session ended with an incident filed because somebody had two tabs open. A detector that fires
on ordinary browser behaviour is one nobody reads. The frontend also takes a `navigator.locks` lock
so tabs queue rather than race; the window covers what a lock cannot reach — a retried request, a
restored session, a second browser. A retry can leave a family with more than one live tip, which is
why the session list takes the newest per family rather than per token: one browser, one row.

**The person it happened to is told.** The trail needs `audit.read`, so it reaches an administrator
and not them — they were simply signed out with no explanation. There is no channel to reach them on,
no email and no push, so `users.session_alert_at` carries the notice and the interface raises it the
next time they sign in, cleared through `POST /api/auth/session-alert/acknowledge`. It cannot be
shown at the login screen: before authentication that would confirm both that a username exists and
that something happened to it.

That revocation commits in **its own transaction** (`SessionRevocation`, `REQUIRES_NEW`). Refusing
the replay means throwing, and a throw rolls back the transaction it happened in — sharing one would
undo the revocation and leave the stolen family alive, which is the single outcome the detection
exists to prevent. Worth knowing because a test inside the suite's usual rolled-back transaction
cannot see the difference: nothing commits there either way. `SessionRefreshTest` opts out for the
reuse cases.

**Sessions do not slide.** A successor inherits its predecessor's expiry unchanged, so a session
ends a fixed span after the login that began it — `osmium.jwt.refresh-ttl`, 12 hours by default —
however much it is used. Operators re-enter a password on that schedule whether or not they have
been active. Changing a password revokes every session the account has, and deleting an account
takes its sessions with it.

### What an operator can do about a stolen session

The two credentials need different answers, and the difference is worth knowing before an incident
rather than during one.

A **refresh token** is a stored row, so it can simply be revoked: logging out ends its family,
`POST /api/auth/sessions/{id}` ends any one of the account's sessions, and rotation catches theft on
its own as soon as both parties use it. The case rotation misses is an attacker who steals the
cookie while the victim never refreshes again — no second presentation, so nothing fires. What
bounds that is the fixed expiry, which no amount of rotating extends.

An **access token** is a stateless JWT with nothing recording that it exists, so revoking one needs
a comparison at authentication time. That is `users.token_version`: it is stamped into every token
as the `ver` claim and checked on every request, so incrementing it refuses every token issued so
far. `POST /api/auth/sessions/revoke-all` and a password change both do that, and both therefore
close the whole session rather than only stopping renewal.

It is a counter and not a "valid from" timestamp, which is what it was first written as. A JWT's
`iat` is whole seconds, so a timestamp has to round, and both directions are wrong: round down and a
token issued earlier in the same second survives the revocation, round up and signing straight back
in rejects the token just minted. A version has no such edge.

Deleting or renaming an account still kills its tokens immediately, since the subject stops
resolving. Stripping its role leaves the token authenticating but holding nothing.

An **administrator can end somebody else's sessions** —
`POST /api/users/{id}/sessions/revoke-all`, on `user.sessions.revoke`. It is its own node rather than one of
its own because it grants nothing new: anyone who can reset a password or delete an account can
already lock that operator out, and both are blunter than this. It exists for "their laptop is gone
and they are asleep", and is recorded with the administrator as the actor and the account as the
target.

Resetting somebody's password through `PATCH /api/users/{id}` **also** ends their sessions. It did
not, originally, and that was a hole worth naming: changing your own password revoked everything,
but an administrator resetting a compromised account's password left the thief the refresh cookie
for the rest of its twelve hours and the access token for its half hour — while the administrator
believed they had dealt with it.

There is deliberately **no way for an administrator to list** another account's sessions. Only the
person holding them can tell which is theirs; an administrator looking at a browser and an address
has no way to judge which one is the intruder, so a list would hand over another operator's devices
and locations in exchange for data nobody in that seat can interpret. `audit.read` sits outside the
`fleet.*` tier for the same reason.

`GET /api/auth/sessions` lists the live ones with the caller's marked, so an operator can recognise
a session they do not. It records the client address and user agent — both only as good as the
request that carried them, which is why the interface says so rather than presenting them as fact.

**Behind a proxy that address is the proxy's**, unless something is configured. `getRemoteAddr()`
returns whoever opened the connection, and in both supported deployments that is nginx — so every
session would carry the same useless address. `server.forward-headers-strategy=native` installs
Tomcat's `RemoteIpValve`, which rewrites the address from `X-Forwarded-For` **only when the peer is
itself a private address**. A client on the internet forging that header is therefore ignored,
because the connection did not come from a proxy. The same setting fixes the address the host socket
records on connect, which had the identical problem.

Refresh tokens are stored **hashed** (SHA-256), so a database dump yields no usable session. Not
BCrypt: this is CSPRNG output rather than a password, so there is nothing to brute-force, no reason
to pay a work factor on every refresh, and BCrypt would silently truncate at 72 bytes.

`/api/auth/refresh` and `/api/auth/logout` are `permitAll`, because the cookie *is* the credential —
requiring a Bearer token would defeat refresh, which exists precisely for when the access token has
expired.

The token carries only the subject — no permission claims. On every request
`DatabaseJwtAuthenticationConverter` resolves the account's nodes from the database via a scalar
projection query (`UserRepository.findAuthorization`), which deliberately avoids hydrating the
`User` entity graph.

The tradeoff is one indexed query per request in exchange for changes taking effect immediately: a
role change, a deletion, or a rename applies on the *next* request rather than at token expiry. A
rename in particular invalidates existing tokens, since the subject no longer resolves — clients
must log in again after renaming themselves.

Baking nodes into the token claims would remove that query, but would leave revoked permissions live
for up to a full token TTL. That is the reason it is not done.

## Hosts, agents and the host socket

A **host** is a machine running the Osmium host software; an **agent** is one Minecraft session on
one server, owned by a host. Enrolling a host issues a token once — only its hash is stored — and
the host then dials in:

```
host → backend    WSS /ws/host, Authorization: Bearer osm_host_<hostId>_<secret>
```

The token embeds the host id so authentication is one lookup plus one hash comparison, rather than a
BCrypt check against every enrolled host.

That endpoint has **its own security filter chain**, deliberately without the resource server.
`permitAll` alone is not enough: the bearer-token filter would still try to authenticate a host
token as a JWT and reject the handshake with 401.

`HostHandshakeAuthenticator` is therefore the only gate, and a refused handshake answers **401** —
which it has to set itself. Aborting a handshake stops the upgrade but does not choose a status, so
without that the refusal went out as `200` with an empty body: the socket was correctly refused and
the host was told the opposite. That is worst exactly where it is most likely, after a token
rotation the host has not picked up yet, and anything watching from in front reads the 200 the same
way. `HostLinkTest` asserts the status rather than only that the client failed, which is what let it
ship — a client-side upgrade failure looks identical whatever the server answered.

One socket per host multiplexes all its agents, so every message carries an `agentId`; there is no
destination field, because the connection *is* the host. Commands are fire-and-forget and state
advances when the host reports back — it is the source of truth about its own agents, and is trusted
only for the agents it owns.

### Where an agent plays is separate from setting it up

`setup_agent` **does not carry the server address**, and an agent may be assigned to **no server at
all**. Both follow from the same fact: a Minecraft account can join any server, so acquiring a
credential and deciding where to use it are different decisions.

Sending the address at setup handed the host a value that went stale the moment the agent was
reassigned, and it was never needed — `connect` carries the address, which is where it matters.
Requiring one at creation was worse: it made an operator choose where an agent would play before it
had been set up, and therefore before anyone knew the credential worked. The natural order is
create, set up, assign, connect.

Null is a real state, not a gap. An agent assigned nowhere is set up and idle: it cannot connect,
and it is not a candidate to forward any server's chat. Previously that was faked by pointing an
agent at a server it was not connected to, which then showed up under Active servers with nobody on
it.

Assignment is `PUT /api/agents/{id}/server`, on `agent.write` — configuration, not credential work
— and refused while the agent is online, since the address decides what the next connection targets.
Renaming stayed on `PATCH` and is allowed at any time, because it is cosmetic.

**This changed the host protocol.** See [`../host/README.md`](../host/README.md), which documents the
removed field.

Reachability is **derived** from the heartbeat rather than stored, so a backend restart cannot leave
a host stuck online. An `ONLINE` agent whose host is unreachable reports as `STALE`, not offline —
the state is genuinely unknown at that point.

### Configuration is stored here and interpreted by the host

`PUT /api/agents/{id}/settings` takes a flat map of strings and stores it as JSON on the agent row.
**The whole set, not a patch** — a key left out has been cleared, which is the only reading under
which a setting can be turned back off.

The keys are declared by the *interface*, in `frontend/src/lib/configuration.ts`, and this backend
does not know what any of them mean. It stores the map and relays it, exactly as it relays a login
`method` without understanding it. A column per setting would need a migration, a DTO field and a
release on three sides for every setting added, to hold something nothing here reads. A host ignores
keys it does not recognise, so a setting exists the moment the interface and one host agree on a
name.

Saved **whether or not the host is reachable**. Configuration is a stated preference rather than an
action, and refusing to store it because a machine is switched off would lose an operator's work
over something they cannot see and did not cause. The relay is best effort, and the settings are
re-sent on every host reconnect — a host holds them in memory only, so a restarted one would
otherwise run on defaults with nothing saying so.

### Rejoining

One key *is* read here: `connect.rejoin`. Reconnecting is a decision about where an agent belongs,
and the rule the host protocol rests on is that a host never makes one of those — it reports where
an agent got to. A host that reconnected itself would be asserting a state nobody asked for, and
nothing here could tell that apart from an operator's own `connect`.

So `agents.wanted` records the wish. `connect` sets it, `disconnect` clears it, and **nothing a host
reports ever touches it** — which is what tells a kick apart from an operator taking an agent out of
the game. `AgentService.rejoinTheWilling` sweeps the gap between the wish and the reported state.

It is a **sweep rather than a hook** on the state report, for the same reason reachability is
derived: what needs reconnecting is a fact about the fleet right now — wanted, not online, due — and
it reads the same after a backend restart, a report that never arrived, or a host that went away for
an hour. A hook would have to fire on exactly the right transition, and every one it missed would be
an agent stranded with nothing left to notice it.

Backoff doubles from `rejoin-delay` to `rejoin-delay-max` and gives up after `rejoin-attempts`, with
one line in the activity feed saying so. Bounded on purpose: an agent that cannot join *this* server
will not be fixed by a thousand more tries, and a warning every five minutes forever is a feed
nobody reads. A host that is unreachable is skipped **without consuming an attempt** — somebody
else's outage must not exhaust the budget and give up exactly as the host comes back.

### What a host says on connect

One `handshake` event carries the two things only the host can state: what it is running, and what
it can log in with. The keys are independent and both optional. It was called `agents` while the
agent list was all it held; the rename is a clean break with no alias.

#### What it is running

Agent state is **stored**, so it outlives the connection that reported it, and `agent_status` only
ever says what *changed*. Between them that leaves one hole: a host that restarts has an Osmium
still asserting the sessions it reported before, with nothing in the protocol to contradict them.
Reachability does not help — the host is back, so `STALE` stops applying and the stale `ONLINE`
resurfaces intact.

So the handshake lists what the host is actually running, and `HostReportService.reconcile` squares
it against what the backend owns for that host:

- **Announced** agents are applied exactly as `agent_status` would apply them, so a host that kept
  its sessions across a dropped socket changes nothing by saying so.
- **Unannounced** `ONLINE` becomes `LINKED` — credentials live on the host's disk and survive a
  restart; the session does not. `SETUP_PENDING` becomes `UNLINKED`, where a failed setup lands, and
  `CONNECTING` becomes `LINKED`, where a connect that runs out of time lands — in both cases the
  command went with the process that was going to answer it.
- **Every other state is left alone.** None of them claim a live session, so silence says nothing
  about them.

Each correction writes an activity entry, because it is a state change the operator did not cause
and would otherwise see unexplained.

**Omitting the key changes nothing** — a host that has not implemented this half simply keeps the
old failure mode. An empty list is a real announcement and means "none of them".

#### What it can log in with

`loginMethods` is the mechanisms that host can actually perform: an opaque `id` plus optional copy
for the operator choosing between them. The frontend offers exactly this list, and `setup` refuses
anything outside it with a **400** before dispatching — membership in a list the host itself
supplied, never the backend learning what a method *means*.

The check applies only while the host is connected. Disconnected, an empty list means nobody has
said rather than that the method is wrong, so the request falls through to the ordinary
undeliverable path and answers **503**, which is the true reason.

**Not stored.** It lives in `HostConnections` beside the socket and goes when the socket does, for
the same reason reachability is derived: it is a claim about a process that is running now, and a
row asserting mechanisms a restarted host has dropped would offer the operator a choice that no
longer exists. A host that advertises nothing can set nothing up, and the frontend says so.

The backend held four placeholders before this, `method_a`–`method_d`, offered to every host
regardless of what it could do — a chooser where three of four selections were wrong and nothing on
screen said which. See *`method` is a mechanism, never an account* in FLEET_CONNECTIVITY.md, whose
earlier rejection of advertisement this reverses.

## Live updates

`GET /api/stream` is a server-sent event stream of everything that changes;
`/api/stream/agents/{id}` narrows it to one agent. The channel is **receive-only** — commands stay
on REST, where they are node-gated and audited.

| Event | Node | Carries | Client does |
|---|---|---|---|
| `agent` | `agent.read` | the resource, in the shape REST returns it | replaces it in place |
| `host` | `host.read` | the resource, in the shape REST returns it | replaces it in place |
| `agent-removed` | `agent.read` | `{ id }` | drops it |
| `host-removed` | `host.read` | `{ id }` | drops it |
| `chat` | `chat.read` | one new line | appends it to the feed |
| `activity` | `activity.read` | one new line | appends it to the feed |
| `telemetry` | `agent.read` | `{ agentId, telemetry }` | merges the vitals into the agent |
| `user` | `user.read` | the account | replaces it in the list |
| `user-removed` | `user.read` | `{ id }` | drops it |
| `audit` | `audit.read` | one new entry | appends it to the trail |
| `permissions` | `user.read.self` | the recipient's own account | replaces what it may do |
| `schematic` | `schematic.read` | the resource, in the shape REST returns it | replaces it in place |
| `schematic-removed` | `schematic.read` | `{ id }` | drops it |
| `build` | `schematic.read` | the plan, in the shape REST returns it | replaces it in place |
| `build-removed` | `schematic.read` | `{ id }` | drops it |
| `build-job` | `agent.read` | the job and its segments | replaces it in place |
| `build-job-removed` | `agent.read` | `{ id }` | drops it |

`build-job` is gated on `agent.read` rather than on the schematic node its plan uses, because what
it carries is which agents are on which piece: reading designs does not entitle you to read the
fleet. It also moves with nobody watching — a segment is freed the moment its agent leaves the game,
and handed back the moment it returns.

`schematic` is the only event here that fires while nothing has changed in the world: a large file
takes minutes to arrive and minutes more to read, and without it the interface shows a row saying
"analysing" with no way to tell a long job from a stuck one. Throttled where it is produced rather
than at the broker, because the work underneath reports thousands of times a second.

Resource events carry the same shapes the REST endpoints return, so a client replaces what it holds
rather than refetching. That is why each feature's `toResponse` is shared between its controller and
the broker instead of being private to a service: two mappers would let the stream and the API
drift.

The feeds are the exception, and deliberately: they are appended to rather than replaced, and
telemetry is a merge rather than a resource, which is what keeps a reading arriving every second
from re-sending an entire agent.

Three properties are load-bearing:

- **Events publish after the transaction commits**, via `TransactionSynchronization`. Emitting inside
  it would announce changes a rollback then discards, and a client applying them in place has no way
  to learn it was told a lie. This is the mirror image of the audit log, which writes *inside* the
  transaction so an entry exists only if the command committed.
- **Progress does not**, and `publishNow` is the exception that says so. A unit of work that runs for
  minutes inside one transaction and reports how far it has got has nothing left to say by the time
  that transaction commits: deferred, every report arrives in one burst at the end, and the pass
  reads as silence followed by a finished job. That is precisely what the schematic reader did — it
  held browsers on "queued" for the whole length of a read. Progress is not a state anything can roll
  back to a wrong value, so it goes out immediately; the settled result at the end still waits.
  `publishNow` is also the only thing that works from inside an `afterCommit` callback, where the
  synchronization list has already been walked and an ordinary publish is dropped in silence.
- **Streams re-read authority every 30s**, and a demotion *narrows* one rather than only being able
  to end it. Authorities resolve per request for REST, so a demotion bites immediately there; a
  stream authorises once and would otherwise run for hours. Only losing `user.read.self` — the node
  the endpoint itself is gated on — closes it. It also never outlives the token that opened it.
- **Deleting a host announces each cascaded agent** before the host itself. Publishing only the host
  would leave every browser holding agents that no longer exist.
- **A host going quiet is announced by a sweep**, because nothing else can. Reachability is derived
  from the heartbeat rather than stored, so a host that stops talking writes no row and fires no
  event — every browser kept showing it green until something unrelated republished it. A 5s task
  compares each host against what was last announced and publishes only on a change, so a quiet
  fleet still sends nothing. Heartbeats themselves stay unpublished: ten seconds per host across
  every open browser is the noise that avoids.

Connect, disconnect and chat publish nothing: they change no stored state. The agent's state moves
when the host reports back, and *that* is what reaches the browser.

`InMemoryLiveUpdateBroker` is the only implementation. With two backend instances a host's WebSocket
lands on one while a browser's stream sits on the other, and that browser never sees the event —
solving it needs a shared broker or sticky routing. The `LiveUpdateBroker` interface exists so that
becomes a second implementation rather than a rewrite.

### Every event declares the node it needs

`LiveUpdateType` carries the permission a subscriber must hold, alongside the SSE event name. It sits
on the type rather than being passed at publish time because it belongs to the kind of event and not
to the occurrence — every `agent` event needs `agent.read`, always — so a publisher cannot forget it
or set it wrong.

**Not every type routes the same way.** `chat`, `activity` and the host events each need a node of
their own, which is exactly
what the controller checks at subscribe and what `tick()` re-checks, so dispatch consulting the field
would be a no-op. `LiveUpdateTypeTest` pins that uniformity rather than leaving it as a comment: the
day a type arrives needing a different node — the audit trail and permission changes are the obvious
candidates — the test fails, because at that moment one check at the door stops being sufficient.
The fix it points at is `matches()` comparing the subscriber's nodes to `event.type.node`, and
`tick()` refreshing each subscription's whole node set instead of probing one.

They are not *fleet* events. The channel carries whatever a browser has to learn about without
asking, and hosts and agents are only what it carries today.

## Audit log

Anything that changes state, acts in game, or grants and revokes access is recorded. Reads are not —
a trail of who listed the agents is noise that buries the entries that matter.

| Group | Actions |
|---|---|
| Agents | `AGENT_CREATE`, `AGENT_UPDATE`, `AGENT_DELETE`, `AGENT_SETUP`, `AGENT_CONNECT`, `AGENT_DISCONNECT`, `AGENT_CHAT` |
| Hosts | `HOST_ENROL`, `HOST_RENAME`, `HOST_ROTATE_TOKEN`, `HOST_DELETE` |
| Accounts | `USER_CREATE`, `USER_UPDATE`, `USER_DELETE`, `USER_ROLE_CHANGE`, `USER_PASSWORD_CHANGE` |

The groups answer different questions. Agent and host entries answer "why is the fleet in this
shape"; account entries answer "who was given what, and by whom", which is the one an incident
usually turns on — `USER_ROLE_CHANGE` records both sides of the change, because that is how
authority is granted.

**No entry ever carries password material**, chosen, reset or current. `USER_PASSWORD_CHANGE` and a
password reset under `USER_UPDATE` record that it happened and who did it, nothing more. Outbound
chat text *is* recorded, because logging that an operator made an agent speak without logging what
it said is close to useless.

Two renames are recorded specifically because they break the trail otherwise: renaming a host or an
account changes the name every earlier entry was filed under, so without the link the history reads
as two unrelated things.

### Reading it

`GET /api/audit` returns **one page, newest first**, with an opaque `nextCursor` to continue from.
Searching is server-side too: `?query=` matches the account, the target, the detail or the name of
the action. Both exist for the same reason — a filter that only saw the rows already fetched would
search the newest hundred of a thirty-day trail and report "nothing matches", which reads as an
answer rather than as a limit. See [Paged feeds](#paged-feeds).

### Taking a copy

`GET /api/audit/export?from=&to=` returns the range as a CSV attachment. `from` is inclusive and
`to` exclusive, both ISO-8601 **instants** rather than dates, so the caller decides what timezone a
day means instead of having UTC assumed for it — the browser sends the operator's local midnight.

Three things about it are deliberate:

- **It is gated on `audit.export`, not `audit.read`.** Reading is bounded and stays inside Osmium,
  where the next read is itself observable; an export leaves as a file nothing here can see again.
  Splitting them lets an account be trusted to look without being trusted to take.
- **It records itself, before a single row is sent.** The entry describes the request rather than
  the delivery, so an abandoned or failed download still leaves the trace that someone asked. That
  puts a new row in the trail being read, so the range is capped at the instant the export started:
  the file cannot contain the record of its own export, and the count in that record equals the rows
  written. A `to` in the future is therefore not an error.
- **The CSV is English and never translated.** It is read by tooling and kept as a record; a header
  row that depended on the operator's locale could not be scripted against, and two files of the
  same range would stop being comparable.

Every field is quoted per RFC 4180. A value starting with `=`, `+`, `-`, `@`, tab or CR keeps its
text and gains a leading apostrophe: `detail` carries in-game chat, written by whoever is on the
Minecraft server, and without that a player typing `=HYPERLINK(…)` gets it executed when an
administrator opens the file. That is a deliberate edit to the data — the alternative is a faithful
file that runs code.

The range is walked in batches of 500 against `idx_audit_entries_at_id` and flushed as it goes, so
no size of range is held in memory.

### Adding a new action needs a migration

Hibernate maps `AuditAction` with a `CHECK` constraint listing every enum name, and it is written
once. Adding a value needs a migration that rewrites the constraint:

```sql
ALTER TABLE audit_entries DROP CONSTRAINT audit_entries_action_check;
ALTER TABLE audit_entries ADD CONSTRAINT audit_entries_action_check
  CHECK (action IN ('AGENT_CREATE', /* … every current value … */));
```

Both `columnDefinition` and an `AttributeConverter` were tried against a real Postgres to suppress
the constraint entirely; Hibernate 7.4 generates it either way. The same applies to `ChatScope`,
`ActivityScope`, `ActivitySeverity` and `AgentState`. See [Schema migrations](#schema-migrations) —
this is one of the three failures that motivated moving off `ddl-auto`.

Two properties are worth knowing before relying on it:

- **An entry exists only if the command committed.** Recording happens inside the command's own
  transaction, so one rejected with 503 because no host was connected leaves no trace. Nothing
  happened, so there is nothing to hold anyone to.
- **The target is a name, not a foreign key.** An entry has to outlive its subject: "admin deleted
  host eu-2" is precisely the record you want once eu-2 is gone, and a cascade would delete the
  evidence along with it.

The acting account comes from the security context rather than a threaded-through parameter.
Authorization decisions are passed explicitly — `UserService` takes an `actorUsername` — because
those change behaviour and must be visible at the call site; this only observes.

Entries are kept for 30 days and purged by a daily job, which is why `@EnableScheduling` is on
`Application`. See the retention table in [`../FLEET_CONNECTIVITY.md`](../FLEET_CONNECTIVITY.md).

## Chat and activity

The other two streams. They record what happened *in game*, as opposed to what an operator did.

| Stream | Endpoint | Holds | Retention |
|---|---|---|---|
| Audit | `GET /api/audit` | who triggered which command, and any outbound text | 30 days |
| Activity | `GET /api/activity` | died, kicked, connected, relink needed | 10 days |
| Chat | `GET /api/chat` | everything said, inbound and outbound | 3 days |

The ladder encodes how long each stays *useful*. Audit outlives the rest because it is the only one
about people; activity is diagnostic and diagnostics go stale; chat is the largest and the only one
full of other people's words, so it gets the shortest life.

Both arrive as host events (`chat` and `activity`) and are **classified by the host** — only it sees
the raw packet types, and the backend cannot infer scope from message text. A scope the backend does
not recognise is dropped rather than guessed at: filing a kick into chat is worse than losing it.

`/api/chat` takes **exactly one** of `agentId` or `server`, and that is the whole design in one
parameter.

A **server** feed is everything that happened there: the global channel, whispers to an agent, and
the agents' own outbound lines. An **agent** feed is what was said to or about that one agent, and
excludes the global channel.

**The two are not mirror images, on purpose.** Global chat is identical for every agent standing on
the server, so folding it into one agent's conversation would put the same message on every agent
page and bury the lines that are actually about that agent. The reverse does not hold: a whisper to
one agent is still something that happened on that server, so the server feed keeps it.

A line carries both a plain `text` and, when the host sent one, the `components` the server actually
styled it with — rank prefixes, the colour that separates a whisper from the room, the styling on a
player's name. **Stored as text and never parsed here**, the same rule the host envelope's payload
follows: the host resolves the server's translation keys and strips everything interactive before
sending it, and the interface draws the result. `components` stays nullable and nothing reads it
without falling back to `text`, so a host that sends none — anything an agent said itself, a server
sending plain text, a host older than the column — is ordinary rather than a gap.

Rows reference the agent by **id and label as plain columns, not a relation**, like audit entries.
The listener role moves between agents, so a server's history must not disappear with whichever one
happened to forward it — and "Mason_04 was banned" is exactly the line you want after Mason_04 is
gone.

`at` is when the **backend received** the event, not when the host observed it. Host clocks are not
synchronised, and a skewed one would file its chat into the middle of the feed or into the future —
which for a cursor read newest-first means either invisible or permanently pinned at the top.
Sub-second receive latency is the accepted cost.

Both are also published on the live stream as `chat` and `activity` events, so an open feed grows
without polling.

## Telemetry

Health, food, position, dimension, ping and nearby players ride **inside `agent_status`**, alongside
the state. `HostReportService` splits the two halves on receipt, because they behave nothing alike:

- **State** is rare and durable. Written and published only when it actually changes, so a host
  repeating `ONLINE` every few seconds costs nothing.
- **Telemetry** is a continuous sample. Taken from every report, kept in `AgentTelemetryStore`, and
  published on its own lightweight `telemetry` event rather than re-sending the whole agent.

Treating them alike would give either an `agent` event per report — the whole resource, several
times a minute per agent, to carry a few numbers — or vitals that only update when an agent
connects.

**Telemetry is coalesced onto a 1 second tick**, not forwarded as it arrives.
`AgentTelemetryPublisher` marks agent **ids** rather than queuing samples, and looks the reading up
at publish time, so a burst collapses into the newest value instead of a backlog the browser would
render and immediately overwrite. Without it a fleet of 200 reporting every 5s would put 40 events a
second on every open stream. The pending set is cleared *before* publishing, so a sample arriving
mid-flush goes out on the next tick rather than being dropped; a tick with nothing new publishes
nothing at all.

The scheduler pool is raised to 4 (`spring.task.scheduling.pool.size`) because of this. The default
is a single thread, and the nightly retention purges are bulk deletes — on one thread a purge would
visibly stall live vitals once a night.

**Nothing is stored.** Telemetry is the only thing here with no historical value and by far the
highest write volume, and keeping it out of Postgres also means a restart cannot resurrect an
hour-old position and render it as current.

**Samples go stale rather than being cleared**, on a 30 second window matching the heartbeat grace.
Nothing pushes an event when a host falls silent — `STALE` is itself derived — so any design that
waited to be *told* to forget would leave last-known vitals on screen indefinitely, presented as
now. Ageing out needs no notification and no cleanup path, and it is the same pattern
`Host.isReachable` already uses.

Two consequences worth knowing:

- **Absent, not zeroed.** `AgentResponse.telemetry` is null when an agent has not reported. Zeroes
  would render as an agent on no health standing at the world origin, which is a very convincing way
  to describe an agent nobody has heard from. **Needs attention** raises nothing for a silent agent
  for the same reason.
- **`health`, `food`, `pingMs` and `position` are required together**, and a tick carrying only some
  of them is dropped whole and logged. The same rule one level down: defaulting a missing `food` to
  0 raises a starvation alert about an agent that is fine, and a missing `position` puts it at the
  origin. `dimension` and `nearby` still default, because "overworld" and "nobody nearby" are cheap
  to be wrong about and neither drives an alert.
- **`isAgent` on nearby players is decided here, not by the host.** A host sees only its own agents
  and a server's fleet can span several hosts, so it cannot tell one of ours from a stranger. The
  host reports names, distances and positions; the backend knows the fleet.
- **A nearby player's `position` is optional**, where the agent's own is required. The difference is
  what an absent value would claim: a defaulted `position` on the agent puts it at the origin, which
  is a lie, while a nearby player without coordinates is simply one whose coordinates were not
  reported, and the interface says exactly that. A host can legitimately know the distance without a
  usable position, and dropping the entry over it would lose the fact that matters most — that
  somebody is standing there. A *partial* one is still discarded: two coordinates and a guess for
  the third is a point nobody was ever at.

Uptime is **not** reported. It is derived from `onlineSince`, which the backend already stamps for
chat listener election — a second counter on the wire would be one more thing that could disagree.

### Outbound chat is rate limited

30 messages a minute, **per agent**, refused with a 429 before the command is dispatched.

Per agent rather than per operator, because the consequence lands on the account: two operators
sharing an agent share its budget, and one operator driving ten agents is not throttled across all
of them. It is also what contains a stolen session holding `chat.speak` — it can speak, but it
cannot spam, and chat spam is the one consequence in this system that is permanent and
unrecoverable.

A **token bucket**, not a count per calendar minute. A fixed window lets an operator send the whole
allowance at 11:59:59 and the whole allowance again a second later, which is precisely the burst
that gets an account banned; a bucket refills continuously, so the sustained rate is the limit
wherever the messages fall.

Two properties that follow from where the budget lives — in memory, outside the transaction:

- **An undeliverable message is refunded.** A rollback does not give back a spent token, so without
  this an operator retrying against a disconnected host would talk themselves out of chatting by the
  time it came back. Same rule as the audit trail: nothing was said, so nothing is spent.
- **A restart forgives whatever was spent.** That is the right way round — the failure mode is being
  briefly too lenient, never locking an operator out of a fleet they need to control.

With several backend instances a fleet could exceed the limit by the number of instances, which is
the same single-instance assumption the event broker already carries.

### Chat listener election

Global chat is identical for every agent on a server, so `ChatListenerService` picks exactly one per
**server** to forward it and tells the rest to stay quiet. Backend-side because only the backend sees
the whole fleet — agents on one server can be spread across several hosts, so no host can tell
whether another already has a listener.

It sweeps on a **timer rather than on events**, and that is the load-bearing decision. `STALE` is
derived from the host's heartbeat at read time, so a host going silent changes nothing in the
database and fires nothing at all; an event-driven election would leave a dead listener holding the
role forever, and the only symptom is that a server's chat stops. The sweep runs inside the
heartbeat grace window and doubles as the retry for an undelivered command.

Two invariants:

- **Told before recorded.** `Agent.chatListener` is set only after the `set_chat_listener` write
  reaches the host, so it never claims a listener that was never told to listen.
- **Eligible means reachable *and* writable.** A host can be inside its grace window with the socket
  already gone. Electing an agent that cannot be written to records a listener in name only.

A working listener is never displaced — a new agent joining does not take the role — so re-election
only happens when the incumbent is lost. `Agent.onlineSince` ranks the candidates and resets on
every entry into `ONLINE`, so an agent that keeps reconnecting cannot out-rank a stable one.

## Player heads

`GET /api/avatars/{name-or-uuid}` returns a Minecraft head, fetched from a skin service and cached
in memory. The frontend renders one for every agent, nearby player and chat line.

The default upstream is Minotar's `helm` rather than its `avatar`: `helm` composites the skin's
second layer — the hat — over the head, which is what a player wearing one looks like in game.
Without it, anyone whose face is drawn on that overlay comes back bare-headed, which reads as the
wrong skin rather than as a missing detail.

It exists so the browser never talks to the skin service. The SPA's CSP is
`img-src 'self' data: blob:`, and widening it to a third-party image host would punch a hole in the
layer that actually contains an XSS. Proxying keeps every image same-origin, and it also keeps which
agents exist, and how often somebody is looking at them, inside the deployment.

It is gated on `agent.read`, like every other route — a head only ever appears beside agents, chat
or hosts, all of which already need that node. That costs the frontend the obvious implementation:
an `<img>` cannot send an `Authorization` header and the token is not a cookie, so the SPA fetches
each head itself and hands the element a blob URL. The alternative was leaving the route open on the
grounds that a public Minecraft skin is not a secret — true, and it still leaves Osmium making
outbound requests on behalf of anyone who can reach it.

That last point is the abuse worth caring about, and the node alone does not answer it, so
`AvatarService` carries three guards:

- **The identifier is validated, not sanitised.** It is interpolated into a URL, so anything that is
  not plainly a Minecraft username or a UUID is refused rather than escaped. That is what keeps the
  proxy pointed where it was configured.
- **Misses are cached too**, on a shorter clock than hits — otherwise a name with no skin is a fresh
  upstream request on every page render, and a skin service having a bad minute is not a reason to
  blank a player out for the rest of the day.
- **Concurrent upstream fetches are capped**, so one caller cannot turn into a flood aimed at the
  skin service or exhaust Osmium's own connections doing it.

An over-long body is refused from the response headers rather than after buffering it, and a
response that is not an image is discarded. Setting `osmium.avatar.upstream` blank disables the
whole thing; the frontend falls back to initials, and nothing else changes.

## Schema migrations

**Flyway owns the schema. Hibernate only checks it.** `ddl-auto=validate` means a mismatch between
the entities and the database is a failure to start, not a failure three screens into the app.

```
src/main/resources/db/migration/
  V1__baseline.sql                 the schema as it stood when Flyway took over
  V2__drop_ddl_auto_leftovers.sql  the dead schema ddl-auto left behind
  V3__audit_export_action.sql      AUDIT_EXPORT added to the audit action constraint
  V4__refresh_tokens.sql           the refresh-token family behind a session
  V5__session_visibility.sql       what a session shows about itself, and the reuse alert
  V6__session_alert.sql            the replayed-session notice an operator dismisses
  V7__optional_agent_server.sql    an agent no longer has to be pointed at a server
  V8__schematics.sql               the library: uploads, their progress and their failures
  V9__schematic_index.sql          what a pass leaves behind: cells, materials, the origin
  V10__schematic_cell_block.sql    the dominant block per cell, so a shape can be coloured
  V11__builds.sql                  build plans: where a schematic stands and what it is built of
  V12__agent_connecting.sql        CONNECTING, and the timestamp that stops it lasting forever
  V13__setup_cancel_audit.sql      AGENT_SETUP_CANCEL added to the audit action constraint
  V14__build_jobs.sql              jobs and their segments: a plan frozen and being carried out
  V15__build_job_paused_holds_its_place.sql  a paused job keeps its claim on its server
  V16__build_segment_ticket.sql    the capability a host presents to fetch a segment
```

Adding one: next version number, a name that says what it does, and a matching entity change. The
test suite is the check — Testcontainers builds a fresh database from the migrations and `validate`
then compares it against the entities, so a migration that drifts from the mapping fails the build.

**Existing databases are adopted, not rebuilt.** `spring.flyway.baseline-on-migrate=true` stamps a
non-empty schema at V1 instead of re-running it, so V1 never executes against a database that
predates Flyway and V2 onwards apply normally. On an empty database V1 runs like any other
migration. Both paths were verified against a real Postgres: a clone of a pre-Flyway database
baselined at V1, applied V2 and started clean.

### Why this replaced `ddl-auto=update`

It cost three separate debugging sessions, and the three share a root cause: **it adds, and does
nothing else.** No alters, no drops, and failures are logged rather than fatal.

| Symptom | What actually happened |
|---|---|
| `violates check constraint "audit_entries_action_check"` | An enum gained a value. The `CHECK` constraint listing the old values was written once and never altered. |
| `column a1_0.chat_listener does not exist` | A `not null` column with no default cannot be added to a table with rows. The `alter` was rejected, logged, **and the application started anyway.** |
| `user_roles`, `hosts.agent_version`, `idx_audit_entries_at` | Orphaned by a refactor, a rename and an index change. Nothing was ever dropped, so all three sat there for months. |

The second is the worst of them, because nothing fails at boot — the symptom arrives later as a
query against a column that is not there.

None of the three could be caught by the tests, for one reason: Testcontainers builds the schema
from scratch on every run, so all of them only ever bite a database that already exists. That is
exactly the gap `validate` plus versioned migrations closes.

One habit worth keeping regardless: **give every new non-nullable column a database default**, so
adding it to a populated table is possible at all.

```kotlin
@Column(name = "chat_listener", nullable = false, columnDefinition = "boolean not null default false")
```

## Paged feeds

All three read the same way: `?limit=&cursor=`, answering `{ items, nextCursor }`, newest first.
`nextCursor` is null when there is nothing older.

**Keyset, not offset.** These are append-only feeds read newest-first, so `offset 200` shifts by one
every time something is recorded: a reader scrolling would see rows repeat or vanish underneath
them. A cursor names the last row already delivered, which nothing arriving later can move.

The cursor is `<instant>|<id>`, unencoded — it carries a timestamp and a row id the same response
already returned in full, so obscuring it would protect nothing. `id` breaks ties on the instant;
without it, two rows recorded in the same instant lose one at a page boundary. Each feed has a
composite index in that order, so paging deep costs the same as the first page.

`PageCursor` is the shared piece. A malformed cursor is a 400, not a silent restart from the top.

## Reading a schematic

Two formats are accepted, `.litematic` and `.schem`, and both are NBT underneath: a tree of named,
length-prefixed, big-endian tags, usually gzipped. Osmium reads them itself. There is no NBT
dependency because every NBT library builds the whole tag tree in memory, and the tree is precisely
what cannot exist here — a schematic accepted at the top of the supported range has a block array
measured in gigabytes.

So `NbtInput` is a pull reader that offers two choices at every tag: read the value, or skip it.
Skipping is what makes the size tractable, because a decoder wants four fields out of a file and has
no use for the rest. Arrays are a length followed by elements pulled one at a time; there is
deliberately no call that returns a whole array, since that call is where the design would fail.

### Two passes, and why

A file states its palette and its block data as separate tags of an **unordered** compound, so a
writer is free to put the data first. When it does, one pass has no way to know which palette index
means air until it has already streamed past the blocks — and buffering the blocks instead is the
one thing that cannot be done at this size.

The price is real: there is no seeking inside a gzip stream, so skipping a tag still costs
decompressing it, and two passes cost two decompressions. Paid once per upload in a background job,
in exchange for a reader that tag order cannot defeat.

### The three things that decode into a different building

None of these fail. They all produce a file that reads, and a build that is wrong.

- **Litematica's block indices straddle long boundaries.** An entry may begin in one long and finish
  in the next. The obvious implementation packs each long independently and is correct for every
  width that divides 64 — and quietly wrong for every other one, most real palettes among them. See
  `PackedEntries`, which also explains why sequential access is what makes streaming possible.
- **A litematica region may have a negative extent**, meaning it runs backwards and its stated
  position is the *maximum* corner. Read as a minimum, every block is present and the build is
  mirrored. Normalised at the door, so nothing downstream carries the rule.
- **Air has three names** — `air`, `cave_air`, `void_air`. Miss the second and a schematic captured
  underground reads as a solid cube.

Both decoders emit non-air blocks in the same order: y outermost, then z, then x. That is the
format's own order, kept because a deterministic build order is what later lets a segment be
described as a range rather than a set, and progress as a single integer rather than a set of
placed positions.

### Sizes, and what the formats can express

An NBT array length is a signed 32-bit int. Sponge stores its block data as one array for the whole
file, so a `.schem` tops out around two billion positions however it is written. Litematica stores
data per region, so the ceiling is per region and a larger build is simply several of them —
multi-region handling is the main path here, not an edge case.

### The version gate

Both formats record the Minecraft data version they were saved from, and it is the only thing in a
file that says which game its block names belong to. A schematic from an older version names blocks
that have since been renamed or removed, and building from it produces a plausible wrong building.

It is a **range**, `min-data-version` to `max-data-version`, because most blocks do not change:
stone from 1.16 is stone in 26.2, and refusing a build for being old would refuse most of the
builds anyone has.

**The range buys parseability, not compatibility, and that difference is the whole risk.** Some
blocks *were* renamed — `grass` became `short_grass` in 1.20.3, `sign` became `oak_sign` in 1.14 — and
nothing here can tell: block names are stored as strings and never resolved against a registry, so
a name that no longer exists looks exactly like one that does. Widening the range does not remove
that failure, it moves it to the host at build time. The material list is where an operator can see
it coming, and a schematic older than `max-data-version` is flagged as such in the interface.

What the two ends *can* check is real:

- **1519, Java Edition 1.13 — the flattening.** Below it a file does not name its blocks at all; it
  stores numeric ids. There is nothing to read, so this end is about the format.
- **4903, Java Edition 26.2**, the version the fleet plays. The tighter end in practice: a schematic
  from a *newer* Minecraft names blocks that do not exist yet, and the game being backwards
  compatible does nothing about that.

Setting both ends to the same number refuses anything but the fleet's own version.

The upload accepts `.schematic` as well as `.litematic` and `.schem`, because the extension is not
what decides. People rename these files and some tools write Sponge format under the older name, so
a modern schematic called `.schematic` is read as what it is.

A **genuine MCEdit `.schematic`** — pre-flattening, from 1.12 or earlier — is refused, and refused
*by name*: it is the one unsupported format an operator is likely to have, and the only one they can
do something about, since converting it is a menu item in the tools they already use. Told merely
that the file was unrecognised, they would reasonably conclude it was broken.

Supporting it properly is not a decoder. It stores blocks as **numeric ids with a data nibble** —
`1` is stone, `5:2` is birch planks — so reading one means carrying the whole pre-flattening
mapping to modern block names, some four thousand entries, which nothing else here would use.

Format is otherwise decided from the file's contents, and settled as soon as the deciding tag's
*name* has been read — the deciding tag in a litematic is `Regions`, which holds the
entire build, so checking the name before the value is the difference between a cheap detection and
decompressing the file to learn what was already known.

## Uploading a schematic

Three calls, not one multipart form:

```
POST  /api/schematics                       declare the name, filename and size
PUT   /api/schematics/{id}/content?offset=  send bytes, at an explicit offset
GET   /api/schematics/{id}                  read receivedBytes to resume
```

Declaring the size first means a file too large for this deployment is refused by one small request
rather than after an hour of transfer. Sending at an explicit offset means a transfer that died at
90% continues instead of starting again — a multipart upload of several gigabytes over a domestic
connection has exactly one failure mode, and it is losing all of it. The body is raw bytes rather
than multipart for the same reason: a multipart parser wants the part in memory or in a temporary
file, which is a second copy of something already too big for one.

An offset that does not continue where the file left off is a **409 carrying the real offset** in
`X-Osmium-Expected-Offset`. That is what makes resuming one round trip rather than two — send, be
told where you are, continue.

### The file and the row cannot be written together

The bytes go to a volume and the description goes to Postgres, and nothing makes those atomic. So
the order is chosen for what a crash between them leaves: bytes are written **first**, leaving a
file longer than the row admits. That is recoverable — the extra bytes were never acknowledged, and
the client will send them again from the offset it is given. The other order loses bytes the row
claims to have, which is not recoverable at all.

`SchematicReconciler` squares the two on boot, because nothing else ever will: a half upload looks
exactly like a paused one, and an interrupted analysis looks exactly like a running one.

| Found | Done |
|---|---|
| more bytes on disk than acknowledged | trimmed back to the row |
| fewer bytes on disk than acknowledged | row rewound — the write order rules this out, so something outside Osmium touched the file |
| `ANALYSING` or `PENDING` | requeued; the work only reads a file and writes a row, so it is safe to repeat |
| `READY` with no file | failed, with a message — better than being chosen for a build |
| a file no row owns | deleted; it is the residue of an upload that died before its row committed |

### Reading it happens on a queue

A pass over a large file is minutes of streaming decompression, so it never runs inside a request.
One at a time, deliberately: two on the same machine do not finish in half the time, they finish in
rather more than the sum, having spent the difference contending for the same disk.

The queue is in memory and the durable record is the row's status, which is what makes a restart
survivable. It is fed **after the caller's transaction commits** — the worker is another thread
reading the same database, and handed an id directly it wins the race often enough to matter: it
looks the row up, does not find it, decides there is nothing to do, and drops it. Nothing else
would have come back to it.

Progress is published on the live channel as `schematic`, throttled at the source and sent with
`publishNow`. A file of several gigabytes takes minutes to arrive and minutes more to read, and
without it the interface has a row saying "analysing" and no way to tell a long job from a stuck one.

**The reading is one transaction, so its reports cannot wait for it.** The whole pass runs inside
`analyse`, and the ordinary publish holds events until commit — which for a schematic is the moment
the read finishes. Every report then arrived at once, after `READY`, and the row appeared to sit at
"queued" for the entire pass and then jump straight to ready. The flip to `ANALYSING` and each report
are delivered immediately; only the settled result at the end is allowed to wait for the commit that
makes it true.

**The queue announces its own line.** `queuePosition` on the schematic says where a waiting file
sits, 1 meaning next. It is not on the row and could not be: it is a fact about the *other*
schematics, so it would have to be rewritten on every one of them each time one is taken. Nor can it
be worked out from the row being sent — the only moment it changes for a waiting schematic is when a
different schematic is taken, and nothing touches the waiting one then. So the queue publishes the
whole line whenever it moves, on `enqueue` and again the instant the worker takes the head. The line
is a handful of entries at worst; a queue long enough for that to cost anything is a queue nobody
reaches the end of today.

It is null for the moment between the last chunk landing and the queue being joined, because joining
waits for that transaction to commit. The announcement that follows carries the real place.

## A build is a plan, not the file

`builds` is where a schematic goes and what it is built out of: a placement, a set of
substitutions, and the schematic it applies to. Its own table because the same schematic is
legitimately built more than once — the same tower on two servers, or twice on one at different
coordinates — and placement on the schematic row would have made the second of those an upload of
the same gigabytes again. A plan is deleted with its schematic: a plan to build a file that no
longer exists cannot be carried out.

Placement is an **anchor for the minimum corner**, all three coordinates or none, enforced by a
check constraint. Two of three does not describe a position, and a column default would put a
half-placed build at the world origin without anybody having said so.

A substitution's replacement is nullable, and null means **place nothing**. That is the ordinary
case rather than an edge one: not having the material is why somebody reaches for this, and a hole
is a more honest answer than a wrong block quietly standing in. One rule per source block, enforced
by a unique constraint — a plan saying a block becomes two different things does not say what it
means.

**Gated on the schematic nodes**, not a pair of its own. A plan is a decision *about* a schematic and
drives no agent by existing; the moment that changes is dispatch, which is `agent.run`. Deleting one
sits with `schematic.delete`, because it is not the reverse of creating it — the coordinates and the
rule set go with it.

**Nothing derived is stored or served *on the plan*.** The offset a placement implies and the
material totals once substitutions are applied are arithmetic over the plan and the index, so they
are computed where they are read. The split is the same: a pure function of the index and its two
arguments, recomputed on every `GET`. What changes that is a **run** — see below — which is the one
place a division is written down, because the moment it becomes work somebody is doing it needs an
identity to hang progress off.

## A job is a plan being carried out

`build_jobs` is one execution of one build, on one server, against a **frozen** division of it. The
plan stays editable while agents are working from it, so a job copies what it needs — the anchor,
the substitutions, and the schematic it was divided from — and reads nothing back through
`build_id`. An operator editing a plan mid-job is editing the *next* job, which is the only reading
that does not leave half a building under one rule set and half under another.

**Job, not run.** `agent.run` is the permission for operating the fleet and "running the fleet" is
what an operator does all day; a third meaning for the same word, sitting next to both, was one
reading too many. Job is the word for a unit of dispatched work and collides with nothing.

The segments are rows for the same reason the job is. A recomputed segment has no identity, and
progress has to attach to something; they are stored in **world coordinates** with the anchor
already applied, and half-open, so a host is told a box and does no transform of its own.

**One unfinished job per build per server**, enforced by a partial unique index — two would claim the
same blocks in the same place for two sets of agents, and only the database sees both requests. The
*per server* half is the point: the same tower on two servers is exactly what a job is for, and it is
why a build is its own row. Paused counts as unfinished, since it keeps its segments in order to be
resumed and would otherwise let a second job in beside it. **One
live segment per agent** is enforced the same way: a bot cannot be in two places, and the version
that looks reasonable in an interface is two segments of the *same* build. A job also pins its
schematic so that deleting *or re-reading* one can be refused while it is live: re-analysis looks
harmless and rewrites the very grid the segments were cut out of.

### Three states, and none of them a dead end

`ACTIVE` is building. `PAUSED` is stopped and resumable. `DONE` is finished, and is the only one
with a finishing time.

Cancel used to be the second of those and was a mistake worth recording: it stopped a job and then
left nothing to do with it but delete it, so an operator performed two acts to express one, and the
work that had been divided and crewed could not be picked up again. Pause keeps the segments, the
assignees and the counts, and resuming is one call.

### Agents are a pool, and pieces are scheduled onto them

`build_job_agents` says who is on a job. `build_segments.agent_id` says what they are holding. Those
were one fact until the crew became a pool, and separating them is what the rest of this section is
downstream of.

The old shape made the crew a *consequence* of the division: as many agents as pieces, each handed
one at the start and holding it for the life of the job. It cannot express a piece that waits for
another piece, and it cannot express **an agent that is on a job while building nothing** — which is
exactly what an agent waiting for a floor beneath its next piece is. Such an agent was linked to
nothing at all: `checkFree` read the segments, found none, and let a second job take a bot that was
already spoken for.

`schedule(job)` is now the only thing that hands work out, and runs after anything that can change
either side of the match — a job starting or resuming, a piece finishing or being handed back, an
agent joining or coming back into the game. It is deliberately dumb: lowest ordinal first, one piece
per idle agent. The interesting question is which pieces are *ready*, and that belongs to the
geometry rather than to a scheduler.

So there are two acts where there was one. **Releasing** hands back a piece and leaves the agent on
the job, which is what makes releasing a failed piece a retry. **Leaving** takes the agent off and
frees what it held for the rest of the pool. And how many pieces a build divides into is asked
separately from who is building it, so a build can be divided finer than its crew.

### Cutting on Y is an order, not a division

A bot is a player: two blocks tall, standing on the layer below to place the one it is on. Its body
therefore fills its own cell at the height it is working **and the height above that**.

Two agents split by height over the same ground are not merely slow, then. The upper one has to
stand exactly where the lower one still has blocks to place, and no separation distance fixes it,
because what the upper one is waiting for *is* the lower one's work. The vertical cuts
in `GRID` were producing plans that could not be built.

`BuildJob.blockers` is the rule: a piece is not handed out while any piece beneath its footprint is
unfinished. Derived from the boxes rather than stored — the split is frozen when the job starts, so
the answer cannot drift, where a dependency table could. It costs nothing where it is not needed:
`COLUMNS` cuts full-height prisms, nothing is beneath anything, and every piece is ready at once.

The upshot is that idle agents on an `ACTIVE` job are an **ordinary state**, not a stuck one, and the
response says which pieces each piece is waiting on so an interface need not guess.

**A paused job keeps holding its crew.** That is the honest reading — those agents are on this job —
and it is what makes resuming a single act rather than a reassignment of everybody. The way out is
named in the refusal: take the agent off that job, or delete the job.

**There is no failed job.** One with failed segments is still `ACTIVE` and needs an operator, because
deciding it is over means picking how many failures are too many and there is no honest number.

**Releasing a failed segment is the retry**, and the only way out of `FAILED`. Nothing reassigns one
by itself: a segment genuinely fails because the box is in bedrock, the material does not exist on
that server, or something is denying the placement — all of which fail the same way for the next
agent, so an automatic retry is a loop rather than a recovery. Somebody reads the reason, fixes what
caused it, and hands the segment back.

That reason **survives the release** and is cleared when the segment is taken, not when it is freed.
A segment sitting in the pool with nothing said about it is one nobody remembers why they freed, and
the operator who freed it is away doing the thing it is asking for.

Without this, `FAILED` was a state nothing could leave: reassignment picks up only `PENDING`,
releasing refused anything not currently assigned, and a job needs every segment `DONE` — so one
failed segment stranded a whole build, with deleting and rebuilding as the only way out. The mock
host never reports `failed`, which is why the live runs never showed it.

### Losing a builder is not losing the work

An agent that leaves the game has its segments returned to `PENDING`, never `FAILED`, and its last
reported block count is deliberately kept — those blocks are still standing, and the number stays
the last thing anybody observed until the next agent surveys the box itself.

An agent that comes **back** is given a waiting segment from an active job on its own server,
lowest ordinal first. Without that half, a reconnect left an agent standing beside the build it had
been on until somebody noticed and reassigned it by hand — for every agent, after every blip. A
paused job is skipped: somebody stopped it deliberately, and quietly re-crewing it would undo that.

Starting one takes **agents, not a part count**: how many pieces a build divides into is how many
agents are carrying them, and the server is derived from the agents rather than asked for. Both
would otherwise be a second place to say something the request already says.

**Assigning a segment dispatches it.** The agent’s host is sent a `build_segment` command naming
the segment and a fetch ticket; it collects the blocks over HTTP, places them, and reports back
with `build_progress` events, which is what moves a job’s counter. Releasing a segment sends
`cancel_segment`, so a host is told to stop rather than left building something nobody is
counting. All three are in `hostlink/HostEnvelope.kt`, and [`host/README.md`](../host/README.md)
is the wire reference.

## Serving a segment

`GET /api/hostlink/jobs/{jobId}/segments/{segmentId}` hands a host the blocks in one segment, with
the job's frozen substitutions already applied. The host places what it is given and decodes
nothing — the alternative, serving the file, means two decoders agreeing forever on palette quirks,
negative Litematica extents and what counts as air.

**Over HTTP rather than the socket.** `HostConnections.send` is blocking and serialised per host, so
a payload of any size there stalls heartbeats, vitals, chat and every command for every agent on
that machine — and vitals go stale after 30 seconds, which would render healthy agents unreachable
while a transfer drained. The socket is the control plane; bulk gets its own request, where a
failure is a retry rather than a dropped connection.

**Nothing per-block is stored.** A pass leaves a count per cell and a material list, so a segment is
produced by reading the file again and keeping what falls in one box. That is affordable because
the decoder streams and drops air as it goes, and a segment is a fraction of a file. Materialising
a blob per segment at dispatch would turn each fetch into a file read, at the cost of roughly the
build's size in disk and a lifecycle to keep in step with jobs that are reassigned, paused and
deleted — worth doing when something measures it, and not before.

### The format

A fixed six-byte record per block: a `u32` linear index into the box, and a `u16` palette entry.
Full layout in [`host/README.md`](../host/README.md), which is the wire reference.

The palette holds block **states** — `oak_stairs[facing=east]` — with properties sorted so one
state spells one way. Neither file format promises an order, and an unsorted spelling would intern
as two palette entries for one block. The *materials* list is still by name, and deliberately so:
stairs facing two ways are one thing to collect and two things to place.

**Fixed width rather than varints**, which look three times better on paper. Positions are
monotonic, so their high bytes barely change and gzip on the wire recovers most of the difference;
what is left is a format a host reads with a fixed stride, with no varint state machine and no
framing ambiguity. The magic carries a version, which is the escape hatch if measurement ever says
otherwise.

**Not the dense grid the file formats use.** The split balances *blocks*, not volume, so a sparse
region is handed a large box — and a grid costs its volume whether anything is in it or not,
punishing exactly the segments the splitter makes big.

Positions are a linear index in the decoders’ own order, y then z then x, so a host walking the
stream is already in build order. The backend sorts before sending rather than relying on it: one
region is naturally ascending, but a Litematica file holds several and they are read one after
another, so a later region can describe positions earlier in the box.

### Dispatch happens after the commit

A command must not describe a row the host cannot read yet. `build_segment` carries a fetch
ticket minted in the same transaction, and a host that is quick about it asks for the blocks
before that transaction commits — the endpoint runs in its own transaction, sees no such ticket,
and answers **401**.

That is not hypothetical: it is what happened the first time this ran against a real schematic.
Three of four segments won the race and the fourth was marked failed over a ticket that was
milliseconds from existing. Dispatch now registers an after-commit synchronisation, which also
covers the cancellations — telling a host to stop is a decision that can roll back, and a host
that has already acted on it has no way to learn it should not have.

**The suite cannot catch this class of bug.** Every REST test runs in a transaction that is
rolled back, so an after-commit callback never fires and dispatch is exercised by nothing but
running the thing. It belongs with the other two failures of that shape: `ddl-auto` emitting an
`alter table` no test sees because Testcontainers builds the schema fresh, and a migration that
reorders rows before dropping the constraint forbidding them, which is invisible when there are
no rows to migrate.

### The ticket

Authenticated by a capability for **one segment**, not by the host’s enrolment token — that is the
credential for a whole machine and every agent on it, and this is a `GET` whose headers reach logs
and proxies.

The ticket is minted when a segment is assigned and cleared when the assignment ends, so **its life
is the assignment rather than a clock**. There is nothing to expire and nothing to revoke: release
the segment and the ticket it was fetched with stops working.

The ids in the path are **checked, not used to look anything up**. Resolving by ticket and then
confirming the path agrees is what stops one leaked capability from becoming a key to the table;
finding by id and then comparing the ticket is the same code with that property removed.

Like `/ws/host`, it sits outside the Bearer chain entirely — a ticket is not a JWT, and the resource
server would reject it before the controller could read it. `permitAll` on the main chain would not
help: that governs authorization while the Bearer filter still authenticates.

## What a pass leaves behind

The blocks are never stored — a billion rows is not a table — so one pass produces a small
permanent summary, and everything after it reads that and never the file again.

**A count per cell of a coarse grid.** This is what makes splitting possible. Dividing a build
between agents has to divide the *blocks* evenly rather than the bounding box: a cathedral is mostly
air and its spire is solid, so four equal boxes can hand one agent most of the work. Counting per
cell turns that into arithmetic over a few hundred thousand numbers instead of a second pass over a
billion.

Only non-empty cells are kept. A sparse build — a rail line, a perimeter wall — has a bounding box
orders of magnitude larger than the thing inside it, and its empty cells would be a table larger
than the schematic.

**The cell edge is derived from the volume, not fixed.** A fixed 16 is right for a dense build and
ruinous for a sparse one: a rail network a hundred thousand blocks long has a bounding volume in the
trillions, and one row per chunk section of that is hundreds of millions of rows. The edge doubles
until the cell count is under `TARGET_CELLS`, so each step divides the count by eight and a handful
of steps covers any size. It is **stored** on the row rather than recomputed, so changing the rule
later cannot silently reinterpret rows written under the old one.

**A count per block type**, by block rather than by block state — stairs facing east and stairs
facing west are the same thing to gather, and a list split by state is a list nobody can shop from.

Both tables are written through `JdbcTemplate` in batches rather than as entities. A quarter of a
million cells is a batch insert, not a persistence context: mapped as entities they would be that
many managed objects, flushed one statement at a time and held in memory until the transaction
ended, for rows written once, read as a set and never updated.

Both cascade from the schematic in the schema. Orphaned cells are invisible — they belong to no
schematic, so nothing ever lists them — and they are the bulk of these tables.

## Drawing one

`GET /api/schematics/{id}/shape?detail=` answers with the build as voxels, read from the occupancy
index rather than the file — so it costs a query rather than a pass, and inherits the index's limit:
it knows how many blocks are in a cell, never where inside it. Past a certain size this is a massing
model and not a picture, and the interface says which it is looking at.

A quarter of a million cubes is more than a browser will draw at a frame rate anybody can drag
against, so three things reduce it and only the last is the browser's:

**Coarsening.** Cells are merged until the longest axis fits inside `detail`, which bounds the grid to
`detail³` before anything else happens. By halving rather than by an arbitrary divisor, so a voxel is
exactly the union of the cells under it and a block cannot land in two.

**Enclosure.** Every voxel with all six neighbours present is dropped. Those are interior — not
hidden from *this* angle but from every angle — so it is exact rather than an approximation, and it
is where the saving is: coarsening turns a building into something closer to solid, and a solid's
inside grows as the cube of its size while its surface grows as the square. A ten-cube of a thousand
voxels has 488 worth drawing.

**Exposure.** Each voxel carries a bitmask of the sides with nothing against them, decided here once
instead of in the browser sixty times a second. Of those the browser draws only the three that can
face a camera, in an order that needs no sorting at all: axis-aligned cubes on a grid have an exact
painter's order that depends only on which octant the camera is in.

The response is **flat** — `x, y, z, faces` repeated — rather than a list of objects. At tens of
thousands of cubes the field names would be most of the payload, and it is read once into an array
rather than being a shape anything works with.

## Dividing a build between agents

`GET /api/schematics/{id}/split?mode=&parts=` answers how a schematic divides. A **GET**, because it
asks rather than acts: the answer is a pure function of the occupancy index and the two arguments,
nothing is stored, and asking again gives the same segments. A plan saved today would be a copy of
something already derivable, kept in step by hand, describing an assignment nothing can yet carry
out — it becomes a row when there is a host that can be sent one.

**Blocks are divided, not the box.** Four equal boxes over a cathedral hand one agent the spire and
most of the work; the building is mostly air and the air is not evenly spread. So every cut is
placed where it balances the counts either side, which the index makes a matter of summing a few
hundred thousand numbers.

Cuts land on cell boundaries, never inside a cell. A cell is the finest thing the index counts, so a
cut through one would produce two segments of unknown size — and known sizes are the entire point of
the segments.

The two modes are **one algorithm with different axes allowed**, not two algorithms:

| Mode | Cuts on | What it costs |
|---|---|---|
| `COLUMNS` | X and Z | Full-height pieces. Every agent has its own ground and nothing ever waits. The safe default. |
| `GRID` | any | Balances best, having every axis to cut on. Pieces at one level go out together; the ones above them wait. |

There was a `LAYERS` cutting on Y alone, and it was **dominated by `GRID` in every case**: a layer is
one piece over the whole footprint, so the ordering rule leaves one agent building and the rest
watching. Its only remaining virtue was bottom-up order, which `GRID` has from the same rule while
still cutting horizontally.

It halves recursively rather than cutting one axis `parts` times, and each cut tries **every axis the
mode allows and keeps whichever balances closest** — not the axis that happens to be longest. That
was the first implementation and it produced splits like 43% / 54% / 1%: the axis with the most
places to cut is not the axis with a good place to cut, and a tall thin build offers plenty of
boundaries up its height that are all useless when the mass is at the bottom.

Which means how much of a `GRID` runs at once is **how many pieces sit at the same level**, not how
many were asked for. Sixteen pieces four wide and four high keep four agents busy; a fifth waits.
`COLUMNS` is the mode to reach for when parallelism matters more than balance.

**Fewer segments than asked for is a real answer.** A schematic three cells wide does not divide
between eight agents however the cuts are placed, and padding the count with empty segments would
send five agents to stand in the air. The response carries both `requested` and `parts`.

## The mock host

Nothing reported by a host exists until one dials in — telemetry, nearby players, chat, activity and
the dashboard trends all stay empty. `src/mockhost` is a fake host that connects, answers commands
and reports invented data, so the interface can be worked on without a Minecraft account, a server,
or the real host.

```bash
# Enrol a host in the interface and copy the token it shows once.
OSMIUM_HOST_TOKEN=osm_host_8_… ./gradlew mockHost
```

That is the whole toggle: it is a separate process, so it runs when you run it and stops when you
stop it. `OSMIUM_HOST_URL` overrides `ws://localhost:8080/ws/host`. Everything else is the ordinary
flow — add agents to that host, set them up, connect them — and the mock answers each command the
way a host would.

It **shares the wire protocol types with the application**, which is the point: rename a command and
the mock stops compiling, instead of drifting and being discovered by whoever maintains the real
host. It is a second implementation of a protocol that otherwise has one, and the only thing
exercising `HostEnvelope` outside the tests that assert on it.

Two details are load-bearing rather than tidy:

- **Its own source set, not `main` or `test`.** It is on neither the application's classpath — so it
  cannot reach the published image — nor the test one, so it never runs in CI.
- **Its classpath takes `main` *classes*, not `main` *output*.** Output includes processed resources,
  which drags `processResources` and `bootBuildInfo` into the task graph; those rewrite `build/`, and
  devtools tears down a running `bootRun` the moment they do. Starting the mock host killed the
  backend it had just connected to.

It reconnects with backoff, because the backend it talks to restarts on every save, and re-sends its
handshake — the backend does not reissue commands on reconnect, so an agent would otherwise sit in
the interface as `ONLINE` with vitals that had stopped arriving.

That handshake also advertises two login methods, `device_code` and `token_paste`. Since the backend
offers only what a host advertises, a mock that said nothing here could not set an agent up at all —
which would take the whole setup path out of local development. They are fictional mechanisms with
real shapes, and like a real host’s they name a mechanism and never an account.

What it does **not** do: log in to anything, hold a credential, or model Minecraft. Setup succeeds
because it was asked to, and reports an invented identity. It cannot tell you whether a real login
works — that is the host's business, and the backend never observes it.


## Tests

```bash
./gradlew test
```

496 tests across 39 classes. Most run against a real Postgres 18 through Testcontainers with
`@ServiceConnection`, so **Docker must be running**.

- **REST tests** cover every route: happy paths, 401s, per-role 403s, 404s, 409 conflicts, 429s,
  503s and validation failures. Each runs in a transaction that is rolled back, so the suite leaves
  no state behind.
- **Socket tests** drive a real client over a real WebSocket. `HostLinkTest` authenticates with an
  enrolment token, heartbeats, receives a dispatched command and answers it; `ChatListenerServiceTest`
  elects listeners across two hosts and asserts on the commands that actually reach them. Both are
  deliberately not transactional — the host runs on other threads, so a rolled-back test transaction
  would be invisible to it — and clean up explicitly instead.
- **Unit tests on a clock the test owns** cover the parts that are about the passage of time:
  telemetry ageing out, the coalescing tick, and the chat rate limiter's bucket. Waiting for real
  seconds to pass would be slow and flaky, so those never touch the container.

No mocking library. The suite runs against real things — a real database, a real socket, or a plain
object with a clock injected — which is why a fake `WebSocketSession` does not appear anywhere. The
avatar proxy follows the same line: `AvatarControllerTest` runs a small HTTP server as the skin
service and counts what it was asked for, because a cache that is not observed preventing a second
request has not been tested.

## Docker image

`Dockerfile` is a two-stage JVM build: `eclipse-temurin:25-jdk` produces the boot jar, which is
copied onto `eclipse-temurin:25-jre` and run as a non-root user.

```bash
docker build -t osmium-backend .
```

The container cannot reach `localhost:5432`. Point it at the compose network:

```bash
-e SPRING_DATASOURCE_URL=jdbc:postgresql://postgres:5432/osmium
```

**Uploaded schematics need a volume.** They are files on disk rather than rows — one can run to
gigabytes and a Postgres value stops at one — so a container without a mount loses every upload on
the next deploy, and the rows describing them survive to point at nothing.

```bash
-v osmium-schematics:/var/lib/osmium/schematics -e OSMIUM_SCHEMATIC_DIRECTORY=/var/lib/osmium/schematics
```

A GraalVM native image was tried and dropped: it built and produced a working 311 MB image, but cost
roughly 20 minutes per CI run, which is not worth it here.

## CI

`.github/workflows/backend-tests.yml` runs `./gradlew test` on pull requests touching `backend/`.
Failures become inline annotations and a job summary table; the JUnit XML and the HTML report are
uploaded as artifacts. It needs the Docker daemon on the hosted runner, since Testcontainers starts
a real Postgres.

One constraint any further workflow here inherits: a container-based or self-hosted runner without
Docker cannot run this suite at all.

`.github/workflows/backend-image.yml` builds this image and pushes it to
`ghcr.io/integr-dev/osmium/backend` on every push to `main` that touches `backend/`, and on manual
dispatch. Tags come from the `version` in `build.gradle.kts`, plus `sha-<short>` and `latest`.

It **calls the test workflow first** and gates publishing on it with `needs`, so a failing suite
means no image. That is also why the test workflow has no `push` trigger: on `main` this one drives
it, and the suite runs once instead of twice.

## Layout

Packaged **by feature first, layer second**. Each feature owns its controller, service,
repository, model and DTOs, so a change to one subsystem stays in one directory.

```
account/      users, roles, permission nodes, login, password rotation, seeding
host/         the machines that run agents
agent/        Minecraft sessions and the commands that drive them
audit/        the operator trail and its retention purge
activity/     what happened to agents: kicks, deaths, lifecycle changes
chat/         what was said in game, per agent and per server, and listener election
schematic/    the library, the readers for .litematic and .schem, the index and the split

hostlink/     the backend<->host channel: envelope, handshake auth, connections, reports
liveupdates/  the backend->browser channel: events, broker, subscriptions, SSE endpoint
security/     node/role definitions, JWT issuing, Spring Security wiring
web/          cross-cutting HTTP: exception handling, OpenAPI setup
```

The seven feature packages each contain `controller/`, `service/`, `repository/`, `model/` and
`dto/`. The four below the gap are not features and stay flat: two are channels, one is framework
wiring, one is cross-cutting HTTP.

`schematic/` keeps the format readers at its top level rather than under `service/`. They are pure
functions over a stream — no Spring, no database, nothing injected — and the split between them and
the parts that touch a row is the most useful line in that package.

All of that is `src/main`. `src/mockhost` sits beside it as a source set of its own — a development
tool that speaks the host protocol, on neither the application classpath nor the test one. See
[The mock host](#the-mock-host).

Naming follows what a class *does*, not how it does it — `HostConnections`, not
`HostSessionRegistry`; `HostMessageHandler`, not `HostWebSocketHandler`. The transport is visible
from the type it extends.
