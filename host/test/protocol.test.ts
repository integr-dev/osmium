import { describe, expect, it } from 'vitest'

import { deserialize, MessageError } from '../src/protocol/deserialize.ts'
import { serialize } from '../src/protocol/serialize.ts'
import { ChatScope, LoginState } from '../src/protocol/wire.ts'
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

  it('sends what was typed beside the line it was read out of', () => {
    const json = parse(
      serialize({
        kind: 'event',
        body: {
          type: 'chat',
          agentId: 42,
          scope: ChatScope.Global,
          from: 'Notch',
          text: '[MEMBER] Notch » selling diamonds',
          typed: 'selling diamonds',
        },
      }),
    )

    expect(json.payload.text).toBe('[MEMBER] Notch » selling diamonds')
    // The decoration off the front. The backend compares this rather than the rendered line, where
    // a rank prefix is constant per player and most of a short message.
    expect(json.payload.typed).toBe('selling diamonds')
  })

  it('omits what was typed for a line it could not read a speaker out of', () => {
    const json = parse(
      serialize({
        kind: 'event',
        body: { type: 'chat', agentId: 42, scope: ChatScope.Global, text: 'Notch joined the game' },
      }),
    )

    // Absent rather than empty: it says this host could not tell where the decoration ended, which
    // is the same thing that left the line unattributed.
    expect('typed' in json.payload).toBe(false)
    expect('from' in json.payload).toBe(false)
  })

  it('keeps the heartbeat host scoped', () => {
    const json = parse(serialize({ kind: 'event', body: { type: 'heartbeat', version: '0.1.0' } }))

    expect(json.type).toBe('heartbeat')
    expect(json.payload.hostVersion).toBe('0.1.0')
    expect(json.agentId).toBeUndefined()
  })
})

describe('the path event', () => {
  it('carries the whole line when it has been drawn', () => {
    const json = parse(
      serialize({
        kind: 'event',
        body: {
          type: 'path',
          agentId: 4,
          state: 'moving',
          dimension: 'overworld',
          goal: { x: 100, y: 64, z: 200 },
          nodes: [
            { x: 0.5, y: 64, z: 0.5 },
            { x: 1.5, y: 64, z: 0.5 },
          ],
          progress: 1,
        },
      }),
    )

    expect(json.type).toBe('path')
    expect(json.agentId).toBe(4)
    expect(json.payload.state).toBe('moving')
    expect(json.payload.dimension).toBe('overworld')
    expect(json.payload.goal).toEqual({ x: 100, y: 64, z: 200 })
    expect(json.payload.nodes).toHaveLength(2)
    expect(json.payload.progress).toBe(1)
  })

  /**
   * An absent `nodes` says the line has not changed, which is not the same as a path with no nodes
   * in it. Most updates are this one: the path is drawn once and progress moves along it.
   */
  it('leaves the line out of an update that only moved along it', () => {
    const json = parse(
      serialize({ kind: 'event', body: { type: 'path', agentId: 4, state: 'moving', progress: 7 } }),
    )

    expect('nodes' in json.payload).toBe(false)
    expect('goal' in json.payload).toBe(false)
    expect(json.payload.progress).toBe(7)
  })

  it('says why it gave up', () => {
    const json = parse(
      serialize({
        kind: 'event',
        body: { type: 'path', agentId: 4, state: 'failed', reason: 'there is no route there' },
      }),
    )

    expect(json.payload.state).toBe('failed')
    expect(json.payload.reason).toBe('there is no route there')
  })

  /** Zero is a real progress, and the falsy one. */
  it('sends a progress of nothing rather than dropping it', () => {
    const json = parse(
      serialize({ kind: 'event', body: { type: 'path', agentId: 4, state: 'moving', progress: 0 } }),
    )

    expect(json.payload.progress).toBe(0)
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

  /**
   * A route, in order, with the destination last. The list is the shape because a route may be
   * handed down whole - the interface sends one entry, a coarse pass over stored map tiles will
   * send the shape of a journey no host can see all of at once.
   */
  it('reads a route as the list it is', () => {
    const command = deserialize(
      envelope('path_to', {
        waypoints: [
          { x: 10, y: 64, z: -20 },
          { x: 120, y: 70, z: -180 },
        ],
      }),
    )

    expect(command.body).toEqual({
      type: 'path_to',
      waypoints: [
        { x: 10, y: 64, z: -20 },
        { x: 120, y: 70, z: -180 },
      ],
    })
  })

  it('reads the one waypoint an operator asked for', () => {
    expect(deserialize(envelope('path_to', { waypoints: [{ x: 1, y: 2, z: 3 }] })).body).toEqual({
      type: 'path_to',
      waypoints: [{ x: 1, y: 2, z: 3 }],
    })
  })

  /**
   * Nothing means going nowhere, which nobody means. A host that quietly did nothing with it would
   * look exactly like one that never got the command.
   */
  it('refuses a route with nothing in it', () => {
    expect(() => deserialize(envelope('path_to', { waypoints: [] }))).toThrow(/payload.waypoints/)
    expect(() => deserialize(envelope('path_to', {}))).toThrow(/payload.waypoints/)
    expect(() => deserialize(envelope('path_to', { waypoints: 'home' }))).toThrow(/payload.waypoints/)
  })

  it('names the waypoint it could not read', () => {
    // Missing z, not missing y: a waypoint with no height is a column and reads perfectly well.
    expect(() =>
      deserialize(envelope('path_to', { waypoints: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5 }] })),
    ).toThrow(/payload.waypoints\[1\]/)
  })

  /**
   * The height is optional, and its absence is a value.
   *
   * It says the destination is a *column*: somewhere picked off a part of the map nobody has walked,
   * to be reached at whatever height the ground turns out to be. Defaulting it to zero would send an
   * agent to the bottom of the world, which is a destination nobody ever means.
   */
  it('reads a waypoint with no height as the column it is', () => {
    const command = deserialize(envelope('path_to', { waypoints: [{ x: 10, z: -20 }] }))

    expect(command.body).toEqual({ type: 'path_to', waypoints: [{ x: 10, z: -20 }] })
    expect('y' in (command.body as { waypoints: object[] }).waypoints[0]!).toBe(false)
  })

  it('reads a null height the same way an absent one is read', () => {
    expect(deserialize(envelope('path_to', { waypoints: [{ x: 10, y: null, z: -20 }] })).body).toEqual({
      type: 'path_to',
      waypoints: [{ x: 10, z: -20 }],
    })
  })

  /** Absent means a column; a word where a number goes means somebody sent nonsense. */
  it('refuses a height that is there and is not a number', () => {
    expect(() => deserialize(envelope('path_to', { waypoints: [{ x: 1, y: 'up', z: 3 }] }))).toThrow(
      /payload.waypoints\[0\].y/,
    )
  })

  it('still needs the two coordinates that are not optional', () => {
    expect(() => deserialize(envelope('path_to', { waypoints: [{ x: 1, y: 2 }] }))).toThrow(/payload.waypoints\[0\]/)
  })

  it('reads a stop, which carries nothing', () => {
    expect(deserialize(envelope('path_stop', {})).body).toEqual({ type: 'path_stop' })
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
