import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, errorMessage, type AgentResponse, type HostResponse } from '../api/client'

/**
 * Fleet state.
 *
 * Hosts, agents and their lifecycle states are **real** and come from the backend. Telemetry, chat and
 * build progress are still **mock**: the backend has no agent connected yet, so nothing reports
 * health, position or chat. Those parts are marked below and are what the SSE stream will replace.
 */

export interface NearbyPlayer {
  name: string
  distance: number
  isBot: boolean
}

export interface ChatLine {
  at: string
  from: string
  text: string
}

/**
 * Something that happened *to* an agent: kicks, deaths, warnings, connectivity transitions. Kept out
 * of chat so an incident is not buried between two lines of small talk.
 */
export interface ActivityLine {
  at: string
  severity: 'info' | 'warning' | 'error'
  text: string
}

/** MOCK. Replaced by the telemetry stream once an agent reports. */
export interface AgentTelemetry {
  uptimeSeconds: number
  health: number
  food: number
  position: { x: number; y: number; z: number }
  dimension: string
  pingMs: number
  task: string
  blocksPlaced: number
  nearby: NearbyPlayer[]
  chat: ChatLine[]
  activity: ActivityLine[]
}

export type FleetAgent = AgentResponse & { telemetry: AgentTelemetry }

export interface Sector {
  id: string
  name: string
  blocksPlaced: number
  totalBlocks: number
  assigned: string[]
  status: 'done' | 'active' | 'queued' | 'blocked'
}

export interface Attention {
  agent: FleetAgent
  reason: string
  severity: 'error' | 'warning'
}

/** A line of ordinary server chat, forwarded by exactly one elected agent per server. */
export interface GlobalChatLine {
  at: string
  server: string
  from: string
  text: string
}

/** States in which an agent is genuinely in game. */
export function isOnline(agent: AgentResponse): boolean {
  return agent.state === 'ONLINE'
}

export const useAgentStore = defineStore('agents', () => {
  const hosts = ref<HostResponse[]>([])
  const agents = ref<FleetAgent[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  // ---- mock, pending a connected agent -------------------------------------------------------

  const schematic = ref({
    name: 'Cathedral of Osmium',
    totalBlocks: 184_000,
    layers: 62,
    currentLayer: 14,
  })

  const sectors = ref<Sector[]>([
    { id: 'sector-c', name: 'Crypt · sector C', blocksPlaced: 21_400, totalBlocks: 21_400, assigned: [], status: 'done' },
    { id: 'sector-a', name: 'Nave · sector A', blocksPlaced: 12_480, totalBlocks: 48_200, assigned: ['Mason_01'], status: 'active' },
    { id: 'sector-b', name: 'Transept · sector B', blocksPlaced: 11_902, totalBlocks: 39_600, assigned: ['Mason_02'], status: 'active' },
    { id: 'sector-e', name: 'North wing · sector E', blocksPlaced: 9_140, totalBlocks: 34_800, assigned: ['Mason_03'], status: 'blocked' },
    { id: 'sector-d', name: 'Spire · sector D', blocksPlaced: 0, totalBlocks: 40_000, assigned: [], status: 'queued' },
  ])

  const globalChat = ref<GlobalChatLine[]>([
    { at: '14:06', server: 'mc.example.com:25565', from: 'Notch', text: 'that cathedral is getting huge' },
    { at: '14:05', server: 'mc.example.com:25565', from: 'Dinnerbone', text: 'who is running all these agents' },
    { at: '14:03', server: 'mc.example.com:25565', from: 'jeb_', text: 'anyone got spare deepslate?' },
  ])

  // ---- loading -------------------------------------------------------------------------------

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      await Promise.all([loadHosts(), loadBots()])
    } finally {
      loading.value = false
    }
  }

  async function loadHosts(): Promise<void> {
    const { data, error: failure } = await api.GET('/api/hosts')
    if (failure) {
      error.value = errorMessage(failure, 'Could not load hosts')
      return
    }
    hosts.value = (data ?? []) as HostResponse[]
  }

  async function loadBots(): Promise<void> {
    const { data, error: failure } = await api.GET('/api/agents')
    if (failure) {
      error.value = errorMessage(failure, 'Could not load agents')
      return
    }
    // Telemetry is preserved across refreshes so the mock does not reset on every poll.
    const previous = new Map(agents.value.map((agent) => [agent.id, agent.telemetry]))
    agents.value = ((data ?? []) as AgentResponse[]).map((agent) => ({
      ...agent,
      telemetry: previous.get(agent.id) ?? mockTelemetry(agent),
    }))
  }

  // ---- derived -------------------------------------------------------------------------------

  const online = computed(() => agents.value.filter(isOnline))

  const blocksPlaced = computed(() =>
    agents.value.reduce((sum, agent) => sum + agent.telemetry.blocksPlaced, 0),
  )

  const progressPercent = computed(() =>
    Math.min(100, (blocksPlaced.value / schematic.value.totalBlocks) * 100),
  )

  const blocksPerMinute = computed(
    () => online.value.filter((agent) => agent.telemetry.blocksPlaced > 0).length * 38,
  )

  const etaMinutes = computed(() => {
    if (blocksPerMinute.value === 0) return null
    const remaining = schematic.value.totalBlocks - blocksPlaced.value
    return Math.max(0, Math.round(remaining / blocksPerMinute.value))
  })

  /** Distinct servers in the fleet. A server is a scope: listener, chat feed and build hang off it. */
  const servers = computed(() => [...new Set(agents.value.map((agent) => agent.serverAddress))].sort())

  /**
   * One elected listener **per server**, not per fleet. Chosen for stability - the longest running
   * online agent - so a new agent joining never displaces a working listener.
   */
  const chatListeners = computed<Record<string, FleetAgent | undefined>>(() => {
    const byServer: Record<string, FleetAgent | undefined> = {}
    for (const server of servers.value) {
      byServer[server] = online.value
        .filter((agent) => agent.serverAddress === server)
        .sort((a, b) => b.telemetry.uptimeSeconds - a.telemetry.uptimeSeconds)[0]
    }
    return byServer
  })

  function globalChatFor(server: string): GlobalChatLine[] {
    return globalChat.value.filter((line) => line.server === server)
  }

  const attention = computed<Attention[]>(() => {
    const found: Attention[] = []
    for (const agent of agents.value) {
      if (agent.state === 'STALE') {
        found.push({ agent, reason: 'Host unreachable', severity: 'error' })
        continue
      }
      if (agent.state === 'NEEDS_RELINK') {
        found.push({ agent, reason: 'Needs relink', severity: 'error' })
        continue
      }
      if (!isOnline(agent)) continue

      if (agent.telemetry.health <= 10) {
        found.push({ agent, reason: `Health ${agent.telemetry.health}/20`, severity: 'error' })
      }
      if (agent.telemetry.food <= 8) {
        found.push({ agent, reason: `Food ${agent.telemetry.food}/20`, severity: 'warning' })
      }
      if (agent.telemetry.pingMs >= 100) {
        found.push({ agent, reason: `Ping ${agent.telemetry.pingMs} ms`, severity: 'warning' })
      }
    }
    return found.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  })

  /** Every agent's incidents merged into one feed, newest first. Conversation is not included. */
  const activity = computed(() =>
    agents.value
      .flatMap((agent) => agent.telemetry.activity.map((line) => ({ ...line, agent })))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 12),
  )

  function byId(id: number): FleetAgent | undefined {
    return agents.value.find((agent) => agent.id === id)
  }

  function hostById(id: number): HostResponse | undefined {
    return hosts.value.find((host) => host.id === id)
  }

  function agentsOnHost(hostId: number): FleetAgent[] {
    return agents.value.filter((agent) => agent.hostId === hostId)
  }

  // ---- commands ------------------------------------------------------------------------------

  /** Every command can legitimately fail with 503 while no agent is connected. */
  async function enrolHost(name: string): Promise<string> {
    const { data, error: failure } = await api.POST('/api/hosts', { body: { name } })
    if (failure || !data?.token) throw new Error(errorMessage(failure, 'Could not enrol the host'))
    await refresh()
    return data.token
  }

  async function renameHost(id: number, name: string): Promise<void> {
    const { error: failure } = await api.PATCH('/api/hosts/{id}', {
      params: { path: { id } },
      body: { name },
    })
    if (failure) throw new Error(errorMessage(failure, 'Could not rename the host'))
    await refresh()
  }

  /** Returns the replacement token, shown once. The host's current connection is closed. */
  async function rotateHostToken(id: number): Promise<string> {
    const { data, error: failure } = await api.POST('/api/hosts/{id}/rotate-token', {
      params: { path: { id } },
    })
    if (failure || !data?.token) throw new Error(errorMessage(failure, 'Could not rotate the token'))
    await refresh()
    return data.token
  }

  async function removeHost(id: number): Promise<void> {
    const { error: failure } = await api.DELETE('/api/hosts/{id}', { params: { path: { id } } })
    if (failure) throw new Error(errorMessage(failure, 'Could not remove the host'))
    await refresh()
  }

  async function addAgent(input: {
    label: string
    hostId: number
    serverAddress: string
  }): Promise<AgentResponse> {
    const { data, error: failure } = await api.POST('/api/agents', { body: input })
    if (failure || !data) throw new Error(errorMessage(failure, 'Could not create the agent'))
    await refresh()
    return data as AgentResponse
  }

  /** Rename and/or move to another server. Omitted fields are left alone by the backend. */
  async function updateAgent(
    id: number,
    changes: { label?: string; serverAddress?: string },
  ): Promise<void> {
    const { error: failure } = await api.PATCH('/api/agents/{id}', {
      params: { path: { id } },
      body: changes,
    })
    if (failure) throw new Error(errorMessage(failure, 'Could not update the agent'))
    await refresh()
  }

  async function removeAgent(id: number): Promise<void> {
    const { error: failure } = await api.DELETE('/api/agents/{id}', { params: { path: { id } } })
    if (failure) throw new Error(errorMessage(failure, 'Could not remove the agent'))
    await refresh()
  }

  async function setupAgent(id: number, method: string): Promise<void> {
    const { error: failure } = await api.POST('/api/agents/{id}/setup', {
      params: { path: { id } },
      body: { method },
    })
    if (failure) throw new Error(errorMessage(failure, 'Could not start setup'))
    await refresh()
  }

  async function connect(id: number): Promise<void> {
    const { error: failure } = await api.POST('/api/agents/{id}/connect', { params: { path: { id } } })
    if (failure) throw new Error(errorMessage(failure, 'Could not connect'))
    await refresh()
  }

  async function disconnect(id: number): Promise<void> {
    const { error: failure } = await api.POST('/api/agents/{id}/disconnect', {
      params: { path: { id } },
    })
    if (failure) throw new Error(errorMessage(failure, 'Could not disconnect'))
    await refresh()
  }

  async function say(id: number, message: string): Promise<void> {
    if (!message.trim()) return
    const { error: failure } = await api.POST('/api/agents/{id}/chat', {
      params: { path: { id } },
      body: { message: message.trim() },
    })
    if (failure) throw new Error(errorMessage(failure, 'Could not send the message'))
  }

  return {
    hosts,
    agents,
    loading,
    error,
    schematic,
    sectors,
    globalChat,
    online,
    servers,
    chatListeners,
    globalChatFor,
    blocksPlaced,
    progressPercent,
    blocksPerMinute,
    etaMinutes,
    attention,
    activity,
    refresh,
    byId,
    hostById,
    agentsOnHost,
    enrolHost,
    renameHost,
    rotateHostToken,
    removeHost,
    addAgent,
    updateAgent,
    removeAgent,
    setupAgent,
    connect,
    disconnect,
    say,
  }
})

/**
 * MOCK. Stable per agent id so the UI does not shuffle on refresh, and only populated for agents the
 * backend reports as online - an UNLINKED agent genuinely has no telemetry.
 */
function mockTelemetry(agent: AgentResponse): AgentTelemetry {
  const seed = agent.id
  const live = isOnline(agent)

  return {
    uptimeSeconds: live ? 1_800 + seed * 917 : 0,
    health: live ? 20 - (seed % 3) * 5 : 0,
    food: live ? 20 - (seed % 4) * 4 : 0,
    position: { x: 100 + seed * 7, y: 71, z: -340 - seed * 5 },
    dimension: 'overworld',
    pingMs: live ? 35 + (seed % 5) * 22 : 0,
    task: live ? 'Awaiting assignment' : describe(agent.state),
    blocksPlaced: live ? seed * 1_240 : 0,
    nearby: [],
    chat: [],
    activity: [],
  }
}

function describe(state: AgentResponse['state']): string {
  switch (state) {
    case 'UNLINKED':
      return 'Not set up yet'
    case 'SETUP_PENDING':
      return 'Awaiting setup on host'
    case 'LINKED':
      return 'Ready to connect'
    case 'NEEDS_RELINK':
      return 'Credentials rejected'
    case 'CONNECT_FAILED':
      return 'Server refused the connection'
    case 'STALE':
      return 'Host unreachable'
    default:
      return 'Idle'
  }
}

export function formatUptime(seconds: number): string {
  if (seconds <= 0) return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`
}
