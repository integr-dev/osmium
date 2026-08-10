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
| `osmium.jwt.ttl` | `OSMIUM_JWT_TTL` | `1h` | access token lifetime |
| `osmium.bootstrap.username` | `OSMIUM_BOOTSTRAP_USERNAME` | `admin` | seeded account |
| `osmium.bootstrap.password` | `OSMIUM_BOOTSTRAP_PASSWORD` | `admin` | seeded account |
| `osmium.cors.origins` | `OSMIUM_CORS_ORIGINS` | empty | comma-separated exact origins for `/api/**` |
| `osmium.audit.retention` | `OSMIUM_AUDIT_RETENTION` | `30d` | how long audit entries are kept |
| `osmium.activity.retention` | `OSMIUM_ACTIVITY_RETENTION` | `10d` | how long agent incidents are kept |
| `osmium.chat.retention` | `OSMIUM_CHAT_RETENTION` | `3d` | how long chat is kept |
| `osmium.chat.messages-per-minute` | `OSMIUM_CHAT_MESSAGES_PER_MINUTE` | `30` | outbound chat allowance, per agent |

CORS is **off** unless origins are listed, because both supported deployments proxy `/api` and are
therefore same-origin. `*` is rejected outright: the configuration allows credentials, and no
browser accepts that combination.

> The committed JWT secret and the `admin`/`admin` bootstrap credentials are development defaults.
> The bootstrap account is a full administrator from the first boot and **nothing forces a password
> rotation**, so both must be overridden before the first boot of anything that is not local
> development.

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
| `role.read` | list roles and their nodes |
| `audit.read` | read the operator audit trail, including outbound message text |
| `fleet.read` | see hosts, agents and telemetry |
| `fleet.control` | create, edit, delete agents; connect and disconnect them |
| `fleet.chat` | **speak in game as an agent** |
| `fleet.login` | enrol hosts, rotate tokens, trigger `setup_agent` |

`fleet.chat` and `fleet.login` stay separate from `fleet.control` even though one tier currently
holds all four: the first is impersonation under an account you own, the second is credential
acquisition. Collapsing them would make that distinction unrecoverable if a narrower tier is ever
wanted.

### Roles

Each tier unions the tier below it. Inheritance is materialized at seed time — the union is computed
in `RoleDefinitions` and the flattened result is written into `role_nodes`, so authorization stays a
single flat set lookup and the table is self-describing.

| Role | Nodes |
|---|---|
| `viewer` | `user.read.self`, `user.edit.self`, `role.read`, `fleet.read` |
| `orchestrator` | *viewer* + `fleet.control`, `fleet.chat`, `fleet.login` |
| `administrator` | *orchestrator* + `user.read`, `user.edit`, `user.create`, `user.delete`, `user.role.write`, `audit.read` |

A viewer is read-only throughout: `fleet.read` gates listing hosts and agents and the live streams,
and nothing else, so it can watch the fleet without being able to touch it. Every way to change the
fleet is a separate node, which is what makes that tier possible without a second set of routes.

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
| `POST` | `/api/auth/login` | — (public) |
| `POST` | `/api/auth/password` | authenticated (rotates your own password, requires the current one) |
| `GET` | `/api/auth/me` | `user.read.self` |
| `GET` | `/api/users` | `user.read` |
| `POST` | `/api/users` | `user.create` |
| `PATCH` | `/api/users/me` | `user.edit.self` |
| `PATCH` | `/api/users/{id}` | `user.edit` |
| `DELETE` | `/api/users/{id}` | `user.delete` |
| `PUT` | `/api/users/{id}/role` | `user.role.write` |
| `GET` | `/api/roles` | `role.read` |
| `GET` | `/api/audit` | `audit.read` (cursor-paged, `query` searches, `limit` clamped to 1..500) |
| `GET` | `/api/activity` | `fleet.read` (cursor-paged; `agentId` narrows to one agent) |
| `GET` | `/api/chat` | `fleet.read` (cursor-paged; **exactly one** of `agentId` or `server`) |
| `GET` | `/api/stream/fleet` | `fleet.read` (server-sent events) |
| `GET` | `/api/stream/agents/{id}` | `fleet.read` (server-sent events) |
| `GET` | `/api/hosts` | `fleet.read` |
| `POST` | `/api/hosts` | `fleet.login` (returns the enrolment token once) |
| `PATCH` | `/api/hosts/{id}` | `fleet.login` (rename) |
| `POST` | `/api/hosts/{id}/rotate-token` | `fleet.login` |
| `DELETE` | `/api/hosts/{id}` | `fleet.login` (cascades to its agents) |
| `GET` | `/api/agents`, `/api/agents/{id}` | `fleet.read` |
| `POST` | `/api/agents` | `fleet.control` |
| `PATCH` | `/api/agents/{id}` | `fleet.control` (rename, move server) |
| `DELETE` | `/api/agents/{id}` | `fleet.control` |
| `POST` | `/api/agents/{id}/setup` | `fleet.login` |
| `POST` | `/api/agents/{id}/connect`, `/disconnect` | `fleet.control` |
| `POST` | `/api/agents/{id}/chat` | `fleet.chat` (rate limited per agent; **429** when exceeded) |

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

One socket per host multiplexes all its agents, so every message carries an `agentId`; there is no
destination field, because the connection *is* the host. Commands are fire-and-forget and state
advances when the host reports back — it is the source of truth about its own agents, and is trusted
only for the agents it owns.

Reachability is **derived** from the heartbeat rather than stored, so a backend restart cannot leave
a host stuck online. An `ONLINE` agent whose host is unreachable reports as `STALE`, not offline —
the state is genuinely unknown at that point.

## Live updates

`GET /api/stream/fleet` is a server-sent event stream of everything that changes;
`/api/stream/agents/{id}` narrows it to one agent. The channel is **receive-only** — commands stay
on REST, where they are node-gated and audited.

| Event | Carries | Client does |
|---|---|---|
| `agent`, `host` | the resource, in the shape REST returns it | replaces it in place |
| `agent-removed`, `host-removed` | `{ id }` | drops it |
| `chat`, `activity` | one new line | appends it to the feed |
| `telemetry` | `{ agentId, telemetry }` | merges the vitals into the agent |

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
- **Streams re-check authority every 30s** and close on failure. Authorities resolve per request for
  REST, so a demotion takes effect immediately — a stream authorises once and would otherwise run for
  hours. It also never outlives the token that opened it.
- **Deleting a host announces each cascaded agent** before the host itself. Publishing only the host
  would leave every browser holding agents that no longer exist.

Connect, disconnect and chat publish nothing: they change no stored state. The agent's state moves
when the host reports back, and *that* is what reaches the browser.

`InMemoryFleetEventBroker` is the only implementation. With two backend instances a host's WebSocket
lands on one while a browser's stream sits on the other, and that browser never sees the event —
solving it needs a shared broker or sticky routing. The `FleetEventBroker` interface exists so that
becomes a second implementation rather than a rewrite.

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
parameter. A server's global chat is identical for every agent on it, so it is forwarded once by an
elected listener and read per *server*; an agent's feed is only what was said to or about that
agent. Serving both from one endpoint would put the same message on every agent page.

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
  host reports names and distances; the backend knows the fleet.

Uptime is **not** reported. It is derived from `onlineSince`, which the backend already stamps for
chat listener election — a second counter on the wire would be one more thing that could disagree.

### Outbound chat is rate limited

30 messages a minute, **per agent**, refused with a 429 before the command is dispatched.

Per agent rather than per operator, because the consequence lands on the account: two operators
sharing an agent share its budget, and one operator driving ten agents is not throttled across all
of them. It is also what contains a stolen session holding `fleet.chat` — it can speak, but it
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

## Schema migrations

**Flyway owns the schema. Hibernate only checks it.** `ddl-auto=validate` means a mismatch between
the entities and the database is a failure to start, not a failure three screens into the app.

```
src/main/resources/db/migration/
  V1__baseline.sql                 the schema as it stood when Flyway took over
  V2__drop_ddl_auto_leftovers.sql  the dead schema ddl-auto left behind
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

## Tests

```bash
./gradlew test
```

200 tests across 15 classes. Most run against a real Postgres 18 through Testcontainers with
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
object with a clock injected — which is why a fake `WebSocketSession` does not appear anywhere.

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

hostlink/     the backend<->host channel: envelope, handshake auth, connections, reports
liveupdates/  the backend->browser channel: events, broker, subscriptions, SSE endpoint
security/     node/role definitions, JWT issuing, Spring Security wiring
web/          cross-cutting HTTP: exception handling, OpenAPI setup
```

The six feature packages each contain `controller/`, `service/`, `repository/`, `model/` and
`dto/`. The four below the gap are not features and stay flat: two are channels, one is framework
wiring, one is cross-cutting HTTP.

Naming follows what a class *does*, not how it does it — `HostConnections`, not
`HostSessionRegistry`; `HostMessageHandler`, not `HostWebSocketHandler`. The transport is visible
from the type it extends.
