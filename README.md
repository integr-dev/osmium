# Osmium

Orchestration for a fleet of Minecraft agents that build a large schematic together.

An operator uploads a schematic, picks the agents to work it, and Osmium splits it into segments and
hands each agent its own slice. The dashboard shows what the fleet is doing: progress, throughput,
what needs attention, and what is being said in game.

> **Status:** early. Authentication, accounts, hosts, agents, the audit log, chat, activity,
> telemetry, live updates and the host transport are built and tested, and so is the build pipeline
> end to end: uploading a schematic, reading it, dividing it between agents, recording the result as
> a **job** — what is being built, where, by whom, and how far along — handing each segment to the
> host that holds the agent, serving its blocks as block *states*, and taking progress back as they
> are placed. The host in [`host/`](host/) signs agents in, puts them on a server and reports what
> they see; building is the part of it still to be written. A mock host in this repository speaks the
> same protocol, and the feeds stay empty until something connects and starts reporting. Remote
> configuration is wired end to end — what an operator sets is stored, sent to the host, and replayed
> on every reconnect — so nothing in the interface runs on mock data any more. An agent's world can
> also be watched live: the host streams the blocks and entities around it, and the browser renders
> them. Alongside that, agents chart the ground they walk over into a shared top-down map, report
> what they are carrying — which an operator can rearrange, drop or put in hand — and report
> everyone in view with their health — and where each of them *was*, kept past the moment they
> went, so the map can say who was standing there an hour ago. An agent's connection can be routed
> through one of its host's proxies, chosen by name, with the credential for it never leaving that
> machine. **An agent can be sent somewhere** — clicked on the map or in the 3D view, typed as a
> coordinate, or asked for in game — and the route it takes is drawn in both views as it walks, and
what came of it is announced in the corner, linked back to the agent. An
> administrator can see what all of that costs on disk, and free it.

## Modules

| Module | What it is | State |
|---|---|---|
| [`backend/`](backend/) | Spring Boot 4.1 / Kotlin. Auth, accounts, hosts, agents, schematics, build plans and jobs, and the WebSocket hosts dial into. | Built, 632 tests |
| [`frontend/`](frontend/) | Vue 3 / Vite SPA. Operator dashboard, the build pipeline, the live world viewer, the charted map and the storage breakdown. | Built, 545 tests |
| [`host/`](host/) | Runs on a machine you control, holds the Minecraft credentials and the proxies, drives the agents. TypeScript, on mineflayer. | Connects, plays, walks where it is sent, reports its world, inventory and neighbours, and streams what it sees; does not build yet, 563 tests |
| [`host/` → `osmium-link`](host/README.md) | The host's own command line: the accounts it can log in with, and the proxies it can route through. | Built — see below |

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

# 4. Optional: a mock host, once you have registered one and copied its token
cd backend && OSMIUM_HOST_TOKEN=osm_host_1_… ./gradlew mockHost
```

The mock host speaks the real protocol over the real socket — it connects, reports agents,
telemetry and chat, fetches segments and places blocks — so the whole pipeline can be exercised
without a Minecraft account. It is a development convenience, not a stand-in for the host program.

Sign in with `admin` / `admin`. Those are development defaults and are seeded only while the `users`
table is empty — override `OSMIUM_BOOTSTRAP_USERNAME` / `OSMIUM_BOOTSTRAP_PASSWORD`, and
`OSMIUM_JWT_SECRET`, before running this anywhere real.

## `osmium-link` — the host's command line

The interface can do almost everything, and the two things it cannot are both about custody. A host
holds its own Minecraft credentials and its own proxy passwords, and neither ever crosses to the
backend — so both are managed on the machine, by the tool that ships beside the host.

```bash
cd host && npm run link                    # or osmium-link from the image
```

Run with no arguments it **takes the screen**: the terminal's alternate buffer, a menu moved through
with the arrow keys, and a form for anything that needs more than one answer — adding a proxy is one
screen of five fields rather than five questions in a row. It comes back to the menu when a task is
done, shows a failure as a page rather than falling over, and leaves your scrollback exactly as it
found it.

| Command | What it does |
|---|---|
| `microsoft` | the device-code sign-in, and keeps the account |
| `token` | adds a Minecraft session token — the one credential nothing here can obtain |
| `list` / `remove <id>` | what this host holds, and dropping one |
| `proxy add` | a proxy agents can be routed through, by name |
| `proxy list` / `proxy remove <name>` | what it can route through, and dropping one |
| `proxy check <name>` | dials through one and says whether it worked |

Every command also takes flags, so a script needs no terminal at all — with two exceptions that are
never arguments, because an argument is in the shell history and in `ps` for every other user on the
machine: a session token, and a proxy password. Details, the proxy file format and the Git Bash
caveat are in [`host/README.md`](host/README.md).

## Permissions

Routes authorize against **permission nodes**, never against role names. Roles are named bundles of
nodes, arranged as nested tiers:

| Role | Adds |
|---|---|
| `viewer` | watch the fleet and the schematics, and see your own account |
| `orchestrator` | *viewer* + acting on hosts and agents, and uploading schematics |
| `administrator` | *orchestrator* + user management, the audit trail, and everything irreversible |

So the split is "runs the agents" versus "runs the people". Details in
[`backend/README.md`](backend/README.md).

## Tests

```bash
cd backend && ./gradlew test     # 632 tests; needs Docker for Testcontainers
cd frontend && npm test          # 545 tests
cd host && npm test              # 563 tests
```

The backend covers every route — happy paths, 401s, per-role 403s, 409s, 429s, 503s — plus real
clients over real host sockets, and unit tests on an injected clock for anything about the passage of
time. The frontend covers the route guard, the auth store, the API client middleware, the fleet
store's derived state, cursor paging, the geometry behind the charts and the box viewer, which stream
updates earn a notice, and that the English and German copy stay in step. The host covers the
protocol codec, the route search and the driver that walks it, the chat formats
against lines captured from real servers, the chat command system — including an adversarial pass on
the one input it takes from strangers — the world stream, where the columns a viewer actually puts
on the wire are checked against the ones its own spiral asked for, the proxy file and what counts as
a dialable entry in it, and the command line's own reading of a keystroke: the escape sequences a
terminal sends, and what each one does to a form.

## CI

Six workflows, all path-filtered so a change to one module does not run the others' jobs.

| Workflow | Runs on | Does |
|---|---|---|
| `backend-tests.yml` | pull request, or called | `./gradlew test`, annotates failures, uploads reports |
| `frontend-tests.yml` | pull request, or called | Vitest, ESLint and the `vue-tsc` build, all three under `if: always()` |
| `host-tests.yml` | pull request, or called | Vitest and the `tsc` build, both under `if: always()` |
| `backend-image.yml` | push to `main` | runs the tests, then publishes `ghcr.io/integr-dev/osmium/backend` |
| `frontend-image.yml` | push to `main` | runs the tests, then publishes `ghcr.io/integr-dev/osmium/frontend` |
| `host-image.yml` | push to `main` | runs the tests, then publishes `ghcr.io/integr-dev/osmium/host` |

**Nothing is published without a green suite.** Each image workflow calls the matching test workflow
as a reusable workflow and gates its publishing job on it with `needs`. The test workflows therefore
have no `push` trigger of their own — on `main` the image workflow drives them, so a push runs the
suite once rather than twice, and the suite cannot drift between the pull-request run and the
publishing run.

Image tags come from the version in `build.gradle.kts` and each module's `package.json`, plus
`sha-<short>` and `latest`. Failing tests become inline annotations and a job summary table, built
from JUnit XML by [`.github/scripts/junit-summary.mjs`](.github/scripts/junit-summary.mjs).

## Licence

See [LICENSE](LICENSE).
