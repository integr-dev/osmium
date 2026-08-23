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
    expect(owner.at.y).toBe((agents[0].at.y + agents[1].at.y) / 2)
  })

  it('keeps each host and its agents in one uncrossed band', () => {
    // Interleaved on the way in: grouping has to come from the layout, not from arrival order.
    const graph = fleetGraph(
      [host(1), host(2)],
      [agent(10, 1), agent(20, 2), agent(11, 1), agent(21, 2)],
    )

    const rows = graph.nodes
      .filter((node) => node.kind === 'agent')
      .sort((a, b) => a.at.y - b.at.y)
      .map((node) => node.ref)

    // Both of host 1's agents above both of host 2's, so no edge has to cross another.
    expect(rows).toEqual([10, 11, 20, 21])

    const owner = (id: number) => graph.nodes.find((node) => node.id === `host-${id}`)!.at.y
    expect(owner(1)).toBeLessThan(owner(2))
  })

  it('still draws a host that is running nothing', () => {
    const graph = fleetGraph([host(1), host(2)], [agent(10, 1)])

    const idle = graph.nodes.find((node) => node.id === 'host-2')
    expect(idle).toBeDefined()
    // Its socket is real even with no agents behind it, so it gets a row and a link.
    expect(graph.links.some((link) => link.id === 'osmium-2')).toBe(true)
    expect(idle!.at.y).not.toBe(graph.nodes.find((node) => node.id === 'host-1')!.at.y)
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
