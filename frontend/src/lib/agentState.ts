import { i18n } from '../i18n'
import type { AgentResponse } from '../api/client'

type AgentState = AgentResponse['state']

/**
 * Presentation for the agent lifecycle. STALE is deliberately neutral rather than red: an unreachable
 * host means the state is unknown, and rendering it as offline would claim knowledge we do not have.
 */
export const STATE_DOT: Record<AgentState, string> = {
  ONLINE: 'bg-success',
  LINKED: 'bg-base-content/40',
  UNLINKED: 'bg-base-content/25',
  SETUP_PENDING: 'bg-info',
  NEEDS_RELINK: 'bg-error',
  CONNECT_FAILED: 'bg-error',
  STALE: 'bg-warning',
}

export const STATE_BADGE: Record<AgentState, string> = {
  ONLINE: 'badge-success badge-soft',
  LINKED: 'badge-ghost',
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
