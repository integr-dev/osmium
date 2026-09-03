import { i18n } from '../i18n'
import type { FleetAgent } from '../stores/agents'
import { isOnline } from './agentState'

/**
 * What to call a dimension on screen.
 *
 * **The wire carries an id, not a label.** A host reports `the_end` — the canonical Minecraft name,
 * with the `minecraft:` namespace stripped — because that is what the value is *for*: it is the
 * grouping key {@link widestGap} compares positions within, and two servers spelling it differently
 * would split one world into two groups. Naming it is this side's job, which is also the only way
 * German gets to say "Das Ende".
 *
 * A dimension nobody has a name for is humanised rather than dropped. Servers run custom worlds, and
 * "Mining World" beats both `mining_world` and an empty field.
 */
/**
 * What the server says somebody is playing as.
 *
 * Survival is deliberately unnamed: it is the ordinary case, and writing it beside every player on
 * a survival server is a column of one repeated word. What is worth saying is that somebody is
 * *not* in it - a creative player near a build is a different thing to notice.
 */
export function gamemodeLabel(mode: number | null | undefined): string | null {
  return { 1: 'creative', 2: 'adventure', 3: 'spectator' }[mode ?? -1] ?? null
}

/**
 * Hit points, on the scale the game draws them.
 *
 * Half a heart survives, because it is a real state and the difference between one hit from dead
 * and two. A whole number never grows a `.0` for it: most players are on a whole number, and a
 * column of `20.0` is noise everywhere except the one row that needs the half.
 *
 * Not clamped to twenty. A player under a health boost genuinely has more, and rounding that down
 * would report somebody as easier to kill than they are.
 */
export function heartsLabel(health: number | null | undefined): string | null {
  if (typeof health !== 'number' || !Number.isFinite(health) || health < 0) return null

  const halves = Math.round(health * 2) / 2
  return i18n.global.t('map.hearts', { n: Number.isInteger(halves) ? halves : halves.toFixed(1) })
}

/**
 * The one-line reading for somebody standing near an agent, wherever one is drawn.
 *
 * Shared because it is drawn in four places — the 3D nametags, the map markers, the map's list of
 * strangers and the agent's own page — and four copies of "health, then ping, then gamemode" is
 * four chances for the same player to be described differently on two screens at once.
 *
 * Health first: it is the field somebody is actually scanning for, and it is the one that changes
 * while they watch. Every part is dropped when the server said nothing, so a line is short rather
 * than padded with blanks.
 */
export function playerVitals(player: {
  health?: number | null
  ping?: number | null
  gamemode?: number | null
}): string {
  return [heartsLabel(player.health), player.ping == null ? null : `${player.ping}ms`, gamemodeLabel(player.gamemode)]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The fleet's own one-line reading, as the map draws it under an agent.
 *
 * Different fields from {@link playerVitals}, and deliberately: an agent is ours, so its food and
 * its ping are known, while what is worth saying about a stranger is the gamemode nobody can ask
 * them for. Shared for the reason the rest of this file is - the map and the 3D viewer both label
 * agents, and two copies is two chances to describe one agent differently on two screens at once.
 */
export function agentVitals(agent: {
  telemetry?: { health?: number | null; food?: number | null; pingMs?: number | null } | null
}): string {
  const telemetry = agent.telemetry
  const parts: string[] = []

  const hearts = heartsLabel(telemetry?.health)
  if (hearts) parts.push(hearts)
  if (typeof telemetry?.food === 'number') parts.push(i18n.global.t('map.food', { n: Math.round(telemetry.food) }))
  if (typeof telemetry?.pingMs === 'number') parts.push(`${telemetry.pingMs}ms`)

  return parts.join(' · ')
}

/**
 * The whole line the map writes under an agent: who it is in game, then how it is doing.
 *
 * Shared so the 3D nametags can say the same thing. The name above a head is the agent's Osmium
 * label — what an operator called it — and its Minecraft username belongs here, because the two are
 * frequently not the same word and the one you can shout at in chat is this one.
 */
export function agentDetail(agent: {
  mcUsername?: string | null
  telemetry?: { health?: number | null; food?: number | null; pingMs?: number | null } | null
}): string {
  return [agent.mcUsername, agentVitals(agent)].filter(Boolean).join(' · ')
}

export function dimensionLabel(id: string): string {
  const known = `agents.dimensions.${id}`
  if (i18n.global.te(known)) return i18n.global.t(known)

  return id
    .replace(/^minecraft:/, '')
    .split('_')
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * The fleet's vitals, reduced to the agents worth looking at first.
 *
 * A dashboard cannot show twenty agents' health bars, and an average hides the one that matters: a
 * fleet averaging 18 health with one agent on 2 is a fleet with a problem. So each reading is
 * reported as its **worst case and who it belongs to**, which is the agent you would open.
 */
export interface VitalsExtreme {
  agent: FleetAgent
  value: number
}

export interface VitalsSummary {
  /** Agents in game, and how many of those have actually reported. */
  online: number
  reporting: number
  lowestHealth: VitalsExtreme | null
  lowestFood: VitalsExtreme | null
  worstPing: VitalsExtreme | null
  spread: Spread | null
}

/** The two agents standing furthest apart, and how far that is. */
export interface Spread {
  from: FleetAgent
  to: FleetAgent
  blocks: number
  dimension: string
  server: string | null
}

export function summariseVitals(agents: FleetAgent[]): VitalsSummary {
  const online = agents.filter(isOnline)

  /**
   * Only agents that are both in game **and** reporting.
   *
   * Telemetry outlives the session it was taken in — the last reading stays until something
   * replaces it — so an agent that has left the game still carries numbers. Reporting them would
   * put a health bar on an agent that is not there.
   */
  const reporting = online.filter((agent) => agent.telemetry !== null)

  return {
    online: online.length,
    reporting: reporting.length,
    lowestHealth: extreme(reporting, (agent) => agent.telemetry!.health, Math.min),
    lowestFood: extreme(reporting, (agent) => agent.telemetry!.food, Math.min),
    worstPing: extreme(reporting, (agent) => agent.telemetry!.pingMs, Math.max),
    spread: widestGap(reporting),
  }
}

/**
 * The agent at one end of a reading, or null when nobody is reporting.
 *
 * Ties keep the first agent in the list rather than the last, so the card does not swap between two
 * equally unhealthy agents every time a sample lands.
 */
function extreme(
  agents: FleetAgent[],
  read: (agent: FleetAgent) => number,
  pick: (...values: number[]) => number,
): VitalsExtreme | null {
  if (!agents.length) return null

  const target = pick(...agents.map(read))
  const found = agents.find((agent) => read(agent) === target)
  return found ? { agent: found, value: target } : null
}

/**
 * How far apart the fleet is standing, as the widest gap between any two agents.
 *
 * **Compared only within one world.** A position means nothing outside the world it was taken in,
 * and there are two ways to leave one: the nether is 1:8 to the overworld, and a different Minecraft
 * server is a different map entirely. Two agents standing at spawn on two servers are not zero
 * blocks apart, they are incomparable. So agents are grouped by server *and* dimension, and the
 * widest gap inside any one of those groups is what gets reported.
 *
 * Every pair, rather than a bounding box: a fleet is tens of agents, and the exact pair is what
 * makes the number actionable — it names who to look at.
 */
function widestGap(agents: FleetAgent[]): Spread | null {
  // Keyed on both, joined by a character neither an address nor a dimension can contain, so two
  // different pairs cannot collide into one group.
  const byWorld = new Map<string, FleetAgent[]>()
  for (const agent of agents) {
    const key = [agent.serverAddress ?? '', agent.telemetry!.dimension].join('\u0000')
    byWorld.set(key, [...(byWorld.get(key) ?? []), agent])
  }

  let widest: Spread | null = null

  for (const here of byWorld.values()) {
    for (let i = 0; i < here.length; i += 1) {
      for (let j = i + 1; j < here.length; j += 1) {
        const blocks = Math.round(distance(here[i]!, here[j]!))
        if (!widest || blocks > widest.blocks) {
          widest = {
            from: here[i]!,
            to: here[j]!,
            blocks,
            dimension: here[i]!.telemetry!.dimension,
            server: here[i]!.serverAddress,
          }
        }
      }
    }
  }

  return widest
}

function distance(one: FleetAgent, other: FleetAgent): number {
  const a = one.telemetry!.position
  const b = other.telemetry!.position
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}
