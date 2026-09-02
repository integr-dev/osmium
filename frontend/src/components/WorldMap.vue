<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { areaAround, fetchTiles, withinCap } from '../api/map'
import { loadPalette } from '../lib/mapPalette'
import { TILE, paintTile, tileKey, type DecodedTile, type Palette } from '../lib/mapTiles'
import { IDENTITY, panBy, zoomAt, type Limits, type View } from '../lib/panZoom'

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
}>()

/** Something to draw on top of the terrain: an agent, or somebody near one. */
export interface Mark {
  id: string
  label: string
  x: number
  z: number
  /** Fleet or not. A player who is not one of ours is the thing this screen exists to show. */
  ours: boolean
  /** Recent positions, oldest first, for the trail. Only the fleet keeps one. */
  trail?: Array<{ x: number; z: number }>
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

/** The last area asked for, so panning inside it asks for nothing. */
let asked: string | null = null
let inflight = 0
let frame = 0

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
 */
function paintRegion(regionX: number, regionZ: number): HTMLCanvasElement | null {
  if (!palette) return null

  const key = `${regionX},${regionZ}`
  const cached = painted.get(key)
  if (cached) return cached

  const element = document.createElement('canvas')
  element.width = REGION * TILE
  element.height = REGION * TILE
  const context = element.getContext('2d')
  if (!context) return null

  const image = context.createImageData(TILE, TILE)
  for (let dz = 0; dz < REGION; dz++) {
    for (let dx = 0; dx < REGION; dx++) {
      const x = regionX * REGION + dx
      const z = regionZ * REGION + dz
      const tile = tiles.value.get(tileKey(x, z))
      if (!tile) continue

      const north = tiles.value.get(tileKey(x, z - 1))
      paintTile(tile, north?.heights, palette, image.data)
      context.putImageData(image, dx * TILE, dz * TILE)
    }
  }

  painted.set(key, element)
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

  // Over the regions the screen covers, not over every tile ever loaded. Walking the tile map meant
  // touching thousands of entries a frame to draw the handful that are visible.
  const fromX = Math.floor(west / span)
  const toX = Math.floor(east / span)
  const fromZ = Math.floor(north / span)
  const toZ = Math.floor(south / span)

  for (let regionZ = fromZ; regionZ <= toZ; regionZ++) {
    for (let regionX = fromX; regionX <= toX; regionX++) {
      const image = paintRegion(regionX, regionZ)
      if (!image) continue

      // Rounded outwards: at fractional scales two neighbouring regions otherwise land a pixel
      // apart and the map is drawn with a grid of seams through it.
      const atX = Math.floor(view.value.x + regionX * span * view.value.k)
      const atY = Math.floor(view.value.y + regionZ * span * view.value.k)
      context.drawImage(image, atX, atY, Math.ceil(step), Math.ceil(step))
    }
  }

  drawMarks(context)
}

// ---- the fleet and everyone else ---------------------------------------------------------------

/** Big enough to find on a map, and the same size at every zoom - it is a label, not a thing. */
const DOT = 4
const TRAIL_WIDTH = 1.5
const LABEL_HALO = 3

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
  }
  return inks
}

function drawMarks(context: CanvasRenderingContext2D): void {
  const { ours, theirs, ink, ground } = themeInks()

  for (const mark of props.marks) {
    const colour = mark.ours ? ours : theirs

    // Oldest faintest. Motion is what makes a fleet read as working rather than as a list of dots,
    // and a trail is the only part of this picture that shows any.
    const trail = mark.trail ?? []
    if (trail.length > 1) {
      context.lineWidth = TRAIL_WIDTH
      for (let at = 1; at < trail.length; at++) {
        const from = trail[at - 1]!
        const to = trail[at]!
        context.globalAlpha = (at / trail.length) * 0.7
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

    // Ringed in the page's own ink rather than in white or black: a dot the colour of the terrain
    // it is standing on is a dot nobody can find, and grass and sand are both light.
    context.beginPath()
    context.arc(atX, atY, DOT, 0, Math.PI * 2)
    context.fillStyle = colour
    context.fill()
    context.lineWidth = 1.5
    context.strokeStyle = ink
    context.stroke()

    // Outlined in the page's ground and filled with its ink. Both were `ink` before, left over from
    // the ring above - a halo the same colour as the letters it surrounds, which is a smudge.
    context.font = '600 11px ui-sans-serif, system-ui, sans-serif'
    context.textAlign = 'center'
    context.lineJoin = 'round'
    context.lineWidth = LABEL_HALO
    context.strokeStyle = ground
    context.strokeText(mark.label, atX, atY - DOT - 4)
    context.fillStyle = ink
    context.fillText(mark.label, atX, atY - DOT - 4)
  }
}

// ---- loading ------------------------------------------------------------------------------------

/**
 * Asks for whatever part of the map is on screen and is not already held.
 *
 * Keyed on the area rather than debounced on time: panning within what has already been asked for
 * asks for nothing, and a pan that crosses into new ground asks once.
 */
async function load(): Promise<void> {
  if (!props.server) return

  const { west, north, east, south } = visible()
  const area = withinCap(areaAround(west, north, east, south))
  const key = `${area.minX},${area.minZ},${area.maxX},${area.maxZ}`
  if (key === asked) return
  asked = key

  const generation = ++inflight
  try {
    palette ??= await loadPalette()
    const found = await fetchTiles(props.server, props.dimension, area)
    // A slower request for an area that has since been panned away from must not overwrite what the
    // newer one brought back.
    if (generation !== inflight) return

    const next = new Map(tiles.value)
    for (const tile of found) {
      next.set(tileKey(tile.x, tile.z), tile)
      painted.delete(regionKey(tile.x, tile.z))
      // The tile to the south shades against this one, and may live in the region below.
      painted.delete(regionKey(tile.x, tile.z + 1))
    }
    tiles.value = next
    failure.value = null
    schedule()
  } catch (err) {
    if (generation !== inflight) return
    // Re-askable: the area is forgotten, so a pan back here tries again rather than showing a hole
    // for as long as the screen is open.
    asked = null
    failure.value = err instanceof Error ? err.message : String(err)
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

function onPointerDown(event: PointerEvent): void {
  dragging = { x: event.clientX, y: event.clientY }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  const box = canvas.value?.getBoundingClientRect()
  if (box) {
    const at = blockAt(event.clientX - box.left, event.clientY - box.top)
    pointer.value = { x: Math.floor(at.x), z: Math.floor(at.z) }
  }

  if (!dragging) return
  view.value = panBy(view.value, event.clientX - dragging.x, event.clientY - dragging.y)
  dragging = { x: event.clientX, y: event.clientY }
  schedule()
  void load()
}

function onPointerUp(event: PointerEvent): void {
  dragging = null
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
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
  void load()
}

/** Puts the middle of the canvas on a block coordinate. */
function centreOn(x: number, z: number, k = view.value.k): void {
  const { width, height } = size()
  view.value = { k, x: width / 2 - x * k, y: height / 2 - z * k }
  schedule()
  void load()
}

defineExpose({ centreOn })

// ---- lifecycle ------------------------------------------------------------------------------------

let observer: ResizeObserver | undefined
let themes: MutationObserver | undefined

onMounted(() => {
  const element = canvas.value
  if (!element) return

  // The element, not the window: this canvas shares a page with a rail that opens and closes, and
  // watching the window misses every resize that is not the window's.
  observer = new ResizeObserver(() => {
    schedule()
    void load()
  })
  observer.observe(element)

  // Light and dark give different ink and a different ground, and the map is drawn to a canvas -
  // which no stylesheet reaches. Dropped rather than recomputed, so the next frame reads them.
  themes = new MutationObserver(() => {
    inks = null
    schedule()
  })
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  // Somewhere to start, replaced the moment the fleet reports a position.
  centreOn(0, 0)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  themes?.disconnect()
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
    asked = null
    failure.value = null
    void load()
  },
)

watch(() => props.marks, schedule, { deep: true })

const scale = computed(() => {
  const k = view.value.k
  return k >= 1 ? String(Math.round(k)) : `1/${Math.round(1 / k)}`
})
</script>

<template>
  <div class="relative min-h-0 flex-1 overflow-hidden rounded-lg">
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
      <span v-else class="opacity-60">{{ t('map.scale', { n: scale }) }}</span>
    </div>

    <div
      v-if="failure"
      class="alert alert-error absolute top-2 right-2 left-2 mx-auto w-fit py-2 text-sm shadow-md"
    >
      {{ t('map.failed', { reason: failure }) }}
    </div>
  </div>
</template>
