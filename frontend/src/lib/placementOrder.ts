/**
 * The order an agent places the blocks of one segment in.
 *
 * **Three nested sweeps, not a named list.** A build is a box, and the only orders worth having are
 * the ones that sweep it: an outer axis, a middle one, an inner one, each run in one direction or
 * the other. Naming them — "bottom-up, north to south" — was the obvious design and the wrong one:
 * the names multiply, each has to be explained, and the operator still cannot say the one thing the
 * fourth name would have been. Choosing the axes says all of it in six controls.
 *
 * `serpentine` is the exception that is not an axis: whether the innermost sweep runs back the way
 * it came instead of returning to the start of the row. It is the difference between an agent
 * walking the length of a wall twice and walking it once, which on a long segment is most of the
 * time spent.
 */

export type Axis = 'x' | 'y' | 'z'

export const AXES: readonly Axis[] = ['x', 'y', 'z']

/**
 * One axis of a sweep: which, and which way along it.
 *
 * `up` is `+y`, `south` is `+z` and `east` is `+x`, which is Minecraft's own convention and the one
 * every coordinate in Osmium is already in.
 */
export interface Sweep {
  axis: Axis
  /** `1` runs from the low coordinate upward, `-1` from the high coordinate down. */
  towards: 1 | -1
}

export interface PlacementOrder {
  /** Outermost first. Every axis appears exactly once. */
  sweeps: [Sweep, Sweep, Sweep]
  serpentine: boolean
}

/**
 * Bottom to top, north to south, west to east, without snaking.
 *
 * Bottom to top outermost is not a taste: a block with nothing under it cannot be placed, so an
 * order that fills the top first is one an agent cannot carry out. Anything else is the operator's
 * to choose, and this is the least surprising of them.
 */
export const DEFAULT_ORDER: PlacementOrder = {
  sweeps: [
    { axis: 'y', towards: 1 },
    { axis: 'z', towards: 1 },
    { axis: 'x', towards: 1 },
  ],
  serpentine: false,
}

/**
 * The wire form: three signed axes and an optional `s`, as in `y+z+x+` or `y-x+z-s`.
 *
 * A string rather than an object because of where it has to travel: a column on a segment, a field
 * on the command that dispatches it, and a value in a settings map. All three are happier with one
 * short token than with a nested shape, and it is readable in a log, which the shape is not.
 */
export function formatOrder(order: PlacementOrder): string {
  const axes = order.sweeps.map((sweep) => `${sweep.axis}${sweep.towards === 1 ? '+' : '-'}`).join('')
  return order.serpentine ? `${axes}s` : axes
}

/**
 * Reads the wire form, or nothing when it is not one.
 *
 * Strict about the part that matters: three axes, each named once. A string naming `y` twice
 * describes no sweep at all, and silently repairing it would place blocks in an order nobody asked
 * for — on a build that is hours of an agent's work.
 */
export function parseOrder(value: string | null | undefined): PlacementOrder | null {
  const text = value?.trim().toLowerCase()
  if (!text) return null

  const serpentine = text.endsWith('s')
  const body = serpentine ? text.slice(0, -1) : text
  if (body.length !== 6) return null

  const sweeps: Sweep[] = []
  for (let at = 0; at < 6; at += 2) {
    const axis = body[at] as Axis
    const sign = body[at + 1]
    if (!AXES.includes(axis) || (sign !== '+' && sign !== '-')) return null
    if (sweeps.some((sweep) => sweep.axis === axis)) return null
    sweeps.push({ axis, towards: sign === '+' ? 1 : -1 })
  }

  return { sweeps: sweeps as [Sweep, Sweep, Sweep], serpentine }
}

/** The same order with one axis moved to a new place in the sweep, the others closing up around it. */
export function reorder(order: PlacementOrder, axis: Axis, to: number): PlacementOrder {
  const rest = order.sweeps.filter((sweep) => sweep.axis !== axis)
  const moved = order.sweeps.find((sweep) => sweep.axis === axis)!
  const at = Math.min(Math.max(to, 0), 2)
  return { ...order, sweeps: [...rest.slice(0, at), moved, ...rest.slice(at)] as [Sweep, Sweep, Sweep] }
}

/** The same order with one axis run the other way. */
export function reverse(order: PlacementOrder, axis: Axis): PlacementOrder {
  return {
    ...order,
    sweeps: order.sweeps.map((sweep) =>
      sweep.axis === axis ? { axis, towards: (sweep.towards === 1 ? -1 : 1) as 1 | -1 } : sweep,
    ) as [Sweep, Sweep, Sweep],
  }
}

export interface Cell {
  x: number
  y: number
  z: number
}

/**
 * Every cell of a box the size of [size], in the order this describes.
 *
 * Written out rather than compared, because the caller is an animation that walks the sequence and
 * a test that reads it. A segment is millions of blocks and is never ordered here — the host does
 * that, one position at a time, from the same three sweeps.
 *
 * Serpentine reverses the innermost sweep on every other pass, counting passes across the whole
 * sequence rather than within one plane, so the snake carries from the end of a layer into the
 * start of the next: the agent finishes where it is and turns around, which is the point.
 */
export function sequence(size: Cell, order: PlacementOrder): Cell[] {
  const [outer, middle, inner] = order.sweeps
  const lengths: Record<Axis, number> = { x: Math.max(0, size.x), y: Math.max(0, size.y), z: Math.max(0, size.z) }

  const along = (sweep: Sweep, step: number): number =>
    sweep.towards === 1 ? step : lengths[sweep.axis] - 1 - step

  const cells: Cell[] = []
  let pass = 0

  for (let a = 0; a < lengths[outer.axis]; a += 1) {
    for (let b = 0; b < lengths[middle.axis]; b += 1) {
      const backwards = order.serpentine && pass % 2 === 1
      for (let c = 0; c < lengths[inner.axis]; c += 1) {
        const step = backwards ? lengths[inner.axis] - 1 - c : c
        const cell = { x: 0, y: 0, z: 0 }
        cell[outer.axis] = along(outer, a)
        cell[middle.axis] = along(middle, b)
        cell[inner.axis] = along(inner, step)
        cells.push(cell)
      }
      pass += 1
    }
  }

  return cells
}
