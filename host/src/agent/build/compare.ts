import { bare, parseSpec } from './plan.ts'

/**
 * What is different between the state a schematic asked for and the state that is standing.
 *
 * Shared by the printer, which uses it to decide whether a placement worked, and by the rig, which
 * uses it to report on a whole build. One implementation because the two must agree: a printer that
 * calls a block finished on a rule the verifier does not share is a printer that reports a build
 * complete and wrong.
 */

export interface Mismatch {
  /** The property, or `block` when it is the wrong block entirely. */
  property: string
  want: string
  have: string
}

/** What a block looks like once it is read out of the world. */
export interface Standing {
  name: string
  properties: Record<string, string>
}

/**
 * Every difference, the block name first.
 *
 * A wrong block is reported alone: the properties of a birch stair say nothing useful about an oak
 * one that should have been there, and listing them would bury the one line that matters.
 *
 * Properties the wanted state does not name are not compared. A schematic's palette carries the
 * whole state, so an extra property on the standing block is one this build of the game has and the
 * file's did not — a difference in versions, not in the build.
 */
export function compare(wanted: string, standing: Standing | undefined): Mismatch[] {
  const want = parseSpec(wanted)
  const name = bare(want.name)

  if (!standing) return [{ property: 'block', want: name, have: 'air' }]

  const have = bare(standing.name)
  if (have !== name) return [{ property: 'block', want: name, have }]

  const out: Mismatch[] = []
  for (const [property, value] of Object.entries(want.properties)) {
    const here = standing.properties[property]
    if (here === undefined) continue
    if (String(here) !== value) out.push({ property, want: value, have: String(here) })
  }

  return out
}

/** One line, for a log or a report. */
export function describe(at: { x: number; y: number; z: number }, misses: readonly Mismatch[]): string {
  const where = `${at.x} ${at.y} ${at.z}`
  const what = misses.map((miss) => `${miss.property}: wanted ${miss.want}, got ${miss.have}`).join(', ')

  return `${where} — ${what}`
}
