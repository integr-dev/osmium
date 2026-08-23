import { i18n } from '../i18n'
import type { AgentResponse } from '../api/client'

type AgentState = AgentResponse['state']

/**
 * Presentation for the agent lifecycle. STALE is deliberately neutral rather than red: an unreachable
 * host means the state is unknown, and rendering it as offline would claim knowledge we do not have.
 *
 * CONNECTING and SETUP_PENDING share a colour on purpose. They are the same fact about the fleet —
 * a command is out and the host has not answered — and an operator who has learnt to read one of
 * them has learnt to read the other.
 */
export const STATE_DOT: Record<AgentState, string> = {
  ONLINE: 'bg-success',
  LINKED: 'bg-base-content/40',
  CONNECTING: 'bg-info',
  UNLINKED: 'bg-base-content/25',
  SETUP_PENDING: 'bg-info',
  NEEDS_RELINK: 'bg-error',
  CONNECT_FAILED: 'bg-error',
  STALE: 'bg-warning',
}

export const STATE_BADGE: Record<AgentState, string> = {
  ONLINE: 'badge-success badge-soft',
  LINKED: 'badge-ghost',
  CONNECTING: 'badge-info badge-soft',
  UNLINKED: 'badge-ghost',
  SETUP_PENDING: 'badge-info badge-soft',
  NEEDS_RELINK: 'badge-error badge-soft',
  CONNECT_FAILED: 'badge-error badge-soft',
  STALE: 'badge-warning badge-soft',
}

/**
 * States in which an agent is genuinely in game.
 *
 * Here rather than in the fleet store because the pure helpers need it — and a store that imports
 * them while they import the store is the import cycle this project has already been bitten by once.
 */
export function isOnline(agent: Pick<AgentResponse, 'state'>): boolean {
  return agent.state === 'ONLINE'
}

/** The state as an operator reads it. Colours stay here; wording lives with the rest of the copy. */
export function stateLabel(state: AgentState): string {
  return i18n.global.t('agentState.' + state)
}

/**
 * Building, shown in place of the lifecycle state rather than beside it.
 *
 * **A display substitution, not a state.** The backend has no such state and never will: an agent
 * is `ONLINE` and separately holds a piece of a run, and collapsing the two would mean the host
 * reporting something it cannot know. What an operator wants at a glance is the more specific of
 * the two facts, and "building" already says "in game" — so the badge is replaced rather than
 * doubled, which is also the only version that fits in a sidebar dot.
 *
 * Only ever substituted over `ONLINE`. An agent that leaves the game has its segments released, so
 * the pairing cannot outlive the session; guarding on it anyway means a stale assignment can never
 * paint a disconnected agent as busy.
 */
const BUILDING_DOT = 'bg-info'
const BUILDING_BADGE = 'badge-info badge-soft'

function substituted(state: AgentState, building: boolean): boolean {
  return building && state === 'ONLINE'
}

export function agentDot(state: AgentState, building = false): string {
  return substituted(state, building) ? BUILDING_DOT : (STATE_DOT[state] ?? 'bg-base-content/30')
}

export function agentBadge(state: AgentState, building = false): string {
  return substituted(state, building) ? BUILDING_BADGE : STATE_BADGE[state]
}

export function agentStateLabel(state: AgentState, building = false): string {
  return substituted(state, building) ? i18n.global.t('agentState.BUILDING') : stateLabel(state)
}
