# Osmium backend

Spring Boot 4.1 / Kotlin. Provides JWT authentication with role-grouped permission nodes, the host
and bot domain, and the WebSocket that agents dial into.

Routes authorize against **nodes only** — never against roles. Roles exist purely as named bundles
of nodes, so adding a role never requires touching a route annotation.

It holds **no Minecraft credentials**. Commands are relayed to the host that owns a bot; that host
performs any login itself and reports back only an identity. See
[`../BOT_CONNECTIVITY.md`](../BOT_CONNECTIVITY.md).

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
| `user.roles.write` | change the role of an account |
| `role.read` | list roles and their nodes |
| `agent.read` | see hosts, bots and telemetry |
| `agent.control` | create, edit, delete bots; connect and disconnect them |
| `agent.chat` | **speak in game as a bot** |
| `agent.login` | enrol hosts, rotate tokens, trigger `setup_bot` |

`agent.chat` and `agent.login` stay separate from `agent.control` even though one tier currently
holds all four: the first is impersonation under an account you own, the second is credential
acquisition. Collapsing them would make that distinction unrecoverable if a narrower tier is ever
wanted.

### Roles

Each tier unions the tier below it. Inheritance is materialized at seed time — the union is computed
in `RoleDefinitions` and the flattened result is written into `role_nodes`, so authorization stays a
single flat set lookup and the table is self-describing.

| Role | Nodes |
|---|---|
| `viewer` | `user.read.self`, `user.edit.self`, `role.read` |
| `orchestrator` | *viewer* + `agent.read`, `agent.control`, `agent.chat`, `agent.login` |
| `administrator` | *orchestrator* + `user.read`, `user.edit`, `user.create`, `user.delete`, `user.roles.write` |

The division is "runs the bots" versus "runs the people": an orchestrator has full authority over the
fleet, and user management is the only thing an administrator adds.

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
| `PUT` | `/api/users/{id}/role` | `user.roles.write` |
| `GET` | `/api/roles` | `role.read` |
| `GET` | `/api/hosts` | `agent.read` |
| `POST` | `/api/hosts` | `agent.login` (returns the enrolment token once) |
| `PATCH` | `/api/hosts/{id}` | `agent.login` (rename) |
| `POST` | `/api/hosts/{id}/rotate-token` | `agent.login` |
| `DELETE` | `/api/hosts/{id}` | `agent.login` (cascades to its bots) |
| `GET` | `/api/bots`, `/api/bots/{id}` | `agent.read` |
| `POST` | `/api/bots` | `agent.control` |
| `PATCH` | `/api/bots/{id}` | `agent.control` (rename, move server) |
| `DELETE` | `/api/bots/{id}` | `agent.control` |
| `POST` | `/api/bots/{id}/setup` | `agent.login` |
| `POST` | `/api/bots/{id}/connect`, `/disconnect` | `agent.control` |
| `POST` | `/api/bots/{id}/chat` | `agent.chat` |

There is no self-registration — administrators create accounts, choosing the username and password.
An account cannot delete itself, change its own role, or edit itself through the administrative
route, so those paths cannot be used to lock yourself out or bypass the current-password check.

Bot commands answer **503** when the owning host has no live connection. They are never queued: a
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

## Hosts, bots and the agent socket

A **host** is a machine running an agent; a **bot** is one Minecraft session on one server, owned by
a host. Enrolling a host issues a token once — only its hash is stored — and the host then dials in:

```
agent → backend    WSS /ws/agent, Authorization: Bearer osm_ag_<hostId>_<secret>
```

The token embeds the host id so authentication is one lookup plus one hash comparison, rather than a
BCrypt check against every enrolled host.

That endpoint has **its own security filter chain**, deliberately without the resource server.
`permitAll` alone is not enough: the bearer-token filter would still try to authenticate an agent
token as a JWT and reject the handshake with 401.

One socket per host multiplexes all its bots, so every message carries a `botId`; there is no
destination field, because the connection *is* the host. Commands are fire-and-forget and state
advances when the agent reports back — it is the source of truth about its own bots, and is trusted
only for the bots it owns.

Reachability is **derived** from the heartbeat rather than stored, so a backend restart cannot leave
a host stuck online. An `ONLINE` bot whose host is unreachable reports as `STALE`, not offline —
the state is genuinely unknown at that point.

## Tests

```bash
./gradlew test
```

88 tests. They run against a real Postgres 18 through Testcontainers with `@ServiceConnection`, so
**Docker must be running**.

- **REST tests** cover every route: happy paths, 401s, per-role 403s, 404s, 409 conflicts, 503s and
  validation failures. Each runs in a transaction that is rolled back, so the suite leaves no state
  behind.
- **`AgentWebSocketTest`** drives a real client over a real socket: it authenticates with an
  enrolment token, heartbeats, receives a dispatched command and answers it. It is deliberately not
  transactional — the agent runs on other threads, so a rolled-back test transaction would be
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

Two things any further workflow here has to repeat: `gradlew` is committed as mode `100644`, so it
must be `chmod +x`ed before use, and a container-based or self-hosted runner without Docker cannot
run this suite at all.

`.github/workflows/backend-image.yml` builds this image and pushes it to
`ghcr.io/integr-dev/osmium/backend` on every push to `main` that touches `backend/`, and on manual
dispatch. Tags come from the `version` in `build.gradle.kts`, plus `sha-<short>` and `latest`.

It **calls the test workflow first** and gates publishing on it with `needs`, so a failing suite
means no image. That is also why the test workflow has no `push` trigger: on `main` this one drives
it, and the suite runs once instead of twice.

## Layout

```
config/      configuration properties, OpenAPI and WebSocket setup, DataInitializer seeding
controller/  REST endpoints and the exception handler
dto/         request/response records, bean validation, entity mappers
model/       JPA entities and the bot lifecycle enum
repository/  Spring Data repositories
security/    node/role definitions, JWT issuing, Spring Security wiring
service/     domain logic; AgentEventService applies what agents report
websocket/   the agent socket: envelope, handshake auth, session registry
```
