# The build rig's server

A Paper server for testing the printer against real Minecraft. Two scripts live here; everything
else in this directory is downloaded or generated and is not committed.

```sh
./setup.sh          # fetch the jar, write the configuration, op the rig and you
./setup.sh --fresh  # the same, and throw the world away first
./start.sh          # run it
```

Then, from `host/`:

```sh
npm run rig -- generate     # write the torture schematic to host/rig/
npm run rig -- run          # build it here and report what came out wrong
```

## Why a real server

Everything the printer gets wrong is something the *server* decides. A schematic says
`minecraft:oak_stairs[facing=east,half=top]`; a client cannot say that, it can only stand somewhere,
look somewhere and click a face — and which stairs that produces is a hundred lines of vanilla
deriving a state from those three things, differently for every family of block.

A fake server would have to reimplement that derivation, which is exactly the thing under test: it
would agree with the printer by construction and catch nothing. So the rig talks to the real one,
and `host/src/agent/build/plan.ts` is checked against it rather than against anybody's memory of how
vanilla works.

## What `setup.sh` sets up

Pinned to **1.21.4**, because mineflayer's tested-version list is what decides it and a server that
drifts ahead of the client library fails as a protocol error somewhere unrelated to whatever is
being tested. `MC_VERSION=1.21.8 ./setup.sh` overrides it.

- **Offline mode**, so the rig connects as whatever name it likes. Nothing here should ever be
  reachable from outside this machine.
- **Superflat, creative, peaceful**, with one stone layer at `y=-60`. The rig builds above it, so
  anything standing inside the box is something the printer put there.
- **No watchdog** (`max-tick-time=-1`), so a rig being stepped through in a debugger does not get
  its server killed for taking too long over one tick.
- **A high packet ceiling** in `config/paper-global.yml`. Paper's default is 500 packets a second
  and a working printer is well past it — left alone, the first thing a correct printer does is get
  itself kicked for flooding.
- **Nothing generated and nothing moving.** No structures, lakes or features in the flat preset, and
  the rig sets thirteen gamerules on every run — no mob spawning, no fire, no weather, no random
  ticks, no raids. Every one of those writes to the same blocks the printer does without anybody
  asking, and a report is only about the printer if nothing else is editing its work.
- **Operator** for the names passed to the script, defaulting to `osmium` and `probe`. The rig uses
  `/gamemode`, `/fill` and `/tp`: it clears the box before every run, so a report is about that run
  rather than about everything ever built there.

Running `setup.sh` accepts the [Minecraft EULA](https://aka.ms/MinecraftEULA) on your behalf, which
the server refuses to start without.

## The three tools

| Command | What it answers |
|---|---|
| `npm run rig -- run` | Builds 183 specimens and reports every square that came out as something other than what the schematic asked for, grouped by family. |
| `npm run rig -- plan <state>` | What this host *would* do to place that state — which face it would click, where it would stand, what it would click afterwards. No server needed. |
| `npm run rig -- probe <item>` | What the server actually makes of one placement, from each of the six directions an agent can look. |
| `npm run rig -- verify --anchor x,y,z` | Reads a build back without building it, for a piece an agent placed through the real pipeline. The same report, pointed at a box rather than at a run. |

What the rig cannot answer is what happens when something *else* is turning the agent. It teleports,
so nothing competes for the head; a flight faces the way it is going on every tick. The same
schematic reads 183 of 183 from the rig and about 177 built through the real pipeline, every miss a
rotation. Until the look is arbitrated the way the hands are — see `agent/schedule.ts` — that gap is
the honest measure of the difference between the two.

`plan` and `probe` are the two halves of a failure: one says what was intended, the other says what
the game does, and a family failing in the rig is one of them being wrong. Every awkward entry in
`plan.ts` — whether an observer faces the agent or away from it, which way an anvil turns, which
half of a door's square hinges left — was settled by `probe` rather than by reading source.
