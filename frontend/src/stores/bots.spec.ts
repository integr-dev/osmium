import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { formatUptime, useBotStore } from './bots'
import type { BotResponse, HostResponse } from '../api/client'
import { respondWith } from '../test/http'

const HOSTS: HostResponse[] = [
  { id: 1, name: 'eu-1', address: '10.0.0.4', agentVersion: '0.1.0', lastSeenAt: null, reachable: true, botCount: 4 },
  { id: 2, name: 'eu-2', address: null, agentVersion: null, lastSeenAt: null, reachable: false, botCount: 1 },
]

/**
 * Ids are load-bearing: mock telemetry is derived from them, so these are chosen to give two clean
 * online bots on one server, plus one bot that trips a health alert.
 */
const BOTS: BotResponse[] = [
  bot({ id: 6, state: 'ONLINE', serverAddress: 'alpha.example:25565' }),
  bot({ id: 12, state: 'ONLINE', serverAddress: 'alpha.example:25565' }),
  bot({ id: 7, state: 'STALE', serverAddress: 'alpha.example:25565' }),
  bot({ id: 3, state: 'LINKED', serverAddress: 'beta.example:25565' }),
  bot({ id: 5, state: 'ONLINE', serverAddress: 'beta.example:25565' }),
]

function bot(fields: Pick<BotResponse, 'id' | 'state' | 'serverAddress'>): BotResponse {
  return {
    label: `Mason_${fields.id}`,
    hostId: 1,
    hostName: 'eu-1',
    mcUsername: null,
    mcUuid: null,
    ...fields,
  }
}

function fleet(bots: BotResponse[] = BOTS) {
  respondWith((call) => {
    if (call.url.endsWith('/api/hosts')) return { body: HOSTS }
    if (call.url.endsWith('/api/bots')) return { body: bots }
    throw new Error(`Unexpected request to ${call.url}`)
  })
}

describe('fleet store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('counts only bots that are in game as online', async () => {
    fleet()
    const store = useBotStore()

    await store.refresh()

    expect(store.online.map((b) => b.id)).toEqual([6, 12, 5])
  })

  it('reports each distinct server once, sorted', async () => {
    fleet()
    const store = useBotStore()

    await store.refresh()

    expect(store.servers).toEqual(['alpha.example:25565', 'beta.example:25565'])
  })

  describe('chat listeners', () => {
    it('elects one listener per server, not one per fleet', async () => {
      fleet()
      const store = useBotStore()

      await store.refresh()

      expect(Object.keys(store.chatListeners)).toEqual([
        'alpha.example:25565',
        'beta.example:25565',
      ])
    })

    // Stability is the point: the longest-running bot wins, so a bot joining never displaces a
    // listener that is already working.
    it('picks the longest-running online bot', async () => {
      fleet()
      const store = useBotStore()

      await store.refresh()

      expect(store.chatListeners['alpha.example:25565']?.id).toBe(12)
    })

    it('leaves a server without a listener when nothing there is online', async () => {
      fleet([bot({ id: 3, state: 'LINKED', serverAddress: 'gamma.example:25565' })])
      const store = useBotStore()

      await store.refresh()

      expect(store.chatListeners['gamma.example:25565']).toBeUndefined()
    })
  })

  describe('attention', () => {
    it('flags an unreachable host as unknown rather than offline', async () => {
      fleet()
      const store = useBotStore()

      await store.refresh()

      const stale = store.attention.find((item) => item.bot.id === 7)
      expect(stale).toMatchObject({ reason: 'Host unreachable', severity: 'error' })
    })

    it('raises health alerts for online bots', async () => {
      fleet()
      const store = useBotStore()

      await store.refresh()

      expect(store.attention.find((item) => item.bot.id === 5)?.reason).toBe('Health 10/20')
    })

    it('ignores telemetry thresholds for bots that are not in game', async () => {
      fleet()
      const store = useBotStore()

      await store.refresh()

      // Bot 3 is LINKED, so its zeroed telemetry must not read as starving on 0 health.
      expect(store.attention.some((item) => item.bot.id === 3)).toBe(false)
    })

    it('orders errors ahead of warnings', async () => {
      fleet()
      const store = useBotStore()

      await store.refresh()

      const severities = store.attention.map((item) => item.severity)
      expect(severities).toEqual([...severities].sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1)))
    })
  })

  it('keeps telemetry across a refresh so the view does not reset on every poll', async () => {
    fleet()
    const store = useBotStore()
    await store.refresh()
    store.byId(6)!.telemetry.blocksPlaced = 999

    await store.refresh()

    expect(store.byId(6)!.telemetry.blocksPlaced).toBe(999)
  })

  it('surfaces a load failure instead of throwing', async () => {
    respondWith(() => ({ status: 503, body: { message: 'Backend is down' } }))
    const store = useBotStore()

    await store.refresh()

    expect(store.error).toBe('Backend is down')
    expect(store.loading).toBe(false)
  })

  it('sends no chat message when it is only whitespace', async () => {
    const store = useBotStore()

    await store.say(6, '   ')

    expect(store.error).toBeNull()
  })
})

describe('formatUptime', () => {
  it('shows a dash rather than a zero for a bot that was never up', () => {
    expect(formatUptime(0)).toBe('—')
  })

  it('drops the hour component below an hour', () => {
    expect(formatUptime(90)).toBe('1m 30s')
  })

  it('shows hours and minutes above an hour', () => {
    expect(formatUptime(3_700)).toBe('1h 1m')
  })
})
