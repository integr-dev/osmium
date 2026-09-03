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

/**
 * A gap in the transcript where somebody was repeating themselves.
 *
 * **Not stored, and not a message.** The backend refuses a repeated line rather than writing it, so
 * there is no row to page back to and nothing was said — which is why this has its own shape rather
 * than being a `ChatMessageResponse` with a flag on it. It exists so that a panel somebody is
 * watching does not lose lines in silence.
 *
 * It follows that a gap is only ever seen by whoever was there. Reloading shows the conversation
 * without the hole and without this, which is the honest end state: nothing was stored, so there is
 * no hole in what was.
 */
export interface ChatSuppressedRun {
  /**
   * Negative and assigned in the browser, because the backend has no id for something it did not
   * store. Negative so it can never collide with a real line's, which is what the list keys on.
   */
  id: number
  at: string
  serverAddress: string
  /** Who was repeating themselves, or null once more than one person has been in the same gap. */
  from: string | null
  count: number
}

/** A rendered row: a line somebody said, or a gap where lines were refused. */
export type ChatRow = ChatMessageResponse | ChatSuppressedRun

export function isSuppressed(row: ChatRow): row is ChatSuppressedRun {
  return 'count' in row
}

/**
 * Folds an arriving run into the rows already on screen.
 *
 * The backend counts the run and resets it when a line gets through, so the count says which of the
 * two things to do: anything past the first grows the row at the top, and a one starts a new one.
 * Reading it off the count rather than off what is on screen means a panel that missed an event
 * corrects itself on the next one, instead of growing a gap that should have closed.
 *
 * Returns the row to prepend, or null when it grew the one already there.
 */
export function foldRun(
  rows: ChatRow[],
  run: Omit<ChatSuppressedRun, 'id'>,
  id: number,
): ChatSuppressedRun | null {
  const head = rows[0]

  if (run.count > 1 && head && isSuppressed(head)) {
    head.count = run.count
    head.at = run.at
    // Named only while one person is responsible for the whole gap. Two people repeating themselves
    // into the same hole makes either name a lie about most of it.
    if (head.from !== run.from) head.from = null
    return null
  }

  return { id, ...run }
}

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
