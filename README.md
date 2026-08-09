# Osmium

Orchestration for a fleet of Minecraft bots that build a large schematic together.

An operator uploads a schematic, picks the bots to work it, and Osmium splits it into segments and
hands each bot its own slice. The dashboard shows what the fleet is doing: progress, throughput, what
needs attention, and what is being said in game.

> **Status:** early. Authentication, accounts, hosts, bots and the agent transport are built and
> tested. The agent itself is not — see [`agent/`](agent/). Telemetry and build progress in the UI
> are still mock, because nothing reports them until an agent connects.

## Modules

| Module | What it is | State |
|---|---|---|
| [`backend/`](backend/) | Spring Boot 4.1 / Kotlin. Auth, accounts, hosts, bots, and the WebSocket agents dial into. | Built, 88 tests |
| [`frontend/`](frontend/) | Vue 3 / Vite SPA. Operator dashboard. | Built |
| [`agent/`](agent/) | Runs on a machine you control, holds the Minecraft credentials, drives the bots. | **Not started** |

## The one idea worth knowing

**Osmium never holds Minecraft credentials, and never performs the login.**

The backend sends a host a `setup_bot` command; that host logs the account in by whatever means it
prefers and reports back only the resulting username and UUID. A full database dump therefore reveals
*which* accounts you run — not the ability to run them.

That constraint shapes everything else: how bots are addressed, why hosts dial out instead of being
connected to, and why a host being unreachable makes a bot's state *unknown* rather than offline.

[`BOT_CONNECTIVITY.md`](BOT_CONNECTIVITY.md) is the design document — credential custody, the wire
protocol, liveness, chat, and the alternatives that were rejected and why.

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
| `viewer` | see your own account and the role list |
| `orchestrator` | *viewer* + full authority over hosts and bots |
| `administrator` | *orchestrator* + user management |

So the split is "runs the bots" versus "runs the people". Details in
[`backend/README.md`](backend/README.md).

## Images

Both modules publish to GHCR on pushes to `main` that touch them, tagged from the version in
`build.gradle.kts` and `package.json` respectively:

- `ghcr.io/integr-dev/osmium/backend`
- `ghcr.io/integr-dev/osmium/frontend`

## Licence

See [LICENSE](LICENSE).
