import type { Waypoint } from '../agent/path/navigator.ts'
import { orderFrom } from '../agent/order.ts'
import type { Command, CommandBody } from './message.ts'
import type { BlockPos } from './wire.ts'

/**
 * Why an inbound frame could not be understood.
 *
 * Every one of these is logged and dropped rather than fatal. A newer backend sending something
 * this build has not learned about is normal traffic, not a reason to tear the socket down - the
 * envelope is designed to parse without understanding the payload precisely so that this stays
 * survivable.
 */
export class MessageError extends Error {}

type Json = Record<string, unknown>

/**
 * Reads one inbound frame.
 *
 * Only commands arrive here - results and events travel the other way - so anything else is
 * reported as unreadable rather than modelled.
 */
export function deserialize(raw: string): Command {
  let envelope: unknown

  try {
    envelope = JSON.parse(raw)
  } catch (err) {
    throw new MessageError(`not valid json: ${(err as Error).message}`)
  }

  if (typeof envelope !== 'object' || envelope === null) throw new MessageError('not an object')
  const frame = envelope as Json

  const kind = str(frame, 'kind', 'kind')
  if (kind !== 'command') throw new MessageError(`not a command: kind '${kind}'`)

  const id = str(frame, 'id', 'id')
  const name = str(frame, 'type', 'type')

  // Read before the payload is decoded, so an unknown command still gets attributed to an agent in
  // the log rather than being reported as a nameless mystery.
  const agentId = num(frame, 'agentId', 'agentId')

  const payload = (typeof frame['payload'] === 'object' && frame['payload'] !== null ? frame['payload'] : {}) as Json

  return { id, agentId, body: body(name, payload) }
}

function body(name: string, payload: Json): CommandBody {
  switch (name) {
    case 'setup_agent':
      return {
        type: 'setup_agent',
        // Absent is survivable: it is only ever logged on this side.
        label: typeof payload['label'] === 'string' ? payload['label'] : '',
        method: str(payload, 'method', 'payload.method'),
      }

    // Always present and never empty, and the authority on where this agent plays - it can differ
    // from the last one, so nothing remembered is used in its place.
    case 'connect':
      return { type: 'connect', address: str(payload, 'serverAddress', 'payload.serverAddress') }

    case 'disconnect':
      return { type: 'disconnect' }

    case 'chat':
      return { type: 'chat', message: str(payload, 'message', 'payload.message') }

    case 'set_chat_listener': {
      const enabled = payload['enabled']
      if (typeof enabled !== 'boolean') throw new MessageError("missing or ill-typed 'payload.enabled'")
      return { type: 'set_chat_listener', enabled }
    }

    case 'set_viewer': {
      const enabled = payload['enabled']
      if (typeof enabled !== 'boolean') throw new MessageError("missing or ill-typed 'payload.enabled'")
      return { type: 'set_viewer', enabled }
    }

    case 'settings': {
      const values = payload['values']
      if (typeof values !== 'object' || values === null) throw new MessageError("missing or ill-typed 'payload.values'")

      // Only the string values. Anything else is a setting this build cannot use, and dropping it
      // here keeps everything downstream from having to ask what type a key is.
      const flat: Record<string, string> = {}
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string') flat[key] = value
      }

      return { type: 'settings', values: flat }
    }

    case 'build_segment':
      return {
        type: 'build_segment',
        jobId: num(payload, 'jobId', 'payload.jobId'),
        segmentId: num(payload, 'segmentId', 'payload.segmentId'),
        // A backend older than the chat commands sends none, which is an agent that cannot name
        // its job rather than a command it must refuse.
        ...(typeof payload['name'] === 'string' ? { name: payload['name'] } : {}),
        ticket: str(payload, 'ticket', 'payload.ticket'),
        min: blockPos(payload['min'], 'payload.min'),
        max: blockPos(payload['max'], 'payload.max'),
        blocks: num(payload, 'blocks', 'payload.blocks'),
        // A backend older than the setting sends none, and a token this build cannot read is the
        // same case: the piece is built in the order everything was built in before it was a
        // choice, rather than the command being refused and the piece going to nobody.
        order: orderFrom(payload['order']),
      }

    case 'chart_segment':
      return {
        type: 'chart_segment',
        jobId: num(payload, 'jobId', 'payload.jobId'),
        segmentId: num(payload, 'segmentId', 'payload.segmentId'),
        ...(typeof payload['name'] === 'string' ? { name: payload['name'] } : {}),
        min: blockPos(payload['min'], 'payload.min'),
        max: blockPos(payload['max'], 'payload.max'),
        columns: num(payload, 'columns', 'payload.columns'),
        // A survey planned before the flight could climb holds one height, which is what it was
        // planned as - so an absent flag is level rather than a refused command.
        rising: payload['rising'] === true,
        ...(typeof payload['dimension'] === 'string' ? { dimension: payload['dimension'] } : {}),
      }

    // Slot numbers are validated where they are acted on rather than here: which squares an
    // operator may touch is a fact about the window, and `agent/inventory.ts` owns it.
    case 'inventory_move':
      return {
        type: 'inventory_move',
        from: num(payload, 'from', 'payload.from'),
        to: num(payload, 'to', 'payload.to'),
      }

    case 'inventory_drop': {
      const count = payload['count']
      return {
        type: 'inventory_drop',
        slot: num(payload, 'slot', 'payload.slot'),
        // Absent means the whole stack, which is the ordinary case and not an omission.
        ...(typeof count === 'number' ? { count } : {}),
      }
    }

    case 'inventory_hold':
      return { type: 'inventory_hold', slot: num(payload, 'slot', 'payload.slot') }

    case 'cancel_segment':
      return {
        type: 'cancel_segment',
        jobId: num(payload, 'jobId', 'payload.jobId'),
        segmentId: num(payload, 'segmentId', 'payload.segmentId'),
      }

    // The route, in order, with the destination last. An empty list is refused rather than read as
    // "go nowhere": nothing means it, and a host that quietly did nothing would look like one that
    // never got the command.
    case 'path_to': {
      const waypoints = payload['waypoints']
      if (!Array.isArray(waypoints) || waypoints.length === 0) {
        throw new MessageError("missing or ill-typed 'payload.waypoints'")
      }

      return {
        type: 'path_to',
        waypoints: waypoints.map((point, at) => waypoint(point, `payload.waypoints[${at}]`)),
      }
    }

    case 'path_stop':
      return { type: 'path_stop' }

    case 'delete_agent':
      return { type: 'delete_agent' }

    default:
      throw new MessageError(`unknown command '${name}'`)
  }
}

function str(source: Json, key: string, path: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw new MessageError(`missing or ill-typed '${path}'`)
  return value
}

function num(source: Json, key: string, path: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MessageError(`missing or ill-typed '${path}'`)
  return value
}

/**
 * Somewhere to go, which may name a column rather than a point.
 *
 * **An absent `y` is a value, not an omission.** It says the height is unknown - a spot picked off
 * a part of the map nobody has charted - and the agent is to get to that column at whatever height
 * the ground turns out to be. Defaulting it to zero here would send an agent to the bottom of the
 * world, which is a destination nobody ever means.
 */
function waypoint(source: unknown, path: string): Waypoint {
  if (typeof source !== 'object' || source === null) throw new MessageError(`missing or ill-typed '${path}'`)
  const raw = source as Json

  const y = raw['y']
  if (y !== undefined && y !== null && (typeof y !== 'number' || !Number.isFinite(y))) {
    throw new MessageError(`missing or ill-typed '${path}.y'`)
  }

  return {
    x: num(raw, 'x', path),
    ...(typeof y === 'number' ? { y } : {}),
    z: num(raw, 'z', path),
  }
}

function blockPos(source: unknown, path: string): BlockPos {
  if (typeof source !== 'object' || source === null) throw new MessageError(`missing or ill-typed '${path}'`)
  const raw = source as Json

  return {
    x: num(raw, 'x', path),
    y: num(raw, 'y', path),
    z: num(raw, 'z', path),
  }
}
