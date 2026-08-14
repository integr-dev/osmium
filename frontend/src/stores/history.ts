import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { buildFigures } from '../lib/build'
import { isOnline } from '../lib/agentState'
import { useAgentStore } from './agents'

/**
 * The only place in Osmium that remembers what a number used to be.
 *
 * Nothing is stored server-side: agents, telemetry and throughput are all reported as "right now",
 * and the API has no series to ask for. So the browser keeps its own, sampled while the tab is open.
 *
 * That makes this **session-scoped by construction** — a reload starts an empty chart, and the
 * interface says as much rather than implying the fleet was idle. A durable series would be a table,
 * an endpoint and a retention policy; this is the version that pays for itself immediately.
 */
export interface Reading {
  online: number
  perMinute: number
}

export interface Sample {
  at: number
  /** The whole fleet. */
  all: Reading
  /** The same reading per server address, so the dashboard's picker has a series to switch to. */
  byServer: Record<string, Reading>
}

/** Ten seconds for half an hour. Long enough to show a trend, short enough to stay honest. */
const SAMPLE_MS = 10_000
const CAPACITY = 180

export const useHistoryStore = defineStore('history', () => {
  const samples = ref<Sample[]>([])
  const agents = useAgentStore()

  function record(): void {
    // Before the first load every figure is zero, and recording those would draw half an hour of
    // flatline that never happened.
    if (!agents.loaded) return

    const total = agents.schematic.totalBlocks
    const byServer: Record<string, Reading> = {}

    for (const address of agents.servers) {
      const here = agents.agents.filter((agent) => agent.serverAddress === address)
      byServer[address] = {
        online: here.filter(isOnline).length,
        perMinute: buildFigures(here, total).perMinute,
      }
    }

    samples.value = [
      ...samples.value,
      {
        at: Date.now(),
        all: { online: agents.online.length, perMinute: agents.blocksPerMinute },
        byServer,
      },
    ].slice(-CAPACITY)
  }

  // Never cleared: the store lives as long as the app, and the series is the whole point of it.
  setInterval(record, SAMPLE_MS)

  /**
   * One reading's series, for the whole fleet or for one server.
   *
   * A server that did not exist when a sample was taken reads as zero rather than being skipped: the
   * gap is real, and dropping the point would compress the timeline and draw a trend that never
   * happened.
   */
  function seriesFor(server: string | null, reading: keyof Reading): number[] {
    return samples.value.map((sample) =>
      server === null ? sample.all[reading] : (sample.byServer[server]?.[reading] ?? 0),
    )
  }

  /** How much of a window the samples actually cover, for the caption under a chart. */
  const minutes = computed(() => {
    const first = samples.value[0]
    const last = samples.value[samples.value.length - 1]
    if (!first || !last) return 0
    return Math.round((last.at - first.at) / 60_000)
  })

  return { samples, seriesFor, minutes }
})
