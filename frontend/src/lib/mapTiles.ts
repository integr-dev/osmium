/**
 * Turning stored map tiles into pixels.
 *
 * A tile is 16x16 columns of the world seen from above, at the resolution of an in-game map at full
 * zoom: one pixel per block column. What the backend stores is block *names* and heights, never
 * colours - so this is where a map becomes something to look at, and it is the only place the two
 * halves meet.
 *
 * Pure and testable, because everything that can go wrong here is silent. A tile drawn transposed,
 * a row offset by one, a shade taken from the wrong neighbour - all of them produce a map, and the
 * map looks like terrain. Only an assertion about a known pixel catches them.
 */

/** Blocks per tile edge. */
export const TILE = 16

/** Pixels in a tile. */
export const AREA = TILE * TILE

/** The height of a column with nothing to draw, as the host and the backend write it. */
export const EMPTY = -32768

/** One tile, decoded from what the API sends. */
export interface DecodedTile {
  x: number
  z: number
  palette: string[]
  /** [AREA] indices into {@link palette}. Meaningless where the matching height is {@link EMPTY}. */
  blocks: Uint8Array
  /** [AREA] heights, or {@link EMPTY}. */
  heights: Int16Array
}

/** What the API sends for one tile. */
export interface TilePayload {
  x: number
  z: number
  palette: string[]
  blocks: string
  heights: string
}

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at)
  return bytes
}

/**
 * Decodes one tile, or null if it is not the shape a tile has.
 *
 * Refused rather than drawn partially: a short array would have the renderer reading past its end,
 * and the result is a tile of whatever happened to be next in memory rather than an obvious gap.
 */
export function decodeTile(payload: TilePayload): DecodedTile | null {
  const blocks = bytesOf(payload.blocks)
  const raw = bytesOf(payload.heights)
  if (blocks.length !== AREA || raw.length !== AREA * 2) return null
  if (payload.palette.length === 0) return null

  // Little-endian, as written. A DataView rather than an Int16Array over the buffer: the byte
  // offset of a decoded string is not guaranteed to be even, and a misaligned typed array throws.
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const heights = new Int16Array(AREA)
  for (let cell = 0; cell < AREA; cell++) heights[cell] = view.getInt16(cell * 2, true)

  return { x: payload.x, z: payload.z, palette: payload.palette, blocks, heights }
}

/**
 * The three brightnesses vanilla shades a map with, as multipliers.
 *
 * Minecraft gives every map colour four variants and uses three of them for terrain - the fourth is
 * reserved for the deepest water. Index 1 is flat ground; 0 is a step down and 2 a step up, which is
 * the whole of a map's relief and most of what makes one readable as landscape rather than as a
 * chart of what blocks are where.
 */
export const SHADES = [180 / 255, 220 / 255, 255 / 255] as const

/**
 * Which of {@link SHADES} a pixel takes, from the step up or down to the column north of it.
 *
 * The odd-looking dither is vanilla's and is worth keeping: on a slope that sits exactly on the
 * threshold, alternating pixels fall either side of it, and the result is the stippled edge a
 * Minecraft map has instead of a hard band. It is a function of position rather than random, so the
 * same terrain shades the same way every time it is drawn.
 *
 * A missing neighbour - the tile to the north has not been charted - reads as level ground. Guessing
 * a step would draw a ridge along the edge of what has been explored.
 */
export function shadeIndex(height: number, north: number | undefined, x: number, z: number): number {
  if (north === undefined || north === EMPTY || height === EMPTY) return 1

  const step = (height - north) * 0.8 + (((x + z) & 1) - 0.5) * 0.4
  if (step > 0.6) return 2
  if (step < -0.6) return 0
  return 1
}

/** A colour per block name. Anything absent is not drawn, which is how air stays air. */
export type Palette = (block: string) => readonly [number, number, number] | undefined

/**
 * Paints one tile into an RGBA buffer, 16x16, row-major from the north-west corner.
 *
 * `northEdge` is the southernmost row of heights from the tile above, which is what the top row of
 * this one shades against. Without it every tile would be flat along its northern edge and the map
 * would be drawn in visible squares.
 *
 * A column with nothing in it, or one whose block has no colour, is left fully transparent rather
 * than filled with a background - so an unexplored gap and a gap in the sky look the same, which
 * they are.
 */
export function paintTile(
  tile: DecodedTile,
  northEdge: Int16Array | undefined,
  palette: Palette,
  out: Uint8ClampedArray,
): void {
  // One lookup per distinct block rather than per pixel: a tile is 256 pixels over a handful of
  // blocks, and the palette behind this is a map lookup and a hex parse.
  const colours = tile.palette.map((block) => palette(block))

  for (let z = 0; z < TILE; z++) {
    for (let x = 0; x < TILE; x++) {
      const cell = z * TILE + x
      const at = cell * 4
      const height = tile.heights[cell]!

      const colour = height === EMPTY ? undefined : colours[tile.blocks[cell]!]
      if (!colour) {
        out[at + 3] = 0
        continue
      }

      const north = z > 0 ? tile.heights[cell - TILE]! : northEdge?.[AREA - TILE + x]
      const shade = SHADES[shadeIndex(height, north, x, z)]!

      out[at] = colour[0] * shade
      out[at + 1] = colour[1] * shade
      out[at + 2] = colour[2] * shade
      out[at + 3] = 255
    }
  }
}

/** The key a tile is held under. Chunk coordinates, so it is what a lookup by position produces. */
export function tileKey(x: number, z: number): string {
  return `${x},${z}`
}

/** The chunk a block coordinate falls in. Floors, so it is right on the negative side of zero. */
export function chunkOf(block: number): number {
  return Math.floor(block / TILE)
}
