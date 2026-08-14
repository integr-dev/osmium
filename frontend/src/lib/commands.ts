import type { RouteLocationRaw } from 'vue-router'
import type { FleetAgent } from '../stores/agents'
import { isOnline } from '../stores/agents'
import type { HostResponse } from '../api/client'
import { t } from '../i18n'

/**
 * What the command palette can do, and how a query picks among it.
 *
 * Kept out of the component so the part with actual logic — matching and ranking — can be tested
 * without mounting anything, which is the line the rest of this suite draws.
 *
 * **Everything here is gated the same way the interface is.** A palette that offers an action the
 * API would refuse is worse than one that offers less: it turns a keystroke into a 403, and the
 * operator has no way to tell that from a bug.
 */
export type CommandSection = 'navigate' | 'agents' | 'hosts' | 'actions'

export interface Command {
  id: string
  section: CommandSection
  label: string
  /** Secondary line: what distinguishes two similarly named things. Also searched. */
  hint?: string
  /** A route to visit, or work to run. Exactly one of the two. */
  to?: RouteLocationRaw
  run?: () => Promise<void> | void
}

export interface CommandContext {
  agents: FleetAgent[]
  hosts: HostResponse[]
  can: (node: string) => boolean
  /** True when the agent's host has been heard from, so a command could actually be delivered. */
  hostReachable: (hostId: number) => boolean
  connect: (id: number) => Promise<void>
  disconnect: (id: number) => Promise<void>
  logout: () => Promise<void>
}

/**
 * Everything the palette could offer this operator, before filtering by what they typed.
 *
 * Rebuilt per open rather than cached: the fleet moves underneath it, and a stale list would offer
 * to connect an agent that is already online.
 */
export function buildCommands(context: CommandContext): Command[] {
  const commands: Command[] = [
    { id: 'go:dashboard', section: 'navigate', label: t('nav.dashboard'), to: { name: 'dashboard' } },
    { id: 'go:map', section: 'navigate', label: t('nav.map'), to: { name: 'map' } },
    { id: 'go:hosts', section: 'navigate', label: t('nav.hosts'), to: { name: 'hosts' } },
    { id: 'go:account', section: 'navigate', label: t('nav.myAccount'), to: { name: 'account' } },
  ]

  // The same nodes the route guard checks, so the palette never lands somewhere it bounces off.
  if (context.can('fleet.control')) {
    commands.push(
      { id: 'go:operations', section: 'navigate', label: t('nav.operations'), to: { name: 'operations' } },
      { id: 'go:configuration', section: 'navigate', label: t('nav.configuration'), to: { name: 'configuration' } },
    )
  }
  if (context.can('user.read')) {
    commands.push({ id: 'go:accounts', section: 'navigate', label: t('nav.allAccounts'), to: { name: 'accounts' } })
  }
  if (context.can('audit.read')) {
    commands.push({ id: 'go:audit', section: 'navigate', label: t('nav.auditLog'), to: { name: 'audit' } })
  }

  for (const agent of context.agents) {
    // Searchable by the Minecraft account as well as the operator's label: those are two different
    // names for the same agent, and whichever one somebody remembers should find it.
    commands.push({
      id: `agent:${agent.id}`,
      section: 'agents',
      label: agent.label,
      hint: [agent.mcUsername, agent.serverAddress].filter(Boolean).join(' · ') || t('agents.notLinked'),
      to: { name: 'agent', params: { id: agent.id } },
    })
  }

  for (const host of context.hosts) {
    commands.push({
      id: `host:${host.id}`,
      section: 'hosts',
      label: host.name,
      hint: host.address ?? t('hosts.notConnected'),
      to: { name: 'hosts' },
    })
  }

  /**
   * Only actions that would actually go through right now: the right state, a server to connect to,
   * and a host that has been heard from. Offering the rest would hand back a 409 or a 503 for a
   * keystroke that looked like it should work.
   *
   * Deleting an agent is deliberately absent. A palette is a place for fast, reversible moves, and
   * one wrong Enter should not be able to destroy something.
   */
  if (context.can('fleet.control')) {
    for (const agent of context.agents) {
      if (!context.hostReachable(agent.hostId)) continue

      if (isOnline(agent)) {
        commands.push({
          id: `disconnect:${agent.id}`,
          section: 'actions',
          label: t('palette.disconnectAgent', { name: agent.label }),
          hint: agent.serverAddress ?? undefined,
          run: () => context.disconnect(agent.id),
        })
      } else if (agent.serverAddress && CONNECTABLE.has(agent.state)) {
        commands.push({
          id: `connect:${agent.id}`,
          section: 'actions',
          label: t('palette.connectAgent', { name: agent.label }),
          hint: agent.serverAddress,
          run: () => context.connect(agent.id),
        })
      }
    }
  }

  commands.push({ id: 'action:logout', section: 'actions', label: t('nav.logOut'), run: context.logout })

  return commands
}

/** Mirrors the backend's own set — see `AgentService.CONNECTABLE`. */
const CONNECTABLE = new Set(['LINKED', 'CONNECT_FAILED', 'STALE'])

/**
 * Ranks [commands] against what has been typed, best first, dropping what does not match at all.
 *
 * Matching is a **subsequence**, not a substring: `eu1a1` should find `eu-1-agent-1`, which is
 * exactly the shape of name an operator gives a fleet and exactly what a substring search fails on.
 * The score is the distance the match had to travel, so tightly packed hits beat scattered ones,
 * and a hit on the label beats one on the hint — someone typing a name means the name.
 */
export function rank(commands: Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return commands

  return commands
    .map((command) => {
      const onLabel = fuzzyScore(needle, command.label)
      if (onLabel !== null) return { command, score: onLabel }
      const onHint = command.hint ? fuzzyScore(needle, command.hint) : null
      // Constant, not a multiplier: a hint match is always worse than any label match, rather than
      // sometimes beating a loose one.
      return onHint === null ? null : { command, score: onHint + HINT_PENALTY }
    })
    .filter((scored) => scored !== null)
    .sort((a, b) => a.score - b.score)
    .map((scored) => scored.command)
}

/** Null when [needle] is not a subsequence of [haystack]. Lower is better. */
function fuzzyScore(needle: string, haystack: string): number | null {
  const target = haystack.toLowerCase()
  let score = 0
  let from = 0

  for (const character of needle) {
    const at = target.indexOf(character, from)
    if (at === -1) return null
    // Skipping characters costs; landing immediately after the previous hit is free, so a run of
    // consecutive letters always beats the same letters scattered across the string.
    score += at - from
    from = at + 1
  }

  // Length breaks ties: with equal travel, the shorter name is the one that was more specifically
  // asked for.
  return score * 10 + target.length
}

const HINT_PENALTY = 10_000
