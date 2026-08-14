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
  spread: Spread | null
}

/** The two agents standing furthest apart, and how far that is. */
export interface Spread {
  from: FleetAgent
  to: FleetAgent
  blocks: number
  dimension: string
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
    spread: widestGap(reporting),
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

/**
 * How far apart the fleet is standing, as the widest gap between any two agents.
 *
 * **Compared only within a dimension.** The nether is 1:8 to the overworld, so the distance between
 * an agent in one and an agent in the other is not a distance at all — it is two coordinate systems
 * subtracted from each other. Agents are grouped by dimension and the widest gap found in any one
 * of them is reported, rather than a number that would be quietly wrong the moment somebody built
 * a portal.
 *
 * Every pair, rather than a bounding box: a fleet is tens of agents, and the exact pair is what
 * makes the number actionable — it names who to look at.
 */
function widestGap(agents: FleetAgent[]): Spread | null {
  const byDimension = new Map<string, FleetAgent[]>()
  for (const agent of agents) {
    const dimension = agent.telemetry!.dimension
    byDimension.set(dimension, [...(byDimension.get(dimension) ?? []), agent])
  }

  let widest: Spread | null = null

  for (const [dimension, here] of byDimension) {
    for (let i = 0; i < here.length; i += 1) {
      for (let j = i + 1; j < here.length; j += 1) {
        const blocks = Math.round(distance(here[i]!, here[j]!))
        if (!widest || blocks > widest.blocks) {
          widest = { from: here[i]!, to: here[j]!, blocks, dimension }
        }
      }
    }
  }

  return widest
}

function distance(one: FleetAgent, other: FleetAgent): number {
  const a = one.telemetry!.position
  const b = other.telemetry!.position
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}
