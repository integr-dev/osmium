# Osmium host

**TypeScript** on [mineflayer](https://github.com/PrismarineJS/mineflayer), with
[prismarine-auth](https://github.com/PrismarineJS/prismarine-auth) for Microsoft sign-in.

The host runs on a machine you control. It holds the Minecraft credentials, drives the agents, and
is the only component that ever performs a login. Everything it needs to talk to already exists on
the backend side and is covered by tests — see `HostLinkTest` and `ChatListenerServiceTest`.

This file is the **wire reference**: every message that crosses the socket, with its exact JSON.
[`../FLEET_CONNECTIVITY.md`](../FLEET_CONNECTIVITY.md) is the reasoning behind it — read that once
before starting, this one while implementing. The backend imposes no language or library; mineflayer
is a choice the host makes rather than something the backend knows about.

### Running one

```
npm install && npm run build

OSMIUM_HOST_TOKEN=osm_host_…  OSMIUM_WS_URL=wss://…/ws/host  npm start
```

`OSMIUM_ACCOUNTS` (default `/agent/accounts.json`) records which credential belongs to which agent;
`OSMIUM_TOKEN_CACHE` (default `/agent/msa`) is prismarine-auth's own token cache;
`OSMIUM_PROXIES` (default `/agent/proxies.json`) is the proxy list below. All three sit under the
same volume, so a container that keeps `/agent` keeps its accounts. `OSMIUM_LOG` takes `error`,
`warn`, `info` or `debug`.

`OSMIUM_SEARCH_COST=true` has every finished route search log, at `debug`, what it cost: how many
squares it expanded, how long it spent thinking against the wall clock, and how much of that went
into reading the world. Off by default - it is a line per search, and the accounting reads the clock
inside the search's own loop.

Accounts are normally added through the interface: "Sign in with Microsoft" when setting an agent up
puts the code in that agent's activity feed. `osmium-link` does the same from a shell, for a host
that is not enrolled yet or for a session token nothing can obtain — and it is the **only** way to
add a proxy, because the password one may need is the thing Osmium deliberately never learns.

```
osmium-link                      ask what to do
osmium-link microsoft            sign in with Microsoft and keep the account
osmium-link token                add a Minecraft session token
osmium-link list                 show what this host holds
osmium-link remove <id>          drop one credential
osmium-link proxy add            add a proxy agents can be routed through
osmium-link proxy list           show the proxies this host holds
osmium-link proxy remove <name>  drop one
osmium-link proxy check <name>   dial through it and say whether it worked
```

**Run it with no arguments and it takes the screen.** It swaps to the terminal's alternate buffer —
the way `less` does, so your scrollback is untouched and comes back on the way out — and shows one
thing at a time: a menu you move through with the arrow keys, and a **form** for anything that needs
more than one answer. Arrows move between fields, left and right change a choice, enter saves, esc
goes back; it returns to the menu when a task is done and leaves when you pick Quit.

Adding a proxy is one screen with five fields on it rather than five questions in a row, which is
the difference between checking what you typed and remembering it. A password is a field like any
other, shown as dots, sitting beside the username it belongs to.

Every command also takes flags for a script, and any gap in one becomes a form when there is a
terminal to draw on — with none, it names the flags that were left out rather than waiting on an
answer that is never coming.

> **Git Bash needs `winpty`.** mintty gives a Windows program a pipe rather than a console, so node
> reports no TTY, raw mode is unavailable and every prompt refuses — which looks like the tool
> exiting the instant it starts. Run `winpty osmium-link`, or use Windows Terminal or PowerShell,
> where it works unwrapped. The tool says so itself rather than printing the usage and leaving you
> to guess. Two values are never arguments: a
session token and a proxy password are typed without echo, or read from stdin and
`OSMIUM_PROXY_PASSWORD` respectively, because an argument is in the shell history and in `ps` for
every other user on the machine.

`proxy check` is the one thing the interface cannot do. It dials through a proxy to
`example.com:443` — or wherever `--to host:port` says — and reports what happened, which beats
pointing an agent at it and reading the activity feed to find out it was wrong.

### Tests, CI and the image

```
npm test          # 563 tests
npm run build     # tsc, which type-checks as it emits
```

The suite covers the protocol codec, the NBT decoding, the chat formats — against lines captured
from real servers rather than invented ones — and the chat command system, including an adversarial
pass over the one input this program takes from strangers. See `test/injection.test.ts`, which is
written as an audit rather than as coverage. The route search and the driver that walks it are
tested against a fake world ticked by hand (`test/search.test.ts`, `test/drive.test.ts`): what a
jump lands on, when a landing brakes, when a journey gives up and when it only gets as close as it
can.

`host-tests.yml` runs both on a pull request; `host-image.yml` runs them again on `main` and only
then publishes `ghcr.io/integr-dev/osmium/host`, tagged with the version in `package.json` plus
`sha-<short>` and `latest`. Nothing reaches the registry without a green suite — the image workflow
calls the test workflow and gates on it, which is why the test workflow has no `push` trigger of its
own.

The image runs as `node`, keeps its credentials on the `/agent` volume, and ships `osmium-link` on
the path: this program is headless, so acquiring a credential means `docker exec` into the running
container.

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

**The first frame you send is [`handshake`](#45-handshake--once-immediately-after-connecting)**,
stating what this host is running and what it can log in with. Without the first, a host that has
restarted leaves Osmium asserting sessions that no longer exist. Without the second, none of its
agents can be set up.

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
  "payload": { "label": "Mason_04", "method": "device_code" } }
```

| Field | Meaning |
|---|---|
| `label` | The operator's name for this agent. Not a Minecraft account name. |
| `method` | The login **mechanism** the operator chose, relayed uninterpreted. |

> ⚠️ **Changed — this payload no longer carries `serverAddress`.** A host must not expect it.
>
> Setting an agent up is acquiring a credential, and a Minecraft account can join any server, so
> where an agent plays is a separate decision that can change afterwards without touching the
> account. Sending it here handed the host a value that went stale the moment the agent was
> reassigned — and it was never needed, because `connect` carries the address, which is the point at
> which it matters.
>
> An agent may now also be assigned to **no server at all**. It can still be set up from there;
> it simply cannot be told to connect until one is chosen.

`method` is always one of the ids **this host advertised** in its
[`handshake`](#45-handshake--once-immediately-after-connecting). The backend has no idea what any of
them mean and stores nothing about them; it checks the string against your own list and relays it
verbatim.

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

**Send it late rather than not at all.** An operator can stop Osmium waiting on a setup — a sign-in
begun on a machine they cannot get back to has no other way out, since nothing here can time a login
out. That returns the agent to `UNLINKED` and **sends you nothing**: it is not a cancellation, and
there is no command to implement for it. Keep going, and report the result whenever it arrives. A
success reaching a backend that has given up still links the agent, because the result is applied on
its own merits rather than on the state the backend expected to find.

> ⚠️ **Changed — the backend no longer invents the list.** It used to offer four placeholders,
> `method_a`–`method_d`, to every host regardless of what that host could do. Now it offers exactly
> what you advertise, and refuses anything else with a **400** before the command is ever sent.
>
> A host that advertises nothing can set nothing up. This is not a failure mode to work around: it
> is the backend declining to guess on your behalf.

An unsupported `method` should still be a normal `ok: false`. The check above closes the common
case, not the race where your list changes between the handshake and the command.

### `connect`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "connect", "agentId": 42,
  "payload": { "serverAddress": "mc.example.com:25565" } }
```

`serverAddress` is **always present and never empty**. It is the authority on where this agent plays:
it is not sent at setup, it can change between one connect and the next, and an agent assigned to no
server is refused by the backend before any command is dispatched. A host should use the address in
this payload rather than anything it remembers.

Fire and forget: **do not send a result.** Report the outcome as an `agent_status` event instead —
`ONLINE` on success, `CONNECT_FAILED` if the server refused, `NEEDS_RELINK` if the stored credential
was rejected.

**Report it, and report it inside 90 seconds.** Dispatching this moves the agent to `CONNECTING` on
the backend — the one state it sets on its own, and the only one it is prepared to take back. It is
what tells an operator the button did something during the seconds a join takes. An agent still
`CONNECTING` after `osmium.agent.connect-window` falls back to `LINKED`, with an activity entry
saying the host never answered.

That fallback is a display correction and nothing else: no command is sent, nothing is cancelled,
and a host reporting `ONLINE` late is still believed. A join that genuinely runs longer than the
window is a reason to raise the setting, not to stay quiet.

The backend advances state only when the host reports, never when it sends — `CONNECTING` included,
which it *withdraws* rather than advances.

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

Report it as a `chat` event with scope `outbound` (§4.3) — from the **server's echo**, so it carries
the same formatting as everybody else's chat. A **command** never echoes, so report that one when it
is sent. See §4.3.

### `set_chat_listener`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "set_chat_listener", "agentId": 42,
  "payload": { "enabled": true } }
```

Fire and forget. Grants or revokes this agent's job of forwarding the server's **global** chat.

Start every agent with the role **off**. Forward `global` only while it is on. See §5.

### `settings`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "settings", "agentId": 42,
  "payload": { "values": { "chat.sender": "^\[[^\]]+\]\s+([A-Za-z0-9_]{1,16}):\s" } } }
```

Everything an operator has configured for this agent. Fire and forget.

**The whole set, not a patch.** A key that is absent has been cleared, which is the only reading
under which a setting can be turned back off. Read each one fresh rather than merging into what was
there.

**Ignore a key you do not know**, rather than refusing the message. The settings are declared by the
interface, not advertised by the host — a setting exists the moment that list and one host agree on
a name — so an Osmium newer than a host is the ordinary case, and refusing would drop the settings
the host *does* understand alongside the one it does not.

Sent when it changes, and again on every reconnect. A host holds this in memory only, so a restarted
one would otherwise run on defaults with nothing saying so.

| Key | Meaning |
|---|---|
| `chat.sender` | How this server writes the speaker into a chat line. One capture group, the player name. Unset means vanilla `<Name> `. See §4.3. |
| `chat.whisper` | How this server writes a whisper *to* this agent. One capture group, who sent it. A line that matches is scope `direct` rather than `global`, and is reported whether or not this agent is the chat listener. Unset means vanilla `Name whispers to you: `. |
| `chat.whisperCommand` | The command this server takes for a private message, as a template: `{name}` and `{message}` are filled in. Unset means `/msg {name} {message}`. See §5.1. |
| `chat.whisperSent` | The other direction: a whisper this agent sent, as the server echoes it back. One capture group, the recipient. A line that matches is scope `outbound`. Unset means vanilla `You whisper to Name: `. |
| `mc.version` | The version to speak, skipping the status ping entirely. Unset means ask the server, which is right almost always — set it for one that refuses a version check or answers dishonestly. A version this build has no protocol for is refused and the ping happens anyway. Read when a session opens. |
| `mc.takeKnockback` | `false` to ignore knockback entirely — the agent is not pushed by hits, explosions or anything else. Unset means take it, like a player. With it off `mc.knockback` does not apply, since nothing is applied either way. Read per packet, so it takes effect at once rather than on the next connect. |
| `mc.knockback` | `true`, `false`, or unset. Whether to undo the client library's velocity scaling. Unset decides it from the version; three states rather than two because a proxy can forward a version it does not advertise, and the packet's shape follows what is on the wire rather than what the handshake claimed. Read when a session opens. |
| `players.whitelist` | Who may command this agent from inside the game, comma-separated. `name` for chat, `name:commands` for chat and server commands, `name:run+say` for exactly those. **Empty means nobody.** See §5.1. |
| `util.autoEat` | `on` to eat before hunger stops health regenerating — under 18 food, or under 14 health, since being fed is what buys the regeneration. A golden apple only under 8 health, because it is worth more than the hunger it fills. The agent clears its control states for the meal and puts back both the states and the hotbar slot it had. Read per pass, so it takes effect at once. `dupe` additionally tops the food back up with the server's own `/dupe` when it runs low. |
| `util.autoTotem` | `on` to keep a totem of undying in the off hand whenever there is a spare one to move there. `dupe` tops the supply back up the same way, at half the target — so it holds between four and eight while nothing is happening. The target **follows the fight**: every three pops inside twenty seconds doubles it, to a ceiling of thirty-two, and it falls back on its own once the window empties. Refilled **on the event that emptied the hand** — the server's entity status for a totem being used, and the window update that follows it — rather than on the sweep, because half a second between a pop and a refill is a death. The sweep is the net behind both. |
| `util.antiHunger` | `careful`, `spoof`, or unset for off. Exhaustion is charged by distance at a rate that depends on whether the server believes the agent is sprinting. `careful` gives up the sprint. `spoof` keeps the speed and drops the packet that declares it. Read per packet and per tick. |
| `util.noFall` | `true` to report standing on the ground on every movement packet that says otherwise, which resets the fall distance the server accumulates. Read per packet. |
| `util.fleeDistance` | Blocks. A player who is not on `players.whitelist` coming this close makes the agent raise a `system`/`error` activity entry, send `stand_down`, and leave. Blank or anything that is not a positive number is off. The agent's own account is not a stranger to it; **every other agent in the fleet is**, so agents sharing a server go on each other's lists. |
| `path.range` | How far from the agent a route may be searched for, in blocks. A search cannot see past the chunks the server has sent — a dozen wide at most — so a larger number does not find longer routes, it spends the search on ground the host has not got. Unset means 128. |
| `path.dig` | `true` to break blocks to get through rather than going round. Off by default, and deliberately: an unattended agent that tunnels through somebody's wall to save nine blocks has done something the operator cannot undo and did not ask for. |
| `path.bridge` | `true` to place blocks from its own inventory to cross a gap or pillar up. Only what it is carrying, so an empty inventory is the same as off. |
| `path.parkour` | `true` to take running jumps across gaps instead of walking round. Quicker and less reliable; a missed jump near lava is the end of the session. |
| `path.maxDrop` | The furthest the agent will step off, in blocks. Four is where fall damage starts, so the default of three is the drop that costs nothing. |
| `path.mode` | `fly` to fly rather than walk, wherever flying is possible. Unset walks. A flying agent flies straight where the hull clears the line, up over and down onto a destination close by where it does not, and searches through the air only where neither works; a long flight climbs twelve blocks clear of the ground under the stretch ahead, higher over whatever is in the way - up to the build limit - before turning round it or searching, and stays at that height until it glides down onto the destination. Every change of height is flown along the way, at about a block up or down for every three along, and steeper only where something is in the way - never straight up or down where a slope is clear. Flying is possible where the server grants it - the `abilities` packet's may-fly flag, which creative sets - or where `path.forceFly` says to fly anyway; anywhere else the agent walks and raises a `system`/`warning` activity entry saying why, and a flight the air has no way through is walked from where it stopped. The walking settings above do not apply to a flight. Read when a waypoint is sought. |
| `path.flyCommand` | A command that asks the server for flight, such as `/fly`, run as chat. Only in `fly` mode, only when flight is not already granted - most such commands toggle, and running one on an agent that may fly would take the leave away - and once per journey. The agent waits up to three seconds for an `abilities` packet granting flight; if none comes, `path.forceFly` decides whether it flies anyway or walks. |
| `path.flySpeed` | What flying and climbing speed is multiplied by, from `0.1` to `10`. Unset, or anything that is not a positive number, is `1`: the server's own fly speed from its `abilities` packet. Read when a waypoint is sought. |
| `path.forceFly` | `true` to fly where the server has not granted flight, after `path.flyCommand` has been tried. The agent comes down 0.04 blocks every forty ticks, which is what stops vanilla kicking a player for floating, and claims to be on the ground on every movement packet, through the same rewrite as `util.noFall`. Anti-cheat plugins see through both. Only read in `fly` mode. |
| `path.haste` | `0` to `100`: how far the search may trade a shorter route for finding one sooner. `0` is the most direct route the rules allow, however long it takes to work out; `100` commits soonest and the route can wander. Matters most on long bridges and towers, where the search is slowest. Unset, or anything that is not a number, means `50`, which is how agents always planned. Read when a waypoint is sought. |
| `connect.proxy` | The name of one of this host's proxies — see **Proxies** below. Blank connects from this machine's own address. A name this host does not hold is **not** a fallback to a direct connection: the attempt is refused, an activity entry says why, and the agent reports `failed_connection`. |
| `connect.rejoin` | `true` to put this agent back into the game by itself after a drop. **Not yours to act on** — it is listed here only because it arrives with the rest and you will see it. Reconnecting is a decision about where an agent belongs, and a host never makes one of those; the backend owns this key and sends an ordinary `connect` when it decides. Ignore it exactly as you would ignore a key you did not recognise. |

**Count the off hand.** mineflayer's `items()` covers slots 9 to 44 and stops there, so a totem in
the off hand is invisible to it — which is exactly where auto-totem has just put one. Counting stock
that way reports one fewer than the agent has, and on the **last** totem reports none, so the
restock that exists to prevent running out finds nothing to multiply and quietly does nothing.
Armour and the crafting grid stay out of the count: a chestplate is not stock, and half a recipe is
not either.

**One pass at a time.** Eating takes longer than the interval between passes, so the timer would
otherwise start a second pass inside the first — and that one skips the restock, because the first
is still holding the flag that says the hand is busy. An agent that kept getting hurt therefore
never got round to topping anything up: the module keeping it alive starved the one keeping it
stocked.

**Watch the movement packet's shape when touching NoFall.** Up to 1.21.2 it carried
`onGround: bool`; from 1.21.4 it carries `flags`, a `MovementFlags` bitfield whose first bit is
`onGround`. Code that looks only for the boolean finds nothing to change on any current server and
passes every packet through honest — and it fails silently, because there is nothing to throw.

**Set every field, not the first one that matches.** mineflayer fills in both from one shared object,
unconditionally:

```js
lastSent.onGround = onGround
lastSent.flags = { onGround, hasHorizontalCollision: undefined } // 1.21.3+
```

So the legacy boolean is always present whether or not this version writes it out. Stopping at the
first match set the field the protocol ignores and left the one it reads untouched — the lie went
into a field nobody opens, which looks identical to the module working. Test it with the object
`physics.js` actually sends; separate cases for each field is how this got through twice.

It claims ground on **every** airborne packet, which is what Meteor's packet mode does. There was a
velocity threshold here on the theory that only a real fall is worth lying about; both halves were
wrong. The server only resets the distance when it is told, so a late lie has already let the damage
accumulate — and the threshold meant the module did nothing on a jump, which is where most fall
damage comes from in a fight.

**Top up at half the target, because multiplication leaves no other choice.** There is no separate
"low" mark: at twelve of sixteen the multiplier rounds to one and the command is a no-op, so the only
counts worth acting on are the ones at or under half. Half the target is therefore both the low mark
and the earliest point at which topping up is possible, which is what makes it early rather than
late — stock swings between the target and half of it and never falls below half.

**The multiplier applies to the stack in hand, not to everything the agent owns.** A totem does not
stack, so the hand holds one and `/dupe 2` adds exactly **one** totem. Working the multiplier out of
the total — four totems, target eight, so double it — asked for `/dupe 2` and gained one, over and
over, while the fight spent one each time. Break-even, with the command apparently working: the live
log read `Duped item 2 times` eleven times in a row before the agent died. It is the shortfall
divided by what one copy carries, plus the one already in hand: four short with one in hand is
`/dupe 5`.

**The low-water mark is its own rule.** It used to be implied by the multiplier, which could only
act at or under half the target — so correcting the multiplier took the mark with it and would have
meant a command per pop. Written down instead: top up when half of what is wanted is gone, and top
up all the way.

**Never await mineflayer's inventory without a deadline.** `clickWindow` ends in
`waitForWindowUpdate`, which waits for the server to echo the slot and has no timeout of its own —
so a click the server treats as a no-op leaves a promise that never settles. A module that guards
itself with "an operation is in flight" is then in flight forever. That is not theoretical: staging
a totem onto the hotbar hung, the flag stayed set, and the agent stopped refilling its off hand
entirely — dying on the next pop with a backpack full of totems. Every window call here now has two
seconds, after which it is abandoned and the next pass tries again.

**Refill the off hand with `equip`, and resist improving on it.** `bot.equip(item, 'off-hand')`
moves the item with two window clicks and holds it on the cursor in between, so there is a real
window in which the agent has a totem in neither hand. Two attempts to close that window both made
things worse and are recorded here so the third one is thought about harder:

- **Staging a spare on the hotbar** so it could be moved with the F-key swap. The staging click hung
  on a server that did not echo the slot, the in-flight flag never cleared, and the module stopped
  refilling entirely.
- **The swap itself**, `block_dig` status 6. A packet the server ignores raises nothing, so the code
  took it as done and never fell back to `equip`. Both modes stopped refilling, including the one
  that does no duping at all.

The cursor window is smaller than the window left by not equipping. Anything replacing `equip` has to
**verify the off hand afterwards** rather than assume a sent packet worked.

**Check the hand, do not assume it.** The plugin copies the main hand whenever there is anything in
it and only falls back to the off hand when there is not — so an empty main hand is the entire
precondition for duping a totem, and selecting an empty square is not the same as still holding
nothing when the command arrives. Auto-eat put a golden apple in the selected slot between the two,
and `/dupe` copied the apple with the multiplier worked out for totems: `Duped item 31 times`, a
stack of apples, and an agent that still had two totems and died. Getting this wrong does not fail
loudly; it copies the wrong item.

Selecting the square, checking both hands and sending the command are therefore one uninterrupted
section under the same lock as eating — and eating puts the hotbar back **inside** its own lock,
because releasing first is what left the apple sitting in the selected slot.

**A golden apple is medicine, not stock.** Auto-eat already draws that line — a gapple is spent on
being badly hurt, never on being hungry — and the restocking has to draw it in the same place.
Counting every food alike sent the dupe after the valuables, because a gapple stacks to sixty-four
where steak rarely does, and the biggest pile is what gets copied. Eating one is still allowed; this
is only about what is counted and what is copied.

**One window operation at a time, because there is one cursor.** `window.selectedItem` holds
whatever a click picked up, and every inventory move in mineflayer is pick-up-then-put-down against
it. Two at once — a totem going into the off hand while a golden apple is moved into the main hand —
interleave their clicks and leave items where neither meant. With food in the inventory that is not
a rare race: eating takes over a second, pops arrive whenever they arrive, and the refill runs off
the pop rather than off the sweep, so the two overlap by default.

A refill that cannot have the window is **remembered and run the moment it is free**, never dropped.
Everything under the lock is bounded, because a lock that a hung click never releases would stop the
agent eating, refilling and restocking for the rest of the session — a worse failure than the
interleaving it prevents.

**The refill is the oldest code in this module and the least touched, deliberately.** Restocking was
built on top of it rather than through it: the dupe reads the inventory and sends a chat command, and
the only thing it asks of the refill is to have run first. Every attempt to make the refill itself
cleverer — retry loops, staging, the swap — has cost an agent its life in testing and been reverted.

The order in a pass is refill, then eat, then restock, and the refill also runs on its own from the
pop event rather than waiting for a pass. Nothing in the restocking path moves a totem.

**Staying alive outranks the rest of the module.** Eating takes the main hand for a second and a
half, duping needs it empty, and both are worth nothing to an agent that dies in the middle of them.
A pass that ends with no totem in the off hand and a spare available does nothing else: something is
in flight, and the next pass is half a second away.

**Never take a totem out of the off hand.** The held item is what pops first, so a totem moved into
the main hand to be copied is the very one the next hit spends — the command then arrives at a
player holding nothing, and the off hand it was taken from is empty too. That is a lost fight, not
just a lost command. If the hotbar has no empty square to select, the dupe is skipped rather than
made room for.

**A full hotbar is the normal case, not the edge case.** That path found no empty square and returned
without duping, so the totem restock had never once run under the conditions it exists for — an agent
in a fight has nine full squares. There is now a second way: hold a spare totem from the backpack and
copy that. It costs a click and it displaces one hotbar item into the backpack, which is why the
empty-square path is still preferred whenever there is one.

Holding a **spare** is safe in a way that holding the off-hand totem is not. The held item pops
first, so what a hit spends is the copy that was about to be made, while the off hand goes on
guarding the agent. The spare is found by walking the squares up to the hotbar rather than by reading
`item.slot` — if that field were ever missing, a name comparison would happily return the off-hand
totem, the one thing this must never take.

**Let the fight set the target.** Eight totems is right for standing around and demonstrably wrong
under end crystals — a test spent eleven in under a minute and died at the target it had been given.
Every three pops inside twenty seconds doubles what the agent aims for, capped at thirty-two, which
is also a promise about how much of the backpack this may take since a totem does not stack.

Ramping sends **fewer** commands, not more, which is the part worth understanding: a bigger target
means each dupe brings back far more, so it asks less often. Simulated over a minute of a totem every
400ms — 45 commands at a fixed eight, 11 while ramping, and the ramping run held a higher floor.

**Copy the last of the biggest pile, not the first.** The off hand is refilled from the first totem
in the backpack, so duping that one aims the command and the refill at the same square — and in a
fight fast enough to need the dupe, the totem is gone from under the command before it lands. The
last one is the one nothing else is about to take. Biggest still wins, because one command should
move as much as it can; last only breaks the tie, which for totems is every time.

**Dupe the off hand where it stands.** The plugin copies the main hand, and the off hand when the
main hand is empty — so what is already in the off hand is duped by *selecting an empty hotbar
square*, not by picking the item up. Equipping it first is both unnecessary and wrong: the
inventory click has to reach the server before the command does, and it does not. The two arrive
together, the server sees a player holding nothing in either hand, and answers **"You must be
holding an item in your hand"** — which is what an agent looks like when it dies beside a totem it
never copied.

Selecting a square is one packet and moves nothing, which is what makes it safe mid-fight when
shuffling items is not. It also leaves the totem doing its job while it is being copied.

**Confirm something is actually in a hand before spending the command.** `equip` resolves when this
side is satisfied; what `/dupe` needs is the server to agree.

**One question at a time, rather than a cooldown between dupes.** Waiting between dupes is what made
this useless, so there is no gap: the guard is that a `/dupe` already sent is given three quarters of
a second to be answered before another goes out. Under end crystals the count keeps falling while the
last command is still in flight, and "still only four" is not evidence it was missed — without this
the module asks three or four times over for one lot of totems.

Do not reach for "has the count gone up" as the test for whether it landed. A dupe sent at four can
land while the agent is down to two, and four is not more than four; the obvious version of this
guard deadlocks exactly during the fight it exists for.

Measured against a totem every 400ms it sends about one command every 1.3 seconds and holds the stock
at three rather than letting it reach zero. Against a quiet fight it sends three in five minutes.
**A server that stops honouring `/dupe` will be asked at that rate for as long as the stock is low**,
which is the accepted cost of having no cooldown.

**`dupe` mode is the server's own plugin, not a protocol trick.** It equips the biggest pile of
what is short and sends `/dupe <multiplier>` in chat, where the multiplier is the largest one that
does not overshoot the target — the plugin multiplies the held stack, so eleven totems become
twenty-two rather than sixteen unless the count happens to divide the target. It is rate limited to
**not** raised as activity: a command the agent runs for itself
every few minutes would be a feed with nothing else in it, and the debug log is where somebody
looking for it will look. On a server without such a plugin the command is a line of chat that does
nothing, so the mode is opt-in per agent.

**Two of the utility modules lie to the server and two do not**, and that is the line to hold when
adding another. Auto-eat and auto-totem do what a player does, only without being asked; nothing
about them is untrue. `util.noFall` and `util.antiHunger: spoof` report something that is not so —
they work, and they are exactly the shape an anticheat plugin looks for. `spoof` in particular keeps
sprinting speed while denying the sprint, which the server can measure for itself. Both are off
unless somebody turns them on, and both say as much in the interface. A ban is the one consequence
in this project that cannot be undone.

**All four read their setting per pass rather than capturing it.** These are toggles an operator
flips while watching an agent, so a module that needed a reconnect to notice would look broken at
exactly the moment it was being tried — the same reason `mc.takeKnockback` is read per packet.

### `inventory_move`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "inventory_move", "agentId": 42,
  "payload": { "from": 36, "to": 9 } }
```

Fire and forget. Move what is in one square of the agent's own inventory onto another, as two
clicks would.

Slot numbers are **Minecraft's own**, in the player window: 5–8 armour, 9–35 the backpack, 36–44 the
hotbar, 45 the off hand. Refuse anything outside that range — the crafting grid holds items only
while a recipe is half-assembled, and its output square is not a container at all.

Report nothing. Where the item ended up goes out on the next `inventory` event (§4.7), which is the
same event that reports the agent moving something itself — so a move the server refused reads as
the item not having moved, which is what happened.

### `inventory_drop`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "inventory_drop", "agentId": 42,
  "payload": { "slot": 36, "count": 16 } }
```

Fire and forget. Throw a square's contents on the ground. An **absent `count` means the whole
stack**, which is the ordinary case. Same slot range as `inventory_move`.

**Refuse all three while the agent is holding a segment.** What a builder is carrying is the build:
it places out of a square, and moving a stack out of that square leaves it putting the wrong block
somewhere. The backend refuses them too, so this is the second of two — which is the point, because
the chat commands below have no first. Refuse silently; there is no result channel on these.

**Use the game's own drop click — mode 4 on the named slot.** Button 1 throws the stack, button 0
throws one, and neither picks anything up. There is no "drop N" click in the protocol, so a partial
drop is that many button-0 clicks.

mineflayer's `bot.toss` is the trap here, and it is the wrong shape twice over: it searches by *item
type* across the whole inventory range, so dropping one from a hotbar square can take it off a
different stack of the same thing — and it works by lifting the stack onto the cursor and putting
the remainder back through `putSelectedItemRange`, which returns it to the first slot it fits in
rather than the one it came from. Dropping one item from the hotbar moved the other sixty-three
into the backpack.

### `inventory_hold`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "inventory_hold", "agentId": 42,
  "payload": { "slot": 40 } }
```

Fire and forget. Put a hotbar square in the agent's hand — refuse anything outside 36–44.

The **square**, not the 0-to-8 index the game keeps. Every command here names a square the same way,
and the one index in this protocol is `held` on the `inventory` event (§4.7), which is a field the
game itself defines as one. Translate at the edge; do not let either numbering leak into the other.

Report nothing. The new hand goes out as `held` on the next `inventory` event.

### `path_to`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "path_to", "agentId": 42,
  "payload": { "waypoints": [ { "x": 128, "y": 64, "z": -340 } ] } }
```

Fire and forget. Walk to the last waypoint, by way of the ones before it.

**A list, not a point.** The interface sends one entry; a route worked out from the map tiles the
fleet has already charted sends the shape of a journey no host's loaded chunks can see all of at
once. Walk them in order and report arrival only at the last.

**`y` is optional, and leaving it out means something.** A destination picked off a part of the map
nobody has charted has no height to give, and the agent should reach that *column* at whatever height
the ground turns out to be. Do not default it to zero; that is the bottom of the world.

Refuse it for an agent that is not in a world — a route is about the world it is standing in, and one
held for a session that has not started would be walked in whichever world it eventually joins. It is
also refused while the agent is holding a build segment: walking a builder away leaves it placing the
next block wherever it ended up.

What came of it arrives as `path` events (§4.8), because how it gets there is yours to decide.

### `path_stop`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "path_stop", "agentId": 42, "payload": {} }
```

Stop where you are. Not an error for an agent going nowhere — it says stop, which having stopped
already satisfies — and never refused, including while building. The one command that undoes a
journey must not be the one that is unavailable when it is most wanted.

### `delete_agent`

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "delete_agent", "agentId": 42, "payload": {} }
```

This agent no longer exists. Leave the game if it is in one, stop it, and release whatever is held
for it.

**Why this is a command at all.** A host that binds credentials to agents — so that a restart can
rebuild them rather than leaving them unreachable — has no other way to learn that one is gone.
[`handshake`](#45-handshake--once-immediately-after-connecting) reports what a host *runs*; nothing
travels the other way to say what the backend has since deleted. Without this the binding outlives
the agent and the account stays held for something nobody can use.

Fire and forget. **Best effort on the backend's side too**: it is sent before the row is removed, and
a host that is unreachable at that moment simply keeps the stale binding — deleting an agent is not
refused because a machine is switched off. A host that cares can prune bindings it still holds for
agents that are never set up again.

**Not an error for an agent you have never heard of.** It asks you to hold nothing for it, which
holding nothing already satisfies.

**Keep the account.** The agent going away says nothing about whether the operator still wants to
play that Minecraft account — release the binding, return the credential to your pool. The one
exception worth making is a generated offline identity, which belonged to that agent and nothing
else.

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

Carries two things with very different lifetimes, and **either half may be sent alone**.

```jsonc
// both halves: a state change that also reports vitals
{ "kind": "event", "type": "agent_status", "agentId": 42,
  "payload": { "state": "ONLINE",
               "health": 18, "food": 17, "pingMs": 42, "dimension": "overworld",
               "position": { "x": 128.5, "y": 71.0, "z": -344.25 },
               "nearby": [ { "name": "Notch", "distance": 12.4,
                             "position": { "x": 140.0, "y": 71.0, "z": -338.0 },
                             "uuid": "…", "ping": 84, "gamemode": 0,
                             "health": 18.5 } ] } }

// state only, when nothing else is worth reporting
{ "kind": "event", "type": "agent_status", "agentId": 42, "payload": { "state": "CONNECT_FAILED" } }

// vitals only — the ordinary case while an agent is just playing
{ "kind": "event", "type": "agent_status", "agentId": 42,
  "payload": { "health": 20, "food": 19, "pingMs": 38,
               "position": { "x": 130.0, "y": 71.0, "z": -344.0 } } }
```

**The state** is a rare, durable fact. Report it whenever it changes; repeating it unchanged is
harmless and ignored.

**The vitals** are a continuous sample, held in memory and never stored. Send them roughly **every
5 seconds** while an agent is `ONLINE`. There is no need to send them at all otherwise — an agent
that is not in game has no vitals, and Osmium shows that as "not reporting" rather than as zeroes.

| Field | Required | Notes |
|---|---|---|
| `state` | no | omit when nothing changed |
| `health` | **with the other three** | out of 20 |
| `food` | **with the other three** | out of 20 |
| `pingMs` | **with the other three** | round trip to the Minecraft server |
| `position` | **with the other three** | `{x, y, z}`, doubles — all three coordinates |
| `dimension` | no | defaults to `overworld` |
| `nearby` | no | `[{ "name", "distance", "position", "uuid", "ping", "gamemode", "health" }]` — everything but the first two optional |

**`health`, `food`, `pingMs` and `position` are all-or-nothing.** Send all four or none of them.
A tick carrying only some is **dropped whole** and logged, rather than having the rest filled in with
defaults — a missing `food` defaulting to 0 would render as a starving agent and raise an alert about
one that is fine, and a missing `position` would place it at the world origin. Osmium would rather
show nothing than something it made up. Sending none of the four is not an error; that is simply a
state report.

**A nearby player's `position` is optional**, unlike the agent's own. Send `{x, y, z}` when you have
it and omit the whole object when you do not — never a partial one, which would be a point nobody was
ever at. Omitting it costs only the coordinates; the player is still listed, and that somebody is
there at all is the fact that matters most. Send it whenever you can: it is what lets an operator
tell a player walking past from one standing on the build.

**"Nearby" means everyone the client can see**, not a radius. The tab list is everyone on the
server, including whoever is in another world; what narrows it is whether the client is tracking
that player's *entity*, which is exactly the render distance the server granted. Measuring a radius
on top of that only hides people the agent can genuinely see — and the one worth reporting is
whoever just walked into view, not whoever is standing closest. Sort by distance and cap the list if
you must; the cap is a ceiling for a spawn lobby, not a range.

**Do not send `isAgent` on nearby players.** Osmium decides that, because a host sees only its own
agents and a server's fleet can span several hosts — no host can tell one of ours from a stranger.

**A nearby player's `health` is readable, and this document used to say it was not.** The claim was
that a client is only sent its own. It is not: health is a synced field on every living entity,
which is how a health-tag mod works with no server plugin behind it. What is true is that mineflayer
lifts it out only for the bot itself, so it has to be read from the entity's metadata.

Read the index **by name**, out of `minecraft-data`'s `entitiesByName.player.metadataKeys`, never
written down. It is 9 on every version checked, and hardcoding that is precisely how you get a
number that is wrong without ever looking wrong — some other field will move into slot nine
eventually and be reported as hit points.

Send it as a **fraction on the game's own scale**, where 20 is full. Half a heart is a real state
and the difference between one hit from dead and two. Do not clamp it: a player under a health boost
genuinely has more than 20, and capping it reports somebody as easier to kill than they are. Omit
it, like `ping` and `gamemode`, when the server has not said — which covers a server that strips it
and the moment between somebody coming into view and their first metadata packet.

**Vitals go stale after 30 seconds**, matching the heartbeat grace. Stop reporting and Osmium shows
the agent as not reporting rather than holding the last numbers on screen as though they were
current. Nothing needs to be sent to clear them.

| State | Meaning | Reported by |
|---|---|---|
| `UNLINKED` | no credentials cached for this agent | host |
| `SETUP_PENDING` | login in progress | **backend only** — do not report it |
| `LINKED` | credentials held, not in game | host |
| `CONNECTING` | `connect` sent, no verdict yet | **backend only** — do not report it |
| `ONLINE` | in game | host |
| `NEEDS_RELINK` | stored credentials rejected; cannot self-heal | host |
| `CONNECT_FAILED` | server refused — whitelist, ban, version | host |
| `STALE` | host unreachable | **derived, never reported** — a `STALE` report is discarded |

`STALE` is derived from the heartbeat, because a host that can talk to the backend is by definition
not stale.

> **Blocks placed do not belong here.** Progress against a segment is its own event —
> `build_progress`, §7.5 — keyed by the segment rather than the agent. Sending a block count in
> `agent_status` does nothing.
>
> Extra payload keys are accepted and ignored, so sending them is harmless but has no effect.

### 4.3 `chat`

```jsonc
{ "kind": "event", "type": "chat", "agentId": 42,
  "payload": { "scope": "global", "from": "Notch", "text": "[VIP] Notch: huge",
               "components": { "text": "", "extra": [
                 { "text": "[VIP] ", "color": "gold", "bold": true },
                 { "text": "Notch", "color": "#55ff55" },
                 { "text": ": huge" } ] } } }
```

| Field | Required | Notes |
|---|---|---|
| `scope` | yes | `outbound`, `direct`, `global` |
| `from` | no | who said it, or `server` when the host cannot tell |
| `text` | yes | truncated at 512 characters; blank is dropped |
| `components` | no | the same line as a chat component; dropped whole past 8192 characters |

**`from` is the speaker, never the observer.** Take it from the packet where the packet says so:
`player_chat` carries the speaker's **uuid**, which cannot be spoofed by someone typing `<Notch>` and
cannot be defeated by a chat formatter. Resolve it against the player list.

Most servers will not give you that. A plugin that reformats chat has to cancel the player message
and send a **system message** instead, so the uuid is gone because the formatter discarded it — the
packet is then telling the truth, and there is nothing to recover. Fall back to reading the name out
of the line: vanilla's `<Name> ` is the sensible default, and a server with its own format needs its
own pattern.

When neither works, attribute the line to **`server`**. Honest for a join notice or command output,
and the one thing a host must not do instead is name the agent that happened to be listening. Every
agent on a server sees the same room, so attributing the room to whoever overheard it turns the
server's small talk into that agent's conversation.

**An agent's own chat is reported from the server's echo**, like anybody else's — scope `outbound`,
with the components the server rendered, so it reads with the same rank and colours as the rest of
the room instead of standing out as the only plain line in it.

Recognise it **the same way you recognise everybody else**: the uuid, or the name the pattern reads
out, compared against the agent's own. Do not look for the text that was sent inside the line. That
works until an agent says something short — `gg` is inside half of what anybody types — and then the
room's chat starts arriving as that agent's own words. A host that cannot attribute its own message
should report it as unattributed, which is the truth, rather than claim a line because it contains
the right letters.

**Commands are the exception**, and are reported when they are sent. A `/tp` produces no chat line,
so there is never an echo to wait for.

**`text` is the line; `components` is how it looked.** The plain form is always sent and is what
everything falls back to — a host that sends no tree loses colour and nothing else. Anything an agent
said itself has no tree at all, because there was never a component to begin with.

A `components` tree must be **resolved and inert** before it is sent:

- **No `translate` nodes.** Resolve them against the language file for the version the agent
  negotiated. Only the host knows that version and has that file, and a key shipped onward would put
  a 470KB table in every browser to say "Notch joined the game".
- **No `clickEvent`, `hoverEvent`, `insertion` or `font`.** This is text written by whoever runs a
  Minecraft server, shown in an operator's console. Nothing there should be one click from a URL that
  server chose.
- **`color` is a vanilla name or `#rrggbb`, and nothing else.** It ends up in a style attribute.
- Bound the tree — nodes, depth and total text. A chat line is written by a stranger.

The backend stores the tree without parsing it and never interprets it, exactly as it treats the
envelope's payload.

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

**Say what happened, not what category it was in.** `text` is the whole message — nothing downstream
adds to it, and an operator reading the feed at midnight has only this line to go on. "Died" and
"Connected" are categories; a line that answers *where, as what, for how long, and why* is a report:

```
Joined play.example.com:41945 as Mason_04 on 26.1, at 128, 71, -344 in the overworld
Joined play.dupeanarchy.com as intemeow on 26.1, at 250, 320, 249 in pvp arena
Died at 214, 12, -87 in the nether: Mason_04 was slain by Zombified Piglin
Kicked after 4 hours: You have been idle for too long
Dropped from play.example.com:41945 after 2 minutes: socketClosed
Could not join play.example.com:25565 speaking 26.1: getaddrinfo ENOTFOUND
```

**Name the world the agent is in, not the dimension type it is built on.** These two lines are the
same code: the first is a vanilla server, the second one with custom worlds. The type is the obvious
thing to reach for and it is a trap — a server like the second runs nearly everything as type
`overworld`, so every line says "in the overworld" and says nothing, while the agent's own page reads
the level name and says "Pvp Arena". One of them has to give, and it is the one that is true and
useless. "the" belongs to the three the game ships; a server's own world is a name.

Two more things worth copying. **Resolve the server's components against the version's language file**
before putting them in here — a kick arrives as `multiplayer.disconnect.idling` and a death as
`death.attack.mob`, and a feed full of translation keys is a feed nobody reads. And **name the
version on a failed join**: it may have been guessed (§3 `connect`), and this line is the only place
the guess is ever visible.

---

### 4.5 `stand_down` — the agent decided to leave

```jsonc
{ "kind": "event", "type": "stand_down", "agentId": 42,
  "payload": { "reason": "Notch came within 14 blocks" } }
```

**The only report that changes what the backend wants rather than what it believes.** Everywhere else
the rule is absolute — a host reports, the backend decides where an agent belongs — and this bends it
for the one case the rule cannot serve: the agent is the only thing that can see who is standing next
to it, and the rejoin sweep would read the absence as a drop and dial straight back into whoever it
just left.

So this is the host saying *the absence is the point*. The backend answers by clearing the wish to be
in the game; the agent stays out until an operator reconnects it deliberately. Send the ordinary
`agent_status` for leaving as well — this says why it will not be coming back on its own, not that it
has gone.

Raise an **activity** entry beside it. `reason` here is for the log; what an operator reads is the
incident, and an agent that left on its own at three in the morning belongs on the dashboard rather
than scrolled past in a feed.

### 4.6 `handshake` — once, immediately after connecting

```jsonc
{ "kind": "event", "type": "handshake",
  "payload": {
    "agents": [ { "agentId": 42, "state": "ONLINE" } ],
    "loginMethods": [ { "id": "device_code", "label": "Device code",
                        "description": "Approve a code on this machine." } ] } }
```

Host-scoped, so **no `agentId`** on the envelope; everything is inside the payload.

> ⚠️ **Renamed from `agents`.** There is no alias — the old name is not handled. It was accurate
> while the agent list was all this carried, and is not now.

Both keys are **optional and independent**, so you can implement one half first.

#### `agents` — what you are running

This is the only message that says what *exists*. `agent_status` reports transitions, and agent
state is **stored** on the backend, so it outlives the connection that reported it. A host that
reported four agents `ONLINE` and then restarted leaves an Osmium showing four agents in game,
indefinitely, with no telemetry behind them — reachability does not save it, because the host is
back, so `STALE` stops applying and the stale `ONLINE` resurfaces intact.

What the backend does with it, for every agent it owns on this host:

| Believed state | Announced | Not announced |
|---|---|---|
| `ONLINE` | applied as reported | → `LINKED` — credentials survived the restart, the session did not |
| `SETUP_PENDING` | applied as reported | → `UNLINKED` — the command went with the process that was going to answer it |
| `CONNECTING` | applied as reported | → `LINKED` — same reason, and the credentials are still on disk |
| anything else | applied as reported | left alone — none of them claim a live session |

An unannounced agent also loses the listener role, so the next election sees a vacancy rather than a
listener that is gone.

**Send it on every connect, not only after a restart.** A host that kept its sessions across a
dropped socket announces them and nothing changes, which is what makes it safe to send always —
and a host cannot reliably tell the two cases apart anyway.

**An empty list is a real announcement**: `"agents": []` means "I am running none of them", which is
exactly what a freshly started host should say. Omitting the key is treated as saying nothing at all,
so a host that has not implemented this half keeps working — it simply keeps the old failure mode.

#### `loginMethods` — what you can log in with

The mechanisms **this machine can actually perform**. The operator picks one and it comes back to you
as `setup_agent`s `method`.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Opaque to the backend, relayed verbatim. This is what you get back. |
| `label` | no | Short name for the chooser. The `id` is shown when this is absent. |
| `description` | no | One line on what the operator is about to be asked to do. |

The copy is yours because the mechanism is yours: you are the only party that knows what your methods
are, so you are the only one that can describe them. The backend does not translate it and has no
list of its own to fall back on.

**The same rule as `method` binds this: a mechanism, never an account.** `"Device code"` is a
mechanism. `"Sign in as build-bot-4@example.com"` is an identity, and putting one here hands the
backend the very thing this design keeps out of it.

**Not stored.** The backend holds the list with your connection and drops it when the socket closes,
the same way it treats reachability. Re-send it on every connect; there is nothing to update or
revoke.

**Advertise nothing and you can set nothing up.** The operator is told that this host has not said
what it can log in with, rather than being offered a chooser that cannot work.

#### `proxies` — what you can route a session through

The proxies this machine holds, so an operator can pick one per agent. The chosen name comes back as
the `connect.proxy` setting.

```jsonc
"proxies": [ { "name": "resi-eu-1", "kind": "socks5",
               "host": "10.0.0.9", "port": 1080, "authenticated": true } ]
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | What `connect.proxy` holds. Unique on this host; a duplicate is dropped. |
| `kind` | no | `socks5` (assumed), `socks4`, `http` or `https`. Opaque to the backend. |
| `host` | yes | Where the proxy is. |
| `port` | yes | Any port. Nothing assumes 1080. |
| `authenticated` | no | Whether it wants a credential. **Never what the credential is.** |

**The address is not a secret; the credential is.** A username and password stay in the file on this
machine and are never sent — the interface says a proxy authenticates and stops there. That is the
same bargain as the accounts: Osmium learns what this host *can do*, never what it holds.

**Not stored**, exactly like `loginMethods`: the backend holds the list with your connection and
drops it when the socket closes. Re-send it on every connect.

---

---

## 4.5 Streaming an agent's world

A host that implements this can be watched live. It is optional: a host that ignores `set_viewer`
and never sends a binary frame is fully compliant, and its agents simply cannot be watched.

### `set_viewer`

```jsonc
// backend → host
{ "id": "cmd-9c2b", "kind": "command", "type": "set_viewer", "agentId": 42,
  "payload": { "enabled": true } }
```

The only command sent because somebody is *looking*. Following an agent means listening to every
block change and every entity movement in its view, so it runs only while a screen is open — the
backend turns it on for the first watcher and off after the last.

**Hold it in memory, and do not persist it.** A host that reconnects is asked again for whatever
still has watchers. Remembering it across a restart would leave a world streaming for nobody.

Remember the subscription even when it cannot be served: an agent between sessions has no world, and
being told about a watcher then is the only way to have one waiting when it spawns back in.

### The frames

World updates are **binary frames on the same socket**, not envelopes. A WebSocket reports which of
the two a frame was, so the backend tells them apart without reading either — the control protocol
stays JSON and this stays bytes.

```
0      u8   frame version (1)
1      u8   flags (bit 0: body is gzipped)
2..5   u32  agent id, big endian
6..    body: UTF-8 JSON, an array of { name, data }
```

The body's vocabulary is prismarine-viewer's, because that is what the browser renders with:
`version`, `loadChunk`, `unloadChunk`, `blockUpdate`, `entity`, `position`.

`version` must come **first** and again on every session. It carries the Minecraft version and the
world's vertical bounds — the renderer cannot place a block without the first, and assumes the
pre-1.18 range of 0 to 256 without the second.

### Three things that will bite

**Gzip the big ones.** A chunk column is JSON and compresses about fifteen times. Below a few
kilobytes it costs more than it saves.

**Coalesce entities.** `entityMoved` fires per entity per tick, so a busy server offers thousands of
messages a second of which all but the last per entity are already stale. Gather them onto a tick —
but *merge* a spawn into the movement that supersedes it rather than dropping it, because the spawn
is the only update that ever states how big a thing is.

**Pace the fill.** Send the view nearest column first, with a gap between them. Sent back to back a
full view arrives as several megabytes within a few milliseconds, overruns the relay's write buffer,
and takes the watcher's socket down with it — as an unexplained abnormal close, because nothing gets
the chance to say why.

## 4.6 Charting the world

The opposite trade to §4.5. That is streamed only while somebody watches and stored nowhere; this is
reported **for the whole session** and kept for good, because the point of a map is that it is drawn
before anybody opens it. Both come off the same world your agent is already walking through.

One pixel per block column — vanilla's zoom zero — so a chunk is exactly a 16×16 tile.

```jsonc
{ "kind": "event", "type": "map_tile", "agentId": 42,
  "payload": { "x": 24, "z": -7, "dimension": "overworld",
               "palette": ["grass_block", "water"],
               "blocks":  "AAAAAQ…",   // base64, 256 bytes, one palette index per column
               "heights": "RgBGAA…" } } // base64, 256 signed 16-bit LE, -32768 for nothing
```

| Field | Required | Notes |
|---|---|---|
| `x`, `z` | yes | **chunk** coordinates, not block ones |
| `dimension` | no | the world without its `minecraft:` prefix; absent is taken as `overworld` |
| `palette` | yes | at most 256 names — 256 columns can hold no more |
| `blocks` | yes | 256 bytes, row-major from the north-west corner: west to east, then north to south |
| `heights` | yes | 256 signed 16-bit little-endian, matching `blocks` cell for cell |

Six rules, each of which has already been got wrong once:

- **Scan each column down from the build limit and stop at the first block a player could see.** Not
  the first *solid* one: water is a surface, and a map that shows the riverbed under it is drawing
  somewhere nobody can see. Air, cave air, void air, barriers, light and structure void are stepped
  past.
- **Send names, never colours.** What colour a block reads as is a question about textures, and the
  backend stores none — the interface owns the palette. This is what lets the whole map be
  re-coloured without any agent re-walking a chunk.
- **The dimension identifies the tile, it does not label it.** The worlds are separate places sharing
  one coordinate system, so filed together an agent through a portal overwrites the map rather than
  adding to it.
- **Send the level name, not the dimension type.** They agree on vanilla and part company on
  anything running Multiverse or behind a proxy, where several worlds share the type `overworld`.
  It is on the `login` and `respawn` packets; mineflayer's `bot.game.dimension` is the type, which
  is the right thing for its own codec lookups and the wrong identity for a map.
- **Clear your already-sent digests on a dimension change.** They say *this chunk already looks like
  this*, which is a statement about a world the agent has left, and would suppress the first look at
  the new one wherever coordinates coincide.
- **Never guess a dimension.** Before the server has said which world you are in, hold the tile and
  read it again later. Terrain filed under a world that does not exist is terrain nobody finds again.
- **Settle and deduplicate.** A chunk is touched by every block change in it and every reload, and
  most of those leave the view from above untouched. Wait for the changes to stop, hash the result,
  and send only what differs — otherwise one player building generates dozens of identical tiles a
  second.
- **Read what is waiting before the server takes it away, nearest the agent first.** The world
  deletes a column *before* it raises `chunkColumnUnload`, so a chunk still settling when the agent
  leaves it is gone by the time anything hears - which at flying speed left holes all through the
  map. Read a waiting chunk in the moment before the unload instead, and never drop one for being far
  away: in arrival order a flying agent's map fills in behind it.

A tile of the wrong length, or one indexing past its own palette, is refused by the backend rather
than stored.

## 4.7 What the agent is carrying

Reported **for the whole session**, like the map and unlike the viewer: it is a few hundred bytes,
it only moves when items do, and an operator opening the page wants to see what is there now rather
than wait for a first report.

```jsonc
{ "kind": "event", "type": "inventory", "agentId": 42,
  "payload": { "slots": [ { "slot": 36, "name": "diamond_pickaxe",
                            "displayName": "Diamond Pickaxe", "count": 1,
                            "damage": 142, "maxDamage": 1561 } ],
               "held": 0 } }
```

| Field | Required | Notes |
|---|---|---|
| `slots` | yes | **occupied squares only** — a square not named is empty, which is what a client draws |
| `slot` | yes | Minecraft's own number in the player window |
| `name` | yes | the item id; the interface looks an icon up by it |
| `displayName` | no | falls back to the id: a worse label, never an empty one |
| `count` | yes | |
| `damage`, `maxDamage` | no | **together or not at all**; absent means the item does not wear out |
| `held` | no | which hotbar square is in hand, 0–8 — an *index*, not a slot |

Five rules:

- **Send the whole inventory, never a patch.** It is forty squares of a few bytes each, and a client
  assembling one out of deltas would have to be told when to throw its copy away — which is every
  respawn, every dimension change and every reconnect, none of which is an event that says so.
- **Report the square you read from**, not the item's own idea of which square it is in. The window
  keeps that field up to date and it agrees today; a stale one is a way for an item to be drawn in a
  square it is not in.
- **Wear travels as used-out-of-total**, and both halves or neither. "Undamaged" and "not the kind of
  thing that takes damage" are different answers, and a client draws a bar for the first and nothing
  for the second.
- **Settle and deduplicate**, as with tiles. `updateSlot` fires on every window refresh the server
  sends, including the full one after a respawn, and picking a stack off the floor is several
  updates. Wait for the changes to stop, hash the result, and send only what differs.
- **Leave the crafting grid out.** Those squares hold items only while a recipe is half-assembled,
  and reporting them puts two squares on an operator's screen that no click can do anything with.

**Say it again whenever a socket comes up.** The backend holds this in memory only, latest wins,
and a new socket may well be a new backend holding none of it — so restate every agent's inventory
alongside the handshake. Nothing else covers it: this event exists only because items moved, so an
agent standing still would otherwise have nothing to say until it next picked something up, and its
card would sit empty for as long as it stood there.

The backend clears an inventory when the agent leaves the game and at no other time. There is no
clock on it, deliberately — see the Charting section's neighbour in FLEET_CONNECTIVITY.md.

### Commands wait for a build

A host that is holding a segment refuses `run`, `disconnect`, `reconnect` and `goto` from chat. `run` hands
whoever typed it an arbitrary server command, so a `/tp` from a trusted player takes a builder off
its box mid-segment; the other two end the session under it. Everything else only reads or talks.

**Silently, like every other refusal here.** Answering would tell the room that the account is a bot
with work queued, which is the thing §5.1 spends its length avoiding.

## 4.8 Where an agent is going

```jsonc
{ "kind": "event", "type": "path", "agentId": 42,
  "payload": { "state": "moving", "dimension": "overworld",
               "goal": { "x": 128, "y": 64, "z": -340 },
               "nodes": [ { "x": 0.5, "y": 64, "z": 0.5 } ],
               "progress": 0 } }
```

| Field | Required | Notes |
|---|---|---|
| `state` | yes | `planning`, `moving`, `arrived`, `failed` or `idle` |
| `dimension` | no | so a map of somewhere else does not draw the line |
| `goal` | no | where the journey ends; `y` absent means a column — see `path_to` |
| `nodes` | no | the whole path, oldest first. **Absent means it has not changed** |
| `work` | no | blocks the route still means to change, in order: `{ x, y, z, kind }`, `kind` `place` or `break`. The block itself, not a standing position. Rides the same updates `nodes` does, and again whenever one is done |
| `progress` | no | how far along `nodes` the agent is |
| `reason` | no | why it gave up, for `failed` |
| `closest` | no | `true` once per journey: the route being walked only gets as close as the search could, because nothing the agent can walk, climb or build reaches the goal. Absent otherwise |

**`reason` is read by the interface, word for word.** It is written for a log, and the interface
matches these whole to give each a sentence of its own in the operator's language: `there is no
route there`, `the search ran out of time`, `it has run out of blocks to build with`, `the world
around it has not arrived yet`, `it could not work out how to get there`, `it could not place a
block on the way`, `it could not break a block on the way`, `the server kept putting it back`. Any
other reason is still shown, in your words.

**`closest` is news, not state.** A search that runs out of world before reaching the goal walks the
nearest it found, once — the world may have more of itself loaded by the time the agent gets there —
and a second search that says the same gives up with `there is no route there`. A search that runs
out of *time* is not this: a long walk is several searches, and the next starts where the last one
stopped.

**Never stored.** A path is current by definition: an old position is still the only answer there is
about where somebody was, and an old path is simply *wrong* about where somebody is going. The
backend holds it in memory for as long as the journey lasts, so an agent that reconnects plans again
rather than resuming.

**Say it again on every connect, and answer every stop.** An update sent while the socket was down
is dropped, and the backend may be a new one that never heard it - so restate the journey as it
stands whenever a socket comes up, `idle` included. And answer `path_stop` with `idle` even when
there is nothing to stop: the one a stop sent may be the update that was lost, and a stop that says
nothing leaves a line drawn for a journey that has ended.

**`nodes` rides only the updates that redrew the line** — the first of a journey, and every re-plan
after it. The ones in between carry `progress` alone, which is most of them: a few hundred points a
second is bandwidth spent redrawing something that moved by one node.

`idle` is both the resting state and what a stop reports. An agent going nowhere and an agent told
to stop going somewhere are the same agent, and giving the second one a state of its own leaves an
interface with a banner nothing ever clears.

### Keep the hull off the faces it touches

**The one thing about walking that is not obvious, and it is not optional.**
`prismarine-physics` resolves a collision to `this.maxX - other.minX` — exactly touching, no
epsilon — so a hull it stops always lands *dead on* the block boundary. Paper counts that as being
inside the block and refuses the movement: `PlayerFailMoveEvent` reports `CLIPPED_INTO_BLOCK`, and
the server sets the agent back to the last position it accepted, several times a second. That
cancels jumps and knockback arcs alike, and from outside it is an agent welded to a wall, able to
move only in the one direction with nothing in it.

Vanilla accepts the same packets, which is why it only shows up on Paper — and a human player never
trips it, because a real client's physics does not land exactly on the boundary either.

So keep the hull a couple of millimetres clear of any face it would otherwise rest against.
**Sideways only.** A hull rests on the floor with its underside flush against the top face, and
lifting that leaves an agent hovering, never landing, never reading as grounded. Standing on
something is not what gets refused; walking into it is.

## 4.9 Proxies

An agent can be routed through a proxy, chosen per agent by name. The names — and only the names —
travel: what each one *is* lives in `OSMIUM_PROXIES` (default `/agent/proxies.json`) on this
machine.

```json
[
  { "name": "resi-eu-1", "kind": "socks5", "host": "10.0.0.9", "port": 1080,
    "username": "erik", "password": "…" },
  { "name": "datacentre", "kind": "http", "host": "proxy.internal", "port": 8080 }
]
```

`kind` is `socks5` (the default), `socks4`, `http` or `https`; `port` is whatever the provider
handed out. `username` and `password` are optional and are the reason this is a file rather than a
setting — a setting is stored in Postgres, rendered into a form and relayed over a socket, and a
proxy credential has no business in any of the three.

The file is read once, at startup. An entry that could not be dialled — no name, no host, a port
that is not a port, a kind nothing speaks — is dropped with a warning and the rest are kept; a file
that is missing or is not JSON leaves the host holding none, which is what a host without proxies
has always been.

**Four connections make up one join, and three of them go through the proxy.** The version ping,
the game socket and the session-server call that proves the account is joining are all routed;
Microsoft sign-in and token refresh are not, because `prismarine-auth` runs on `msal` and offers no
per-request agent. That traffic is rare — a first sign-in, then a refresh about once a day — and it
is worth knowing it comes from this machine's own address.

**A proxy that cannot be reached fails the connection.** There is no fallback to a direct one: the
whole reason to route an agent through somewhere else is that this machine's address must not appear
on that server, so a silent direct connection would be the one outcome worth preventing. The same
goes for a `connect.proxy` naming something this host does not hold.

---

## 5. Chat scoping and the listener role

The host is the only side that can classify chat — it sees the raw packet types, and the backend
cannot infer scope from message text.

| Scope | Event | Feed | Example |
|---|---|---|---|
| `outbound` | `chat` | chat + audit | an operator made the agent speak — reported when it is sent |
| `direct` | `chat` | chat | a player whispered the agent |
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

### 5.1 Chat commands, and the only untrusted input in this host

An agent can be told to do things from inside the game:

```
!osm [account] id | ping | health | food | uptime | help                   trusted for chat
!osm [account] 8ball <question> | cf | roll [sides]                         trusted for chat
!osm [account] say <message> | run <command> | disconnect | reconnect        trusted for commands
```

Naming an account addresses one agent — `@name` works too. Leaving it out addresses every agent that
heard the line. `help` is generated from the command table and **filtered to the asker's tier**, so a
command added there lists itself, and somebody who cannot use `run` is not told it exists.

**`8ball`, `cf` and `roll` are toys**, and are on the chat tier because talking is all they do.
Two things about them are deliberate. The 8-ball **never repeats the question back**: echoing it
would be a second way to put a stranger's words in an agent's mouth, and that is what `say` is, with
a guard this would not have. And all three take their randomness as an argument, leaving the single
call to `Math.random` at the edge — a coin that comes up heads half the time is the whole behaviour,
and a function that rolls its own dice can only be tested by rolling it a thousand times and hoping.

`roll` answers a six for anything it cannot read as a number of sides, `d20` and `twenty` included:
somebody reaching for the obvious thing gets an answer rather than a lesson in syntax. Sides are
capped at 1000, because the answer goes into chat.

**`say` needs `commands`, not `chat`**, which surprises people because it only talks. What it says
is arbitrary and it says it under an account you own — the room reads it as that account's owner, and
enough of it is a mute or a ban, the one consequence here that cannot be undone. It does not
`disrupt`, though: talking does not take a builder off its box, which is what separates it from
`run`.

**Two tiers, because asking and using are different powers.** `players.whitelist` holds `name` for
chat and `name:commands` for both; an entry with nothing written after the colon is chat. A setting
from a newer Osmium must never quietly grant more than it says.

- **chat** — `id`, `ping`, `health`, `food`, `uptime`, `help`, `8ball`, `cf`, `roll`. Asks the
  agent about itself, and plays with the toys. Everything it answers is a fixed sentence about
  itself.
- **an exact list** — `name:run+say` grants precisely those and refuses everything else, the chat
  commands included. **This is what the interface writes**, always: the tiers are read for settings
  saved before it existed, and normalised into a list the first time the form is saved. This is for the player who should have one command out of the powerful tier and
  none of the others; `name:none` grants nothing at all. **A word after the colon that is not a tier
  is read as a list of one**, never as a tier guessed at — so `name:everything` from some future
  Osmium grants nothing here rather than silently falling back to chat. A command a host cannot name
  is refused, on any grant, which is what makes that safe.
- **commands** — also `goto`, `run`, `disconnect` and `reconnect`. `goto <x> <y> <z>` walks the
  agent somewhere and `goto stop` halts it; it is the one command here that answers on failure,
  because "there is no route there" is the ordinary outcome of pointing across a ravine and an
  operator standing in the world deserves to know which happened. `run` sends a server command under
  whatever permissions the agent's Minecraft account holds; on an operator account this is close to
  handing the account over, since whoever holds it can `/op` themselves and nothing here can tell
  that apart from an intended `/tp`.

**A command works in a private message too, and is answered there.** A whisper reached exactly one
agent because somebody sent it to exactly one account, so it is already addressed — `!osm run …` on
its own is enough, and naming the account says twice what the whisper already said. The answer goes
back the same way, using `chat.whisperCommand`; if that template is unusable the answer falls back to
chat rather than vanishing, because an answer in the wrong channel is a small indiscretion and an
answer nobody ever sees is a feature that looks broken.

`say` and `run` ignore all of this on purpose. Neither is an answer — one is speech into the room and
the other is an action in the world — and doing either privately would do a different thing from the
one that was asked for.

**Nothing reports where an agent is standing.** The readings a command answers with are about the
agent itself — latency, health, food, uptime — and there is deliberately no command for coordinates or
dimension. That is the one thing chat could give away that somebody on the server does not already
have, and an agent that can be asked where it is standing is an agent that can be found and killed
for its inventory.

**`disconnect` from chat does not clear the operator's intent.** The host leaves; `connect.rejoin`
lives on the backend and still says the agent is wanted, so with that on the agent comes back at the
next sweep. That is the design working rather than a fault — a host never decides where an agent
belongs — but it means chat can pause an agent, not retire it. `reconnect` is the same round trip
made on purpose: the session ends, and the address it was on is dialled again once there is nothing
in the way of it.

`say` refuses anything beginning with `/` — that is `run`'s job and it needs the other tier — and
anything beginning with the prefix, so an agent cannot be made to issue a command every other agent
then hears. `run` filters nothing: there is no list of safe commands (`/tp` is fine until the agent
is an operator and somebody sends it into a vault), so the tier is the whole decision, made once by
the operator. A `run` is written to the activity feed naming who asked and what was sent.

**This is the one place a host acts on something a stranger typed.** Everything else arrives over the
authenticated socket from the backend. So the guards are the whole of the trust boundary, and they
are checked in the order that fails cheapest:

1. It parses as a command. Nearly every line stops here.
2. It is addressed to this agent — by account, or to everybody.
3. The person who said it is in `players.whitelist`.

**An empty whitelist means nobody**, not everybody. An unset setting has to be the safe answer, and
on a public server the unsafe answer is every stranger standing in spawn.

**A known command name is never read as an account.** `!osm id` is `id` asked of everybody, because
resolving the alternative needs a lookup no single host can do — it only knows its own agents. The
cost is that an agent whose account is literally `id` cannot be addressed by name, which is written
down rather than hidden.

**Answer with silence, not a refusal.** Telling a stranger "you may not do that" confirms the account
is a bot, names the software behind it, and advertises that a list exists to get onto — and hands
anybody a way to make the fleet talk.

**Handle it before the listener check.** The election decides who *forwards* chat to the backend, not
who hears it. Every agent hears the room, and `!osm id` asked of everybody has to be answered by
everybody; an agent that stayed silent because somebody else was elected would look broken.

**The trust is only as good as `chat.sender`.** Where the protocol signs player chat, the speaker
came from a uuid and cannot be faked. Where it does not — a server that reformats its chat, which is
exactly the kind that needs a pattern — the name was read out of the rendered line. A pattern
anchored at `^`, as the documented ones are, cannot be talked past by anything inside a message; a
loose one is a way in.

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
live and reports it, in the [`handshake`](#45-handshake--once-immediately-after-connecting). That
re-enumeration is not optional: it is the only thing that clears state the backend is still
asserting from a previous process.

**Commands are never queued.** If the host is not connected, the operator's request fails with a 503
immediately. One firing long after they have resolved things by hand is worse than an outright
failure.

---


---

## 7. Building: jobs, segments, and fetching blocks

This is the half of work assignment that exists. The two messages that would hand you a segment and
take progress back do not, so nothing here is reachable from the socket yet — but the endpoint is
built, tested and stable, and a host can be written against it now.

### 7.1 What a job is

An operator picks a schematic, says where it stands and what it is built out of — that is a **build**
— then picks the agents to work it. Starting it freezes a **job**: the anchor, the substitutions and
the schematic are copied into it, and the division into **segments** is written down rather than
recomputed.

Frozen matters to you. Editing the plan afterwards changes the *next* job, so a segment fetched an
hour after it was handed out describes the same blocks it did then.

A segment is **one agent’s share, as a half-open box in world coordinates**: `max` is the first
block *not* in it. One job is one Minecraft server; one agent holds at most one segment at a time,
across every job.

### 7.2 Fetching a segment’s blocks

```http
GET /api/hostlink/jobs/{jobId}/segments/{segmentId}
X-Osmium-Ticket: 9f2c…
Accept-Encoding: gzip
```

**Over HTTP, not the socket.** The socket is the control plane: sends on it are serialised per host,
so a payload of any size there would stall heartbeats, vitals, chat and every command for every
agent on your machine — and vitals go stale after 30 seconds, so a long transfer would render
healthy agents unreachable. Bulk gets its own request, where a failure is a retry rather than a
dropped connection.

**The ticket is a capability for one segment**, not a second credential to store. It is minted when
that segment is assigned to one of your agents, and it dies when the assignment does — released,
finished, or handed to somebody else. Reassignment mints a new one. Treat it as opaque and do not
persist it: if you have lost it, you have lost the assignment too.

**Never send your enrolment token here.** That one is the credential for the whole machine and every
agent on it; this is a `GET` whose URL and headers end up in logs and proxies.

| Status | Meaning |
|---|---|
| `200` | The blocks, in the format below. |
| `401` | No ticket, an unknown one, or one that does not name this segment. Do not retry with the same ticket. |
| `409` | The job is finished, or this segment is no longer yours to build. Stop and wait to be told again. |

Ask for `gzip`. The body is highly compressible and the backend serves it as sent otherwise.

### 7.3 The segment format

Content type `application/vnd.osmium.segment`. **Big-endian throughout.**

```
"OSM1"                     4 bytes, magic and version
u16                        palette entries
  u16 length, UTF-8 bytes  each block state, repeated
i32 x3                     box minimum: x, y, z (world coordinates)
u32 x3                     box size: dx, dy, dz
u32                        block count
  u32 linear, u16 palette  each block, repeated, ascending
```

A record is six bytes, so the block section is `count * 6` and can be walked with a fixed stride.

**Positions are a linear index into the box**, not coordinates:

```
linear = ((y * dz) + z) * dx + x        // x, y, z measured from the box minimum

y = linear / (dx * dz)
z = (linear / dx) % dz
x = linear % dx
```

That is y outermost, then z, then x — the order Litematica and Sponge both store blocks in, and
therefore **build order**: bottom layer first. Records arrive ascending, so walking the stream in
order is walking the build in order, and you never need to sort or seek.

Seven things worth knowing, each of which is a decision rather than an accident:

- **Only blocks that get placed are sent.** Air never appears — not in the records and not in the
  palette. A segment’s box is mostly empty and you are not charged for it.
- **The substitutions are already applied.** The palette holds what to place, not what the file
  said. A block the operator substituted for *nothing* is simply absent, which is the honest answer
  to not having the material: a hole rather than a wrong block standing in.
- **The palette describes this segment**, not the schematic. It holds only materials actually
  present here, in first-appearance order.
- **Palette entries are block *states*, not block names.** `minecraft:oak_stairs[facing=east,
  half=bottom]`, in the single-string form Sponge palettes already use. Place the state, not the
  block: stairs without their facing are stairs pointing whichever way your server defaults to,
  which is a building that looks almost right and is wrong everywhere it matters. Two facings of
  one block are two palette entries, because they are two different things to place.
- **Properties are sorted by name**, so one state always spells one way. Neither format promises
  an order, and an unsorted spelling would put the same state in a palette twice.
- **Names are as the file wrote them**, usually `minecraft:` but not always — Osmium never resolves
  a block name against a registry, which is what lets it accept a schematic from an older
  Minecraft. A bare name means the vanilla namespace, as it does everywhere in Minecraft. A name
  you do not recognise is not necessarily wrong; report it and move on rather than failing the
  segment.
- **A substitution can flatten states.** A rule names a block, so one rule catches every state of
  it, and what comes back is what the operator wrote — often a plain name with no properties at
  all. Do not assume an entry has any.
- **An empty segment is a valid answer**, with `count = 0` and an empty palette. A box whose every
  block was substituted away still gets handed out; finish it and report it built.

### 7.4 Reading one, roughly

```ts
const n = view.getUint32(at); at += 4

for (let i = 0; i < n; i++) {
  const linear = view.getUint32(at); at += 4
  const state = palette[view.getUint16(at)]; at += 2   // "minecraft:oak_stairs[facing=east]"

  const y = Math.floor(linear / (dx * dz))
  const z = Math.floor(linear / dx) % dz
  const x = linear % dx

  place(minX + x, minY + y, minZ + z, state)
}
```

`linear` is unsigned and a large box exceeds a signed 32-bit range, so read it as unsigned and do
the arithmetic in doubles - which hold every value up to 2⁵³ exactly. The backend refuses to serve a
box of more than 2³²−1 positions rather than letting an index wrap, so it always fits.

### 7.5 Being told to build, and reporting back

Two messages, and they close the loop. Both are **implemented and exercised** — the mock host in
this repository fetches a real segment, parses it and reports against it, which is how the
specification below got its bugs shaken out before you inherited it.

#### `build_segment` — backend to host

```jsonc
{ "id": "cmd-7f3a", "kind": "command", "type": "build_segment", "agentId": 42,
  "payload": {
    "jobId": 7,
    "segmentId": 31,
    "ticket": "9f2c…",
    "min": { "x": 128, "y": 64, "z": -340 },
    "max": { "x": 160, "y": 96, "z": -308 },
    "blocks": 20431
  } }
```

Fire and forget: **do not answer with a result.** Report what came of it as `build_progress`,
exactly as `connect` reports through `agent_status`.

The box and the count travel as well as being derivable from the body you are about to fetch, so
you can size the work, refuse one you cannot do, and log something legible before making an HTTP
call. The ticket rides along because this command is the act that minted it.

**The ticket is valid from the moment you receive this.** The backend deliberately sends the
command only after the transaction that minted the ticket has committed — an earlier version sent
it inside that transaction, and a host quick enough to fetch got a 401 for a ticket that was
milliseconds from existing. If you ever see a 401 on a ticket you have only just been given, that
is a backend bug and worth saying so loudly.

#### `cancel_segment` — backend to host

```jsonc
{ "id": "cmd-…", "kind": "command", "type": "cancel_segment", "agentId": 42,
  "payload": { "jobId": 7, "segmentId": 31 } }
```

Stop building that segment. Sent when it is taken back from you, and when its job is paused or
deleted. Fire and forget, and **not an error** for a segment you have already finished or never
started: it asks you to stop, which having stopped satisfies.

Take it seriously. A host that keeps placing blocks after a job is paused defeats the only thing
pausing exists to do.

#### `build_progress` — host to backend

```jsonc
{ "kind": "event", "type": "build_progress", "agentId": 42,
  "payload": { "segmentId": 31, "blocksPlaced": 12480, "state": "building" } }
```

| Field | Required | Notes |
|---|---|---|
| `segmentId` | yes | Which segment. Not the agent — see below. |
| `blocksPlaced` | no | **How many *you* have placed** since you were given this segment. Not a delta, and not the total standing in the box. |
| `state` | no | `building`, `done` or `failed`. Omit to report only a count. |
| `reason` | no | Why it failed. Written for whoever reads host logs; truncated at 256. |

Send it roughly **every five seconds** while building, alongside the vitals in `agent_status`.

**Count your own work, from zero, every time you are handed the segment.** You cannot know whether
somebody built part of it before you, and you are not expected to: the backend remembers what was
standing when you took the piece and reports the higher of the two. So a segment handed from one
agent to another does not fall back to nothing when the new one says `0`, and the blocks you place
over work somebody else already did are not counted twice.

**It is a total, not a delta.** Report where you are, not what has happened since the last message.
The same report applied twice leaves the same number, one that never arrives costs nothing once the
next lands, and a host that restarts mid-segment simply starts counting again — all of which a
delta gets wrong. It is also clamped to the segment’s own size, so a generous count cannot drive a
job past finished.

**Keyed by the segment, not the agent.** An agent holds one segment at a time, so either would
identify it — but a report that arrives just after a segment was taken back would then land on
whatever that agent picked up next, which is one box’s count applied to another. The backend
ignores a report about a segment you do not hold.

`done` is what closes a segment, and the last `done` in a job closes the job — nothing else can
know. It carries the count with it, so you need not send a final total that exactly equals the
size; say `done` and the backend fills it in.

`failed` is for **you tried and could not**. It is not for losing the connection: an agent that
drops out has its segment returned to the pool automatically and handed back when it returns, so
there is nothing to report and nothing to retry. Reporting `failed` on a disconnect turns a blip
into something an operator has to come and look at.

## 8. A minimally compliant host

1. Dial `wss://<backend>/ws/host` with the bearer token; reconnect with backoff, loudly on 4xx.
2. Send `heartbeat` every 10s with `hostVersion`.
3. Run every agent this host owns in **one process**, mapping `agentId` to a client internally.
4. Handle `setup_agent` → reply `ok` with `mcUsername` + `mcUuid`, or `ok: false` with `reason`.
5. Handle `connect` / `disconnect` → no result; report `agent_status` when the state actually moves.
   Report vitals in `agent_status` every ~5s while an agent is `ONLINE`.
6. Handle `chat` → say it, then report the server's echo of it as a `chat` event with scope
   `outbound`. A command never echoes, so report that one as it is sent.
7. Handle `set_chat_listener` → toggle `global` forwarding for that agent; default off.
8. Classify inbound chat into the five scopes and emit `chat` / `activity`, naming the speaker in
   `from` — or `server` when it cannot be read out of the line. Never the observing agent.
9. Handle `settings` → apply the keys you know, **ignore the rest**, and read the whole set fresh
   rather than merging it into what was there.
10. Handle `build_segment` → fetch the blocks with the ticket, place them, and report
   `build_progress` every ~5s with the running total; `done` when finished, `failed` only if you
   genuinely could not. Handle `cancel_segment` → stop, and treat an unknown segment as already
   satisfied.
11. Report the agent's `inventory` when items move, and handle `inventory_move`, `inventory_drop`
   and `inventory_hold` — all three fire and forget, answered by the next report rather than by a
   result. Optional, like the map and the world stream: a host that reports none of it simply shows
   an empty card. Slot numbers are Minecraft's own, in the player window.
12. Reply `ok: false` to any command you do not recognise.
13. Send `handshake` immediately on **every** connect, both halves:
    - `agents` — re-enumerate what is actually live. Not optional: it is the only thing that clears
      sessions the backend is still asserting from a previous process. An empty array is a real
      answer.
    - `loginMethods` — what this machine can log in with. **Advertise nothing and no agent on this
      host can be set up at all**, because the backend offers exactly this list and holds none of
      its own.

## Before writing any of it

Read [`../FLEET_CONNECTIVITY.md`](../FLEET_CONNECTIVITY.md). It records the agent state machine, the
credential-custody argument, listener election, retention, and what was rejected and why — which
will save re-deriving it.
