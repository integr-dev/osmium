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
        ticket: str(payload, 'ticket', 'payload.ticket'),
        min: blockPos(payload['min'], 'payload.min'),
        max: blockPos(payload['max'], 'payload.max'),
        blocks: num(payload, 'blocks', 'payload.blocks'),
      }

    case 'cancel_segment':
      return {
        type: 'cancel_segment',
        jobId: num(payload, 'jobId', 'payload.jobId'),
        segmentId: num(payload, 'segmentId', 'payload.segmentId'),
      }

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

function blockPos(source: unknown, path: string): BlockPos {
  if (typeof source !== 'object' || source === null) throw new MessageError(`missing or ill-typed '${path}'`)
  const raw = source as Json

  return {
    x: num(raw, 'x', path),
    y: num(raw, 'y', path),
    z: num(raw, 'z', path),
  }
}
