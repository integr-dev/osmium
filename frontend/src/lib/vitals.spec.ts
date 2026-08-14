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
