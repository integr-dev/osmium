import type { BotResponse } from '../api/client'

type BotState = BotResponse['state']

/**
 * Presentation for the bot lifecycle. STALE is deliberately neutral rather than red: an unreachable
 * host means the state is unknown, and rendering it as offline would claim knowledge we do not have.
 */
export const STATE_DOT: Record<BotState, string> = {
  ONLINE: 'bg-success',
  LINKED: 'bg-base-content/40',
  UNLINKED: 'bg-base-content/25',
  SETUP_PENDING: 'bg-info',
  NEEDS_RELINK: 'bg-error',
  CONNECT_FAILED: 'bg-error',
  STALE: 'bg-warning',
}

export const STATE_BADGE: Record<BotState, string> = {
  ONLINE: 'badge-success badge-soft',
  LINKED: 'badge-ghost',
  UNLINKED: 'badge-ghost',
  SETUP_PENDING: 'badge-info badge-soft',
  NEEDS_RELINK: 'badge-error badge-soft',
  CONNECT_FAILED: 'badge-error badge-soft',
  STALE: 'badge-warning badge-soft',
}

export const STATE_LABEL: Record<BotState, string> = {
  ONLINE: 'Online',
  LINKED: 'Ready',
  UNLINKED: 'Not set up',
  SETUP_PENDING: 'Setting up',
  NEEDS_RELINK: 'Needs relink',
  CONNECT_FAILED: 'Connect failed',
  STALE: 'Unknown',
}
