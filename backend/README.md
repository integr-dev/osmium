# Osmium backend

Spring Boot 4.1 / Kotlin service providing JWT authentication with role-grouped permission nodes.

Routes authorize against **nodes only** — never against roles. Roles exist purely as named bundles
of nodes, so adding a role never requires touching a route annotation.

## Requirements

- JDK 21 (the Gradle toolchain pins `languageVersion = 21`)
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

Fully normalized across five tables: `users`, `roles`, `permission_nodes`, and the join tables
`user_roles` and `role_nodes`. A node's string *is* its primary key, so there is no surrogate id to
keep in sync.

### Nodes

| Node | Grants |
|---|---|
| `user.read.self` | read your own account |
| `user.edit.self` | rename your own account |
| `user.read` | list all accounts |
| `user.edit` | edit any account, including resetting its password |
| `user.create` | create accounts |
| `user.delete` | delete accounts |
| `user.roles.write` | change the roles of an account |
| `role.read` | list roles and their nodes |

### Roles

Each tier unions the tier below it. Inheritance is materialized at seed time — the union is computed
in `RoleDefinitions` and the flattened result is written into `role_nodes`, so authorization stays a
single flat set lookup and the table is self-describing.

| Role | Nodes |
|---|---|
| `viewer` | `user.read.self`, `user.edit.self` |
| `orchestrator` | *viewer* + `user.read` |
| `administrator` | *orchestrator* + `user.edit`, `user.create`, `user.delete`, `user.roles.write`, `role.read` |

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
| `PUT` | `/api/users/{id}/roles` | `user.roles.write` |
| `GET` | `/api/roles` | `role.read` |

There is no self-registration — administrators create accounts, choosing the username and password.
An account cannot delete itself, so an administrator cannot lock themselves out that way.

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

## Tests

```bash
./gradlew test
```

46 REST tests covering every route: happy paths, 401s, per-role 403s, 404s, 409 conflicts and
validation failures. They run against a real Postgres 18 through Testcontainers with
`@ServiceConnection`, so **Docker must be running**. Each test runs in a transaction that is rolled
back, so the suite leaves no state behind.

## Native image

`Dockerfile` is a two-stage build: GraalVM compiles a native executable via the
`org.graalvm.buildtools.native` Gradle plugin, and the result is copied onto a slim Debian runtime.

```bash
docker build -t osmium-backend .
```

Expect 5–15 minutes and roughly 8 GB of RAM; raise Docker's memory limit or `native-image` will be
killed mid-build. The runtime stage is glibc-based to match the build image — an Alpine/musl runtime
would not run the binary.

The container cannot reach `localhost:5432`. Point it at the compose network:

```bash
-e SPRING_DATASOURCE_URL=jdbc:postgresql://postgres:5432/osmium
```

> The native build has not been executed yet; only the JVM build and the test suite are verified.

## Layout

```
config/      configuration properties, OpenAPI setup, DataInitializer seeding
controller/  REST endpoints and the exception handler
dto/         request/response records, bean validation, entity mappers
model/       JPA entities
repository/  Spring Data repositories
security/    node/role definitions, JWT issuing, Spring Security wiring
```
