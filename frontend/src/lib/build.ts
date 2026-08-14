import type { FleetAgent } from '../stores/agents'
import { isOnline } from './agentState'

/**
 * Build progress for a set of agents.
 *
 * **Still mock**, like everything hanging off `agent.build` — but taking the agents as an argument
 * rather than reading the whole fleet is what lets the dashboard ask the question per server. A
 * schematic is built *on* a server, so summing two servers' progress adds up two unrelated builds.
 */
export interface BuildFigures {
  placed: number
  /** What this set of agents is working towards: one schematic for each server they are on. */
  target: number
  percent: number
  perMinute: number
  /** Null when nothing is being placed, which is most of the time. An ETA needs a rate. */
  etaMinutes: number | null
}

/** Invented, and the one number here with no basis at all. See the store. */
const BLOCKS_PER_BUILDER_PER_MINUTE = 38

export function buildFigures(agents: FleetAgent[], schematicBlocks: number): BuildFigures {
  const placed = agents.reduce((sum, agent) => sum + agent.build.blocksPlaced, 0)

  /**
   * **One schematic per server, not one for the fleet.**
   *
   * A schematic is built on a server, so a fleet spread across three of them is building three
   * copies of it. Dividing the sum of all three by a single schematic's block count reported the
   * whole fleet as finished the moment the copies together added up — 100% and no time remaining,
   * while every individual server still had hours to go.
   *
   * Agents assigned nowhere add no target. They cannot connect, so they are not building anything.
   */
  const servers = new Set(agents.map((agent) => agent.serverAddress).filter((it) => it !== null))
  const target = schematicBlocks * Math.max(1, servers.size)

  // Builders, not bodies: an agent standing in the world having placed nothing contributes no rate.
  const perMinute = rateOf(agents)

  return {
    placed,
    target,
    percent: target > 0 ? Math.min(100, (placed / target) * 100) : 0,
    perMinute,
    etaMinutes: etaOf(agents, schematicBlocks, servers),
  }
}

function rateOf(agents: FleetAgent[]): number {
  const building = agents.filter((agent) => isOnline(agent) && agent.build.blocksPlaced > 0).length
  return building * BLOCKS_PER_BUILDER_PER_MINUTE
}

/**
 * When the last server finishes, not when the pooled work divided by the pooled rate runs out.
 *
 * Those are different numbers, and the pooled one is wrong: it assumes an agent on one server can
 * help finish the build on another, which is exactly what it cannot do. A fleet where one server
 * needs twelve hours and another seven does not finish in ten — it finishes in twelve.
 *
 * A server with work left and nobody placing never finishes at all, so the answer is null rather
 * than the longest of the servers that happen to be moving.
 */
function etaOf(agents: FleetAgent[], schematicBlocks: number, servers: Set<string>): number | null {
  // Nothing is assigned anywhere, so there is one nominal build and no server to split by.
  if (servers.size === 0) {
    const rate = rateOf(agents)
    const placed = agents.reduce((sum, agent) => sum + agent.build.blocksPlaced, 0)
    return rate === 0 ? null : Math.max(0, Math.round((schematicBlocks - placed) / rate))
  }

  let longest = 0

  for (const server of servers) {
    const here = agents.filter((agent) => agent.serverAddress === server)
    const remaining = schematicBlocks - here.reduce((sum, agent) => sum + agent.build.blocksPlaced, 0)
    if (remaining <= 0) continue

    const rate = rateOf(here)
    if (rate === 0) return null

    longest = Math.max(longest, Math.round(remaining / rate))
  }

  return longest
}
