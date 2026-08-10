import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { formatUptime, useAgentStore } from './agents'
import type { AgentResponse, HostResponse } from '../api/client'
import { respondWith } from '../test/http'

const HOSTS: HostResponse[] = [
  { id: 1, name: 'eu-1', address: '10.0.0.4', hostVersion: '0.1.0', lastSeenAt: null, reachable: true, agentCount: 4 },
  { id: 2, name: 'eu-2', address: null, hostVersion: null, lastSeenAt: null, reachable: false, agentCount: 1 },
]

/**
 * Ids are load-bearing: mock telemetry is derived from them, so these are chosen to give two clean
 * online agents on one server, plus one agent that trips a health alert.
 */
const AGENTS: AgentResponse[] = [
  agent({ id: 6, state: 'ONLINE', serverAddress: 'alpha.example:25565' }),
  agent({ id: 12, state: 'ONLINE', serverAddress: 'alpha.example:25565' }),
  agent({ id: 7, state: 'STALE', serverAddress: 'alpha.example:25565' }),
  agent({ id: 3, state: 'LINKED', serverAddress: 'beta.example:25565' }),
  agent({ id: 5, state: 'ONLINE', serverAddress: 'beta.example:25565' }),
]

function agent(fields: Pick<AgentResponse, 'id' | 'state' | 'serverAddress'>): AgentResponse {
  return {
    label: `Mason_${fields.id}`,
    hostId: 1,
    hostName: 'eu-1',
    mcUsername: null,
    mcUuid: null,
    ...fields,
  }
}

function fleet(agents: AgentResponse[] = AGENTS) {
  respondWith((call) => {
    if (call.url.endsWith('/api/hosts')) return { body: HOSTS }
    if (call.url.endsWith('/api/agents')) return { body: agents }
    throw new Error(`Unexpected request to ${call.url}`)
  })
}

describe('fleet store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('counts only agents that are in game as online', async () => {
    fleet()
    const store = useAgentStore()

    await store.refresh()

    expect(store.online.map((b) => b.id)).toEqual([6, 12, 5])
  })

  it('reports each distinct server once, sorted', async () => {
    fleet()
    const store = useAgentStore()

    await store.refresh()

    expect(store.servers).toEqual(['alpha.example:25565', 'beta.example:25565'])
  })

  describe('chat listeners', () => {
    it('elects one listener per server, not one per fleet', async () => {
      fleet()
      const store = useAgentStore()

      await store.refresh()

      expect(Object.keys(store.chatListeners)).toEqual([
        'alpha.example:25565',
        'beta.example:25565',
      ])
    })

    // Stability is the point: the longest-running agent wins, so an agent joining never displaces a
    // listener that is already working.
    it('picks the longest-running online agent', async () => {
      fleet()
      const store = useAgentStore()

      await store.refresh()

      expect(store.chatListeners['alpha.example:25565']?.id).toBe(12)
    })

    it('leaves a server without a listener when nothing there is online', async () => {
      fleet([agent({ id: 3, state: 'LINKED', serverAddress: 'gamma.example:25565' })])
      const store = useAgentStore()

      await store.refresh()

      expect(store.chatListeners['gamma.example:25565']).toBeUndefined()
    })
  })

  describe('attention', () => {
    it('flags an unreachable host as unknown rather than offline', async () => {
      fleet()
      const store = useAgentStore()

      await store.refresh()

      const stale = store.attention.find((item) => item.agent.id === 7)
      expect(stale).toMatchObject({ reason: 'Host unreachable', severity: 'error' })
    })

    it('raises health alerts for online agents', async () => {
      fleet()
      const store = useAgentStore()

      await store.refresh()

      expect(store.attention.find((item) => item.agent.id === 5)?.reason).toBe('Health 10/20')
    })

    it('ignores telemetry thresholds for agents that are not in game', async () => {
      fleet()
      const store = useAgentStore()

      await store.refresh()

      // Agent 3 is LINKED, so its zeroed telemetry must not read as starving on 0 health.
      expect(store.attention.some((item) => item.agent.id === 3)).toBe(false)
    })

    it('orders errors ahead of warnings', async () => {
      fleet()
      const store = useAgentStore()

      await store.refresh()

      const severities = store.attention.map((item) => item.severity)
      expect(severities).toEqual([...severities].sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1)))
    })
  })

  it('keeps telemetry across a refresh so the view does not reset on every poll', async () => {
    fleet()
    const store = useAgentStore()
    await store.refresh()
    store.byId(6)!.telemetry.blocksPlaced = 999

    await store.refresh()

    expect(store.byId(6)!.telemetry.blocksPlaced).toBe(999)
  })

  it('surfaces a load failure instead of throwing', async () => {
    respondWith(() => ({ status: 503, body: { message: 'Backend is down' } }))
    const store = useAgentStore()

    await store.refresh()

    expect(store.error).toBe('Backend is down')
    expect(store.loading).toBe(false)
  })

  it('sends no chat message when it is only whitespace', async () => {
    const store = useAgentStore()

    await store.say(6, '   ')

    expect(store.error).toBeNull()
  })
})

describe('live updates', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('replaces an agent in place when the backend reports a state change', async () => {
    fleet()
    const store = useAgentStore()
    await store.refresh()

    store.applyEvent('agent', { ...agent({ id: 6, state: 'STALE', serverAddress: 'alpha.example:25565' }) })

    expect(store.byId(6)!.state).toBe('STALE')
    expect(store.agents).toHaveLength(AGENTS.length)
  })

  // The mock telemetry is stable per id, so losing it on every event would reshuffle the UI.
  it('keeps telemetry when an agent is updated by an event', async () => {
    fleet()
    const store = useAgentStore()
    await store.refresh()
    store.byId(6)!.telemetry.blocksPlaced = 4242

    store.applyEvent('agent', { ...agent({ id: 6, state: 'ONLINE', serverAddress: 'alpha.example:25565' }) })

    expect(store.byId(6)!.telemetry.blocksPlaced).toBe(4242)
  })

  it('adds an agent it has never seen', async () => {
    fleet()
    const store = useAgentStore()
    await store.refresh()

    store.applyEvent('agent', agent({ id: 99, state: 'UNLINKED', serverAddress: 'gamma.example:25565' }))

    expect(store.byId(99)).toBeDefined()
  })

  it('drops an agent that was removed', async () => {
    fleet()
    const store = useAgentStore()
    await store.refresh()

    store.applyEvent('agent-removed', { id: 6 })

    expect(store.byId(6)).toBeUndefined()
  })

  it('drops a host that was removed', async () => {
    fleet()
    const store = useAgentStore()
    await store.refresh()

    store.applyEvent('host-removed', { id: 1 })

    expect(store.hostById(1)).toBeUndefined()
  })

  // A newer backend may send event types this build has never heard of; that must not throw.
  it('ignores an unknown event type', async () => {
    fleet()
    const store = useAgentStore()
    await store.refresh()

    expect(() => store.applyEvent('something-new', { whatever: true })).not.toThrow()
    expect(store.agents).toHaveLength(AGENTS.length)
  })
})

describe('formatUptime', () => {
  it('shows a dash rather than a zero for an agent that was never up', () => {
    expect(formatUptime(0)).toBe('—')
  })

  it('drops the hour component below an hour', () => {
    expect(formatUptime(90)).toBe('1m 30s')
  })

  it('shows hours and minutes above an hour', () => {
    expect(formatUptime(3_700)).toBe('1h 1m')
  })
})
