import type { Event, Outbound, Result } from './message.ts'

type Json = Record<string, unknown>

/**
 * Writes a key only when there is something to put under it.
 *
 * A JSON `null` is not the same as an absent key on the other side. The backend reads optional
 * fields straight off the raw node, and Jackson answers `asString()` on a null node with the
 * *string* `"null"` - so a `state` we meant to omit arrives as an unknown state, is logged as one,
 * and dropped. Omitted has to mean absent.
 */
function put(target: Json, key: string, value: unknown): void {
  if (value !== undefined && value !== null) target[key] = value
}

export function serialize(message: Outbound): string {
  return JSON.stringify(message.kind === 'result' ? result(message.body) : event(message.body))
}

function result(body: Result): Json {
  const payload: Json = body.setup.ok
    ? { mcUsername: body.setup.mcUsername, mcUuid: body.setup.mcUuid }
    : { reason: body.setup.reason }

  return {
    id: body.id,
    kind: 'result',
    type: 'setup_agent',
    agentId: body.agentId,
    ok: body.setup.ok,
    payload,
  }
}

function event(body: Event): Json {
  switch (body.type) {
    case 'handshake':
      return {
        kind: 'event',
        type: 'handshake',
        payload: {
          agents: body.agents.map((agent) => ({ agentId: agent.agentId, state: agent.state })),
          loginMethods: body.loginMethods,
          proxies: body.proxies,
        },
      }

    case 'heartbeat':
      return { kind: 'event', type: 'heartbeat', payload: { hostVersion: body.version } }

    case 'agent_status': {
      const payload: Json = {}

      put(payload, 'state', body.state)
      put(payload, 'dimension', body.dimension)
      put(payload, 'nearby', body.nearby)

      // All four or none, which is why they arrive as one value: a tick carrying only some of them
      // is dropped whole rather than having the rest filled in with defaults.
      if (body.vitals) {
        payload['health'] = body.vitals.health
        payload['food'] = body.vitals.food
        payload['pingMs'] = body.vitals.ping
        payload['position'] = body.vitals.position
      }

      return { kind: 'event', type: 'agent_status', agentId: body.agentId, payload }
    }

    case 'chat': {
      const payload: Json = { scope: body.scope, text: body.text }

      // Absent means the label the backend already holds for this agent, so it is left out rather
      // than guessed at here.
      put(payload, 'from', body.from)

      // The styled form, when there is one. `text` carries the whole line either way, so anything
      // that ignores this loses the colours and nothing else.
      put(payload, 'components', body.components)

      // What was typed, for a line whose speaker could be named. Absent is meaningful rather than
      // missing: it says this host could not tell where the server's decoration ended.
      put(payload, 'typed', body.typed)

      return { kind: 'event', type: 'chat', agentId: body.agentId, payload }
    }

    case 'stand_down':
      return {
        kind: 'event',
        type: 'stand_down',
        agentId: body.agentId,
        payload: { reason: body.reason },
      }

    case 'activity':
      return {
        kind: 'event',
        type: 'activity',
        agentId: body.agentId,
        payload: { scope: body.scope, severity: body.severity, text: body.text },
      }

    case 'inventory':
      return {
        kind: 'event',
        type: 'inventory',
        agentId: body.agentId,
        // Flat, like a map tile and for the same reason: the payload of an envelope is already the
        // body of one event, and a second wrapper inside it says nothing the type has not said.
        payload: { slots: body.inventory.slots, held: body.inventory.held },
      }

    case 'map_tile':
      return {
        kind: 'event',
        type: 'map_tile',
        agentId: body.agentId,
        // Flat rather than nested under `tile`: the payload of an envelope is already the body of
        // one event, and a second wrapper inside it says nothing the type has not said.
        payload: {
          dimension: body.tile.dimension,
          x: body.tile.x,
          z: body.tile.z,
          palette: body.tile.palette,
          blocks: body.tile.blocks,
          heights: body.tile.heights,
        },
      }

    case 'path': {
      const payload: Json = { state: body.state }

      put(payload, 'dimension', body.dimension)
      put(payload, 'goal', body.goal)
      // Only on the updates that redrew it. An absent `nodes` says the line has not changed, which
      // is not the same as a path with no nodes in it.
      put(payload, 'nodes', body.nodes)
      put(payload, 'work', body.work)
      put(payload, 'progress', body.progress)
      put(payload, 'reason', body.reason)

      return { kind: 'event', type: 'path', agentId: body.agentId, payload }
    }

    case 'build_progress': {
      const payload: Json = { segmentId: body.segmentId }

      put(payload, 'blocksPlaced', body.blocksPlaced)
      put(payload, 'state', body.state)
      put(payload, 'reason', body.reason)

      return { kind: 'event', type: 'build_progress', agentId: body.agentId, payload }
    }
  }
}
