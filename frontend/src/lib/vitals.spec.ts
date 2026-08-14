import { describe, expect, it } from 'vitest'
import { summariseVitals } from './vitals'
import type { FleetAgent } from '../stores/agents'

function agent(overrides: Partial<FleetAgent> = {}): FleetAgent {
  return {
    id: 1,
    label: 'eu-1',
    state: 'ONLINE',
    telemetry: { health: 20, food: 20, pingMs: 40, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', nearby: [] },
    ...overrides,
  } as FleetAgent
}

describe('the fleet at its worst', () => {
  /** An average hides the one that matters: 18 across the fleet with one agent on 2 is a problem. */
  it('reports the worst reading and who it belongs to', () => {
    const hurt = agent({ id: 2, label: 'eu-2', telemetry: { ...agent().telemetry!, health: 4 } })
    const laggy = agent({ id: 3, label: 'eu-3', telemetry: { ...agent().telemetry!, pingMs: 320 } })

    const summary = summariseVitals([agent(), hurt, laggy])

    expect(summary.lowestHealth).toEqual({ agent: hurt, value: 4 })
    expect(summary.worstPing).toEqual({ agent: laggy, value: 320 })
  })

  /**
   * Telemetry outlives the session it was taken in, so an agent that has left the game still carries
   * numbers. Reporting them would put a health bar on an agent that is not there.
   */
  it('ignores agents that are not in game, however recently they reported', () => {
    const gone = agent({ id: 2, state: 'LINKED', telemetry: { ...agent().telemetry!, health: 1 } })

    const summary = summariseVitals([agent(), gone])

    expect(summary.lowestHealth?.value).toBe(20)
    expect(summary.online).toBe(1)
  })

  it('counts who is reporting separately from who is in game', () => {
    const silent = agent({ id: 2, telemetry: null })

    const summary = summariseVitals([agent(), silent])

    expect(summary.online).toBe(2)
    expect(summary.reporting).toBe(1)
  })

  /** Nothing to report is null, not zero — zero is a reading, and a wrong one. */
  it('reports nothing rather than zero when nobody has said anything', () => {
    expect(summariseVitals([]).lowestHealth).toBeNull()
    expect(summariseVitals([agent({ telemetry: null })]).worstPing).toBeNull()
  })

  /** Otherwise the card swaps between two equally unhealthy agents on every sample. */
  it('keeps the first agent on a tie', () => {
    const first = agent({ id: 1, label: 'a', telemetry: { ...agent().telemetry!, food: 3 } })
    const second = agent({ id: 2, label: 'b', telemetry: { ...agent().telemetry!, food: 3 } })

    expect(summariseVitals([first, second]).lowestFood?.agent.label).toBe('a')
  })
})

describe('how far apart the fleet is standing', () => {
  const at = (id: number, x: number, z: number, dimension = 'overworld') =>
    agent({
      id,
      label: `a${id}`,
      telemetry: { ...agent().telemetry!, dimension, position: { x, y: 64, z } },
    })

  it('reports the widest gap and both agents in it', () => {
    const summary = summariseVitals([at(1, 0, 0), at(2, 30, 40), at(3, 3, 4)])

    expect(summary.spread?.blocks).toBe(50)
    expect([summary.spread?.from.id, summary.spread?.to.id]).toEqual([1, 2])
  })

  /**
   * The nether is 1:8 to the overworld, so subtracting one from the other is two coordinate systems
   * subtracted, not a distance. A portal must not invent a spread of thousands of blocks.
   */
  it('never measures across dimensions', () => {
    const summary = summariseVitals([at(1, 0, 0), at(2, 5000, 0, 'the_nether')])

    expect(summary.spread).toBeNull()
  })

  it('takes the widest gap found inside any one dimension', () => {
    const summary = summariseVitals([
      at(1, 0, 0),
      at(2, 10, 0),
      at(3, 0, 0, 'the_nether'),
      at(4, 400, 0, 'the_nether'),
    ])

    expect(summary.spread?.blocks).toBe(400)
    expect(summary.spread?.dimension).toBe('the_nether')
  })

  it('has nothing to report about one agent, or none', () => {
    expect(summariseVitals([at(1, 0, 0)]).spread).toBeNull()
    expect(summariseVitals([]).spread).toBeNull()
  })
})

/**
 * The same error as the nether one, one level up: a different Minecraft server is a different map,
 * so two agents at spawn on two servers are not zero blocks apart — they are incomparable.
 */
describe('spread never leaves one world', () => {
  const on = (id: number, server: string, x: number) =>
    agent({
      id,
      label: `a${id}`,
      serverAddress: server,
      telemetry: { ...agent().telemetry!, position: { x, y: 64, z: 0 } },
    })

  it('never measures across servers', () => {
    expect(summariseVitals([on(1, 'a:25565', 0), on(2, 'b:25565', 900)]).spread).toBeNull()
  })

  it('takes the widest gap inside a single server', () => {
    const summary = summariseVitals([
      on(1, 'a:25565', 0),
      on(2, 'a:25565', 20),
      on(3, 'b:25565', 0),
      on(4, 'b:25565', 500),
    ])

    expect(summary.spread?.blocks).toBe(500)
    expect(summary.spread?.server).toBe('b:25565')
  })
})
