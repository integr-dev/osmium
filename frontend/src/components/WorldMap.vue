<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { fetchTiles } from '../api/map'
import { loadPalette } from '../lib/mapPalette'
import { EMPTY, TILE, decodeTile, paintTile, tileKey, type DecodedTile, type Palette, type TilePayload } from '../lib/mapTiles'
import { useAgentStore } from '../stores/agents'
import { IDENTITY, panBy, zoomAt, type Limits, type View } from '../lib/panZoom'
import { afterShiftPress, areaUnderway, type Area, type AreaPicked, type Corner, type ShiftPress } from '../lib/area'

/**
 * The world as the fleet has charted it, drawn one pixel per block column.
 *
 * Vanilla's zoom zero, which is what makes it read as a Minecraft map rather than as a chart: a
 * chunk is a 16x16 tile, and terrain is shaded by the step up or down to the column north of it,
 * the same rule the game uses. What arrives from the backend is block names and heights - never
 * colours - so the palette is applied here, out of the same block atlas the 3D viewer renders from.
 *
 * Two layers, drawn to one canvas. The terrain is slow-moving and cached per tile; the agents and
 * the people around them move every second and are drawn over it each frame. The split is what
 * keeps a pan cheap: panning redraws, it does not repaint a single tile.
 */
const props = defineProps<{
  server: string
  /** Which world. The dimensions are separate maps sharing a coordinate system. */
  dimension: string
  /** Where the fleet is right now, in block coordinates. Drawn over the terrain. */
  marks: Mark[]
  /** Where the fleet is going. Drawn under the marks, so a line never covers a face. */
  paths: PathLine[]
  /**
   * An area already dragged out, drawn over everything until whoever opened a panel about it lets
   * it go. Held by the caller, because the panel is the caller's.
   */
  area?: Area | null
  /** Where builds stand and will stand in this world. Drawn over the terrain, under everything else. */
  builds?: BuildBox[]
}>()

/**
 * A build's footprint, as this map draws it.
 *
 * **Planned or under way, and the line says which.** A plan's box is dashed — it is where somebody
 * has said a build will go, and nothing is there yet — and a job's is solid, in the colour building
 * has everywhere else in the interface. Both are the same footprint arithmetic, `footprintOf` in
 * `lib/placement.ts`, so a plan that becomes a job does not move.
 */
export interface BuildBox {
  id: string
  label: string
  /** Inclusive at both ends, like every block range on this map. */
  box: Footprint
  planned: boolean
  /** The pieces a job was cut into, drawn inside its box; a finished one is washed in. */
  sections: Array<{ box: Footprint; done: boolean }>
}

/** A range of whole blocks seen from above, inclusive at both ends. */
interface Footprint {
  west: number
  east: number
  north: number
  south: number
}

/**
 * One agent's journey, as this screen draws it.
 *
 * Live only: a path that has ended is not a weaker answer the way an old position is, it is a wrong
 * one, so there is nothing here for an agent standing still.
 */
export interface PathLine {
  id: string
  /** In block coordinates, oldest first. */
  points: Array<{ x: number; y: number; z: number }>
  /** How far along {@link points} the agent has got. What is behind it is drawn spent. */
  progress: number
  /**
   * Where the journey ends, which is not always the last node of a path still being planned.
   *
   * No height, and not because it is unknown: this map is drawn from above, and the square marking a
   * destination is in the same place at every one. A goal may genuinely have no height anyway - a
   * spot picked off uncharted ground names a column - so asking for one here would be asking the
   * caller to invent it for a marker that would not use it.
   */
  goal?: { x: number; z: number }
}

/**
 * Somewhere on the map that was clicked rather than dragged over.
 *
 * Carries where it is in the world *and* where it is on the screen, because whoever acts on it has
 * to draw a panel there. Working that out again from the block coordinate would mean a second copy
 * of the projection, in a component that has no business owning one.
 */
const emit = defineEmits<{ pick: [Picked]; select: [AreaPicked] }>()

export interface Picked {
  x: number
  /**
   * The ground at that column, from the same heights the shading is drawn from.
   *
   * Null where nothing has been charted there. A map is drawn from what agents have walked past, so
   * clicking a blank corner of it is an ordinary thing to do and answering with a zero would be a
   * destination at the bottom of the world.
   */
  y: number | null
  z: number
  /** Where on the canvas, for the panel that opens about it. */
  px: number
  py: number
}

/** Something to draw on top of the terrain: an agent, or somebody near one. */
export interface Mark {
  id: string
  label: string
  x: number
  z: number
  /** Fleet or not. A player who is not one of ours is the thing this screen exists to show. */
  ours: boolean
  /**
   * A second line under the name: health, ping, whatever is known about them.
   *
   * Drawn smaller and dimmer, and only above a certain zoom - see {@link DETAIL_FROM}. A map at a
   * sixteenth of a pixel per block is being read for where things are, and a paragraph over every
   * dot is what stops that being answerable.
   */
  detail?: string
  /** Recent positions, oldest first, for the trail. Only the fleet keeps one. */
  trail?: Array<{ x: number; z: number }>
  /**
   * Nobody can see this one any more; it is drawn where it last was.
   *
   * The same marker, drained of colour - see {@link GONE}. Its {@link detail} is the caller's to
   * write, and is the one line that says so.
   */
  gone?: boolean
  /** Their head, already fetched by the caller. Absent until it arrives, or if there is none. */
  avatar?: string | null
  /**
   * The state class the sidebar puts on its dot, drawn in the same corner here.
   *
   * A class rather than a colour, because half of them are Osmium's own rather than daisyUI's, and
   * resolving one is a question for the stylesheet - see {@link dotColour}. Agents only: a player
   * who is not ours has no state we know.
   */
  dot?: string
}

const { t } = useI18n()

const canvas = ref<HTMLCanvasElement | null>(null)
const failure = ref<string | null>(null)
const pointer = ref<{ x: number; z: number } | null>(null)

/**
 * Pixels per block.
 *
 * One is vanilla's full zoom and the resolution the data is stored at, so it is where this starts.
 * The range is wider than any other picture in Osmium: a build is read at eight pixels a block and
 * a continent at a sixteenth of one, and both are the same map.
 */
const LIMITS: Limits = { min: 1 / 16, max: 8 }

const view = ref<View>({ ...IDENTITY })

/** Decoded tiles, keyed by chunk. */
const tiles = shallowRef(new Map<string, DecodedTile>())

/**
 * Painted terrain, one canvas per {@link REGION} block of chunks rather than one per chunk.
 *
 * A screenful at one pixel per block is several thousand chunks, and drawing one image each is
 * several thousand `drawImage` calls every frame - which is what made panning crawl. Composed into
 * regions, the same screenful is a couple of dozen.
 */
const painted = new Map<string, HTMLCanvasElement>()
let palette: Palette | null = null

/** Chunks per region edge. 32 makes a 512 by 512 texture, which any GPU blits without thinking. */
const REGION = 32

function regionKey(x: number, z: number): string {
  return `${Math.floor(x / REGION)},${Math.floor(z / REGION)}`
}

/**
 * How many tiles each region holds.
 *
 * **A region with none is never painted.** Most of any world has not been charted, and every region
 * on screen used to get a 512 by 512 canvas whether it had anything in it or not - zoomed out, that
 * was a couple of thousand of them, gigabytes of blank pixels, and a crawl.
 */
const filled = new Map<string, number>()

/**
 * How many of a region's pixels each painted pixel stands for, by zoom.
 *
 * Every pixel down to half size; zoomed further out, a canvas at full size is being drawn at a
 * fraction of it, so it is painted at a quarter or a sixteenth of its size instead - which is what the
 * screen shows anyway, at a sixteenth or a two hundred and fifty-sixth of the memory and the drawing.
 */
const DETAILS = [1, 4, 16] as const
type Detail = (typeof DETAILS)[number]

function detailFor(k: number): Detail {
  return k >= 0.5 ? 1 : k >= 0.125 ? 4 : 16
}

/** Pixels held in painted canvases, against {@link paintedMost}. */
let paintedPixels = 0

/** The most painted pixels kept: two hundred and fifty-six full-size regions' worth. */
function paintedMost(): number {
  return 256 * (REGION * TILE) ** 2
}

/** Throws away every painting of a region, at every detail, so the next draw paints it afresh. */
function unpaint(region: string): void {
  for (const detail of DETAILS) {
    const key = `${region}@${detail}`
    const held = painted.get(key)
    if (!held) continue
    paintedPixels -= held.width * held.height
    painted.delete(key)
  }
}

/** Holds a tile, counts it into its region, and throws away the paintings it changes. */
function holdTile(tile: DecodedTile, into: Map<string, DecodedTile>): void {
  const key = tileKey(tile.x, tile.z)
  if (!into.has(key)) {
    const region = regionKey(tile.x, tile.z)
    filled.set(region, (filled.get(region) ?? 0) + 1)
  }
  into.set(key, tile)

  unpaint(regionKey(tile.x, tile.z))
  // The tile to the south shades against this one, and may live in the region below.
  unpaint(regionKey(tile.x, tile.z + 1))
}

/**
 * Regions already fetched, and those being fetched, so nothing is asked for twice.
 *
 * A region that came back empty counts as fetched: most of any world has never been walked, and
 * asking again on every pan would be a request per frame for ground nobody has charted.
 */
const have = new Set<string>()
const pending = new Set<string>()

/** Regions still wanted, nearest the middle of the screen first. */
let queue: Array<{ x: number; z: number; key: string }> = []
let active = 0
let frame = 0

/**
 * How many region requests are in the air at once.
 *
 * Three rather than one, because a screenful is a dozen regions and they are mostly waiting on the
 * network; and three rather than all of them, because a browser would open six connections and
 * spend them on the far corners while the middle of the screen is still blank.
 */
const CONCURRENCY = 3

// ---- geometry ---------------------------------------------------------------------------------

/** Screen pixels of the canvas, which is not its CSS size on a scaled display. */
function size(): { width: number; height: number } {
  const element = canvas.value
  return { width: element?.clientWidth ?? 0, height: element?.clientHeight ?? 0 }
}

/** The block coordinate under a point on the canvas. */
function blockAt(px: number, py: number): { x: number; z: number } {
  return { x: (px - view.value.x) / view.value.k, z: (py - view.value.y) / view.value.k }
}

/**
 * How high the ground is at one column, or null where nothing has been charted.
 *
 * The same numbers the shading is drawn from, so the height a panel offers is the height the map is
 * already showing - and it comes free, because the tile is loaded for having been drawn.
 *
 * One above the surface, which is where a body stands rather than where the ground is. A destination
 * is somewhere to be, and the block itself is somewhere to be inside.
 */
function groundAt(bx: number, bz: number): number | null {
  const tile = tiles.value.get(tileKey(Math.floor(bx / TILE), Math.floor(bz / TILE)))
  if (!tile) return null

  // Modulo twice, because a negative coordinate's remainder is negative and a tile has no such cell.
  const lx = ((bx % TILE) + TILE) % TILE
  const lz = ((bz % TILE) + TILE) % TILE
  const height = tile.heights[lz * TILE + lx]

  if (height === undefined || height === EMPTY) return null
  return height + 1
}

/** The rectangle of world the canvas is currently showing, in blocks. */
function visible(): { west: number; north: number; east: number; south: number } {
  const { width, height } = size()
  const topLeft = blockAt(0, 0)
  const bottomRight = blockAt(width, height)
  return { west: topLeft.x, north: topLeft.z, east: bottomRight.x, south: bottomRight.z }
}

// ---- terrain ----------------------------------------------------------------------------------

/**
 * Paints every tile of one region onto a single canvas, once.
 *
 * Cached, because painting is a palette lookup and a shade per pixel and a pan would otherwise
 * redo it every frame. Batched into regions rather than tiles because the *drawing* is the cost
 * that scales with the screen: a viewport at one pixel per block covers thousands of chunks, and
 * one `drawImage` each is thousands of calls a frame.
 *
 * The northern row of each tile shades against the tile above, which may be in the region above -
 * hence the lookup by chunk rather than within this canvas. A region is discarded when any tile in
 * it, or on its northern border, arrives.
 *
 * Painted at the detail the zoom needs - see {@link detailFor} - and into one image written once,
 * rather than a thousand small writes, one per tile.
 */
function paintRegion(regionX: number, regionZ: number, detail: Detail): HTMLCanvasElement | null {
  if (!palette) return null

  const region = `${regionX},${regionZ}`
  if (!filled.get(region)) return null

  const key = `${region}@${detail}`
  const cached = painted.get(key)
  if (cached) return cached

  const side = (REGION * TILE) / detail
  const element = document.createElement('canvas')
  element.width = side
  element.height = side
  const context = element.getContext('2d')
  if (!context) return null

  const out = context.createImageData(side, side)
  const scratch = new Uint8ClampedArray(TILE * TILE * 4)
  // Pixels per tile at this detail, and which block of each group of `detail` stands in for it: the
  // middle one, so a coarse map samples a tile's centre rather than its north-west corner.
  const cells = TILE / detail
  const middle = detail >> 1

  for (let dz = 0; dz < REGION; dz++) {
    for (let dx = 0; dx < REGION; dx++) {
      const x = regionX * REGION + dx
      const z = regionZ * REGION + dz
      const tile = tiles.value.get(tileKey(x, z))
      if (!tile) continue

      const north = tiles.value.get(tileKey(x, z - 1))
      paintTile(tile, north?.heights, palette, scratch)

      for (let cz = 0; cz < cells; cz++) {
        for (let cx = 0; cx < cells; cx++) {
          const from = ((cz * detail + middle) * TILE + cx * detail + middle) * 4
          const to = ((dz * cells + cz) * side + dx * cells + cx) * 4
          out.data[to] = scratch[from]!
          out.data[to + 1] = scratch[from + 1]!
          out.data[to + 2] = scratch[from + 2]!
          out.data[to + 3] = scratch[from + 3]!
        }
      }
    }
  }

  context.putImageData(out, 0, 0)
  painted.set(key, element)
  paintedPixels += side * side

  // Oldest first, which is the order a map was painted in: what was on screen a pan ago goes before
  // what is on screen now.
  for (const [held, canvasOf] of painted) {
    if (paintedPixels <= paintedMost() || held === key) break
    paintedPixels -= canvasOf.width * canvasOf.height
    painted.delete(held)
  }

  return element
}

function draw(): void {
  const element = canvas.value
  const context = element?.getContext('2d')
  if (!element || !context) return

  const ratio = window.devicePixelRatio || 1
  const { width, height } = size()
  if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
    element.width = Math.round(width * ratio)
    element.height = Math.round(height * ratio)
  }

  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)

  // Nearest neighbour, always. A map at one pixel per block is a grid of blocks, and smoothing it
  // turns a coastline into a smear - and at eight pixels a block, into mush.
  context.imageSmoothingEnabled = false

  const { west, north, east, south } = visible()
  const span = REGION * TILE
  const step = span * view.value.k
  const detail = detailFor(view.value.k)

  // Over the regions the screen covers, not over every tile ever loaded. Walking the tile map meant
  // touching thousands of entries a frame to draw the handful that are visible.
  const fromX = Math.floor(west / span)
  const toX = Math.floor(east / span)
  const fromZ = Math.floor(north / span)
  const toZ = Math.floor(south / span)

  for (let regionZ = fromZ; regionZ <= toZ; regionZ++) {
    for (let regionX = fromX; regionX <= toX; regionX++) {
      const image = paintRegion(regionX, regionZ, detail)
      if (!image) continue

      // Rounded outwards: at fractional scales two neighbouring regions otherwise land a pixel
      // apart and the map is drawn with a grid of seams through it.
      const atX = Math.floor(view.value.x + regionX * span * view.value.k)
      const atY = Math.floor(view.value.y + regionZ * span * view.value.k)
      context.drawImage(image, atX, atY, Math.ceil(step), Math.ceil(step))
    }
  }

  drawBuilds(context)
  drawPaths(context)
  drawMarks(context)
  drawArea(context)
}

// ---- the fleet and everyone else ---------------------------------------------------------------

/** Big enough to find on a map, and the same size at every zoom - it is a label, not a thing. */
const DOT = 4
const TRAIL_WIDTH = 2

/** Thicker than a trail: where an agent is going is the thing being read, not the background. */
const PATH_WIDTH = 2.5

/** What is already walked, kept faintly so the whole journey still reads as one line. */
const PATH_SPENT = 0.25
const PATH_ALPHA = 0.85

/**
 * How far off the agent's own height a segment has to be before it is dashed.
 *
 * A map seen from above draws a path over a mountain and a path through a tunnel as the same
 * straight line, which is a lie of omission - and it becomes a loud one as soon as an agent can
 * fly. Dashing says "this part is not at your eye level" without needing a second view to say it.
 *
 * Three blocks, because a staircase is not worth marking and a storey is.
 */
const PATH_HEIGHT = 3

const PATH_DASH = [6, 4]

/** The square drawn where a journey ends. Hollow, so the terrain under it is still readable. */
const GOAL_SIZE = 9

/**
 * How solid the freshest end of a trail is drawn.
 *
 * Near enough to opaque. Where an agent has just been is the part worth seeing, and terrain under a
 * two-pixel line is terrain still visible either side of it - so the trail is drawn to be followed
 * rather than to be searched for. Older segments still fade away from this, which is what makes the
 * direction of travel readable without a marker on either end.
 */
const TRAIL_ALPHA = 0.95
const LABEL_HALO = 3

/** A head, square as Minecraft draws one, and the state pip in its corner. */
const HEAD = 18
const PIP = 3.5

/**
 * What a position nobody can confirm is drawn in.
 *
 * A literal mid grey rather than a theme token, and deliberately: the point of it is that the
 * marker is the same marker with the colour taken out, so it must not *be* one of the two colours
 * that mean something. Mid enough to carry on both grounds, and the halo and the ring every marker
 * already gets do the rest.
 */
const GONE = '#9ca3af'

/**
 * Heads, by the url they were fetched from.
 *
 * The caller resolves the url - it is an authenticated request against Osmium's own avatar
 * endpoint - and this turns it into something a canvas can draw. Kept for the life of the screen:
 * a fleet is a dozen images and they are the same dozen on every frame.
 */
const faces = new Map<string, HTMLImageElement>()

/**
 * What colour the stylesheet paints a state dot.
 *
 * Measured rather than tabulated. Half of these classes are Osmium's own and half are daisyUI's,
 * and both change with the theme; asking the document what a class looks like is the only way the
 * map and the sidebar cannot come to disagree.
 */
const dots = new Map<string, string>()

function dotColour(className: string): string {
  const held = dots.get(className)
  if (held) return held

  const probe = document.createElement('span')
  probe.className = className
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  document.body.append(probe)
  const colour = getComputedStyle(probe).backgroundColor
  probe.remove()

  dots.set(className, colour)
  return colour
}

/** The image for a url, once it has loaded. Requests it the first time it is asked for. */
function faceFor(url: string): HTMLImageElement | undefined {
  const held = faces.get(url)
  if (held) return held.complete && held.naturalWidth > 0 ? held : undefined

  const image = new Image()
  // Drawn to a canvas that is never read back, so this only needs to not taint anything.
  image.decoding = 'async'
  image.onload = () => schedule()
  image.src = url
  faces.set(url, image)
  return undefined
}

/**
 * Below this many pixels per block, only names are drawn.
 *
 * Zoomed out far enough, the dots are close enough together that two lines of text under each one
 * overlap into a grey band. The name is what identifies somebody; the vitals are what somebody
 * reads once they have found them, by which point they have zoomed in.
 */
const DETAIL_FROM = 0.5

/**
 * The theme's colours, read once.
 *
 * `getComputedStyle` forces the browser to resolve style, and doing it inside the draw loop meant
 * one forced recalculation per frame for four values that change only when the theme does.
 */
interface Ink {
  ours: string
  theirs: string
  ink: string
  ground: string
  /** An area being dragged out: the one mark about the operator's hand rather than the world. */
  accent: string
  /** What building is drawn in everywhere else — an agent's badge, a job's progress. */
  building: string
}

let inks: Ink | null = null

function themeInks(): Ink {
  if (inks) return inks

  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback

  inks = {
    ours: read('--color-primary', '#80b55f'),
    theirs: read('--color-error', '#e05252'),
    ink: read('--color-base-content', '#111111'),
    // What a label is outlined in. The page's own ground rather than white or black, so the halo
    // belongs to the theme in both of them.
    ground: read('--color-base-100', '#ffffff'),
    accent: read('--color-accent', '#38bdf8'),
    building: read('--osmium-building', '#a78bfa'),
  }
  return inks
}

/** How much of the build colour a job's box is washed with. A plan's is not washed at all. */
const BUILD_FILL = 0.1

/** A plan's dashes, in screen pixels, so they read the same at every zoom. */
const PLAN_DASH = [6, 4]

/** How strongly a piece's edge is drawn: enough to count them, not enough to compete with the box. */
const SECTION_LINE = 0.55

/** How much more a finished piece is washed in than the rest of its job. */
const SECTION_DONE_FILL = 0.18

/**
 * Where builds stand, and where they are going to.
 *
 * Under the paths and the marks: a build is ground an agent works on, and a box drawn over a face
 * would hide the one thing a map is opened to find. Haloed in the page's ground like everything
 * else here, so the edge holds on terrain of any colour.
 */
function drawBuilds(context: CanvasRenderingContext2D): void {
  const builds = props.builds ?? []
  if (!builds.length) return

  const { building, ground } = themeInks()

  // Inclusive at both ends: a block is k pixels wide, and the last one is in the box too.
  const onScreen = (box: Footprint) => ({
    left: view.value.x + box.west * view.value.k,
    top: view.value.y + box.north * view.value.k,
    width: (box.east - box.west + 1) * view.value.k,
    height: (box.south - box.north + 1) * view.value.k,
  })

  for (const build of builds) {
    const { left, top, width, height } = onScreen(build.box)

    if (!build.planned) {
      context.globalAlpha = BUILD_FILL
      context.fillStyle = building
      context.fillRect(left, top, width, height)
      context.globalAlpha = 1
    }

    // The pieces, thin and under the outline, so the division reads as the inside of one build
    // rather than as several builds side by side. A finished one is washed in: the part of the
    // footprint that is done is the first thing anybody looking at a job wants to see.
    for (const section of build.sections) {
      const piece = onScreen(section.box)
      if (section.done) {
        context.globalAlpha = SECTION_DONE_FILL
        context.fillStyle = building
        context.fillRect(piece.left, piece.top, piece.width, piece.height)
      }
      context.globalAlpha = SECTION_LINE
      context.lineWidth = 1
      context.strokeStyle = building
      context.strokeRect(piece.left, piece.top, piece.width, piece.height)
      context.globalAlpha = 1
    }

    context.setLineDash(build.planned ? PLAN_DASH : [])
    context.lineJoin = 'miter'
    context.lineWidth = LABEL_HALO
    context.strokeStyle = ground
    context.strokeRect(left, top, width, height)
    context.lineWidth = 1.5
    context.strokeStyle = building
    context.strokeRect(left, top, width, height)
    context.setLineDash([])

    // Its name over the north-west corner, which is the corner a placement names.
    context.textAlign = 'left'
    context.lineJoin = 'round'
    context.lineWidth = LABEL_HALO
    context.font = '600 11px ui-sans-serif, system-ui, sans-serif'
    context.strokeStyle = ground
    context.strokeText(build.label, left, top - 4)
    context.fillStyle = building
    context.fillText(build.label, left, top - 4)
  }
}

/** How much of the accent an area is washed with, so the terrain under it still reads. */
const AREA_FILL = 0.18

/** An area being dragged out, or the one a panel is open about. Over everything else. */
function drawArea(context: CanvasRenderingContext2D): void {
  const area = live.value ?? props.area ?? null
  if (!area) return

  const { accent, ground } = themeInks()
  const left = view.value.x + area.west * view.value.k
  const top = view.value.y + area.north * view.value.k
  // Inclusive at both ends: a block is k pixels wide, and the last one is in the area too.
  const width = (area.east - area.west + 1) * view.value.k
  const height = (area.south - area.north + 1) * view.value.k

  context.globalAlpha = AREA_FILL
  context.fillStyle = accent
  context.fillRect(left, top, width, height)
  context.globalAlpha = 1

  // Haloed in the page's ground like the names, so the edge holds against terrain of any colour.
  context.lineJoin = 'miter'
  context.lineWidth = LABEL_HALO
  context.strokeStyle = ground
  context.strokeRect(left, top, width, height)
  context.lineWidth = 1.5
  context.strokeStyle = accent
  context.strokeRect(left, top, width, height)
}

/**
 * Where the fleet is going.
 *
 * Under the marks and over the terrain: a journey is context for the agent walking it, and a line
 * drawn over a face would hide the thing it is about.
 *
 * Two passes over one line rather than two lines. What is behind the agent is drawn faint and what
 * is ahead is drawn solid, so the direction of travel is readable without an arrowhead - the same
 * idea the trails already use, running the other way.
 */
function drawPaths(context: CanvasRenderingContext2D): void {
  const { ours, ink, ground } = themeInks()

  for (const path of props.paths) {
    const points = path.points
    if (points.length > 1) {
      // The height everything is compared against. An agent walks its own path, so the part of it
      // at the agent's level is the part that is where it looks like it is.
      const eye = points[Math.min(Math.max(path.progress, 0), points.length - 1)]?.y ?? 0

      context.lineWidth = PATH_WIDTH
      context.lineJoin = 'round'
      context.lineCap = 'round'
      context.strokeStyle = ours

      for (let at = 1; at < points.length; at++) {
        const from = points[at - 1]!
        const to = points[at]!

        context.globalAlpha = at <= path.progress ? PATH_SPENT : PATH_ALPHA
        // Set per segment rather than per line: a journey that climbs has both kinds in it, and
        // the point of the dash is to say which parts of this one line are which.
        context.setLineDash(Math.abs(to.y - eye) > PATH_HEIGHT ? PATH_DASH : [])

        context.beginPath()
        context.moveTo(view.value.x + from.x * view.value.k, view.value.y + from.z * view.value.k)
        context.lineTo(view.value.x + to.x * view.value.k, view.value.y + to.z * view.value.k)
        context.stroke()
      }

      context.setLineDash([])
      context.globalAlpha = 1
    }

    // The destination, whether or not a line reaches it yet - a search still running has a goal and
    // no path, and that is exactly the moment somebody wants to see where the agent was sent.
    const goal = path.goal
    if (!goal) continue

    const atX = view.value.x + goal.x * view.value.k
    const atY = view.value.y + goal.z * view.value.k
    const half = GOAL_SIZE / 2

    // Haloed in the page's ground the way every label here is, so it holds on any terrain.
    context.lineWidth = LABEL_HALO
    context.strokeStyle = ground
    context.strokeRect(atX - half, atY - half, GOAL_SIZE, GOAL_SIZE)
    context.lineWidth = 1.5
    context.strokeStyle = ours
    context.strokeRect(atX - half, atY - half, GOAL_SIZE, GOAL_SIZE)

    // A dot in the middle, in the text colour rather than the accent, so the square reads as a
    // marker on the map rather than as one more agent.
    context.fillStyle = ink
    context.beginPath()
    context.arc(atX, atY, 1.5, 0, Math.PI * 2)
    context.fill()
  }
}

function drawMarks(context: CanvasRenderingContext2D): void {
  const { ours, theirs, ink, ground } = themeInks()

  for (const mark of props.marks) {
    const colour = mark.gone ? GONE : mark.ours ? ours : theirs

    // Oldest faintest. Motion is what makes a fleet read as working rather than as a list of dots,
    // and a trail is the only part of this picture that shows any.
    const trail = mark.trail ?? []
    if (trail.length > 1) {
      context.lineWidth = TRAIL_WIDTH
      for (let at = 1; at < trail.length; at++) {
        const from = trail[at - 1]!
        const to = trail[at]!
        context.globalAlpha = (at / trail.length) * TRAIL_ALPHA
        context.strokeStyle = colour
        context.beginPath()
        context.moveTo(view.value.x + from.x * view.value.k, view.value.y + from.z * view.value.k)
        context.lineTo(view.value.x + to.x * view.value.k, view.value.y + to.z * view.value.k)
        context.stroke()
      }
      context.globalAlpha = 1
    }

    const atX = view.value.x + mark.x * view.value.k
    const atY = view.value.y + mark.z * view.value.k

    const face = mark.avatar ? faceFor(mark.avatar) : undefined

    if (face) {
      // Square, as Minecraft draws a head, and pixelated - these are 8 by 8 images and smoothing
      // them turns a face into a smudge. Bordered in the marker's own colour so ours and theirs are
      // still told apart at a glance, which the head alone does not do.
      const left = atX - HEAD / 2
      const top = atY - HEAD / 2

      context.imageSmoothingEnabled = false
      // Through the filter for somebody nobody can see any more, so the head reads as the same
      // head rather than as a different person. Put back straight afterwards: the filter is on the
      // context, not on the call, and everything drawn after it would inherit it.
      if (mark.gone) context.filter = 'grayscale(1)'
      context.drawImage(face, left, top, HEAD, HEAD)
      context.filter = 'none'

      // The same halo the names get, for the same reason: a head is eight pixels of whatever the
      // skin happens to be, and against terrain of a similar tone it has no edge at all. The
      // marker's own colour is laid down the middle of that halo rather than replacing it, so
      // ours and theirs still tell apart without giving the head a second ring.
      context.lineJoin = 'round'
      context.lineWidth = LABEL_HALO
      context.strokeStyle = ground
      context.strokeRect(left - 1, top - 1, HEAD + 2, HEAD + 2)
      context.lineWidth = 1
      context.strokeStyle = colour
      context.strokeRect(left - 1, top - 1, HEAD + 2, HEAD + 2)

      // The sidebar's dot, in the sidebar's corner. Ringed in the page's ground the way the sidebar
      // rings it in the panel's, so it reads as a pip on the head rather than as a hole in it.
      if (mark.dot) {
        context.beginPath()
        context.arc(left + HEAD, top + HEAD, PIP, 0, Math.PI * 2)
        context.fillStyle = dotColour(mark.dot)
        context.fill()
        context.lineWidth = 2
        context.strokeStyle = ground
        context.stroke()
      }
    } else {
      // Until the head arrives, and for anyone who has none. Ringed in the page's own ink rather
      // than in white or black: a dot the colour of the terrain it stands on is one nobody can
      // find, and grass and sand are both light.
      context.beginPath()
      context.arc(atX, atY, DOT, 0, Math.PI * 2)
      context.fillStyle = colour
      context.fill()
      context.lineWidth = 1.5
      context.strokeStyle = ink
      context.stroke()
    }

    // Outlined in the page's ground and filled with its ink. Both were `ink` before, left over from
    // the ring above - a halo the same colour as the letters it surrounds, which is a smudge.
    // Outlined in the page's ground and filled with its ink. Both were `ink` before, left over from
    // the ring above - a halo the same colour as the letters it surrounds, which is a smudge.
    // A last-known line is drawn however far out the map is: it does not describe the marker, it
    // qualifies it, and a grey dot with no explanation is one an operator would read as live.
    const detail = mark.gone || view.value.k >= DETAIL_FROM ? mark.detail : undefined
    // Clear of whichever was drawn, so a name does not sit on a face.
    const above = mark.avatar && faces.get(mark.avatar)?.complete ? HEAD / 2 + 2 : DOT
    const nameAt = atY - above - (detail ? 14 : 4)

    context.textAlign = 'center'
    context.lineJoin = 'round'
    context.lineWidth = LABEL_HALO
    context.strokeStyle = ground

    context.font = '600 11px ui-sans-serif, system-ui, sans-serif'
    context.strokeText(mark.label, atX, nameAt)
    context.fillStyle = ink
    context.fillText(mark.label, atX, nameAt)

    if (detail) {
      context.font = '10px ui-sans-serif, system-ui, sans-serif'
      context.strokeStyle = ground
      context.strokeText(detail, atX, atY - above - 4)
      context.globalAlpha = 0.75
      context.fillStyle = ink
      context.fillText(detail, atX, atY - above - 4)
      context.globalAlpha = 1
    }
  }
}

// ---- loading ------------------------------------------------------------------------------------

/**
 * The regions the screen is showing, nearest its middle first.
 *
 * Ordered, because they arrive one at a time and the middle is where somebody is looking. Filling
 * outwards reads as the map resolving; filling in whatever order the network answered reads as
 * something being wrong with it.
 */
function wantedRegions(): Array<{ x: number; z: number; key: string }> {
  const { west, north, east, south } = visible()
  const span = REGION * TILE

  const midX = (west + east) / 2
  const midZ = (north + south) / 2

  const found: Array<{ x: number; z: number; key: string; away: number }> = []
  for (let z = Math.floor(north / span); z <= Math.floor(south / span); z++) {
    for (let x = Math.floor(west / span); x <= Math.floor(east / span); x++) {
      const away = Math.hypot((x + 0.5) * span - midX, (z + 0.5) * span - midZ)
      found.push({ x, z, key: `${x},${z}`, away })
    }
  }

  return found.sort((one, other) => one.away - other.away).map(({ x, z, key }) => ({ x, z, key }))
}

/**
 * Asks for whatever part of the map is on screen and is not already held.
 *
 * **A region at a time, not the whole window.** One request for everything visible had to be capped
 * - the backend answers at most 4096 chunks - and a screen at one pixel per block wants twice that,
 * so the cap quietly trimmed the request to the middle and the edges were never asked for at all.
 * Per region there is no cap to hit, a pan asks only for ground it has not seen, and each piece is
 * drawn the moment it lands rather than the screen staying blank until the last of it arrives.
 */
function load(): void {
  if (!props.server || !props.dimension) return

  const wanted = wantedRegions()
  const onScreen = new Set(wanted.map((region) => region.key))

  // Anything queued that has since been panned away from is dropped rather than fetched: it is no
  // longer what anybody is looking at, and it would be ahead of what is.
  queue = queue.filter((region) => onScreen.has(region.key))

  const queued = new Set(queue.map((region) => region.key))
  for (const region of wanted) {
    if (have.has(region.key) || pending.has(region.key) || queued.has(region.key)) continue
    queue.push(region)
  }

  pump()
}

/** Starts as many queued regions as the budget allows. */
function pump(): void {
  while (active < CONCURRENCY && queue.length > 0) {
    const region = queue.shift()
    if (region) void fetchRegion(region)
  }
}

async function fetchRegion(region: { x: number; z: number; key: string }): Promise<void> {
  pending.add(region.key)
  active++

  const server = props.server
  const dimension = props.dimension

  try {
    palette ??= await loadPalette()
    const found = await fetchTiles(server, dimension, {
      minX: region.x * REGION,
      minZ: region.z * REGION,
      maxX: region.x * REGION + REGION - 1,
      maxZ: region.z * REGION + REGION - 1,
    })

    // The world may have been changed under this request - a different server, or a different
    // dimension of the same one - in which case these tiles belong to somewhere else entirely.
    if (server !== props.server || dimension !== props.dimension) return

    const next = new Map(tiles.value)
    for (const tile of found) holdTile(tile, next)
    tiles.value = next
    have.add(region.key)
    failure.value = null
    schedule()
  } catch (err) {
    // Not marked as held, so panning back here tries again rather than leaving a hole for as long
    // as the screen is open.
    failure.value = err instanceof Error ? err.message : String(err)
  } finally {
    pending.delete(region.key)
    active--
    pump()
  }
}

/** One draw per frame however many things asked for one. */
function schedule(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    draw()
  })
}

// ---- input ---------------------------------------------------------------------------------------

let dragging: { x: number; y: number } | null = null

/**
 * Where the press started, and whether it has travelled far enough to be a pan.
 *
 * The map is dragged far more often than it is clicked, and every drag ends with a pointerup over
 * some coordinate - so without this, panning across the world would open a panel about wherever the
 * hand happened to stop.
 */
let pressed: { x: number; y: number; moved: boolean } | null = null

/** Pixels of travel before a press stops being a click. About the slop in a firm mouse click. */
const SLOP = 4

/**
 * An area being dragged out: the block the drag started on and the one under the pointer now.
 *
 * **Shift turns a drag from a pan into an area.** A plain drag is how the map is moved, and far more
 * common than choosing a stretch of it, so it keeps the plain gesture and this one asks for a key.
 * A shift click is one corner instead, and the next is the other - see `afterShiftPress`.
 */
let selecting: (ShiftPress & { x: number; y: number }) | null = null

/** A first corner a shift click left, waiting for the second. Any press without shift lets it go. */
let waiting: Corner | null = null

/** The box of that drag, for drawing while it is being made. */
const live = shallowRef<Area | null>(null)

/** The block under the pointer, for one end of an area. */
function cornerAt(event: PointerEvent): Corner | undefined {
  const box = canvas.value?.getBoundingClientRect()
  if (!box) return undefined
  const at = blockAt(event.clientX - box.left, event.clientY - box.top)
  return { x: Math.floor(at.x), z: Math.floor(at.z) }
}

function onPointerDown(event: PointerEvent): void {
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)

  const corner = event.shiftKey && event.button === 0 ? cornerAt(event) : undefined
  if (corner) {
    selecting = { start: corner, end: corner, moved: false, x: event.clientX, y: event.clientY }
    live.value = areaUnderway(waiting, selecting, corner)
    schedule()
    return
  }

  if (waiting) {
    waiting = null
    live.value = null
    schedule()
  }

  dragging = { x: event.clientX, y: event.clientY }
  pressed = { x: event.clientX, y: event.clientY, moved: false }
}

function onPointerMove(event: PointerEvent): void {
  const box = canvas.value?.getBoundingClientRect()
  if (box) {
    const at = blockAt(event.clientX - box.left, event.clientY - box.top)
    pointer.value = { x: Math.floor(at.x), z: Math.floor(at.z) }
  }

  if (selecting) {
    if (Math.abs(event.clientX - selecting.x) + Math.abs(event.clientY - selecting.y) > SLOP) selecting.moved = true
    const corner = cornerAt(event)
    if (corner) {
      selecting.end = corner
      live.value = areaUnderway(waiting, selecting, corner)
      schedule()
    }
    return
  }

  // A first corner waiting for its second: the area it would make, following the pointer.
  if (waiting) {
    const corner = cornerAt(event)
    if (corner) {
      live.value = areaUnderway(waiting, null, corner)
      schedule()
    }
  }

  if (pressed && !pressed.moved) {
    const travelled = Math.abs(event.clientX - pressed.x) + Math.abs(event.clientY - pressed.y)
    if (travelled > SLOP) pressed.moved = true
  }

  if (!dragging) return
  view.value = panBy(view.value, event.clientX - dragging.x, event.clientY - dragging.y)
  dragging = { x: event.clientX, y: event.clientY }
  schedule()
  load()
}

function onPointerUp(event: PointerEvent): void {
  dragging = null
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)

  if (selecting) {
    const press = selecting
    selecting = null

    // A cancelled drag - the pointer taken away by the browser - chose nothing.
    const box = canvas.value?.getBoundingClientRect()
    if (event.type === 'pointercancel' || !box) {
      waiting = null
      live.value = null
      schedule()
      return
    }

    const after = afterShiftPress(waiting, press)
    waiting = after.waiting
    live.value = after.chosen ? null : areaUnderway(waiting, null, press.end)
    schedule()

    if (after.chosen) emit('select', { area: after.chosen, px: event.clientX - box.left, py: event.clientY - box.top })
    return
  }

  const press = pressed
  pressed = null

  const box = canvas.value?.getBoundingClientRect()
  if (!press || press.moved || !box) return

  const px = event.clientX - box.left
  const py = event.clientY - box.top
  const at = blockAt(px, py)
  const x = Math.floor(at.x)
  const z = Math.floor(at.z)

  emit('pick', { x, y: groundAt(x, z), z, px, py })
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const box = canvas.value?.getBoundingClientRect()
  if (!box) return

  // Exponential in the wheel delta, so a trackpad's many small events and a mouse's few large ones
  // travel the same distance for the same gesture.
  const factor = Math.exp(-event.deltaY * 0.002)
  view.value = zoomAt(view.value, event.clientX - box.left, event.clientY - box.top, factor, LIMITS)
  schedule()
  load()
}

/** Puts the middle of the canvas on a block coordinate. */
function centreOn(x: number, z: number, k = view.value.k): void {
  const { width, height } = size()
  view.value = { k, x: width / 2 - x * k, y: height / 2 - z * k }
  schedule()
  load()
}

defineExpose({ centreOn })

// Drawn over the terrain, so a panel opening or closing about an area redraws it.
watch(
  () => props.area,
  () => schedule(),
)

// ---- lifecycle ------------------------------------------------------------------------------------

let observer: ResizeObserver | undefined
let themes: MutationObserver | undefined
let stopCharting: (() => void) | undefined

/**
 * A chunk an agent has just charted, drawn as it arrives.
 *
 * **A region is only ever fetched once**, so without this a map showed the ground charted before it
 * was opened and nothing after - and a region that came back empty stayed empty for as long as the
 * page was open, however much of it the fleet then flew over. Only the tile's own region and the one
 * south of it are repainted, which is what a fetched tile throws away too.
 *
 * Into the map in place rather than a copy of it: this arrives many times a second while an agent
 * flies, and copying several thousand tiles for each one is the cost a pan was made cheap to avoid.
 */
function charted(event: { serverAddress?: string; dimension?: string; tile?: TilePayload }): void {
  if (event.serverAddress !== props.server || event.dimension !== props.dimension || !event.tile) return

  const tile = decodeTile(event.tile)
  if (!tile) return

  holdTile(tile, tiles.value)
  triggerRef(tiles)
  schedule()
}

onMounted(() => {
  const element = canvas.value
  if (!element) return

  // The element, not the window: this canvas shares a page with a rail that opens and closes, and
  // watching the window misses every resize that is not the window's.
  observer = new ResizeObserver(() => {
    schedule()
    load()
  })
  observer.observe(element)

  // Light and dark give different ink and a different ground, and the map is drawn to a canvas -
  // which no stylesheet reaches. Dropped rather than recomputed, so the next frame reads them.
  themes = new MutationObserver(() => {
    inks = null
    // The state dots are theme colours too, and they were measured against the old one.
    dots.clear()
    schedule()
  })
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  stopCharting = useAgentStore().onFeedEvent((name, data) => {
    if (name === 'map-tile') charted(data as Parameters<typeof charted>[0])
  })

  // Somewhere to start, replaced the moment the fleet reports a position.
  centreOn(0, 0)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  themes?.disconnect()
  stopCharting?.()
  if (frame) cancelAnimationFrame(frame)
})

// A different server, or a different dimension of the same one, is a different world - and the
// coordinates carry over, so a tile kept from the last one is not merely stale, it is somewhere
// else. Everything drawn is thrown away rather than merged into.
watch(
  () => [props.server, props.dimension],
  () => {
    tiles.value = new Map()
    painted.clear()
    paintedPixels = 0
    filled.clear()
    have.clear()
    queue = []
    failure.value = null
    load()
  },
)

watch(() => props.marks, schedule, { deep: true })
watch(() => props.paths, schedule, { deep: true })
watch(() => props.builds, schedule, { deep: true })

const scale = computed(() => {
  const k = view.value.k
  return k >= 1 ? String(Math.round(k)) : `1/${Math.round(1 / k)}`
})
</script>

<template>
  <!--
    Square corners, not rounded. This pane is full bleed - it runs to the edges of the frame - so a
    radius here does not soften a card, it cuts four notches out of the corners of the window and
    shows the page behind them. `overflow-hidden` stays: it is what keeps the canvas inside.
  -->
  <div class="relative min-h-0 flex-1 overflow-hidden">
    <canvas
      ref="canvas"
      class="size-full cursor-grab touch-none active:cursor-grabbing"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="pointer = null"
      @wheel="onWheel"
    />

    <!-- Over the map rather than beside it: the numbers are about what is under the pointer. -->
    <div
      class="bg-base-200/80 pointer-events-none absolute bottom-2 left-2 rounded px-2 py-1 font-mono text-xs tabular-nums shadow-sm"
    >
      <span v-if="pointer">{{ t('map.at', { x: pointer.x, z: pointer.z }) }}</span>
      <span v-else class="opacity-60">{{ t('map.scale', { n: scale }) }} · {{ t('map.selectHint') }}</span>
    </div>

    <div
      v-if="failure"
      class="alert alert-error absolute top-2 right-2 left-2 mx-auto w-fit py-2 text-sm shadow-md"
    >
      {{ t('map.failed', { reason: failure }) }}
    </div>
  </div>
</template>
