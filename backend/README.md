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

Hibernate creates the schema on first boot (`ddl-auto=update`) and `DataInitializer` seeds the
permission nodes, the three roles, and — only while the `users` table is empty — a bootstrap
administrator.

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
| `GET` | `/api/audit` | `audit.read` (newest first, `limit` clamped to 1..1000) |
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
| `POST` | `/api/agents/{id}/chat` | `fleet.chat` |

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

Events carry the same shapes the REST endpoints return (`agent`, `agent-removed`, `host`,
`host-removed`), so a client replaces the resource in place rather than refetching. That is why the
response mappers live in `dto/Mappers.kt` instead of being private to a service: two mappers would
let the stream and the API drift.

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

### Adding a new action needs a manual migration

Hibernate maps `AuditAction` with a `CHECK` constraint listing every enum name, and
`ddl-auto=update` writes that constraint **once and never alters it**. Adding a value therefore
succeeds at boot and then fails at insert time against the stale list:

```
ERROR: new row for relation "audit_entries" violates check constraint "audit_entries_action_check"
```

Run this against any existing database when the enum changes:

```sql
ALTER TABLE audit_entries DROP CONSTRAINT audit_entries_action_check;
ALTER TABLE audit_entries ADD CONSTRAINT audit_entries_action_check
  CHECK (action IN ('AGENT_CREATE', /* … every current value … */));
```

Both `columnDefinition` and an `AttributeConverter` were tried against a real Postgres to suppress
the constraint; Hibernate 7.4 generates it either way. The tests never catch this, because
Testcontainers builds a fresh schema from the current enum on every run — it only bites a database
that already exists.

That is the second symptom of the same root cause: **`ddl-auto=update` is not a migration tool.** It
adds tables and columns and does nothing else. Flyway or Liquibase is the real answer before this
runs anywhere that cannot be dropped and recreated.

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

## Tests

```bash
./gradlew test
```

121 tests. They run against a real Postgres 18 through Testcontainers with `@ServiceConnection`, so
**Docker must be running**.

- **REST tests** cover every route: happy paths, 401s, per-role 403s, 404s, 409 conflicts, 503s and
  validation failures. Each runs in a transaction that is rolled back, so the suite leaves no state
  behind.
- **`HostLinkTest`** drives a real client over a real socket: it authenticates with an
  enrolment token, heartbeats, receives a dispatched command and answers it. It is deliberately not
  transactional — the host runs on other threads, so a rolled-back test transaction would be
  invisible to it — and cleans up explicitly instead.

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

hostlink/     the backend<->host channel: envelope, handshake auth, connections, reports
liveupdates/  the backend->browser channel: events, broker, subscriptions, SSE endpoint
security/     node/role definitions, JWT issuing, Spring Security wiring
web/          cross-cutting HTTP: exception handling, OpenAPI setup
```

The four feature packages each contain `controller/`, `service/`, `repository/`, `model/` and
`dto/`. The four below the gap are not features and stay flat: two are channels, one is framework
wiring, one is cross-cutting HTTP.

Naming follows what a class *does*, not how it does it — `HostConnections`, not
`HostSessionRegistry`; `HostMessageHandler`, not `HostWebSocketHandler`. The transport is visible
from the type it extends.
