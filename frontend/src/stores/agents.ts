import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, errorMessage, type AgentResponse, type HostResponse, type UserResponse } from '../api/client'
import { openLiveUpdates, type LiveUpdateHandle } from '../api/liveUpdates'
import { useAuthStore } from './auth'
import { t } from '../i18n'
import { buildFigures } from '../lib/build'
import { isOnline } from '../lib/agentState'

/**
 * Fleet state.
 *
 * Hosts, agents, their lifecycle states, chat, activity and **telemetry** are real and come from the
 * backend — though nothing fills them until a host connects. Only **build progress** is still mock:
 * blocks placed, sectors and the schematic. Those parts are marked.
 *
 * Chat and activity are not held here. They are cursor-paged feeds owned by whichever view shows
 * one; the store only hands on the live lines as they arrive. See `src/lib/feed.ts`.
 */

/**
 * Telemetry is **absent, not zeroed**, when an agent has not reported recently. Zeroes would render
 * as an agent on 0 health standing at the origin, which is a very convincing way to describe an
 * agent nobody has heard from.
 */
export type AgentTelemetry = NonNullable<AgentResponse['telemetry']>
export type NearbyPlayer = AgentTelemetry['nearby'][number]

/**
 * MOCK, pending the schematic pipeline. Kept off `telemetry` so the real and the invented are not
 * mixed in one object — the host reports vitals, and nothing reports build progress yet.
 */
export interface BuildProgress {
  blocksPlaced: number
  task: string
}

export type FleetAgent = AgentResponse & { build: BuildProgress }

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

/** A Minecraft server and how much of the fleet is on it. */
export interface ServerSummary {
  address: string
  online: number
  total: number
  /** The agent forwarding this server's global chat, or undefined when nothing is listening. */
  listener: FleetAgent | undefined
}

// Defined in `src/lib/agentState.ts` and re-exported here, where most callers already look for it.
export { isOnline }

export const useAgentStore = defineStore('agents', () => {
  const hosts = ref<HostResponse[]>([])
  const agents = ref<FleetAgent[]>([])
  const loading = ref(false)
  const loaded = ref(false)
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

  // ---- loading -------------------------------------------------------------------------------

  /**
   * `loaded` is what tells an empty fleet apart from one nobody has asked for yet.
   *
   * Without it every list has to render its empty state during the first request, so a fresh page
   * says "No hosts yet." before it has any idea whether that is true. It stays true afterwards: a
   * later refresh is a background update over content that is already on screen, and blanking it
   * back to skeletons would be a worse lie than briefly stale numbers.
   */
  async function refresh(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      await Promise.all([loadHosts(), loadAgents()])
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  async function loadHosts(): Promise<void> {
    const { data, error: failure } = await api.GET('/api/hosts')
    if (failure) {
      error.value = errorMessage(failure, t('errors.loadHosts'))
      return
    }
    hosts.value = (data ?? []) as HostResponse[]
  }

  async function loadAgents(): Promise<void> {
    const { data, error: failure } = await api.GET('/api/agents')
    if (failure) {
      error.value = errorMessage(failure, t('errors.loadAgents'))
      return
    }
    // Build progress is mock, so it is kept across refreshes rather than reshuffling on every poll.
    const previous = new Map(agents.value.map((agent) => [agent.id, agent.build]))
    agents.value = ((data ?? []) as AgentResponse[]).map((agent) => ({
      ...agent,
      build: previous.get(agent.id) ?? mockBuild(agent),
    }))
  }

  // ---- live updates --------------------------------------------------------------------------

  /**
   * The stream carries the same shapes the REST endpoints return, so an event is applied in place
   * rather than triggering a refetch. That is what makes a change another operator made — or one a
   * host reported with nobody watching — appear without polling.
   */
  let connection: LiveUpdateHandle | null = null
  const liveUpdatesConnected = ref(false)

  function connectLiveUpdates(): void {
    if (connection) return
    connection = openLiveUpdates('/api/stream', {
      onEvent: applyEvent,
      onConnect() {
        liveUpdatesConnected.value = true
      },
      onDisconnect() {
        liveUpdatesConnected.value = false
      },
    })
  }

  function disconnectLiveUpdates(): void {
    connection?.close()
    connection = null
    liveUpdatesConnected.value = false
  }

  /**
   * The seam between transport and state: everything the stream delivers lands here. Exported so
   * the ingest can be exercised without standing up a socket, and so a future transport swap is one
   * call site rather than a rewrite.
   */
  function applyEvent(name: string, data: unknown): void {
    switch (name) {
      case 'agent':
        upsertAgent(data as AgentResponse)
        break
      case 'agent-removed':
        agents.value = agents.value.filter((agent) => agent.id !== (data as { id: number }).id)
        break
      case 'host':
        upsertHost(data as HostResponse)
        break
      case 'host-removed':
        hosts.value = hosts.value.filter((host) => host.id !== (data as { id: number }).id)
        break
      case 'telemetry':
        applyTelemetry(data as { agentId: number; telemetry: AgentTelemetry })
        break
      case 'permissions':
        // Not fleet state, but there is one stream and therefore one ingest. The backend enforces a
        // role change on the next request either way; this is what stops the UI from going on
        // offering buttons that now fail, which reads as a bug rather than as access having changed.
        useAuthStore().user = data as UserResponse
        break
      case 'chat':
      case 'activity':
      case 'audit':
      case 'user':
      case 'user-removed':
        // Paged lists, owned by whichever view is showing one, so these are handed on rather than
        // accumulated here: the store has no way to know which page a line belongs on.
        for (const listener of feedListeners) listener(name, data)
        break
      // 'ready' and anything this build does not know about are ignored, so a newer backend
      // sending a new event type never breaks an older tab.
    }
  }

  /**
   * Live lines for whoever is displaying a paged list of them — chat, activity, the audit trail and
   * the account list.
   *
   * Returns its own unsubscribe, so a component drops the listener when it unmounts rather than the
   * store growing a registry of views. Everything else the stream carries is state the store owns,
   * which is why this exists only for the paged lists.
   */
  const feedListeners = new Set<(name: string, data: unknown) => void>()

  function onFeedEvent(listener: (name: string, data: unknown) => void): () => void {
    feedListeners.add(listener)
    return () => feedListeners.delete(listener)
  }

  /** Mock build progress is kept across the update, exactly as `loadAgents` does. */
  function upsertAgent(incoming: AgentResponse): void {
    const index = agents.value.findIndex((agent) => agent.id === incoming.id)
    if (index === -1) {
      agents.value = [...agents.value, { ...incoming, build: mockBuild(incoming) }]
      return
    }
    agents.value[index] = { ...incoming, build: agents.value[index]!.build }
  }

  /**
   * Vitals arrive on their own event, several times a minute per agent, so they are merged into the
   * agent in place. The alternative — resending the whole agent each tick — is what the split event
   * exists to avoid.
   */
  function applyTelemetry(incoming: { agentId: number; telemetry: AgentTelemetry }): void {
    const index = agents.value.findIndex((agent) => agent.id === incoming.agentId)
    if (index === -1) return
    agents.value[index] = { ...agents.value[index]!, telemetry: incoming.telemetry }
  }

  function upsertHost(incoming: HostResponse): void {
    const index = hosts.value.findIndex((host) => host.id === incoming.id)
    if (index === -1) hosts.value = [...hosts.value, incoming]
    else hosts.value[index] = incoming
  }

  // ---- derived -------------------------------------------------------------------------------

  const online = computed(() => agents.value.filter(isOnline))

  /**
   * The fleet-wide build figures. The arithmetic lives in `src/lib/build.ts` so the dashboard can
   * ask the same question of one server's agents — a schematic is built on a server, and summing
   * two of them adds up two unrelated builds.
   */
  const fleetBuild = computed(() => buildFigures(agents.value, schematic.value.totalBlocks))

  const blocksPlaced = computed(() => fleetBuild.value.placed)

  const progressPercent = computed(() => fleetBuild.value.percent)

  const blocksPerMinute = computed(() => fleetBuild.value.perMinute)

  const etaMinutes = computed(() => fleetBuild.value.etaMinutes)

  /**
   * Distinct servers in the fleet. A server is a scope: listener, chat feed and build hang off it.
   *
   * Agents assigned nowhere contribute none. That is the point of allowing it — an agent that is set
   * up and waiting for work used to be parked on a server it was not connected to, which then
   * appeared here with nobody on it.
   */
  const servers = computed(() =>
    [...new Set(agents.value.map((agent) => agent.serverAddress).filter((it) => it !== null))].sort(),
  )

  /**
   * Each server with its share of the fleet, and the agent forwarding its global chat.
   *
   * The listener is **read, not computed**. Election is backend-side — only it sees the whole fleet,
   * and agents on one server can be spread across several hosts — and `chatListener` reports which
   * agent was actually told to forward. Working it out here would be a guess that quietly disagrees
   * with what the agents are doing. A server with nobody listening has no global feed, which is
   * honest rather than a gap to paper over.
   */
  const serverSummaries = computed<ServerSummary[]>(() =>
    servers.value.map((address) => {
      const here = agents.value.filter((agent) => agent.serverAddress === address)
      return {
        address,
        online: here.filter(isOnline).length,
        total: here.length,
        listener: here.find((agent) => agent.chatListener),
      }
    }),
  )

  const attention = computed<Attention[]>(() => {
    const found: Attention[] = []
    for (const agent of agents.value) {
      if (agent.state === 'STALE') {
        found.push({ agent, reason: t('attention.hostUnreachable'), severity: 'error' })
        continue
      }
      if (agent.state === 'NEEDS_RELINK') {
        found.push({ agent, reason: t('attention.needsRelink'), severity: 'error' })
        continue
      }
      if (!isOnline(agent)) continue

      // An agent that has not reported raises nothing. Silence is not a healthy reading, but it is
      // not a low one either — inventing an alert from missing data is how a dashboard cries wolf.
      const vitals = agent.telemetry
      if (!vitals) continue

      if (vitals.health <= 10) {
        found.push({ agent, reason: `${t('agents.health')} ${vitals.health}/20`, severity: 'error' })
      }
      if (vitals.food <= 8) {
        found.push({ agent, reason: `${t('agents.food')} ${vitals.food}/20`, severity: 'warning' })
      }
      if (vitals.pingMs >= 100) {
        found.push({ agent, reason: `${t('agents.ping')} ${vitals.pingMs} ms`, severity: 'warning' })
      }
    }
    return found.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  })

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

  /**
   * Every command can legitimately fail with 503 while no host is connected.
   *
   * None of these refetch afterwards. Anything that changes stored state publishes an event, which
   * arrives before the response is written, so a refetch would only re-read what the stream has
   * already applied. Connect, disconnect and chat change nothing stored at all — the state moves
   * when the host reports back.
   */
  async function enrolHost(name: string): Promise<string> {
    const { data, error: failure } = await api.POST('/api/hosts', { body: { name } })
    if (failure || !data?.token) throw new Error(errorMessage(failure, t('errors.enrolHost')))
    return data.token
  }

  async function renameHost(id: number, name: string): Promise<void> {
    const { error: failure } = await api.PATCH('/api/hosts/{id}', {
      params: { path: { id } },
      body: { name },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.renameHost')))
  }

  /** Returns the replacement token, shown once. The host's current connection is closed. */
  async function rotateHostToken(id: number): Promise<string> {
    const { data, error: failure } = await api.POST('/api/hosts/{id}/rotate-token', {
      params: { path: { id } },
    })
    if (failure || !data?.token) throw new Error(errorMessage(failure, t('errors.rotateToken')))
    return data.token
  }

  async function removeHost(id: number): Promise<void> {
    const { error: failure } = await api.DELETE('/api/hosts/{id}', { params: { path: { id } } })
    if (failure) throw new Error(errorMessage(failure, t('errors.removeHost')))
  }

  async function addAgent(input: {
    label: string
    hostId: number
    serverAddress: string | null
  }): Promise<AgentResponse> {
    const { data, error: failure } = await api.POST('/api/agents', { body: input })
    if (failure || !data) throw new Error(errorMessage(failure, t('errors.createAgent')))
    return data as AgentResponse
  }

  /** Rename. Where an agent plays is [assignServer], which has its own preconditions. */
  async function updateAgent(id: number, changes: { label?: string }): Promise<void> {
    const { error: failure } = await api.PATCH('/api/agents/{id}', {
      params: { path: { id } },
      body: changes,
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.updateAgent')))
  }

  /**
   * Points an agent at a Minecraft server, or at none — pass null to unassign.
   *
   * Separate from the rename because it is a different kind of change: it decides what the next
   * connection targets, so the backend refuses it while the agent is online.
   */
  async function assignServer(id: number, serverAddress: string | null): Promise<void> {
    const { error: failure } = await api.PUT('/api/agents/{id}/server', {
      params: { path: { id } },
      body: { serverAddress },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.assignServer')))
  }

  async function removeAgent(id: number): Promise<void> {
    const { error: failure } = await api.DELETE('/api/agents/{id}', { params: { path: { id } } })
    if (failure) throw new Error(errorMessage(failure, t('errors.removeAgent')))
  }

  async function setupAgent(id: number, method: string): Promise<void> {
    const { error: failure } = await api.POST('/api/agents/{id}/setup', {
      params: { path: { id } },
      body: { method },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.setUpAgent')))
  }

  async function connect(id: number): Promise<void> {
    const { error: failure } = await api.POST('/api/agents/{id}/connect', { params: { path: { id } } })
    if (failure) throw new Error(errorMessage(failure, t('errors.connectAgent')))
  }

  async function disconnect(id: number): Promise<void> {
    const { error: failure } = await api.POST('/api/agents/{id}/disconnect', {
      params: { path: { id } },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.disconnectAgent')))
  }

  async function say(id: number, message: string): Promise<void> {
    if (!message.trim()) return
    const { error: failure } = await api.POST('/api/agents/{id}/chat', {
      params: { path: { id } },
      body: { message: message.trim() },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.sendMessage')))
  }

  return {
    hosts,
    agents,
    loading,
    loaded,
    error,
    liveUpdatesConnected,
    connectLiveUpdates,
    applyEvent,
    onFeedEvent,
    disconnectLiveUpdates,
    schematic,
    sectors,
    online,
    servers,
    serverSummaries,
    blocksPlaced,
    progressPercent,
    blocksPerMinute,
    etaMinutes,
    attention,
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
    assignServer,
    removeAgent,
    setupAgent,
    connect,
    disconnect,
    say,
  }
})

/**
 * MOCK, pending the schematic pipeline. Stable per agent id so the UI does not shuffle on refresh,
 * and only populated for agents the backend reports as online.
 */
function mockBuild(agent: AgentResponse): BuildProgress {
  const live = isOnline(agent)
  return {
    blocksPlaced: live ? agent.id * 1_240 : 0,
    task: live ? t('agentTask.awaitingAssignment') : describe(agent.state),
  }
}

function describe(state: AgentResponse['state']): string {
  switch (state) {
    case 'UNLINKED':
      return t('agentTask.notSetUp')
    case 'SETUP_PENDING':
      return t('agentTask.awaitingSetup')
    case 'LINKED':
      return t('agentTask.readyToConnect')
    case 'NEEDS_RELINK':
      return t('agentTask.credentialsRejected')
    case 'CONNECT_FAILED':
      return t('agentTask.serverRefused')
    case 'STALE':
      return t('agentTask.hostUnreachable')
    default:
      return t('agentTask.idle')
  }
}

/**
 * How long the agent has been in game, from `onlineSince`. Derived rather than reported: the backend
 * already stamps the moment an agent enters the game, for chat listener election, so a second
 * uptime counter on the wire would be one more thing that could disagree with it.
 */
export function uptimeOf(agent: AgentResponse): string {
  if (!agent.onlineSince) return '—'
  return formatUptime(Math.floor((Date.now() - new Date(agent.onlineSince).getTime()) / 1000))
}

export function formatUptime(seconds: number): string {
  if (seconds <= 0) return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`
}
