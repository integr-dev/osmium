import { describe, expect, it } from 'vitest'
import type { DashboardSample, HostTraffic } from '../api/dashboard'
import type { Attention, FleetAgent } from '../stores/agents'
import {
  fleetTraffic,
  formatCount,
  formatRate,
  activitySeries,
  groupAttention,
  fleetLoad,
  hostLoad,
  projection,
  readingOf,
  since,
  thin,
} from './dashboard'

const reading = (online: number) => ({ online, agents: 3, placed: 10, total: 20, perMinute: 1 })

function host(overrides: Partial<HostTraffic> = {}): HostTraffic {
  return {
    hostId: 1,
    name: 'h',
    reachable: true,
    linkSent: 0,
    linkReceived: 0,
    gameSent: null,
    gameReceived: null,
    cpu: null,
    memory: null,
    systemCpu: null,
    systemMemory: null,
    systemMemoryTotal: null,
    ...overrides,
  }
}

function sample(at: string, hosts: HostTraffic[] = []): DashboardSample {
  return { at, fleet: reading(2), servers: { 'a.example': reading(1) }, hosts }
}

describe('readings', () => {
  it('reads the fleet, a server, and zero for a server that was not there', () => {
    const point = sample('2026-09-16T12:00:00Z')

    expect(readingOf(point, null).online).toBe(2)
    expect(readingOf(point, 'a.example').online).toBe(1)
    expect(readingOf(point, 'b.example')).toEqual({ online: 0, agents: 0, placed: 0, total: 0, perMinute: 0 })
  })

  it('keeps the samples inside the range', () => {
    const samples = [sample('2026-09-16T11:00:00Z'), sample('2026-09-16T12:00:00Z')]

    expect(since(samples, Date.parse('2026-09-16T11:30:00Z'))).toEqual([samples[1]])
  })
})

describe('fleet traffic', () => {
  it('adds every host together', () => {
    const point = sample('2026-09-16T12:00:00Z', [
      host({ linkSent: 10, linkReceived: 20, gameSent: 1, gameReceived: 2 }),
      host({ hostId: 2, linkSent: 5, linkReceived: 5, gameSent: 3, gameReceived: 4 }),
    ])

    expect(fleetTraffic(point)).toEqual({ linkSent: 15, linkReceived: 25, gameSent: 4, gameReceived: 6 })
  })

  /** A host too old to count is not a fleet that stopped playing. */
  it('has no game traffic when no host reports it', () => {
    const traffic = fleetTraffic(sample('2026-09-16T12:00:00Z', [host({ linkSent: 1 })]))

    expect(traffic.gameSent).toBeNull()
    expect(traffic.gameReceived).toBeNull()
  })

  it('counts only the hosts that do report it', () => {
    const traffic = fleetTraffic(
      sample('2026-09-16T12:00:00Z', [host({ gameSent: 7, gameReceived: 8 }), host({ hostId: 2 })]),
    )

    expect(traffic.gameSent).toBe(7)
  })
})

describe('thinning', () => {
  it('leaves a short series alone', () => {
    const points = [{ at: 1, value: 1 }]
    expect(thin(points, 10)).toBe(points)
  })

  it('keeps the peak of each bucket and ends on the newest moment', () => {
    const points = Array.from({ length: 10 }, (_, index) => ({ at: index, value: index === 3 ? 100 : 1 }))

    const thinned = thin(points, 5)

    expect(thinned).toHaveLength(5)
    expect(thinned.map((point) => point.value)).toContain(100)
    expect(thinned.at(-1)!.at).toBe(9)
  })
})

describe('the projection', () => {
  const now = 1_000_000

  it('reaches zero when the finish is inside the chart', () => {
    const projected = projection(100, 10, now, now + 60 * 60_000)!

    expect(projected.finishAt).toBe(now + 10 * 60_000)
    expect(projected.line).toEqual([
      { at: now, value: 100 },
      { at: now + 10 * 60_000, value: 0 },
    ])
  })

  it('stops at the edge of the chart when the finish is beyond it', () => {
    const projected = projection(100, 10, now, now + 5 * 60_000)!

    expect(projected.line[1]).toEqual({ at: now + 5 * 60_000, value: 50 })
  })

  it('has nothing to project when nothing is moving or nothing is left', () => {
    expect(projection(100, 0, now, now + 1)).toBeNull()
    expect(projection(0, 10, now, now + 1)).toBeNull()
  })
})

describe('formatting', () => {
  it('writes rates in binary units', () => {
    expect(formatRate(0)).toBe('0 B/s')
    expect(formatRate(812)).toBe('812 B/s')
    expect(formatRate(4300)).toBe('4.2 KB/s')
    expect(formatRate(1024 * 1024 * 150)).toBe('150 MB/s')
  })

  it('writes counts short', () => {
    expect(formatCount(950)).toBe('950')
    expect(formatCount(1240)).toBe('1.2k')
    expect(formatCount(52_000)).toBe('52k')
    expect(formatCount(3_100_000)).toBe('3.1M')
  })
})

describe('attention groups', () => {
  const agent = (id: number) => ({ id, label: `A${id}` }) as FleetAgent
  const item = (id: number, kind: Attention['kind'], severity: Attention['severity']): Attention => ({
    agent: agent(id),
    kind,
    reason: kind,
    detail: `${id}`,
    severity,
  })

  it('folds agents with the same cause, errors first and then the most affected', () => {
    const groups = groupAttention([
      item(1, 'highPing', 'warning'),
      item(2, 'lowFood', 'warning'),
      item(3, 'lowFood', 'warning'),
      item(4, 'hostUnreachable', 'error'),
    ])

    expect(groups.map((group) => group.kind)).toEqual(['hostUnreachable', 'lowFood', 'highPing'])
    expect(groups[1]!.entries.map((entry) => entry.agent.id)).toEqual([2, 3])
    expect(groups[1]!.entries[0]!.detail).toBe('2')
  })
})

describe('activity over time', () => {
  const MIN = 60_000
  const noon = Date.parse('2026-08-14T12:00:00Z')
  const at = (time: number) => new Date(time).toISOString()

  it('counts each entry into its bucket and its severity', () => {
    const series = activitySeries(
      [
        { at: at(noon + 10_000), severity: 'ERROR' },
        { at: at(noon + 20_000), severity: 'WARNING' },
        { at: at(noon + 30_000), severity: 'WARNING' },
        { at: at(noon + MIN + 1), severity: 'INFO' },
      ],
      noon,
      noon + 2 * MIN,
      MIN,
      0,
    )

    expect(series.ERROR.map((point) => point.value)).toEqual([1, 0, 0])
    expect(series.WARNING.map((point) => point.value)).toEqual([2, 0, 0])
    expect(series.INFO.map((point) => point.value)).toEqual([0, 1, 0])
  })

  /** On the clock, not on the range: otherwise every point would slide as time moves. */
  it('aligns buckets to the clock and keeps points inside the chart', () => {
    const series = activitySeries([], noon + 30_000, noon + 90_000, MIN, 0)

    expect(series.INFO.map((point) => point.at)).toEqual([noon + 30_000, noon + 90_000])
  })

  /** Older than anything loaded is unread, not quiet. */
  it('leaves out buckets older than what is loaded', () => {
    const series = activitySeries([], noon, noon + 3 * MIN, MIN, noon + 2 * MIN)

    expect(series.INFO).toHaveLength(2)
    expect(series.INFO[0]!.at).toBe(noon + 2.5 * MIN)
  })

  it('drops what falls outside the chart', () => {
    const series = activitySeries([{ at: at(noon - 10 * MIN), severity: 'ERROR' }], noon, noon + MIN, MIN, 0)

    expect(series.ERROR.every((point) => point.value === 0)).toBe(true)
  })
})

/**
 * What the hosts are costing their machines.
 *
 * A reading is all five numbers or none, which is what lets a chart leave a gap for a host that
 * has not said rather than drawing an idle machine.
 */
describe('host load', () => {
  const loaded = (overrides: Partial<HostTraffic> = {}) =>
    host({
      cpu: 40,
      memory: 500_000_000,
      systemCpu: 25,
      systemMemory: 4_000_000_000,
      systemMemoryTotal: 16_000_000_000,
      ...overrides,
    })

  it('reads one host, and nothing for one that has not reported', () => {
    const point = sample('2026-09-16T12:00:00Z', [loaded(), host({ hostId: 2, name: 'quiet' })])

    expect(hostLoad(point, 1)).toEqual({
      cpu: 40,
      systemCpu: 25,
      memory: 500_000_000,
      systemMemory: 4_000_000_000,
      systemMemoryTotal: 16_000_000_000,
    })
    expect(hostLoad(point, 2)).toBeNull()
    expect(hostLoad(point, 99)).toBeNull()
  })

  /**
   * Bytes are bytes: Osmium holding memory on three machines is holding the sum of it, and
   * processor *time* adds the same way.
   */
  it('adds every host together', () => {
    const point = sample('2026-09-16T12:00:00Z', [
      loaded({ hostId: 1, cpu: 30, memory: 1_000_000_000, systemMemory: 4_000_000_000 }),
      loaded({ hostId: 2, cpu: 50, memory: 2_000_000_000, systemMemory: 8_000_000_000 }),
    ])

    const fleet = fleetLoad(point)

    expect(fleet?.cpu.percent).toBe(80)
    expect(fleet?.memory.bytes).toBe(3_000_000_000)
    expect(fleet?.systemMemory.bytes).toBe(12_000_000_000)
    // 12 of the fleet's 32 GB, which is the same arithmetic one host does against its own.
    expect(fleet?.systemMemory.percent).toBeCloseTo(37.5)
  })

  /**
   * The one exception. A percentage of one machine cannot be added to a percentage of another:
   * three machines at 50% are not one machine at 150%, they are a fleet running at half.
   */
  it('averages the machines own processor figure rather than adding it', () => {
    const point = sample('2026-09-16T12:00:00Z', [
      loaded({ hostId: 1, systemCpu: 90 }),
      loaded({ hostId: 2, systemCpu: 10 }),
    ])

    expect(fleetLoad(point)?.systemCpu.percent).toBe(50)
  })

  /** A host that has not reported is left out rather than counted as an idle machine. */
  it('ignores hosts that have said nothing', () => {
    const point = sample('2026-09-16T12:00:00Z', [
      loaded({ hostId: 1, cpu: 30 }),
      host({ hostId: 2, name: 'quiet' }),
    ])

    expect(fleetLoad(point)?.cpu.percent).toBe(30)
  })

  it('is nothing at all while no host reports', () => {
    expect(fleetLoad(sample('2026-09-16T12:00:00Z', [host()]))).toBeNull()
  })
})
