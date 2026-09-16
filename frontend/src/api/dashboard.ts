import { api, errorMessage } from './client'
import { t } from '../i18n'

/**
 * The dashboard's history: a point every ten seconds for the last six hours, kept by the backend.
 *
 * Declared here rather than taken from the generator, which marks every field optional and every
 * nullable one as merely absent — and a host that has not reported its traffic is `null`, which
 * the charts treat differently from zero.
 */
export interface DashboardReading {
  online: number
  agents: number
  placed: number
  total: number
  perMinute: number
}

export interface HostTraffic {
  hostId: number
  name: string
  reachable: boolean
  linkSent: number
  linkReceived: number
  gameSent: number | null
  gameReceived: number | null
}

export interface DashboardSample {
  /** ISO timestamp, as the backend writes an `Instant`. */
  at: string
  fleet: DashboardReading
  servers: Record<string, DashboardReading>
  hosts: HostTraffic[]
}

export async function fetchDashboardHistory(): Promise<DashboardSample[] | { error: string }> {
  const { data, error } = await api.GET('/api/dashboard/history')
  if (error) return { error: errorMessage(error, t('errors.loadDashboard')) }
  return (data ?? []) as DashboardSample[]
}
