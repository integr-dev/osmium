import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Mock bot state. Everything here is local and invented - there is no orchestration API yet, so
 * this exists to shape the UI. Swap the seed data and the actions for real calls when the agent
 * module lands.
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

export interface Bot {
  id: string
  name: string
  online: boolean
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
}

function seed(): Bot[] {
  return [
    {
      id: 'bot-1',
      name: 'Mason_01',
      online: true,
      uptimeSeconds: 8_412,
      health: 20,
      food: 17,
      position: { x: 128, y: 71, z: -344 },
      dimension: 'overworld',
      pingMs: 42,
      task: 'Placing layer 14 · sector A',
      blocksPlaced: 12_480,
      nearby: [
        { name: 'Mason_02', distance: 6.2, isBot: true },
        { name: 'Hauler_01', distance: 18.9, isBot: true },
        { name: 'Notch', distance: 41.3, isBot: false },
      ],
      chat: [
        { at: '14:02', from: 'Mason_02', text: 'sector A almost done' },
        { at: '14:04', from: 'Mason_01', text: 'starting layer 14' },
      ],
    },
    {
      id: 'bot-2',
      name: 'Mason_02',
      online: true,
      uptimeSeconds: 8_390,
      health: 16,
      food: 12,
      position: { x: 134, y: 71, z: -338 },
      dimension: 'overworld',
      pingMs: 55,
      task: 'Placing layer 14 · sector B',
      blocksPlaced: 11_902,
      nearby: [
        { name: 'Mason_01', distance: 6.2, isBot: true },
        { name: 'Hauler_01', distance: 14.1, isBot: true },
      ],
      chat: [{ at: '14:02', from: 'Mason_02', text: 'sector A almost done' }],
    },
    {
      id: 'bot-3',
      name: 'Hauler_01',
      online: true,
      uptimeSeconds: 7_120,
      health: 20,
      food: 20,
      position: { x: 96, y: 68, z: -310 },
      dimension: 'overworld',
      pingMs: 38,
      task: 'Ferrying stone from depot 2',
      blocksPlaced: 0,
      nearby: [{ name: 'Mason_02', distance: 14.1, isBot: true }],
      chat: [{ at: '13:58', from: 'Hauler_01', text: 'depot 2 running low on stone' }],
    },
    {
      id: 'bot-4',
      name: 'Scout_01',
      online: true,
      uptimeSeconds: 2_045,
      health: 9,
      food: 6,
      position: { x: -12, y: 94, z: -502 },
      dimension: 'overworld',
      pingMs: 121,
      task: 'Surveying build perimeter',
      blocksPlaced: 0,
      nearby: [],
      chat: [{ at: '14:01', from: 'Scout_01', text: 'hostile mobs north ridge' }],
    },
    {
      id: 'bot-5',
      name: 'Mason_03',
      online: false,
      uptimeSeconds: 0,
      health: 0,
      food: 0,
      position: { x: 131, y: 71, z: -341 },
      dimension: 'overworld',
      pingMs: 0,
      task: 'Disconnected',
      blocksPlaced: 9_140,
      nearby: [],
      chat: [{ at: '13:44', from: 'system', text: 'connection reset by peer' }],
    },
    {
      id: 'bot-6',
      name: 'Miner_01',
      online: false,
      uptimeSeconds: 0,
      health: 0,
      food: 0,
      position: { x: 210, y: 12, z: -418 },
      dimension: 'overworld',
      pingMs: 0,
      task: 'Disconnected',
      blocksPlaced: 0,
      nearby: [],
      chat: [],
    },
  ]
}

export interface Sector {
  id: string
  name: string
  blocksPlaced: number
  totalBlocks: number
  assigned: string[]
  status: 'done' | 'active' | 'queued' | 'blocked'
}

export interface Attention {
  bot: Bot
  reason: string
  severity: 'error' | 'warning'
}

export const useBotStore = defineStore('bots', () => {
  const bots = ref<Bot[]>(seed())
  const startedAt = ref(new Date().toISOString())

  const schematic = ref({
    name: 'Cathedral of Osmium',
    totalBlocks: 184_000,
    layers: 62,
    currentLayer: 14,
  })

  const sectors = ref<Sector[]>([
    {
      id: 'sector-c',
      name: 'Crypt · sector C',
      blocksPlaced: 21_400,
      totalBlocks: 21_400,
      assigned: [],
      status: 'done',
    },
    {
      id: 'sector-a',
      name: 'Nave · sector A',
      blocksPlaced: 12_480,
      totalBlocks: 48_200,
      assigned: ['Mason_01'],
      status: 'active',
    },
    {
      id: 'sector-b',
      name: 'Transept · sector B',
      blocksPlaced: 11_902,
      totalBlocks: 39_600,
      assigned: ['Mason_02'],
      status: 'active',
    },
    {
      id: 'sector-e',
      name: 'North wing · sector E',
      blocksPlaced: 9_140,
      totalBlocks: 34_800,
      assigned: ['Mason_03'],
      status: 'blocked',
    },
    {
      id: 'sector-d',
      name: 'Spire · sector D',
      blocksPlaced: 0,
      totalBlocks: 40_000,
      assigned: [],
      status: 'queued',
    },
  ])

  const online = computed(() => bots.value.filter((bot) => bot.online))
  const blocksPlaced = computed(() => bots.value.reduce((sum, bot) => sum + bot.blocksPlaced, 0))

  const progressPercent = computed(() =>
    Math.min(100, (blocksPlaced.value / schematic.value.totalBlocks) * 100),
  )

  /** Only builders contribute to throughput; haulers and scouts place nothing. */
  const blocksPerMinute = computed(
    () => online.value.filter((bot) => bot.blocksPlaced > 0).length * 38,
  )

  const etaMinutes = computed(() => {
    if (blocksPerMinute.value === 0) return null
    const remaining = schematic.value.totalBlocks - blocksPlaced.value
    return Math.max(0, Math.round(remaining / blocksPerMinute.value))
  })

  /** Anything an operator would want to act on, worst first. */
  const attention = computed<Attention[]>(() => {
    const found: Attention[] = []
    for (const bot of bots.value) {
      if (!bot.online) {
        found.push({ bot, reason: 'Disconnected', severity: 'error' })
        continue
      }
      if (bot.health <= 10) found.push({ bot, reason: `Health ${bot.health}/20`, severity: 'error' })
      if (bot.food <= 8) found.push({ bot, reason: `Food ${bot.food}/20`, severity: 'warning' })
      if (bot.pingMs >= 100) found.push({ bot, reason: `Ping ${bot.pingMs} ms`, severity: 'warning' })
    }
    return found.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  })

  /** Every bot's chat merged into one feed, newest first. */
  const activity = computed(() =>
    bots.value
      .flatMap((bot) => bot.chat.map((line) => ({ ...line, bot })))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 12),
  )

  function byId(id: string): Bot | undefined {
    return bots.value.find((bot) => bot.id === id)
  }

  function disconnect(id: string) {
    const bot = byId(id)
    if (!bot) return
    bot.online = false
    bot.uptimeSeconds = 0
    bot.health = 0
    bot.food = 0
    bot.pingMs = 0
    bot.task = 'Disconnected'
    bot.nearby = []
    bot.chat.push({ at: stamp(), from: 'system', text: 'disconnected by operator' })
  }

  function reconnect(id: string) {
    const bot = byId(id)
    if (!bot) return
    bot.online = true
    bot.health = 20
    bot.food = 20
    bot.pingMs = 45
    bot.task = 'Awaiting assignment'
    bot.chat.push({ at: stamp(), from: 'system', text: 'reconnected' })
  }

  function say(id: string, text: string) {
    const bot = byId(id)
    if (!bot || !text.trim()) return
    bot.chat.push({ at: stamp(), from: bot.name, text: text.trim() })
  }

  /** Drives the uptime counters so the mock does not look frozen. */
  setInterval(() => {
    for (const bot of bots.value) if (bot.online) bot.uptimeSeconds += 1
  }, 1000)

  return {
    bots,
    startedAt,
    schematic,
    sectors,
    online,
    blocksPlaced,
    progressPercent,
    blocksPerMinute,
    etaMinutes,
    attention,
    activity,
    byId,
    disconnect,
    reconnect,
    say,
  }
})

function stamp(): string {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

export function formatUptime(seconds: number): string {
  if (seconds <= 0) return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`
}
