import { isOnline, type FleetAgent } from '../stores/agents'

/**
 * The fleet's vitals, reduced to the agents worth looking at first.
 *
 * A dashboard cannot show twenty agents' health bars, and an average hides the one that matters: a
 * fleet averaging 18 health with one agent on 2 is a fleet with a problem. So each reading is
 * reported as its **worst case and who it belongs to**, which is the agent you would open.
 */
export interface VitalsExtreme {
  agent: FleetAgent
  value: number
}

export interface VitalsSummary {
  /** Agents in game, and how many of those have actually reported. */
  online: number
  reporting: number
  lowestHealth: VitalsExtreme | null
  lowestFood: VitalsExtreme | null
  worstPing: VitalsExtreme | null
}

export function summariseVitals(agents: FleetAgent[]): VitalsSummary {
  const online = agents.filter(isOnline)

  /**
   * Only agents that are both in game **and** reporting.
   *
   * Telemetry outlives the session it was taken in — the last reading stays until something
   * replaces it — so an agent that has left the game still carries numbers. Reporting them would
   * put a health bar on an agent that is not there.
   */
  const reporting = online.filter((agent) => agent.telemetry !== null)

  return {
    online: online.length,
    reporting: reporting.length,
    lowestHealth: extreme(reporting, (agent) => agent.telemetry!.health, Math.min),
    lowestFood: extreme(reporting, (agent) => agent.telemetry!.food, Math.min),
    worstPing: extreme(reporting, (agent) => agent.telemetry!.pingMs, Math.max),
  }
}

/**
 * The agent at one end of a reading, or null when nobody is reporting.
 *
 * Ties keep the first agent in the list rather than the last, so the card does not swap between two
 * equally unhealthy agents every time a sample lands.
 */
function extreme(
  agents: FleetAgent[],
  read: (agent: FleetAgent) => number,
  pick: (...values: number[]) => number,
): VitalsExtreme | null {
  if (!agents.length) return null

  const target = pick(...agents.map(read))
  const found = agents.find((agent) => read(agent) === target)
  return found ? { agent: found, value: target } : null
}
