import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, errorMessage, type BotResponse, type HostResponse } from '../api/client'

/**
 * Fleet state.
 *
 * Hosts, bots and their lifecycle states are **real** and come from the backend. Telemetry, chat and
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
 * Something that happened *to* a bot: kicks, deaths, warnings, connectivity transitions. Kept out
 * of chat so an incident is not buried between two lines of small talk.
 */
export interface ActivityLine {
  at: string
  severity: 'info' | 'warning' | 'error'
  text: string
}

/** MOCK. Replaced by the telemetry stream once an agent reports. */
export interface BotTelemetry {
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

export type FleetBot = BotResponse & { telemetry: BotTelemetry }

export interface Sector {
  id: string
  name: string
  blocksPlaced: number
  totalBlocks: number
  assigned: string[]
  status: 'done' | 'active' | 'queued' | 'blocked'
}

export interface Attention {
  bot: FleetBot
  reason: string
  severity: 'error' | 'warning'
}

/** A line of ordinary server chat, forwarded by exactly one elected bot per server. */
export interface GlobalChatLine {
  at: string
  server: string
  from: string
  text: string
}

/** States in which a bot is genuinely in game. */
export function isOnline(bot: BotResponse): boolean {
  return bot.state === 'ONLINE'
}

export const useBotStore = defineStore('bots', () => {
  const hosts = ref<HostResponse[]>([])
  const bots = ref<FleetBot[]>([])
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
    { at: '14:05', server: 'mc.example.com:25565', from: 'Dinnerbone', text: 'who is running all these bots' },
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
    const { data, error: failure } = await api.GET('/api/bots')
    if (failure) {
      error.value = errorMessage(failure, 'Could not load bots')
      return
    }
    // Telemetry is preserved across refreshes so the mock does not reset on every poll.
    const previous = new Map(bots.value.map((bot) => [bot.id, bot.telemetry]))
    bots.value = ((data ?? []) as BotResponse[]).map((bot) => ({
      ...bot,
      telemetry: previous.get(bot.id) ?? mockTelemetry(bot),
    }))
  }

  // ---- derived -------------------------------------------------------------------------------

  const online = computed(() => bots.value.filter(isOnline))

  const blocksPlaced = computed(() =>
    bots.value.reduce((sum, bot) => sum + bot.telemetry.blocksPlaced, 0),
  )

  const progressPercent = computed(() =>
    Math.min(100, (blocksPlaced.value / schematic.value.totalBlocks) * 100),
  )

  const blocksPerMinute = computed(
    () => online.value.filter((bot) => bot.telemetry.blocksPlaced > 0).length * 38,
  )

  const etaMinutes = computed(() => {
    if (blocksPerMinute.value === 0) return null
    const remaining = schematic.value.totalBlocks - blocksPlaced.value
    return Math.max(0, Math.round(remaining / blocksPerMinute.value))
  })

  /** Distinct servers in the fleet. A server is a scope: listener, chat feed and build hang off it. */
  const servers = computed(() => [...new Set(bots.value.map((bot) => bot.serverAddress))].sort())

  /**
   * One elected listener **per server**, not per fleet. Chosen for stability - the longest running
   * online bot - so a new bot joining never displaces a working listener.
   */
  const chatListeners = computed<Record<string, FleetBot | undefined>>(() => {
    const byServer: Record<string, FleetBot | undefined> = {}
    for (const server of servers.value) {
      byServer[server] = online.value
        .filter((bot) => bot.serverAddress === server)
        .sort((a, b) => b.telemetry.uptimeSeconds - a.telemetry.uptimeSeconds)[0]
    }
    return byServer
  })

  function globalChatFor(server: string): GlobalChatLine[] {
    return globalChat.value.filter((line) => line.server === server)
  }

  const attention = computed<Attention[]>(() => {
    const found: Attention[] = []
    for (const bot of bots.value) {
      if (bot.state === 'STALE') {
        found.push({ bot, reason: 'Host unreachable', severity: 'error' })
        continue
      }
      if (bot.state === 'NEEDS_RELINK') {
        found.push({ bot, reason: 'Needs relink', severity: 'error' })
        continue
      }
      if (!isOnline(bot)) continue

      if (bot.telemetry.health <= 10) {
        found.push({ bot, reason: `Health ${bot.telemetry.health}/20`, severity: 'error' })
      }
      if (bot.telemetry.food <= 8) {
        found.push({ bot, reason: `Food ${bot.telemetry.food}/20`, severity: 'warning' })
      }
      if (bot.telemetry.pingMs >= 100) {
        found.push({ bot, reason: `Ping ${bot.telemetry.pingMs} ms`, severity: 'warning' })
      }
    }
    return found.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  })

  /** Every bot's incidents merged into one feed, newest first. Conversation is not included. */
  const activity = computed(() =>
    bots.value
      .flatMap((bot) => bot.telemetry.activity.map((line) => ({ ...line, bot })))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 12),
  )

  function byId(id: number): FleetBot | undefined {
    return bots.value.find((bot) => bot.id === id)
  }

  function hostById(id: number): HostResponse | undefined {
    return hosts.value.find((host) => host.id === id)
  }

  function botsOnHost(hostId: number): FleetBot[] {
    return bots.value.filter((bot) => bot.hostId === hostId)
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

  async function addBot(input: {
    label: string
    hostId: number
    serverAddress: string
  }): Promise<BotResponse> {
    const { data, error: failure } = await api.POST('/api/bots', { body: input })
    if (failure || !data) throw new Error(errorMessage(failure, 'Could not create the bot'))
    await refresh()
    return data as BotResponse
  }

  /** Rename and/or move to another server. Omitted fields are left alone by the backend. */
  async function updateBot(
    id: number,
    changes: { label?: string; serverAddress?: string },
  ): Promise<void> {
    const { error: failure } = await api.PATCH('/api/bots/{id}', {
      params: { path: { id } },
      body: changes,
    })
    if (failure) throw new Error(errorMessage(failure, 'Could not update the bot'))
    await refresh()
  }

  async function removeBot(id: number): Promise<void> {
    const { error: failure } = await api.DELETE('/api/bots/{id}', { params: { path: { id } } })
    if (failure) throw new Error(errorMessage(failure, 'Could not remove the bot'))
    await refresh()
  }

  async function setupBot(id: number, method: string): Promise<void> {
    const { error: failure } = await api.POST('/api/bots/{id}/setup', {
      params: { path: { id } },
      body: { method },
    })
    if (failure) throw new Error(errorMessage(failure, 'Could not start setup'))
    await refresh()
  }

  async function connect(id: number): Promise<void> {
    const { error: failure } = await api.POST('/api/bots/{id}/connect', { params: { path: { id } } })
    if (failure) throw new Error(errorMessage(failure, 'Could not connect'))
    await refresh()
  }

  async function disconnect(id: number): Promise<void> {
    const { error: failure } = await api.POST('/api/bots/{id}/disconnect', {
      params: { path: { id } },
    })
    if (failure) throw new Error(errorMessage(failure, 'Could not disconnect'))
    await refresh()
  }

  async function say(id: number, message: string): Promise<void> {
    if (!message.trim()) return
    const { error: failure } = await api.POST('/api/bots/{id}/chat', {
      params: { path: { id } },
      body: { message: message.trim() },
    })
    if (failure) throw new Error(errorMessage(failure, 'Could not send the message'))
  }

  return {
    hosts,
    bots,
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
    botsOnHost,
    enrolHost,
    renameHost,
    rotateHostToken,
    removeHost,
    addBot,
    updateBot,
    removeBot,
    setupBot,
    connect,
    disconnect,
    say,
  }
})

/**
 * MOCK. Stable per bot id so the UI does not shuffle on refresh, and only populated for bots the
 * backend reports as online - an UNLINKED bot genuinely has no telemetry.
 */
function mockTelemetry(bot: BotResponse): BotTelemetry {
  const seed = bot.id
  const live = isOnline(bot)

  return {
    uptimeSeconds: live ? 1_800 + seed * 917 : 0,
    health: live ? 20 - (seed % 3) * 5 : 0,
    food: live ? 20 - (seed % 4) * 4 : 0,
    position: { x: 100 + seed * 7, y: 71, z: -340 - seed * 5 },
    dimension: 'overworld',
    pingMs: live ? 35 + (seed % 5) * 22 : 0,
    task: live ? 'Awaiting assignment' : describe(bot.state),
    blocksPlaced: live ? seed * 1_240 : 0,
    nearby: [],
    chat: [],
    activity: [],
  }
}

function describe(state: BotResponse['state']): string {
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
