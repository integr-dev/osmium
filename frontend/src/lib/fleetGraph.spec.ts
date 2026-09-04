import { describe, expect, it } from 'vitest'
import { agentHealth, fleetGraph, hostHealth } from './fleetGraph'
import type { AgentResponse, HostResponse } from '../api/client'

const NOW = Date.parse('2026-08-23T12:00:00Z')
const fresh = new Date(NOW - 2_000).toISOString()
const old = new Date(NOW - 25_000).toISOString()

function host(id: number, over: Partial<HostResponse> = {}): HostResponse {
  return {
    id,
    name: `host-${id}`,
    hostVersion: '0.7.0',
    lastSeenAt: fresh,
    reachable: true,
    agentCount: 0,
    loginMethods: [],
    proxies: [],
    ...over,
  }
}

function agent(id: number, hostId: number, over: Partial<AgentResponse> = {}): AgentResponse {
  return {
    id,
    label: `Mason_${id}`,
    hostId,
    hostName: `host-${hostId}`,
    serverAddress: 'mc.example.com:25565',
    state: 'ONLINE',
    mcUsername: null,
    mcUuid: null,
    onlineSince: null,
    chatListener: false,
    ...over,
  } as AgentResponse
}

describe('hostHealth', () => {
  it('calls an unreachable host down however recently it was seen', () => {
    expect(hostHealth({ reachable: false, lastSeenAt: fresh })).toBe('down')
  })

  /**
   * The bug this replaced: health was read off how old `lastSeenAt` was, which cannot work.
   * Heartbeats are not published — deliberately — so that timestamp freezes when the host connects
   * and ages forever, and every host turned amber a few seconds after the page loaded.
   */
  it('does not age a reachable host out on its own', () => {
    expect(hostHealth({ reachable: true, lastSeenAt: fresh })).toBe('live')
    expect(hostHealth({ reachable: true, lastSeenAt: old })).toBe('live')
  })

  it('treats a host that has never reported as stale rather than dead', () => {
    expect(hostHealth({ reachable: true, lastSeenAt: null })).toBe('stale')
  })
})

describe('agentHealth', () => {
  it('lights only the states where something is actually flowing', () => {
    expect(agentHealth('ONLINE')).toBe('live')
    expect(agentHealth('LINKED')).toBe('down')
    expect(agentHealth('UNLINKED')).toBe('down')
  })

  it('is amber where the answer is unknown rather than negative', () => {
    // Both are cases where "nothing is happening" would be the wrong thing to draw.
    expect(agentHealth('STALE')).toBe('stale')
    expect(agentHealth('SETUP_PENDING')).toBe('stale')
  })
})

describe('fleetGraph', () => {
  it('gives every agent its own row and centres its host on them', () => {
    const graph = fleetGraph([host(1)], [agent(10, 1), agent(11, 1)])

    const agents = graph.nodes.filter((node) => node.kind === 'agent')
    const [owner] = graph.nodes.filter((node) => node.kind === 'host')

    expect(agents).toHaveLength(2)
    expect(agents[0].at.y).not.toBe(agents[1].at.y)
    // The mean, which is what makes the fan symmetrical rather than hung off the first child.
    expect(owner.at.y).toBeCloseTo((agents[0].at.y + agents[1].at.y) / 2)
  })

  /** Half the fleet each side, which is half the height. */
  it('puts consecutive hosts on opposite sides of Osmium', () => {
    const graph = fleetGraph([host(1), host(2), host(3)], [])

    const middle = graph.nodes.find((node) => node.id === 'osmium')!.at.x
    const side = (id: number) =>
      Math.sign(graph.nodes.find((node) => node.id === `host-${id}`)!.at.x - middle)

    expect(side(1)).toBe(-side(2))
    // Alternating rather than split down the middle of the list: adding a host must not move every
    // host after it across the picture.
    expect(side(3)).toBe(side(1))
  })

  /** The other half of not being a stripe: a busy host is a block, not a screen and a half. */
  it('wraps the agents of a host into a second column rather than one long run', () => {
    // Twelve deep is what a lone host is allowed before it wraps; the thirteenth starts a column.
    const many = Array.from({ length: 13 }, (_, index) => agent(index + 1, 1))
    const graph = fleetGraph([host(1)], many)

    const seats = graph.nodes.filter((node) => node.kind === 'agent')
    const columns = new Set(seats.map((seat) => seat.at.x))
    const rows = new Set(seats.map((seat) => seat.at.y))

    expect(columns.size).toBe(2)
    // Twelve rows for thirteen agents, not thirteen.
    expect(rows.size).toBe(12)
  })

  it('keeps each host and its agents in one uncrossed band', () => {
    // Interleaved on the way in: grouping has to come from the layout, not from arrival order.
    // Hosts 1 and 3 share a side, so their bands are what must not overlap.
    const graph = fleetGraph(
      [host(1), host(2), host(3)],
      [agent(10, 1), agent(30, 3), agent(11, 1), agent(31, 3)],
    )

    const rows = graph.nodes
      .filter((node) => node.kind === 'agent')
      .filter((node) => [10, 11, 30, 31].includes(node.ref!))
      .sort((a, b) => a.at.y - b.at.y)
      .map((node) => node.ref)

    // Both of host 1's agents above both of host 3's, so no edge has to cross another.
    expect(rows).toEqual([10, 11, 30, 31])

    const owner = (id: number) => graph.nodes.find((node) => node.id === `host-${id}`)!.at.y
    expect(owner(1)).toBeLessThan(owner(3))
  })

  it('still draws a host that is running nothing', () => {
    const graph = fleetGraph([host(1), host(2)], [agent(10, 1)])

    const idle = graph.nodes.find((node) => node.id === 'host-2')
    expect(idle).toBeDefined()
    // Its socket is real even with no agents behind it, so it gets a row and a link.
    expect(graph.links.some((link) => link.id === 'osmium-2')).toBe(true)
  })

  it('cannot show an agent as healthier than the socket carrying it', () => {
    // Its stored state says ONLINE; the only party that can see the session has gone.
    const graph = fleetGraph([host(1, { reachable: false })], [agent(10, 1)])

    expect(graph.nodes.find((node) => node.id === 'agent-10')!.health).toBe('down')
  })

  it('moves packets only where something is flowing', () => {
    const graph = fleetGraph(
      [host(1), host(2, { reachable: false })],
      [agent(10, 1), agent(20, 2)],
    )

    const link = (id: string) => graph.links.find((entry) => entry.id === id)!

    expect(link('osmium-1').packets).toBeGreaterThan(0)
    expect(link('osmium-2').packets).toBe(0)
    expect(link('2-20').packets).toBe(0)
  })

  /**
   * The two outer tiers. An agent with a server reaches it; one with a proxy reaches it through
   * that proxy; and neither node is invented for an agent that named neither.
   */
  it('draws an agent straight to its server when it names no proxy', () => {
    const graph = fleetGraph([host(1)], [agent(10, 1)])

    const server = graph.nodes.find((node) => node.kind === 'server')
    expect(server?.label).toBe('mc.example.com:25565')
    expect(graph.nodes.some((node) => node.kind === 'proxy')).toBe(false)

    // Straight from the agent, because a direct connection has no middle to draw.
    const seat = graph.nodes.find((node) => node.kind === 'agent')!
    expect(graph.links.some((link) => link.from.x === seat.at.x && link.to.x === server!.at.x)).toBe(true)
  })

  it('puts a proxy between an agent and its server when one is named', () => {
    const graph = fleetGraph(
      [host(1)],
      [agent(10, 1, { settings: { 'connect.proxy': 'resi-eu' } } as Partial<AgentResponse>)],
    )

    const proxy = graph.nodes.find((node) => node.kind === 'proxy')!
    const server = graph.nodes.find((node) => node.kind === 'server')!
    const seat = graph.nodes.find((node) => node.kind === 'agent')!

    expect(proxy.label).toBe('resi-eu')
    // Outward in order: the agent, then the proxy, then the server, all on the same side.
    expect(Math.abs(proxy.at.x)).toBeGreaterThan(Math.abs(seat.at.x))
    expect(Math.abs(server.at.x)).toBeGreaterThan(Math.abs(proxy.at.x))
    expect(Math.sign(proxy.at.x - seat.at.x)).toBe(Math.sign(server.at.x - proxy.at.x))
  })

  /** An agent assigned nowhere has nowhere to draw to, rather than a node saying so. */
  it('draws no route for an agent with no server', () => {
    const graph = fleetGraph([host(1)], [agent(10, 1, { serverAddress: null })])

    expect(graph.nodes.some((node) => node.kind === 'server')).toBe(false)
    expect(graph.nodes.some((node) => node.kind === 'proxy')).toBe(false)
  })

  /** Two agents on one server is one server node, at the mean of the two. */
  it('gathers agents onto one stop rather than drawing it twice', () => {
    const graph = fleetGraph([host(1)], [agent(10, 1), agent(11, 1)])

    const servers = graph.nodes.filter((node) => node.kind === 'server')
    const seats = graph.nodes.filter((node) => node.kind === 'agent')

    expect(servers).toHaveLength(1)
    expect(servers[0].at.y).toBeCloseTo((seats[0].at.y + seats[1].at.y) / 2)
  })

  /**
   * The health rule for the route tiers, and the reason they can be drawn at all: an agent that is
   * ONLINE has proved the path, so one live agent makes the route live however many of its
   * neighbours are sitting at LINKED.
   */
  it('takes a route as proved by the best agent on it', () => {
    const graph = fleetGraph(
      [host(1)],
      [agent(10, 1, { state: 'LINKED' }), agent(11, 1, { state: 'ONLINE' })],
    )

    expect(graph.nodes.find((node) => node.kind === 'server')!.health).toBe('live')
  })

  it('draws a route nobody has got through as dead rather than as working', () => {
    const graph = fleetGraph([host(1)], [agent(10, 1, { state: 'LINKED' })])

    expect(graph.nodes.find((node) => node.kind === 'server')!.health).toBe('down')
  })

  /** One proxy serving two agents on one server is one line onward, not two stacked on each other. */
  it('draws the proxy-to-server line once however many agents take it', () => {
    const graph = fleetGraph(
      [host(1)],
      [
        agent(10, 1, { settings: { 'connect.proxy': 'resi-eu' } } as Partial<AgentResponse>),
        agent(11, 1, { settings: { 'connect.proxy': 'resi-eu' } } as Partial<AgentResponse>),
      ],
    )

    const proxy = graph.nodes.find((node) => node.kind === 'proxy')!
    const onward = graph.links.filter(
      (link) => link.from.x === proxy.at.x && link.from.y === proxy.at.y,
    )

    expect(onward).toHaveLength(1)
  })

  it('puts Osmium first and halfway down, so every edge leaves one point', () => {
    const graph = fleetGraph([host(1), host(2)], [agent(10, 1), agent(20, 2)])

    const [first] = graph.nodes
    expect(first.id).toBe('osmium')
    expect(first.at.y).toBe(graph.height / 2)
  })

  it('is tall enough for an empty fleet to render at all', () => {
    const graph = fleetGraph([], [])

    expect(graph.height).toBeGreaterThan(0)
    expect(graph.nodes).toHaveLength(1)
    expect(graph.links).toHaveLength(0)
  })
})
