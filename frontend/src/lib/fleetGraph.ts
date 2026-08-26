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

/** How far out from Osmium each tier stands, and how far apart two agent columns are. */
const HOST_REACH = 200
const AGENT_REACH = 400
const COLUMN_STEP = 200

/**
 * Vertical pitch between agent slots, at its tightest and at its loosest.
 *
 * A range rather than a number, because the tiers are horizontal and their width is therefore
 * fixed by the deployment rather than by the drawing: three tiers of a two-host fleet are as wide
 * as three tiers of a twenty-host one. Left at a constant, that made every small fleet a flat
 * band across the panel. The rows are spread to fill the height instead, up to the point where
 * spreading them further would just be a gap.
 */
const ROW_MIN = 46
const ROW_MAX = 180

/** What the finished picture is aimed at, being roughly the shape of the panel it is drawn in. */
const ASPECT = 1.8

/**
 * Rows one host may use before its agents wrap into a second column.
 *
 * Fewer as the fleet grows: with one host there is nothing to stack under, so it may run twelve
 * deep, while eight hosts sharing two sides get four each. This is the number that stops a busy
 * fleet being a stripe — one row per agent read straight down the page, so twenty agents was a
 * screen and a half — and the reason it is not a constant is that the same cap makes a small
 * fleet too short to fill anything.
 */
function rowsPerHost(hosts: number): number {
  const perSide = Math.max(1, Math.ceil(hosts / 2))
  return Math.min(12, Math.max(3, Math.round(14 / perSide)))
}

const PADDING = 48

/**
 * Room for a label beside the node it names.
 *
 * The bounds were the nodes and nothing else, so the outermost agent on each side had its name
 * written past the edge of the picture and clipped there — `Mason_12` arrived as `Mason`. SVG
 * text has no width until it is measured in a browser, and this is a layout that must be the same
 * on every machine, so the allowance is a constant: about fifteen characters at the size labels
 * are drawn.
 */
const LABEL_ROOM = 150

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

/**
 * How a host's socket to Osmium is doing.
 *
 * **`reachable` is the whole answer, and deliberately so.** Reading freshness off `lastSeenAt` here
 * looked like a finer-grained version of the same thing and was not: heartbeats are not published,
 * on purpose — ten seconds per host times every open browser is pure noise — so that timestamp
 * freezes at the moment the host connected and ages forever. A host was amber within twelve seconds
 * of the page loading and stayed there. The graph was measuring how long the tab had been open.
 *
 * The backend already owns this judgement, against a 30s grace and the heartbeats it actually
 * receives, and announces every change. Amber is left to the one case the browser can see for
 * itself: reachable, but nothing has ever been heard from it.
 */
export function hostHealth(host: Pick<HostResponse, 'reachable' | 'lastSeenAt'>): LinkHealth {
  if (!host.reachable) return 'down'
  return host.lastSeenAt ? 'live' : 'stale'
}

/**
 * Lays the fleet out in tiers either side of Osmium.
 *
 * Osmium in the middle, its hosts outward from it, their agents outward again — the reading order
 * is still what can reach what, and every edge still leaves one point and arrives at another with
 * nothing crossing it.
 *
 * **Two things stop it being a stripe.** Hosts alternate sides, so half the fleet is drawn to the
 * left of Osmium and half to the right and the picture is half as tall for it. And a host's agents
 * wrap into a second column at [ROWS_PER_HOST] rather than continuing down the page, so a host with
 * twenty of them is a block rather than a screen and a half.
 *
 * Both are about the same failing: the earlier version grew downward and only downward, so a fleet
 * of forty was three screens of scrolling and the shape said nothing except how many rows there
 * were. What is drawn now spends its room in both directions and can be read at a glance.
 *
 * A host sits at the mean of its own agents, which is what makes each fan symmetrical and keeps a
 * host visually inside the group it owns rather than beside it. A host running nothing takes a row
 * of its own, because its socket is still worth drawing.
 *
 * Deterministic, and positioned from nothing but the two lists: the same fleet draws the same
 * picture on every machine, which is what makes a layout something a test can hold.
 */
export function fleetGraph(hosts: HostResponse[], agents: AgentResponse[]): FleetGraph {
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []

  // Osmium at the origin, its sides mirror images. Everything is shifted into frame at the end, so
  // no coordinate below has to know how big the drawing turned out to be.
  const osmium: Point = { x: 0, y: 0 }

  const wrap = rowsPerHost(hosts.length)

  /**
   * Planned before it is placed.
   *
   * How tall a row should be depends on how many rows there are and how wide the picture came out,
   * and neither is known until every host has been dealt out. So the first pass decides who sits
   * where in rows and columns, and the second turns that into coordinates.
   */
  const banks = [
    { direction: 1, slot: 0 },
    { direction: -1, slot: 0 },
  ]

  const planned = hosts.map((host, index) => {
    // Alternating rather than split down the middle of the list, so adding a host does not move
    // every host after it to the other side of the picture.
    const bank = banks[index % banks.length]!
    const owned = agents.filter((agent) => agent.hostId === host.id)
    const top = bank.slot

    bank.slot += Math.max(1, Math.min(owned.length, wrap))

    return { host, owned, top, side: bank.direction }
  })

  const columns = Math.max(0, ...planned.map(({ owned }) => Math.ceil(owned.length / wrap) - 1))
  const reach = AGENT_REACH + columns * COLUMN_STEP
  const span = reach * (hosts.length > 1 ? 2 : 1)
  const rows = Math.max(1, ...banks.map((bank) => bank.slot))

  // Spread to fill, then held: past `ROW_MAX` the rows are no longer laid out, they are adrift.
  const pitch = Math.min(ROW_MAX, Math.max(ROW_MIN, span / ASPECT / rows))

  for (const { host, owned, top, side } of planned) {
    const health = hostHealth(host)

    const seats: GraphNode[] = owned.map((agent, place) => {
      // An agent on an unreachable host cannot be better than the socket carrying it: its stored
      // state is a claim nobody can currently confirm.
      const state = health === 'down' ? 'down' : agentHealth(agent.state)

      return {
        id: `agent-${agent.id}`,
        kind: 'agent',
        label: agent.label,
        ref: agent.id,
        at: {
          x: side * (AGENT_REACH + Math.floor(place / wrap) * COLUMN_STEP),
          y: (top + (place % wrap)) * pitch + pitch / 2,
        },
        health: state,
        detail: agent.serverAddress ?? undefined,
      }
    })

    const at: Point = {
      x: side * HOST_REACH,
      y: seats.length
        ? seats.reduce((total, seat) => total + seat.at.y, 0) / seats.length
        : top * pitch + pitch / 2,
    }

    nodes.push({
      id: `host-${host.id}`,
      kind: 'host',
      label: host.name,
      ref: host.id,
      at,
      health,
      detail: host.hostVersion ?? undefined,
    })

    links.push({
      id: `osmium-${host.id}`,
      from: osmium,
      to: at,
      health,
      packets: PACKETS[health],
    })

    for (const seat of seats) {
      nodes.push(seat)
      links.push({
        id: `${host.id}-${seat.ref}`,
        from: at,
        to: seat.at,
        health: seat.health,
        packets: PACKETS[seat.health],
      })
    }
  }

  // Halfway down the taller side, so every edge leaves one point and the two sides balance on it.
  osmium.y = (rows * pitch) / 2
  nodes.unshift({
    id: 'osmium',
    kind: 'osmium',
    label: 'Osmium',
    at: osmium,
    health: 'live',
  })

  // Shifted into frame last, which is where the mirror stops being two signs and becomes a picture.
  const xs = nodes.map((node) => node.at.x)
  const ys = nodes.map((node) => node.at.y)

  // Each side gets label room, because each side writes its labels outward. See [LABEL_ROOM].
  const left = Math.min(...xs) - PADDING - LABEL_ROOM
  const top = Math.min(...ys) - PADDING

  for (const node of nodes) {
    node.at.x -= left
    node.at.y -= top
  }

  return {
    nodes,
    links,
    width: Math.max(...xs) + PADDING + LABEL_ROOM - left,
    height: Math.max(...ys) + PADDING - top,
  }
}
