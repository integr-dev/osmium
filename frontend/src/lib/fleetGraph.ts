import type { AgentResponse, HostResponse } from '../api/client'

/**
 * The fleet as a graph: Osmium, the hosts dialled into it, and the agents each host runs.
 *
 * Three tiers rather than four. Every edge here is a **process relationship** — a WebSocket, or a
 * client the host owns — so an edge means one party can reach the other and would notice if it
 * could not. A Minecraft server would have been a fourth tier and a different kind of line
 * entirely: nothing on that link reports to Osmium, so its health would have been invented.
 *
 * Layout and health are here rather than in the component because they are the part that can be
 * silently wrong. A misplaced node still renders, as a picture of a fleet that does not exist.
 */

export interface Point {
  x: number
  y: number
}

/**
 * How a link is doing.
 *
 * `stale` is not a lesser `down`. It is the state where something is genuinely in flight or
 * genuinely unknown, and drawing either of those as a dead line claims knowledge we do not have —
 * the same reason an agent on an unreachable host is amber in every other view.
 */
export type LinkHealth = 'live' | 'stale' | 'down'

export interface GraphNode {
  /** Unique across tiers, because a host and an agent can share a numeric id. */
  id: string
  kind: 'osmium' | 'host' | 'agent'
  label: string
  /** The row this stands for, so a click can navigate. Absent on Osmium itself. */
  ref?: number
  at: Point
  /** Of the link that feeds it. Osmium is always `live`: it is the thing doing the asking. */
  health: LinkHealth
  /** Second line under the label. Empty when there is nothing worth saying. */
  detail?: string
}

export interface GraphLink {
  id: string
  from: Point
  to: Point
  health: LinkHealth
  /**
   * How many packets travel this edge at once. Derived from health rather than chosen: motion is
   * the thing an eye catches first across a whole graph, so it has to mean something.
   */
  packets: number
}

export interface FleetGraph {
  nodes: GraphNode[]
  links: GraphLink[]
  width: number
  height: number
}

/** Column centres. Osmium on the left because the arrows describe what it can reach. */
const COLUMN = { osmium: 90, host: 400, agent: 760 }

/** Vertical pitch between agent slots, which is what the whole layout is measured in. */
const ROW = 46

const PADDING = 32

/**
 * A heartbeat older than this, on a host still inside its grace window, reads as stale.
 *
 * The backend's window is 30s and it decides `reachable`; this is the softer line in front of it,
 * so a host about to drop off shows as faltering rather than flipping straight from fine to gone.
 */
const HEARTBEAT_FRESH_MS = 12_000

/** Live is three packets, faltering is one, dead is none. */
const PACKETS: Record<LinkHealth, number> = { live: 3, stale: 1, down: 0 }

/**
 * How an agent's link to its host is doing.
 *
 * Only `ONLINE` is a live link: the host is driving a Minecraft client and telemetry is arriving.
 * `SETUP_PENDING` is a command in flight and `STALE` is a state nobody can currently see — both
 * are amber, because in neither case is the answer "nothing is happening".
 */
export function agentHealth(state: AgentResponse['state']): LinkHealth {
  if (state === 'ONLINE') return 'live'
  if (state === 'SETUP_PENDING' || state === 'STALE') return 'stale'
  return 'down'
}

/** How a host's socket to Osmium is doing. `now` is passed in so this stays a pure function. */
export function hostHealth(host: Pick<HostResponse, 'reachable' | 'lastSeenAt'>, now: number): LinkHealth {
  if (!host.reachable) return 'down'
  if (!host.lastSeenAt) return 'stale'
  return now - Date.parse(host.lastSeenAt) > HEARTBEAT_FRESH_MS ? 'stale' : 'live'
}

/**
 * Lays the fleet out left to right.
 *
 * Agents get one slot each, grouped under their host so no edge crosses another. **A host then
 * sits at the mean of its own agents' slots**, which is what makes the fan symmetrical and keeps a
 * host visually inside the group it owns rather than beside it. A host running nothing takes a slot
 * of its own, because it still has a socket worth drawing.
 */
export function fleetGraph(
  hosts: HostResponse[],
  agents: AgentResponse[],
  now: number,
): FleetGraph {
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []

  let slot = 0
  const y = () => PADDING + slot * ROW + ROW / 2
  const hostPoints: Point[] = []

  for (const host of hosts) {
    const owned = agents.filter((agent) => agent.hostId === host.id)
    const health = hostHealth(host, now)
    const agentNodes: GraphNode[] = []

    for (const agent of owned) {
      agentNodes.push({
        id: `agent-${agent.id}`,
        kind: 'agent',
        label: agent.label,
        ref: agent.id,
        at: { x: COLUMN.agent, y: y() },
        // An agent on an unreachable host cannot be better than the socket carrying it: its stored
        // state is a claim nobody can currently confirm.
        health: health === 'down' ? 'down' : agentHealth(agent.state),
        detail: agent.serverAddress ?? undefined,
      })
      slot += 1
    }

    // Its own slot when it runs nothing, so an idle host is still on the picture.
    const at: Point = {
      x: COLUMN.host,
      y: agentNodes.length
        ? agentNodes.reduce((total, node) => total + node.at.y, 0) / agentNodes.length
        : y(),
    }
    if (!agentNodes.length) slot += 1

    hostPoints.push(at)
    nodes.push({
      id: `host-${host.id}`,
      kind: 'host',
      label: host.name,
      ref: host.id,
      at,
      health,
      detail: host.hostVersion ?? undefined,
    })

    for (const node of agentNodes) {
      nodes.push(node)
      links.push({
        id: `${host.id}-${node.ref}`,
        from: at,
        to: node.at,
        health: node.health,
        packets: PACKETS[node.health],
      })
    }
  }

  const height = Math.max(PADDING * 2 + ROW, PADDING * 2 + slot * ROW)
  const osmium: Point = { x: COLUMN.osmium, y: height / 2 }

  nodes.unshift({ id: 'osmium', kind: 'osmium', label: 'Osmium', at: osmium, health: 'live' })

  hosts.forEach((host, index) => {
    const health = hostHealth(host, now)
    links.unshift({
      id: `osmium-${host.id}`,
      from: osmium,
      to: hostPoints[index],
      health,
      packets: PACKETS[health],
    })
  })

  return { nodes, links, width: COLUMN.agent + PADDING * 4, height }
}
