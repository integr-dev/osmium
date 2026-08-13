# Osmium

Orchestration for a fleet of Minecraft agents that build a large schematic together.

An operator uploads a schematic, picks the agents to work it, and Osmium splits it into segments and
hands each agent its own slice. The dashboard shows what the fleet is doing: progress, throughput,
what needs attention, and what is being said in game.

> **Status:** early. Authentication, accounts, hosts, agents, the audit log, chat, activity,
> telemetry, live updates and the host transport are built and tested. The host program itself lives
> outside this repository — Rust on azalea, see [`host/`](host/). Those feeds stay empty until a host
> connects and starts reporting. Build progress and remote configuration are the two parts of the
> UI still running on mock data.

## Modules

| Module | What it is | State |
|---|---|---|
| [`backend/`](backend/) | Spring Boot 4.1 / Kotlin. Auth, accounts, hosts, agents, and the WebSocket hosts dial into. | Built, 276 tests |
| [`frontend/`](frontend/) | Vue 3 / Vite SPA. Operator dashboard. | Built, 127 tests |
| [`host/`](host/) | Runs on a machine you control, holds the Minecraft credentials, drives the agents. Rust, on azalea. | **Built separately** |

## The one idea worth knowing

**Osmium never holds Minecraft credentials, and never performs the login.**

The backend sends a host a `setup_agent` command; that host logs the account in by whatever means it
prefers and reports back only the resulting username and UUID. A full database dump therefore
reveals *which* accounts you run — not the ability to run them.

That constraint shapes everything else: how agents are addressed, why hosts dial out instead of
being connected to, and why a host being unreachable makes an agent's state *unknown* rather than
offline.

[`FLEET_CONNECTIVITY.md`](FLEET_CONNECTIVITY.md) is the design document — credential custody, the
wire protocol, liveness, chat, and the alternatives that were rejected and why.

## Running it locally

Needs **JDK 25**, **Node 24** and **Docker**.

```bash
# 1. Postgres
docker compose -f backend/docker-compose.yml up -d

# 2. Backend on :8080
cd backend && ./gradlew bootRun          # gradlew.bat on Windows

# 3. Frontend on :5173, proxying /api to the backend
cd frontend && npm install && npm run dev
```

Sign in with `admin` / `admin`. Those are development defaults and are seeded only while the `users`
table is empty — override `OSMIUM_BOOTSTRAP_USERNAME` / `OSMIUM_BOOTSTRAP_PASSWORD`, and
`OSMIUM_JWT_SECRET`, before running this anywhere real.

## Permissions

Routes authorize against **permission nodes**, never against role names. Roles are named bundles of
nodes, arranged as nested tiers:

| Role | Adds |
|---|---|
| `viewer` | watch the fleet, and see your own account |
| `orchestrator` | *viewer* + acting on hosts and agents |
| `administrator` | *orchestrator* + user management |

So the split is "runs the agents" versus "runs the people". Details in
[`backend/README.md`](backend/README.md).

## Tests

```bash
cd backend && ./gradlew test     # 276 tests; needs Docker for Testcontainers
cd frontend && npm test          # 127 tests
```

The backend covers every route — happy paths, 401s, per-role 403s, 409s, 429s, 503s — plus real
clients over real host sockets, and unit tests on an injected clock for anything about the passage of
time. The frontend covers the route guard, the auth store, the API client middleware, the fleet
store's derived state, cursor paging, and that the English and German copy stay in step.

## CI

Four workflows, all path-filtered so a change to one module does not run the other's jobs.

| Workflow | Runs on | Does |
|---|---|---|
| `backend-tests.yml` | pull request, or called | `./gradlew test`, annotates failures, uploads reports |
| `frontend-tests.yml` | pull request, or called | Vitest, ESLint and the `vue-tsc` build, all three under `if: always()` |
| `backend-image.yml` | push to `main` | runs the tests, then publishes `ghcr.io/integr-dev/osmium/backend` |
| `frontend-image.yml` | push to `main` | runs the tests, then publishes `ghcr.io/integr-dev/osmium/frontend` |

**Nothing is published without a green suite.** Each image workflow calls the matching test workflow
as a reusable workflow and gates its publishing job on it with `needs`. The test workflows therefore
have no `push` trigger of their own — on `main` the image workflow drives them, so a push runs the
suite once rather than twice, and the suite cannot drift between the pull-request run and the
publishing run.

Image tags come from the version in `build.gradle.kts` and `package.json` respectively, plus
`sha-<short>` and `latest`. Failing tests become inline annotations and a job summary table, built
from JUnit XML by [`.github/scripts/junit-summary.mjs`](.github/scripts/junit-summary.mjs).

## Licence

See [LICENSE](LICENSE).
