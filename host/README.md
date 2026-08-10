# Osmium host

**Not built here.** This directory is a placeholder; the host is being written separately, in
**Rust** on [azalea](https://github.com/azalea-rs/azalea).

The host runs on a machine you control. It holds the Minecraft credentials, drives the agents, and
is the only component that ever performs a login. Everything it needs to talk to already exists on
the backend side and is covered by tests — see `HostLinkTest`.

This file and [`../FLEET_CONNECTIVITY.md`](../FLEET_CONNECTIVITY.md) are the contract between the
two sides. The backend imposes no language or library: the protocol is a WebSocket carrying JSON
envelopes, so azalea is a choice the host makes rather than something the backend knows about.

## What it has to do

1. **Dial out** to `wss://<backend>/ws/host` with `Authorization: Bearer <enrolment token>`, taken
   from `OSMIUM_HOST_TOKEN`. Nothing connects *to* the host, so it needs no inbound ports.
2. **Heartbeat** every ~10s. Reachability is derived from it: miss the grace window and every agent on
   this host becomes `STALE` in the UI.
3. **Handle `setup_agent`** — log an account in by whatever mechanism the operator picked, cache the
   credentials locally, and report back **only** the resulting username and UUID.
4. **Handle `connect`, `disconnect`, `chat`** and report state changes and telemetry as events.
5. **Run all of this host's agents in one process**, mapping `agentId` to a client internally.

## The rule that must not be broken

**Credentials never leave this machine.** Not in a result, not in telemetry, not in a log line the
backend receives. The backend is designed so that it *cannot* learn them, and that property is only
real if the host upholds it.

Store the token cache with mode `0600`, encrypted with a key from the environment, listed in
`.gitignore` and `.dockerignore`, and mounted as a volume rather than baked into an image.

## Before writing any of it

Read [`../FLEET_CONNECTIVITY.md`](../FLEET_CONNECTIVITY.md). It specifies the envelope, the three
message kinds, correlation ids, the agent state machine, chat scoping and listener election, and the
rules for unknown messages. It also records what was rejected and why, which will save re-deriving
it.

Two decisions from that document are easy to get wrong:

- **An unknown message is never fatal.** An unknown event is logged and ignored; an unknown command
  gets `ok: false`, never silence, so the backend's pending request fails fast instead of hanging.
- **The backend is the source of truth for work, the host for agent state.** The host receives a
  segment and builds it; it does not schedule. Conversely the backend never asserts an agent's state
  back onto the host — on reconnect the host re-enumerates what is actually live.
