import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { fetchDashboardHistory, type DashboardSample } from '../api/dashboard'
import { useAgentStore } from './agents'

/**
 * The dashboard's past, as the backend keeps it: a point every ten seconds for six hours.
 *
 * Loaded whenever the live stream connects — the first time, and after every drop, since points
 * published while it was down are gone — and appended to as each new point arrives. A reload or a
 * second tab therefore opens on the same trend rather than an empty chart.
 *
 * The backend holds this in memory, so a backend restart does start it again; `minutes` is how the
 * interface says so.
 */

/** Matches `DashboardHistory.CAPACITY` on the backend. */
const CAPACITY = 2160

export const useHistoryStore = defineStore('history', () => {
  const samples = ref<DashboardSample[]>([])
  const error = ref<string | null>(null)
  const agents = useAgentStore()

  async function load(): Promise<void> {
    const result = await fetchDashboardHistory()
    if ('error' in result) {
      error.value = result.error
      return
    }
    error.value = null
    // A point can arrive while the request is out. Anything newer than what came back is kept.
    const last = result.at(-1)?.at ?? ''
    samples.value = [...result, ...samples.value.filter((sample) => sample.at > last)].slice(-CAPACITY)
  }

  function append(sample: DashboardSample): void {
    const last = samples.value.at(-1)
    if (last && sample.at <= last.at) return
    samples.value = [...samples.value, sample].slice(-CAPACITY)
  }

  // Never unsubscribed: the store lives as long as the app, and so does the stream.
  agents.onFeedEvent((name, data) => {
    if (name === 'dashboard-sample') append(data as DashboardSample)
  })

  watch(
    () => agents.liveUpdatesConnected,
    (connected) => {
      if (connected) void load()
    },
    { immediate: true },
  )

  /** How much time the samples cover, for the caption under a chart. */
  const minutes = computed(() => {
    const first = samples.value[0]
    const last = samples.value.at(-1)
    if (!first || !last) return 0
    return Math.round((Date.parse(last.at) - Date.parse(first.at)) / 60_000)
  })

  return { samples, error, minutes, load, append }
})
