import type { ChatMessageResponse } from '../api/client'
import { isOnline, type FleetAgent } from '../stores/agents'

/**
 * What a chat panel is showing.
 *
 * The two are separate because the backend keeps them separate: a server's global chat is identical
 * for every agent standing on it, so folding it into each agent's conversation would bury the lines
 * that are actually about that agent. The endpoint takes exactly one of the two for the same reason.
 */
export type ChatScope = { kind: 'server'; address: string } | { kind: 'agent'; id: number }

/** Stable identity for a scope — what `watch` compares and what the rail persists. */
export function scopeKey(scope: ChatScope): string {
  return scope.kind === 'server' ? `server:${scope.address}` : `agent:${scope.id}`
}

/** The inverse, for a key read back out of storage. Anything unrecognised is treated as absent. */
export function parseScopeKey(key: string | null): ChatScope | null {
  if (!key) return null
  const [kind, ...rest] = key.split(':')
  const value = rest.join(':')
  if (kind === 'server' && value) return { kind: 'server', address: value }
  if (kind === 'agent' && /^\d+$/.test(value)) return { kind: 'agent', id: Number(value) }
  return null
}

/** The query the paged endpoint wants. */
export function scopeFilter(scope: ChatScope): { agentId: number } | { server: string } {
  return scope.kind === 'server' ? { server: scope.address } : { agentId: scope.id }
}

/**
 * Whether a line arriving on the live stream belongs in a panel showing [scope].
 *
 * The two are not mirror images. A **server** takes everything that happened there — the global
 * channel, whispers to an agent, proximity chat, the agents' own lines — because all of it happened
 * on that server. An **agent** excludes the global channel, which is identical for every agent
 * standing there and would bury the lines that are actually about this one.
 *
 * Global lines arrive tagged with whichever agent forwarded them, which is why the agent side has to
 * say so explicitly: otherwise the elected listener's conversation quietly becomes the whole
 * server's.
 */
export function belongsTo(line: ChatMessageResponse, scope: ChatScope): boolean {
  return scope.kind === 'server'
    ? line.serverAddress === scope.address
    : line.agentId === scope.id && line.scope !== 'GLOBAL'
}

/**
 * Which agents could speak into this scope.
 *
 * Speaking is impersonation through a specific agent, so a scope needs one chosen before anything
 * can be sent. On a server that means anyone standing there, listener first — it is the agent
 * already forwarding the conversation, so it is the one whose reply lands in the feed being read.
 *
 * An agent scope offers only that agent, offline included: the panel disables the box and says why,
 * which is more use than an empty picker that never explains itself.
 */
export function speakerCandidates(agents: FleetAgent[], scope: ChatScope): FleetAgent[] {
  if (scope.kind === 'agent') {
    const found = agents.find((agent) => agent.id === scope.id)
    return found ? [found] : []
  }

  const here = agents.filter((agent) => agent.serverAddress === scope.address && isOnline(agent))
  return [...here].sort((left, right) => Number(right.chatListener) - Number(left.chatListener))
}
