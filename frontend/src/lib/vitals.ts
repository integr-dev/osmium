import { i18n } from '../i18n'

/**
 * What to call a dimension on screen.
 *
 * **The wire carries an id, not a label.** A host reports `the_end` — the canonical Minecraft name,
 * with the `minecraft:` namespace stripped — because that is what the value is *for*: it is a key
 * that positions are grouped by, and two servers spelling it differently would split one world into
 * two groups. Naming it is this side's job, which is also the only way
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
