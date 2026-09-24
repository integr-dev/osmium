import type { DashboardReading, DashboardSample } from '../api/dashboard'
import type { ActivityEntryResponse } from '../api/client'
import type { Attention, AttentionKind, FleetAgent } from '../stores/agents'
import { bytes } from './bytes'
import type { TimePoint } from './series'

/**
 * The arithmetic behind the dashboard's charts, kept out of the view so it can be tested without one.
 */

/** How far back the charts look. The backend keeps six hours, so that is the longest there is. */
export const RANGES = [
  { key: '15m', ms: 15 * 60_000 },
  { key: '1h', ms: 60 * 60_000 },
  { key: '6h', ms: 6 * 60 * 60_000 },
] as const

export type RangeKey = (typeof RANGES)[number]['key']

export function rangeMs(key: RangeKey): number {
  return RANGES.find((range) => range.key === key)!.ms
}

export type { TimePoint }

const NO_READING: DashboardReading = { online: 0, agents: 0, placed: 0, total: 0, perMinute: 0 }

/**
 * One sample's reading for the fleet or for one server.
 *
 * A server missing from a sample reads as zero rather than being skipped: it had nobody on it and
 * nothing building then, and dropping the point would draw a line across a gap that was real.
 */
export function readingOf(sample: DashboardSample, server: string | null): DashboardReading {
  return server === null ? sample.fleet : (sample.servers[server] ?? NO_READING)
}

/** Samples at or after [since], oldest first — the same order the backend keeps them in. */
export function since(samples: DashboardSample[], from: number): DashboardSample[] {
  return samples.filter((sample) => Date.parse(sample.at) >= from)
}

export function seriesOf(
  samples: DashboardSample[],
  pick: (sample: DashboardSample) => number,
): TimePoint[] {
  return samples.map((sample) => ({ at: Date.parse(sample.at), value: pick(sample) }))
}

/**
 * Every host added together, in bytes a second.
 *
 * `game` is null when no host reported one, which is a host too old to count rather than a fleet
 * that is not playing — so the chart can leave that line out instead of drawing zero.
 */
export interface FleetTraffic {
  linkSent: number
  linkReceived: number
  gameSent: number | null
  gameReceived: number | null
}

export function fleetTraffic(sample: DashboardSample): FleetTraffic {
  const reported = sample.hosts.filter((host) => host.gameSent !== null)
  return {
    linkSent: sum(sample.hosts.map((host) => host.linkSent)),
    linkReceived: sum(sample.hosts.map((host) => host.linkReceived)),
    gameSent: reported.length ? sum(reported.map((host) => host.gameSent ?? 0)) : null,
    gameReceived: reported.length ? sum(reported.map((host) => host.gameReceived ?? 0)) : null,
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

/**
 * What one host is costing its machine, at one moment. Null until the host reports it.
 *
 * A reading is all five numbers or none — see `HostTrafficResponse` — so this is either the whole
 * thing or nothing, and a chart can leave a gap rather than drawing an idle machine.
 */
export interface HostLoad {
  /** The host process, as a percentage of one core. Two busy cores is 200. */
  cpu: number
  /** The whole machine, as a percentage of all its cores together. */
  systemCpu: number
  /** Resident bytes for the process, and bytes in use across the machine. */
  memory: number
  systemMemory: number
  systemMemoryTotal: number
}

export function hostLoad(sample: DashboardSample, hostId: number): HostLoad | null {
  const host = sample.hosts.find((entry) => entry.hostId === hostId)
  if (!host || host.cpu === null || host.systemMemoryTotal === null) return null

  return {
    cpu: host.cpu,
    systemCpu: host.systemCpu ?? 0,
    memory: host.memory ?? 0,
    systemMemory: host.systemMemory ?? 0,
    systemMemoryTotal: host.systemMemoryTotal,
  }
}

/**
 * The four things a load chart draws, in the order they are drawn.
 *
 * One table, because a host's own page and the dashboard draw the same four and a chip has to mean
 * the same thing on both: the process against a single core, the machine against all of them, and
 * the two memory figures against what the machine has.
 */
export const LOAD_MEASURES = [
  { key: 'cpu', tone: 'text-warning' },
  { key: 'systemCpu', tone: 'text-error' },
  { key: 'memory', tone: 'text-secondary' },
  { key: 'systemMemory', tone: 'text-accent' },
] as const

export type LoadKey = (typeof LOAD_MEASURES)[number]['key']

/**
 * One measure as a load chart wants it: the number it is drawn at, and the number it is read as.
 *
 * Memory is plotted as a share of the machine's own total so it can share an axis with the
 * processor — a chart mixing bytes and percent has to pick which of the two its scale is for, and
 * is then lying about the other — and read as bytes, which is what an operator acts on.
 */
export interface LoadReading {
  percent: number
  bytes: number
}

export function loadReading(load: HostLoad, key: LoadKey): LoadReading {
  if (key === 'cpu' || key === 'systemCpu') return { percent: load[key], bytes: 0 }
  const total = load.systemMemoryTotal
  return { percent: total ? (load[key] / total) * 100 : 0, bytes: load[key] }
}

/**
 * Every reporting host added together, at one moment.
 *
 * **Added, not averaged — except where adding would be nonsense.** Bytes are bytes: Osmium holding
 * 400 MB on each of three machines is holding 1.2 GB, and that is the number an operator wants.
 * Processor *time* adds up the same way, so the process line is the fleet's cores-worth of work.
 *
 * A machine's own processor figure is the exception. It is already a percentage of that machine,
 * and three machines at 50% are not one machine at 150% — they are a fleet running at half. So
 * that one line is the mean, and it is the only one.
 *
 * The percentages the chart is drawn at come from the fleet's totals: bytes held against bytes the
 * fleet has, which is the same arithmetic one host does against its own.
 */
export type FleetLoad = Record<LoadKey, LoadReading>

export function fleetLoad(sample: DashboardSample): FleetLoad | null {
  const loads = sample.hosts
    .map((host) => hostLoad(sample, host.hostId))
    .filter((load): load is HostLoad => load !== null)
  if (!loads.length) return null

  const total = sum(loads.map((load) => load.systemMemoryTotal))
  const share = (bytes: number) => (total ? (bytes / total) * 100 : 0)

  const memory = sum(loads.map((load) => load.memory))
  const systemMemory = sum(loads.map((load) => load.systemMemory))

  return {
    cpu: { percent: sum(loads.map((load) => load.cpu)), bytes: 0 },
    // The mean: a percentage of a machine cannot be added to a percentage of another one.
    systemCpu: { percent: sum(loads.map((load) => load.systemCpu)) / loads.length, bytes: 0 },
    memory: { percent: share(memory), bytes: memory },
    systemMemory: { percent: share(systemMemory), bytes: systemMemory },
  }
}

/** A percentage a person can read: 0%, 12.5%, 100%. */
export function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`
}

/**
 * At most [max] points, keeping the shape and always the newest.
 *
 * Six hours is 2160 points, several times wider than any card is in pixels. Each bucket keeps its
 * highest value rather than its first, so a burst of traffic is not thinned away.
 */
export function thin(points: TimePoint[], max: number): TimePoint[] {
  if (points.length <= max) return points
  const size = Math.ceil(points.length / max)
  const kept: TimePoint[] = []
  for (let start = 0; start < points.length; start += size) {
    const bucket = points.slice(start, start + size)
    const peak = bucket.reduce((best, point) => (point.value > best.value ? point : best))
    kept.push({ at: bucket[bucket.length - 1]!.at, value: peak.value })
  }
  return kept
}

/**
 * Where the remaining work reaches zero at the current rate, drawn from now to the edge of the chart.
 *
 * Returns the line's two ends, the second clipped at [until] when the finish is further away than
 * the chart reaches. Null when nothing is left or nothing is moving: a flat projection would say
 * "never", which is the stalled badge's job.
 */
export function projection(
  remaining: number,
  perMinute: number,
  now: number,
  until: number,
): { line: [TimePoint, TimePoint]; finishAt: number } | null {
  if (remaining <= 0 || perMinute <= 0) return null
  const finishAt = now + (remaining / perMinute) * 60_000
  const end = Math.min(finishAt, until)
  const left = Math.max(0, remaining - (perMinute * (end - now)) / 60_000)
  return { line: [{ at: now, value: remaining }, { at: end, value: left }], finishAt }
}

/**
 * A rate a person can read: 0 B/s, 812 B/s, 4.2 KB/s, 150 MB/s.
 *
 * The same formatter file sizes go through, so a chart and a size in the library cannot come to
 * disagree about what a megabyte is.
 */
export function formatRate(bytesPerSecond: number): string {
  return `${bytes(bytesPerSecond)}/s`
}

/** A count a person can read at a glance: 950, 12.4k, 3.1M. */
export function formatCount(value: number): string {
  if (Math.abs(value) < 1000) return String(Math.round(value))
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * The attention list folded by cause: "Low food — 3 agents" rather than three rows saying the
 * same thing. Errors first, then the causes affecting the most agents.
 */
export interface AttentionGroup {
  kind: AttentionKind
  severity: Attention['severity']
  entries: { agent: FleetAgent; detail: string | null }[]
}

export function groupAttention(items: Attention[]): AttentionGroup[] {
  const groups = new Map<AttentionKind, AttentionGroup>()
  for (const item of items) {
    const group = groups.get(item.kind) ?? { kind: item.kind, severity: item.severity, entries: [] }
    group.entries.push({ agent: item.agent, detail: item.detail })
    groups.set(item.kind, group)
  }
  return [...groups.values()].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    return b.entries.length - a.entries.length
  })
}

export type Severity = ActivityEntryResponse['severity']

/**
 * How wide one point of the activity chart is, per range: sixteen to twenty-four points, which is
 * enough to see a burst and few enough that a quiet minute is not its own spike.
 */
export const ACTIVITY_BUCKET_MS: Record<RangeKey, number> = {
  '15m': 60_000,
  '1h': 5 * 60_000,
  '6h': 15 * 60_000,
}

/**
 * Incidents per bucket across [from, to], one line per severity.
 *
 * Buckets are aligned to the clock rather than to [from], so they stay put as time moves. A bucket
 * that ends before [knownSince] is left out rather than drawn as zero: the feed is paged, and what
 * is older than the oldest entry loaded is unread, not quiet. Pass 0 when everything is loaded.
 *
 * Each point sits in the middle of its bucket, clamped to [to] so the newest does not run off the
 * chart.
 */
export function activitySeries(
  entries: Pick<ActivityEntryResponse, 'at' | 'severity'>[],
  from: number,
  to: number,
  size: number,
  knownSince: number,
): Record<Severity, TimePoint[]> {
  const first = Math.floor(from / size) * size
  const counts = new Map<number, Record<Severity, number>>()
  for (let start = first; start <= to; start += size) {
    if (start + size <= knownSince) continue
    counts.set(start, { INFO: 0, WARNING: 0, ERROR: 0 })
  }

  for (const entry of entries) {
    const start = Math.floor(Date.parse(entry.at) / size) * size
    const bucket = counts.get(start)
    if (bucket) bucket[entry.severity] += 1
  }

  const series: Record<Severity, TimePoint[]> = { INFO: [], WARNING: [], ERROR: [] }
  for (const [start, bucket] of counts) {
    const at = Math.min(to, Math.max(from, start + size / 2))
    for (const severity of ['INFO', 'WARNING', 'ERROR'] as const) {
      series[severity].push({ at, value: bucket[severity] })
    }
  }
  return series
}
