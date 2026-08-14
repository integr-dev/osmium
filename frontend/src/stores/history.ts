import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
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
export interface Sample {
  at: number
  online: number
  blocksPerMinute: number
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

    samples.value = [
      ...samples.value,
      { at: Date.now(), online: agents.online.length, blocksPerMinute: agents.blocksPerMinute },
    ].slice(-CAPACITY)
  }

  // Never cleared: the store lives as long as the app, and the series is the whole point of it.
  setInterval(record, SAMPLE_MS)

  const online = computed(() => samples.value.map((sample) => sample.online))
  const blocksPerMinute = computed(() => samples.value.map((sample) => sample.blocksPerMinute))

  /** How much of a window the samples actually cover, for the caption under a chart. */
  const minutes = computed(() => {
    const first = samples.value[0]
    const last = samples.value[samples.value.length - 1]
    if (!first || !last) return 0
    return Math.round((last.at - first.at) / 60_000)
  })

  return { samples, online, blocksPerMinute, minutes }
})
