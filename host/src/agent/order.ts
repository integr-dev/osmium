import { log } from '../log.ts'
import type { BlockPos } from '../protocol/wire.ts'

/**
 * The order the blocks of one piece are placed in.
 *
 * Three nested sweeps — an outer axis, a middle one, an inner one, each run one way or the other —
 * and whether the innermost snakes back the way it came instead of returning to the start of every
 * row. The backend carries the operator's choice as a token and this is where it becomes positions.
 *
 * `+y` is up, `+z` is south and `+x` is east: Minecraft's own convention, and the one every
 * coordinate on this wire is already in.
 */

export type Axis = 'x' | 'y' | 'z'

export interface Sweep {
  axis: Axis
  /** `1` runs from the low coordinate upward, `-1` from the high one down. */
  towards: 1 | -1
}

export interface PlacementOrder {
  /** Outermost first. Every axis appears exactly once. */
  sweeps: [Sweep, Sweep, Sweep]
  serpentine: boolean
}

/**
 * Bottom to top, north to south, west to east.
 *
 * Bottom to top outermost is not a preference: a block with nothing under it cannot be placed, so an
 * order filling the top first is one an agent cannot carry out. This is what every piece was built
 * in before the order was a choice, and what one arrives with when nobody has chosen.
 */
export const DEFAULT_ORDER: PlacementOrder = {
  sweeps: [
    { axis: 'y', towards: 1 },
    { axis: 'z', towards: 1 },
    { axis: 'x', towards: 1 },
  ],
  serpentine: false,
}

const AXES: readonly string[] = ['x', 'y', 'z']

/**
 * Reads the token a `build_segment` carries, falling back to the default.
 *
 * **Lenient here, strict on the backend.** The operator's choice is checked where it is made, by
 * something that can answer them; by the time it reaches a host the piece is already assigned, and
 * refusing to build it over a string this build does not recognise would strand the work. So an
 * unreadable token is logged and built in the default order, which is the outcome an older host
 * gives anyway.
 */
export function orderFrom(value: unknown): PlacementOrder {
  if (value === undefined || value === null) return DEFAULT_ORDER
  if (typeof value !== 'string') {
    log.warn(`Ignoring a placement order that is not a string, building bottom-up instead`)
    return DEFAULT_ORDER
  }

  const parsed = parseOrder(value)
  if (parsed) return parsed

  log.warn(`Ignoring placement order '${value}', which this host cannot read; building bottom-up instead`)
  return DEFAULT_ORDER
}

/** The token, or nothing when it is not one: three axes, each named once, each with a direction. */
export function parseOrder(value: string): PlacementOrder | undefined {
  const text = value.trim().toLowerCase()
  const serpentine = text.endsWith('s')
  const body = serpentine ? text.slice(0, -1) : text
  if (body.length !== 6) return undefined

  const sweeps: Sweep[] = []
  for (let at = 0; at < 6; at += 2) {
    const axis = body[at] as Axis
    const sign = body[at + 1]
    if (!AXES.includes(axis) || (sign !== '+' && sign !== '-')) return undefined
    if (sweeps.some((sweep) => sweep.axis === axis)) return undefined
    sweeps.push({ axis, towards: sign === '+' ? 1 : -1 })
  }

  return { sweeps: sweeps as [Sweep, Sweep, Sweep], serpentine }
}

export function formatOrder(order: PlacementOrder): string {
  const axes = order.sweeps.map((sweep) => `${sweep.axis}${sweep.towards === 1 ? '+' : '-'}`).join('')
  return order.serpentine ? `${axes}s` : axes
}

/**
 * Every position in the box, in this order.
 *
 * **A generator, because a piece is not a list.** A segment of a real build is millions of blocks,
 * and the one thing a builder needs is the next position — holding all of them to hand out one at a
 * time would be the largest allocation this process ever made, for no gain.
 *
 * Both corners are inclusive: the box a `build_segment` names is the blocks to place, not the space
 * between them.
 */
export function* positions(min: BlockPos, max: BlockPos, order: PlacementOrder): Generator<BlockPos> {
  const low = { x: Math.min(min.x, max.x), y: Math.min(min.y, max.y), z: Math.min(min.z, max.z) }
  const high = { x: Math.max(min.x, max.x), y: Math.max(min.y, max.y), z: Math.max(min.z, max.z) }
  const span = { x: high.x - low.x + 1, y: high.y - low.y + 1, z: high.z - low.z + 1 }

  const [outer, middle, inner] = order.sweeps
  const at = (sweep: Sweep, step: number): number =>
    sweep.towards === 1 ? low[sweep.axis] + step : high[sweep.axis] - step

  let pass = 0
  for (let a = 0; a < span[outer.axis]; a += 1) {
    for (let b = 0; b < span[middle.axis]; b += 1) {
      // Counted across the whole sweep rather than within one plane, so the snake carries from the
      // end of a row into the start of the next: the agent turns around where it is standing.
      const backwards = order.serpentine && pass % 2 === 1
      for (let c = 0; c < span[inner.axis]; c += 1) {
        const step = backwards ? span[inner.axis] - 1 - c : c
        const position = { x: 0, y: 0, z: 0 }
        position[outer.axis] = at(outer, a)
        position[middle.axis] = at(middle, b)
        position[inner.axis] = at(inner, step)
        yield position
      }
      pass += 1
    }
  }
}
