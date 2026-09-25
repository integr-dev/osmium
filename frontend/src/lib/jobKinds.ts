import { Hammer, Map as MapIcon, Pickaxe } from 'lucide-vue-next'
import type { Component } from 'vue'
import type { JobType } from '../api/jobs'

/**
 * What kind of work a job is, everywhere it has to be shown.
 *
 * **One table rather than a `switch` in each place that draws a job.** A job's kind reaches the
 * sidebar dot, the badge beside an agent, the progress bar, the job card, the box on the 2D map and
 * the cage in the 3D view — six places that would otherwise each have their own opinion about which
 * violet meant building. The first time one of them disagreed the colour would stop meaning
 * anything, which is the whole job of a colour.
 *
 * The hues themselves are in `style.css`, per theme. What is here is which token belongs to which
 * kind, and the names of the classes built from it.
 */
export const JOB_TYPES: readonly JobType[] = ['BUILD', 'EXCAVATE', 'MAP']

/**
 * The suffix the classes and the CSS variable are named after.
 *
 * A participle rather than the enum's own spelling: these read as what an agent is *doing*, which
 * is what the badge and the dot say, and `osmium-dot-EXCAVATE` says something else.
 */
export const JOB_TINT: Record<JobType, 'building' | 'excavating' | 'mapping'> = {
  BUILD: 'building',
  EXCAVATE: 'excavating',
  MAP: 'mapping',
}

/** The CSS variable, for the two views that draw on a canvas and cannot use a class. */
export function jobInk(type: JobType): string {
  return `--osmium-${JOB_TINT[type]}`
}

/**
 * The fallback each colour falls back to where a variable cannot be read.
 *
 * Both canvases resolve the variable at draw time and both can be asked to draw before the
 * stylesheet has settled — see `WorldMap.themeInks`. These are the dark theme's values, which is
 * the theme Osmium opens in.
 */
export const JOB_FALLBACK: Record<JobType, string> = {
  BUILD: '#a78bfa',
  EXCAVATE: '#e7a13d',
  MAP: '#4bb8d4',
}

export function jobDot(type: JobType): string {
  return `osmium-dot-${JOB_TINT[type]}`
}

export function jobBadge(type: JobType): string {
  return `osmium-badge-${JOB_TINT[type]}`
}

export function jobProgress(type: JobType): string {
  return `osmium-progress-${JOB_TINT[type]}`
}

/**
 * The colour as a style, for the odd mark that is neither a dot nor a badge — an icon beside a
 * title, a swatch in a legend.
 *
 * A style rather than a fourth family of classes: one icon per card does not earn three more rules
 * in the stylesheet, and the variable is the same one those rules would read.
 */
export function jobStyle(type: JobType): { color: string } {
  return { color: `var(${jobInk(type)})` }
}

/** What each kind is called, as a key into the copy. */
export function jobTypeLabel(type: JobType): string {
  return `jobType.${type}`
}

/**
 * The icon each kind is drawn with.
 *
 * A second signal beside the colour, because colour alone is the one distinction some operators
 * cannot make. A hammer raises, a pickaxe takes away, a map is drawn.
 */
export const JOB_ICON: Record<JobType, Component> = {
  BUILD: Hammer,
  EXCAVATE: Pickaxe,
  MAP: MapIcon,
}

/**
 * What a job's count is counting.
 *
 * A build places blocks, an excavation clears them, and a mapping job walks columns of ground —
 * the same number, three different things to call it, and "blocks placed" on a survey is simply
 * wrong. The key resolves against the copy; see `jobs.progress.*`.
 */
export function jobUnit(type: JobType): string {
  return `jobs.unit.${type}`
}

/**
 * The one kind a set of jobs is, or null where they are not all the same.
 *
 * **The dashboard sums across jobs, and the words have to survive that.** A fleet building a tower
 * while another crew charts a valley has a total that is blocks *and* columns, and "Blocks placed"
 * over it is simply wrong — so a mixed fleet is said in neutral words rather than in the words of
 * whichever job happened to be first in the list.
 */
export function oneKind(types: readonly JobType[]): JobType | null {
  const first = types[0]
  if (first === undefined) return null
  return types.every((type) => type === first) ? first : null
}
