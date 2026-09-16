import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useHistoryStore } from './history'
import { useAgentStore } from './agents'
import type { DashboardSample } from '../api/dashboard'
import { respondWith } from '../test/http'

function sample(at: string): DashboardSample {
  return {
    at,
    fleet: { online: 1, agents: 1, placed: 0, total: 0, perMinute: 0 },
    servers: {},
    hosts: [],
  }
}

describe('the dashboard history', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('loads what the backend kept and says how long it covers', async () => {
    respondWith(() => ({ body: [sample('2026-09-16T12:00:00Z'), sample('2026-09-16T12:30:00Z')] }))
    const history = useHistoryStore()

    await history.load()

    expect(history.samples).toHaveLength(2)
    expect(history.minutes).toBe(30)
    expect(history.error).toBeNull()
  })

  it('appends each point the stream brings, once', () => {
    const history = useHistoryStore()
    const agents = useAgentStore()

    agents.applyEvent('dashboard-sample', sample('2026-09-16T12:00:10Z'))
    agents.applyEvent('dashboard-sample', sample('2026-09-16T12:00:10Z'))
    agents.applyEvent('dashboard-sample', sample('2026-09-16T12:00:20Z'))

    expect(history.samples.map((point) => point.at)).toEqual(['2026-09-16T12:00:10Z', '2026-09-16T12:00:20Z'])
  })

  /** A point can arrive while the request is out; it is newer than anything the answer holds. */
  it('keeps a point that arrived during a load', async () => {
    const history = useHistoryStore()
    history.append(sample('2026-09-16T12:00:20Z'))
    respondWith(() => ({ body: [sample('2026-09-16T12:00:00Z'), sample('2026-09-16T12:00:10Z')] }))

    await history.load()

    expect(history.samples.map((point) => point.at)).toEqual([
      '2026-09-16T12:00:00Z',
      '2026-09-16T12:00:10Z',
      '2026-09-16T12:00:20Z',
    ])
  })

  it('says so when the history cannot be read, and keeps what it had', async () => {
    const history = useHistoryStore()
    history.append(sample('2026-09-16T12:00:00Z'))
    respondWith(() => ({ status: 403, body: { message: 'Forbidden' } }))

    await history.load()

    expect(history.error).toBeTruthy()
    expect(history.samples).toHaveLength(1)
  })
})
