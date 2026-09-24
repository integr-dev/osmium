/**
 * A box of the world, dragged out on the map or in the 3D view.
 *
 * **Whole blocks, inclusive at both ends.** Dragging from one block to another selects both of them
 * and everything between, whichever way the drag went - which is what somebody means by "from here
 * to there", and what makes a drag that starts and ends on the same block one block rather than
 * nothing.
 *
 * Height is optional because the map has none to give: it is drawn from above, and a column there is
 * every height at once.
 */
export interface Area {
  west: number
  east: number
  north: number
  south: number
  /** The lowest and highest block, when the drag was made somewhere with height. */
  low?: number
  high?: number
}

/** One end of a drag: a block, with its height when the surface it was made on has one. */
export interface Corner {
  x: number
  y?: number | null
  z: number
}

/** An area as it is handed up from where it was dragged, with where on the surface it ended. */
export interface AreaPicked {
  area: Area
  /** Where the drag ended on the surface, for the panel that opens about it. */
  px: number
  py: number
}

/**
 * One press with shift held, from the block it went down on to the block it came up on.
 *
 * `moved` is whether it travelled far enough to be a drag rather than a click.
 */
export interface ShiftPress {
  start: Corner
  end: Corner
  moved: boolean
}

/**
 * What a shift press that has just been let go of comes to.
 *
 * **Two ways to choose the same area.** A drag is both corners in one gesture. A click is one corner,
 * held until the next shift click supplies the other - which is how an area too big to drag across
 * the screen at one zoom gets chosen at all. A drag while a first corner is waiting starts again from
 * where the drag did, because that is what the hand just said.
 */
export function afterShiftPress(
  waiting: Corner | null,
  press: ShiftPress,
): { waiting: Corner | null; chosen: Area | null } {
  if (!press.moved && waiting === null) return { waiting: press.start, chosen: null }
  return { waiting: null, chosen: areaBetween(press.moved || waiting === null ? press.start : waiting, press.end) }
}

/** The area to draw while a shift press is still down, or while a first corner waits for its second. */
export function areaUnderway(waiting: Corner | null, press: ShiftPress | null, pointer: Corner): Area {
  if (press && (press.moved || waiting === null)) return areaBetween(press.start, pointer)
  return areaBetween(waiting ?? pointer, pointer)
}

/** The box two corners span, whichever way round they are. */
export function areaBetween(from: Corner, to: Corner): Area {
  const area: Area = {
    west: Math.min(from.x, to.x),
    east: Math.max(from.x, to.x),
    north: Math.min(from.z, to.z),
    south: Math.max(from.z, to.z),
  }

  if (typeof from.y === 'number' && typeof to.y === 'number') {
    area.low = Math.min(from.y, to.y)
    area.high = Math.max(from.y, to.y)
  }

  return area
}

/**
 * The twelve edges of a one-block box from its corner, as the ends of line segments.
 *
 * A whole cage rather than the hover box's corners: an area is a stretch of the world, and its edges
 * are the thing being shown. Scaled to the area rather than rebuilt for it.
 */
export function cubeEdges(): number[] {
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
    [0, 1, 0],
    [1, 1, 0],
    [1, 1, 1],
    [0, 1, 1],
  ] as const
  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ] as const

  return edges.flatMap(([from, to]) => [...corners[from], ...corners[to]])
}

/** How many blocks it is across, from west to east and north to south, and high where it has height. */
export function areaSize(area: Area): { width: number; depth: number; height?: number } {
  const size: { width: number; depth: number; height?: number } = {
    width: area.east - area.west + 1,
    depth: area.south - area.north + 1,
  }
  if (area.low !== undefined && area.high !== undefined) size.height = area.high - area.low + 1
  return size
}

/**
 * The line under a panel's title: both corners, then the size.
 *
 * Numbers and symbols only, like every coordinate in the interface, so it reads the same in every
 * locale and nothing in it has to be translated.
 */
export function areaNote(area: Area): string {
  const size = areaSize(area)

  if (area.low !== undefined && area.high !== undefined && size.height !== undefined) {
    return (
      `${area.west}, ${area.low}, ${area.north} → ${area.east}, ${area.high}, ${area.south} · ` +
      `${size.width} × ${size.height} × ${size.depth}`
    )
  }

  return `${area.west}, ${area.north} → ${area.east}, ${area.south} · ${size.width} × ${size.depth}`
}

/**
 * An area handed from the map to the Map tab, as query parameters.
 *
 * **The URL is the handoff**, rather than a store the two screens share: the tab is reached by a
 * router push, it can be linked and bookmarked, and nothing is left behind to be applied to the
 * next survey somebody opens the tab to write.
 *
 * The world is carried with the corners because it has to be. A box of coordinates means a
 * different place in the nether than it does in the overworld, and the tab refuses to start a
 * survey that does not say where it is - so a handoff that dropped them would hand over a form
 * that still has to be filled in by hand.
 */
export interface AreaHandoff {
  area: Area
  server: string
  dimension: string
}

export function areaQuery(handoff: AreaHandoff): Record<string, string> {
  return {
    west: String(handoff.area.west),
    north: String(handoff.area.north),
    east: String(handoff.area.east),
    south: String(handoff.area.south),
    server: handoff.server,
    world: handoff.dimension,
  }
}

/**
 * The handoff a query carries, or null when it carries none.
 *
 * All of it or none of it: anything can be typed into an address bar, and half an area is not a
 * form to prefill. Heights are not carried at all — the map is drawn from above, and what a survey
 * flies at is the one number it has to be told.
 */
export function areaFromQuery(query: Record<string, unknown>): AreaHandoff | null {
  const server = text(query['server'])
  const dimension = text(query['world'])
  if (!server || !dimension) return null

  const west = whole(query['west'])
  const north = whole(query['north'])
  const east = whole(query['east'])
  const south = whole(query['south'])
  if (west === null || north === null || east === null || south === null) return null

  return {
    area: {
      west: Math.min(west, east),
      east: Math.max(west, east),
      north: Math.min(north, south),
      south: Math.max(north, south),
    },
    server,
    dimension,
  }
}

/** A repeated parameter arrives as an array, which is not a value. */
function text(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function whole(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isInteger(value) ? value : null
}

/** The parameters {@link areaQuery} writes, so the tab that reads them can also clear them. */
export const AREA_PARAMS = ['west', 'north', 'east', 'south', 'server', 'world'] as const

/**
 * The query with the handoff taken out.
 *
 * Read once and then dropped: the form is the plan from that moment, and a reload that filled the
 * map's corners back in would quietly undo whatever was typed after arriving.
 */
export function withoutArea<T extends Record<string, unknown>>(query: T): Partial<T> {
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(query)) {
    if (!(AREA_PARAMS as readonly string[]).includes(key)) kept[key] = value
  }
  return kept as Partial<T>
}
