import type { RouteLocationRaw } from 'vue-router'
import type { AgentPathResponse, AgentResponse, SchematicResponse } from '../api/client'
import type { ToastKind } from '../stores/toasts'

/**
 * Which live updates are worth a notice in the corner, and what it says.
 *
 * Decided here rather than in the store so every rule can be read, and tested, without a stream: the
 * store only hands each update and what it replaced to one of these, and posts whatever comes back.
 *
 * **Every notice links to what it is about.** A notice about an agent that dropped out is only half
 * useful if finding that agent is the operator's job, so each carries the page that answers "which
 * one, and what now".
 */
export interface Notice {
  kind: ToastKind
  key: string
  params: Record<string, unknown>
  to: RouteLocationRaw
  /** Closes by itself: it only says something went as asked. See the toast store. */
  fade?: boolean
  /** What it is the latest word on, so a newer notice about the same thing replaces it. */
  topic?: string
}

export function agentPage(id: number): RouteLocationRaw {
  return { name: 'agent', params: { id: String(id) } }
}

export function hostPage(id: number): RouteLocationRaw {
  return { name: 'host', params: { id: String(id) } }
}

export const JOBS_PAGE: RouteLocationRaw = { name: 'operations', query: { tab: 'jobs' } }

const SCHEMATICS_PAGE: RouteLocationRaw = { name: 'operations', query: { tab: 'schematics' } }

/**
 * The host's reasons for giving up, each to copy of its own.
 *
 * The host words these for its log, in English, and they are the whole vocabulary it has: matched
 * whole here so a German operator reads German. One this table does not know - a newer host - is
 * still shown, in the host's own words, rather than hidden behind a generic line.
 */
export const PATH_REASONS: Readonly<Record<string, string>> = {
  'there is no route there': 'toast.path.none',
  'the search ran out of time': 'toast.path.timedOut',
  'it has run out of blocks to build with': 'toast.path.noBlocks',
  'the world around it has not arrived yet': 'toast.path.unloaded',
  'it could not work out how to get there': 'toast.path.broke',
  'it could not place a block on the way': 'toast.path.couldNotPlace',
  'it could not break a block on the way': 'toast.path.couldNotBreak',
  'the server kept putting it back': 'toast.path.putBack',
}

/**
 * Whole blocks, and two numbers for a column. Numbers only, so the notice reads the same in every
 * locale and nothing in it is frozen in the language it was posted in.
 */
function goalOf(goal: AgentPathResponse['goal']): string {
  if (!goal) return '?'
  const x = Math.round(goal.x)
  const z = Math.round(goal.z)
  return goal.y === null ? `${x}, ${z}` : `${x}, ${Math.round(goal.y)}, ${z}`
}

/**
 * How a journey ended, or that the route being walked is only the closest the search could find.
 *
 * `IDLE` says nothing: it is what a stop reports, and the operator who pressed stop knows.
 *
 * **Nor does an errand.** An agent building a piece walks to the next block a few hundred times,
 * and every one of those arrivals went exactly as asked — by nobody. Announcing them buries the
 * journeys an operator did ask for under a column of successes about a build that has its own
 * progress. A failure still speaks: an agent that cannot reach its own work is worth knowing
 * about however it came to be going there.
 *
 * **All of them are the latest word on one agent's journey**, so each replaces the last: an arrival
 * is out of date once the same agent reports a failure, and "only getting as close as it can" once
 * the journey has ended either way. An arrival also fades by itself - it is the one outcome that
 * only says things went as asked.
 */
export function pathNotice(path: AgentPathResponse, name: string): Notice | null {
  const params = { name, goal: goalOf(path.goal) }
  const to = agentPage(path.agentId)
  const topic = `path:${path.agentId}`

  switch (path.state) {
    case 'ARRIVED':
      if (path.errand) return null
      return { kind: 'success', key: 'toast.path.arrived', params, to, topic, fade: true }
    case 'FAILED': {
      if (!path.reason) return { kind: 'error', key: 'toast.path.failed', params, to, topic }
      const key = PATH_REASONS[path.reason]
      return key
        ? { kind: 'error', key, params, to, topic }
        : { kind: 'error', key: 'toast.path.failedBecause', params: { ...params, reason: path.reason }, to, topic }
    }
    case 'PLANNING':
    case 'MOVING':
      if (path.errand || !path.closest) return null
      return { kind: 'warning', key: 'toast.path.closest', params, to, topic }
    default:
      return null
  }
}

/**
 * An agent leaving the game, or failing to get into it, when nobody here asked it to.
 *
 * `leftOnPurpose` is this tab's own Disconnect: telling the operator what they did a second ago is
 * noise. A failure to join is said either way, because the result lands long after the press and on
 * whatever page the operator has moved to since.
 *
 * A move to `STALE` says nothing: that is the host going quiet, which has a notice of its own.
 */
export function agentNotice(
  previous: AgentResponse | undefined,
  incoming: AgentResponse,
  leftOnPurpose: boolean,
): Notice | null {
  if (!previous) return null

  const was = previous.state
  const now = incoming.state
  const params = { name: incoming.label }
  const to = agentPage(incoming.id)

  if (now === 'NEEDS_RELINK' && was !== 'NEEDS_RELINK') {
    return { kind: 'error', key: 'toast.agent.needsRelink', params, to }
  }
  if (now === 'CONNECT_FAILED' && was !== 'CONNECT_FAILED') {
    return {
      kind: 'error',
      key: 'toast.agent.connectFailed',
      params: { ...params, server: incoming.serverAddress ?? '?' },
      to,
    }
  }
  if (leftOnPurpose) return null

  if (was === 'ONLINE' && now !== 'ONLINE' && now !== 'STALE') {
    return incoming.rejoining
      ? { kind: 'warning', key: 'toast.agent.dropped', params, to }
      : { kind: 'warning', key: 'toast.agent.left', params, to }
  }
  if (previous.rejoining && !incoming.rejoining && now !== 'ONLINE') {
    return { kind: 'warning', key: 'toast.agent.gaveUp', params, to }
  }
  return null
}

const WORKING: ReadonlySet<SchematicResponse['status']> = new Set(['UPLOADING', 'PENDING', 'ANALYSING'])

/**
 * A schematic finished being read, which takes minutes after the upload.
 *
 * Only a change this tab watched happen. A schematic seen for the first time already `READY` is one
 * that was ready before the page opened, and a rename is an update to one that stays ready.
 */
export function schematicNotice(
  was: SchematicResponse['status'] | undefined,
  incoming: SchematicResponse,
): Notice | null {
  if (!was || !WORKING.has(was)) return null

  const params = { name: incoming.name }

  if (incoming.status === 'READY') return { kind: 'success', key: 'toast.schematic.ready', params, to: SCHEMATICS_PAGE }
  if (incoming.status === 'FAILED') return { kind: 'error', key: 'toast.schematic.failed', params, to: SCHEMATICS_PAGE }
  return null
}
