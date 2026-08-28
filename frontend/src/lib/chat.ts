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
 * Which of the fleet's agents said a line, when one of them did.
 *
 * Chat names an **account**; an operator thinks in **agents**. This is the only place the two can be
 * joined — a host reports who spoke and has no idea which of Osmium's agents that is.
 *
 * **Matched on the account *and* the server**, because one Minecraft account can be played by two
 * agents on two servers. Keyed on the account alone, the second agent overwrote the first and every
 * line from either was labelled with whichever happened to be built last.
 *
 * The fallback keeps the common case working. An agent moved to a different server would otherwise
 * lose its name on everything it said before the move, since the line carries the address it was
 * said on. So an account played by exactly one agent still resolves by name alone — the ambiguity
 * the pair exists to settle does not exist there.
 *
 * Lower-cased, because Minecraft compares names that way and a formatter may not preserve the case
 * the account was registered with.
 */
export function agentsByAccount(agents: FleetAgent[]): Map<string, string> {
  const named = new Map<string, string>()
  const labelsFor = new Map<string, string[]>()

  for (const agent of agents) {
    if (!agent.mcUsername) continue

    const account = agent.mcUsername.toLowerCase()
    // Joined by a character neither an account nor an address can contain, like widestGap does.
    named.set(`${account}\u0000${agent.serverAddress ?? ''}`, agent.label)
    labelsFor.set(account, [...(labelsFor.get(account) ?? []), agent.label])
  }

  for (const [account, labels] of labelsFor) {
    if (labels.length === 1) named.set(account, labels[0]!)
  }

  return named
}

/** The agent behind a line, from the map [agentsByAccount] built. */
export function agentBehind(line: ChatMessageResponse, named: Map<string, string>): string | undefined {
  const account = line.from.toLowerCase()

  return named.get(`${account}\u0000${line.serverAddress ?? ''}`) ?? named.get(account)
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
