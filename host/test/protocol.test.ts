import { describe, expect, it } from 'vitest'

import { deserialize, MessageError } from '../src/protocol/deserialize.ts'
import { serialize } from '../src/protocol/serialize.ts'
import { LoginState } from '../src/protocol/wire.ts'
import { advertised } from '../src/token/login.ts'

function parse(raw: string): any {
  return JSON.parse(raw)
}

describe('serialize', () => {
  it('puts a result on the envelope the contract describes', () => {
    const json = parse(
      serialize({
        kind: 'result',
        body: {
          id: 'command-id',
          agentId: 67,
          setup: { ok: true, mcUsername: 'MeowBot1', mcUuid: '00000000-0000-0000-0000-000000000000' },
        },
      }),
    )

    expect(json.id).toBe('command-id')
    expect(json.kind).toBe('result')
    expect(json.type).toBe('setup_agent')
    // Not `agent_id`: the envelope is camelCase, and the backend reads nothing from the other.
    expect(json.agentId).toBe(67)
    expect(json.ok).toBe(true)
    expect(json.payload.mcUsername).toBe('MeowBot1')
  })

  it('says what we run and what we can do, on the handshake', () => {
    const json = parse(
      serialize({
        kind: 'event',
        body: {
          type: 'handshake',
          agents: [{ agentId: 42, state: LoginState.Online }],
          loginMethods: advertised(),
        },
      }),
    )

    expect(json.type).toBe('handshake')
    // Host scoped, so everything is inside the payload.
    expect(json.agentId).toBeUndefined()
    expect(json.payload.agents[0]).toEqual({ agentId: 42, state: 'ONLINE' })
    // Device code leads: it is the only mechanism that works on a host nobody has put credential
    // files on.
    expect(json.payload.loginMethods[0].id).toBe('device_code')
  })

  it("uses the backend's names for states, and omits what it has none of", () => {
    const json = parse(
      serialize({
        kind: 'event',
        body: { type: 'agent_status', agentId: 42, state: LoginState.FailedConnection },
      }),
    )

    expect(json.payload.state).toBe('CONNECT_FAILED')
    // Omitted, not null: a null node reads back as the string "null" and is dropped as an unknown
    // value.
    expect('dimension' in json.payload).toBe(false)
    expect('health' in json.payload).toBe(false)
  })

  it('sends the vitals as a set', () => {
    const json = parse(
      serialize({
        kind: 'event',
        body: {
          type: 'agent_status',
          agentId: 42,
          vitals: { health: 18, food: 17, ping: 42, position: { x: 128.5, y: 71, z: -344.25 } },
        },
      }),
    )

    expect(json.payload.health).toBe(18)
    expect(json.payload.food).toBe(17)
    expect(json.payload.pingMs).toBe(42)
    expect(json.payload.position.x).toBe(128.5)
    expect('state' in json.payload).toBe(false)
  })

  it('keeps the heartbeat host scoped', () => {
    const json = parse(serialize({ kind: 'event', body: { type: 'heartbeat', version: '0.1.0' } }))

    expect(json.type).toBe('heartbeat')
    expect(json.payload.hostVersion).toBe('0.1.0')
    expect(json.agentId).toBeUndefined()
  })
})

describe('deserialize', () => {
  const envelope = (type: string, payload: unknown) =>
    JSON.stringify({ id: 'c1', kind: 'command', type, agentId: 26, payload })

  it('reads a connect', () => {
    const command = deserialize(envelope('connect', { serverAddress: 'play.example.com' }))

    expect(command.id).toBe('c1')
    expect(command.agentId).toBe(26)
    expect(command.body).toEqual({ type: 'connect', address: 'play.example.com' })
  })

  it('reads a build segment whole', () => {
    const command = deserialize(
      envelope('build_segment', {
        jobId: 7,
        segmentId: 31,
        ticket: '9f2c',
        min: { x: 128, y: 64, z: -340 },
        max: { x: 160, y: 96, z: -308 },
        blocks: 20431,
      }),
    )

    expect(command.body).toMatchObject({ type: 'build_segment', jobId: 7, blocks: 20431 })
  })

  it('survives a label it was not sent', () => {
    const command = deserialize(envelope('setup_agent', { method: 'device_code' }))

    expect(command.body).toEqual({ type: 'setup_agent', label: '', method: 'device_code' })
  })

  it('reads settings as a flat map', () => {
    const command = deserialize(envelope('settings', { values: { 'chat.sender': '^<(\\w+)> ' } }))

    expect(command.body).toEqual({ type: 'settings', values: { 'chat.sender': '^<(\\w+)> ' } })
  })

  it('keeps only the settings it can use', () => {
    // A value that is not a string is a setting this build cannot apply, and dropping it here saves
    // everything downstream from asking what type a key is.
    const command = deserialize(envelope('settings', { values: { good: 'yes', count: 7, off: null } }))

    expect(command.body).toEqual({ type: 'settings', values: { good: 'yes' } })
  })

  it('reads an empty settings map, which means everything was cleared', () => {
    expect(deserialize(envelope('settings', { values: {} })).body).toEqual({ type: 'settings', values: {} })
  })

  it('refuses settings with nothing to apply', () => {
    expect(() => deserialize(envelope('settings', {}))).toThrow(/payload.values/)
  })

  it('refuses anything that is not a command', () => {
    expect(() => deserialize(JSON.stringify({ kind: 'event', type: 'heartbeat' }))).toThrow(MessageError)
  })

  it('refuses a command it has not learned about', () => {
    expect(() => deserialize(envelope('teleport', {}))).toThrow(/unknown command 'teleport'/)
  })

  it('names the field it could not read', () => {
    expect(() => deserialize(envelope('chat', {}))).toThrow(/payload.message/)
  })

  it('reports malformed json rather than throwing something else', () => {
    expect(() => deserialize('{')).toThrow(MessageError)
  })
})
